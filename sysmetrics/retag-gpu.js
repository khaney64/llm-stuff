#!/usr/bin/env node
// retag-gpu.js - Move a card's sysmetrics `gpu` history from one index to another.
//
// InfluxDB cannot edit tags in place, so a "rename" is copy-with-new-tags then
// delete-the-old-series. Used when a card changes slot (see dual-3090-setup.md,
// "Metrics history retag").
//
// Usage: node retag-gpu.js <count|backup|copy|verify|delete> --host H --from N [options]
//   count    per-field point counts and time range for --from (and --to if given)
//   backup   copy the --from series unchanged into --backup-bucket
//   copy     copy the --from series to index --to, rewriting gpu/topic/gpu_uuid/gpu_name
//   verify   per-field counts of --from and --to must match exactly
//   delete   re-runs verify, then deletes the --from series (only the old topic)
//
// Options:
//   --host H             host tag (required)
//   --from N             source gpu index (required)
//   --to N               target gpu index (copy, verify, delete)
//   --uuid ID            gpu_uuid for the copied points (default: latest tagged source point)
//   --name NAME          gpu_name for the copied points (default: latest tagged source point)
//   --bucket B           default: sysmetrics
//   --backup-bucket B    default: sysmetrics_gpu_backup
//   --start TIME         RFC3339 (default: first source point, floored to the day)
//   --stop TIME          RFC3339 (default: now)
//   --chunk-hours N      copy/backup window per query (default: 24)
//
// Env: INFLUXDB_URL, INFLUXDB_ORG
//      INFLUXDB_HOME_TOKEN  read access to the bucket (count, verify)
//      INFLUXDB_WRITE_TOKEN write+delete access (backup, copy, delete)

'use strict';

const http  = require('http');
const https = require('https');

const MEASUREMENT = 'gpu';
const DAY_MS = 24 * 3600 * 1000;

function parseArgs(argv) {
  const opts = { command: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) throw new Error(`missing value for ${a}`);
    opts[key] = val;
    i++;
  }
  opts.bucket = opts.bucket || 'sysmetrics';
  opts['backup-bucket'] = opts['backup-bucket'] || 'sysmetrics_gpu_backup';
  opts['chunk-hours'] = opts['chunk-hours'] ? Number(opts['chunk-hours']) : 24;
  return opts;
}

const fluxStr = (s) => JSON.stringify(String(s));

function topicFor(host, idx) {
  return `metrics/${host}/gpu/${idx}`;
}

function seriesFilter(host, idx) {
  return `|> filter(fn: (r) => r._measurement == ${fluxStr(MEASUREMENT)} and r.host == ${fluxStr(host)} and r.gpu == ${fluxStr(idx)})`;
}

// Storage can return one series as several tables with the same group key, which
// count() rejects. Regrouping by field merges them; mapping _value to 1 first keeps
// float and int fields from colliding.
const COUNT_PER_FIELD = [
  '|> map(fn: (r) => ({r with _value: 1}))',
  '|> group(columns: ["_field"])',
  '|> count()',
];

function buildCountQuery(bucket, host, idx, start, stop) {
  return [
    `from(bucket: ${fluxStr(bucket)})`,
    `|> range(start: ${start}, stop: ${stop})`,
    seriesFilter(host, idx),
    ...COUNT_PER_FIELD,
    '|> keep(columns: ["_field", "_value"])',
  ].join('\n  ');
}

function buildEdgeQuery(bucket, host, idx, start, stop, fn) {
  return [
    `from(bucket: ${fluxStr(bucket)})`,
    `|> range(start: ${start}, stop: ${stop})`,
    seriesFilter(host, idx),
    `|> ${fn}()`,
    '|> keep(columns: ["_time"])',
  ].join('\n  ');
}

function buildLatestTagsQuery(bucket, host, idx, start, stop) {
  return [
    `from(bucket: ${fluxStr(bucket)})`,
    `|> range(start: ${start}, stop: ${stop})`,
    seriesFilter(host, idx),
    '|> filter(fn: (r) => exists r.gpu_uuid)',
    '|> last()',
    '|> keep(columns: ["_time", "gpu_uuid", "gpu_name"])',
  ].join('\n  ');
}

// `to()` echoes every row it writes; the trailing count keeps the response small.
function buildCopyQuery({ bucket, targetBucket, host, from, to, uuid, name, start, stop }) {
  const lines = [
    `from(bucket: ${fluxStr(bucket)})`,
    `|> range(start: ${start}, stop: ${stop})`,
    seriesFilter(host, from),
  ];
  if (to !== undefined) {
    lines.push(`|> map(fn: (r) => ({r with gpu: ${fluxStr(to)}, topic: ${fluxStr(topicFor(host, to))}, gpu_uuid: ${fluxStr(uuid)}, gpu_name: ${fluxStr(name)}}))`);
  }
  lines.push(`|> to(bucket: ${fluxStr(targetBucket)})`);
  lines.push(...COUNT_PER_FIELD);
  lines.push('|> group()');
  lines.push('|> sum()');
  lines.push('|> keep(columns: ["_value"])');
  return lines.join('\n  ');
}

function buildDeletePredicate(host, idx) {
  return `_measurement="${MEASUREMENT}" AND host="${host}" AND gpu="${idx}" AND topic="${topicFor(host, idx)}"`;
}

function chunkRanges(startIso, stopIso, chunkHours) {
  const step = chunkHours * 3600 * 1000;
  const stop = Date.parse(stopIso);
  const ranges = [];
  for (let t = Date.parse(startIso); t < stop; t += step) {
    ranges.push([new Date(t).toISOString(), new Date(Math.min(t + step, stop)).toISOString()]);
  }
  return ranges;
}

function floorToDay(iso) {
  return new Date(Math.floor(Date.parse(iso) / DAY_MS) * DAY_MS).toISOString();
}

// Parses the API's plain CSV (header row per table, blank line between tables).
function parseCsv(text) {
  const rows = [];
  let header = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { header = null; continue; }
    const cells = line.split(',');
    if (!header) { header = cells; continue; }
    const row = {};
    header.forEach((h, i) => { if (h) row[h] = cells[i]; });
    rows.push(row);
  }
  return rows;
}

function sumByField(rows) {
  const totals = {};
  for (const r of rows) totals[r._field] = (totals[r._field] || 0) + Number(r._value);
  return totals;
}

function compareCounts(source, target) {
  const fields = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
  const mismatches = fields
    .filter(f => (source[f] || 0) !== (target[f] || 0))
    .map(f => ({ field: f, source: source[f] || 0, target: target[f] || 0 }));
  return { ok: fields.length > 0 && mismatches.length === 0, fields, mismatches };
}

// --- HTTP ---------------------------------------------------------------

function request(path, token, body, contentType) {
  const base = new URL(process.env.INFLUXDB_URL);
  const transport = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path,
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': contentType,
        'Accept': 'application/csv',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.trim()}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function orgParam() {
  return `org=${encodeURIComponent(process.env.INFLUXDB_ORG)}`;
}

async function flux(token, query) {
  const text = await request(`/api/v2/query?${orgParam()}`, token, JSON.stringify({ query, type: 'flux' }), 'application/json');
  return parseCsv(text);
}

function requireToken(name) {
  const token = process.env[name];
  if (!token) throw new Error(`${name} is not set; this command needs it`);
  return token;
}

// --- Commands -----------------------------------------------------------

async function seriesSummary(token, bucket, host, idx, start, stop) {
  const counts = sumByField(await flux(token, buildCountQuery(bucket, host, idx, start, stop)));
  const firsts = await flux(token, buildEdgeQuery(bucket, host, idx, start, stop, 'first'));
  const lasts  = await flux(token, buildEdgeQuery(bucket, host, idx, start, stop, 'last'));
  const times = (rows) => rows.map(r => r._time).filter(Boolean).sort();
  return {
    counts,
    first: times(firsts)[0] || null,
    last: times(lasts).pop() || null,
  };
}

function printSummary(label, s) {
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
  console.log(`${label}: ${total} points, ${s.first || '-'} -> ${s.last || '-'}`);
  for (const [f, n] of Object.entries(s.counts).sort()) console.log(`  ${f.padEnd(16)} ${n}`);
}

async function resolveStart(token, opts) {
  if (opts.start) return opts.start;
  const firsts = await flux(token, buildEdgeQuery(opts.bucket, opts.host, opts.from, '1970-01-01T00:00:00Z', opts.stop, 'first'));
  const first = firsts.map(r => r._time).filter(Boolean).sort()[0];
  if (!first) throw new Error(`no points for host=${opts.host} gpu=${opts.from}`);
  return floorToDay(first);
}

async function runVerify(readToken, opts) {
  const src = sumByField(await flux(readToken, buildCountQuery(opts.bucket, opts.host, opts.from, opts.start, opts.stop)));
  const dst = sumByField(await flux(readToken, buildCountQuery(opts.bucket, opts.host, opts.to, opts.start, opts.stop)));
  const result = compareCounts(src, dst);
  for (const f of result.fields) {
    const mark = (src[f] || 0) === (dst[f] || 0) ? 'ok  ' : 'DIFF';
    console.log(`  ${mark} ${f.padEnd(16)} gpu=${opts.from}: ${src[f] || 0}  gpu=${opts.to}: ${dst[f] || 0}`);
  }
  return result;
}

async function runChunkedCopy(writeToken, opts, targetBucket, to, uuid, name) {
  const ranges = chunkRanges(opts.start, opts.stop, opts['chunk-hours']);
  let total = 0;
  for (const [start, stop] of ranges) {
    const rows = await flux(writeToken, buildCopyQuery({
      bucket: opts.bucket, targetBucket, host: opts.host, from: opts.from, to, uuid, name, start, stop,
    }));
    const n = rows.reduce((a, r) => a + Number(r._value || 0), 0);
    total += n;
    console.log(`  ${start} -> ${stop}  ${n}`);
  }
  console.log(`wrote ${total} points to ${targetBucket}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const commands = ['count', 'backup', 'copy', 'verify', 'delete'];
  if (!commands.includes(opts.command)) throw new Error(`command must be one of: ${commands.join(', ')}`);
  for (const v of ['INFLUXDB_URL', 'INFLUXDB_ORG']) if (!process.env[v]) throw new Error(`${v} is not set`);
  if (!opts.host || opts.from === undefined) throw new Error('--host and --from are required');
  if (['copy', 'verify', 'delete'].includes(opts.command) && opts.to === undefined) throw new Error('--to is required');
  if (opts.to !== undefined && opts.to === opts.from) throw new Error('--to must differ from --from');

  const readToken = requireToken('INFLUXDB_HOME_TOKEN');
  const writeToken = ['backup', 'copy', 'delete'].includes(opts.command) ? requireToken('INFLUXDB_WRITE_TOKEN') : null;

  opts.stop = opts.stop || new Date().toISOString();
  opts.start = await resolveStart(readToken, opts);
  console.log(`bucket=${opts.bucket} host=${opts.host} range ${opts.start} -> ${opts.stop}`);

  switch (opts.command) {
    case 'count': {
      printSummary(`gpu=${opts.from}`, await seriesSummary(readToken, opts.bucket, opts.host, opts.from, opts.start, opts.stop));
      if (opts.to !== undefined) {
        printSummary(`gpu=${opts.to}`, await seriesSummary(readToken, opts.bucket, opts.host, opts.to, opts.start, opts.stop));
      }
      break;
    }
    case 'backup':
      await runChunkedCopy(writeToken, opts, opts['backup-bucket']);
      break;
    case 'copy': {
      let { uuid, name } = opts;
      if (!uuid || !name) {
        const latest = (await flux(readToken, buildLatestTagsQuery(opts.bucket, opts.host, opts.from, opts.start, opts.stop)))
          .sort((a, b) => (a._time < b._time ? 1 : -1))[0] || {};
        uuid = uuid || latest.gpu_uuid;
        name = name || latest.gpu_name;
      }
      if (!uuid || !name) throw new Error('no tagged source points to take gpu_uuid/gpu_name from; pass --uuid and --name');
      console.log(`gpu ${opts.from} -> ${opts.to}, gpu_uuid=${uuid}, gpu_name=${name}`);
      await runChunkedCopy(writeToken, opts, opts.bucket, opts.to, uuid, name);
      break;
    }
    case 'verify': {
      const result = await runVerify(readToken, opts);
      console.log(result.ok ? 'verify: OK' : 'verify: FAILED');
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'delete': {
      const result = await runVerify(readToken, opts);
      if (!result.ok) {
        console.error('verify failed; refusing to delete');
        process.exitCode = 1;
        break;
      }
      const predicate = buildDeletePredicate(opts.host, opts.from);
      console.log(`deleting: ${predicate}`);
      await request(
        `/api/v2/delete?${orgParam()}&bucket=${encodeURIComponent(opts.bucket)}`,
        writeToken,
        JSON.stringify({ start: opts.start, stop: opts.stop, predicate }),
        'application/json',
      );
      console.log('delete: done');
      break;
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildCountQuery,
  buildCopyQuery,
  buildDeletePredicate,
  chunkRanges,
  floorToDay,
  parseCsv,
  sumByField,
  compareCounts,
};
