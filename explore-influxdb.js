#!/usr/bin/env node
// explore-influxdb.js - Query InfluxDB to discover what LLM proxy data exists
// Usage: node explore-influxdb.js
// Env vars: INFLUXDB_URL, INFLUXDB_BUCKET, INFLUXDB_ORG, INFLUXDB_TOKEN

const http  = require('http');
const https = require('https');

const INFLUXDB_URL    = process.env.INFLUXDB_URL;
const INFLUXDB_ORG    = process.env.INFLUXDB_ORG;
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET;
const INFLUXDB_TOKEN  = process.env.INFLUXDB_TOKEN;

if (!INFLUXDB_URL || !INFLUXDB_ORG || !INFLUXDB_BUCKET || !INFLUXDB_TOKEN) {
  console.error('Missing required env vars: INFLUXDB_URL, INFLUXDB_ORG, INFLUXDB_BUCKET, INFLUXDB_TOKEN');
  process.exit(1);
}

const parsed = new URL(INFLUXDB_URL);
const transport = parsed.protocol === 'https:' ? https : http;

function fluxQuery(query) {
  const body = JSON.stringify({ query, type: 'flux' });
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `/api/v2/query?org=${encodeURIComponent(INFLUXDB_ORG)}`,
      method: 'POST',
      headers: {
        'Authorization': `Token ${INFLUXDB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/csv',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`InfluxDB ${res.statusCode}: ${data.trim().slice(0, 500)}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseCSV(csv) {
  const lines = csv.trim().split('\n').filter(l => l && !l.startsWith('#'));
  if (lines.length === 0) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).filter(l => l.trim()).map(line => {
    // Simple CSV parse (handles our use case - no embedded commas in values)
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
}

async function run() {
  const bucket = INFLUXDB_BUCKET;
  console.log(`\n=== InfluxDB Data Explorer ===`);
  console.log(`URL: ${INFLUXDB_URL}  Org: ${INFLUXDB_ORG}  Bucket: ${bucket}\n`);

  // 1. Time range & count
  console.log('--- Time Range & Record Count ---');
  try {
    const csv = await fluxQuery(`
      from(bucket: "${bucket}")
        |> range(start: 0)
        |> filter(fn: (r) => r._measurement == "llm_request")
        |> filter(fn: (r) => r._field == "prompt_tokens")
        |> count()
        |> group()
        |> sum()
    `);
    const rows = parseCSV(csv);
    if (rows.length > 0) {
      console.log(`  Total records (by prompt_tokens field): ${rows[0]._value || '?'}`);
    }
  } catch (e) { console.log(`  Error: ${e.message}`); }

  try {
    const csv = await fluxQuery(`
      from(bucket: "${bucket}")
        |> range(start: 0)
        |> filter(fn: (r) => r._measurement == "llm_request")
        |> filter(fn: (r) => r._field == "prompt_tokens")
        |> group()
        |> first()
        |> keep(columns: ["_time"])
    `);
    const rows = parseCSV(csv);
    if (rows.length > 0) console.log(`  Earliest record: ${rows[0]._time}`);
  } catch (e) { console.log(`  Earliest: Error - ${e.message}`); }

  try {
    const csv = await fluxQuery(`
      from(bucket: "${bucket}")
        |> range(start: 0)
        |> filter(fn: (r) => r._measurement == "llm_request")
        |> filter(fn: (r) => r._field == "prompt_tokens")
        |> group()
        |> last()
        |> keep(columns: ["_time"])
    `);
    const rows = parseCSV(csv);
    if (rows.length > 0) console.log(`  Latest record:   ${rows[0]._time}`);
  } catch (e) { console.log(`  Latest: Error - ${e.message}`); }

  // 2. Distinct tag values
  const tags = ['backend', 'model', 'job_type', 'job_name', 'done_reason', 'host'];
  console.log('\n--- Distinct Tag Values ---');
  for (const tag of tags) {
    try {
      const csv = await fluxQuery(`
        import "influxdata/influxdb/schema"
        schema.tagValues(bucket: "${bucket}", tag: "${tag}", predicate: (r) => r._measurement == "llm_request")
      `);
      const rows = parseCSV(csv);
      const values = rows.map(r => r._value).filter(Boolean);
      console.log(`  ${tag} (${values.length}): ${values.join(', ')}`);
    } catch (e) {
      console.log(`  ${tag}: Error - ${e.message}`);
    }
  }

  // 3. Field keys & counts
  console.log('\n--- Fields with Data ---');
  try {
    const csv = await fluxQuery(`
      import "influxdata/influxdb/schema"
      schema.fieldKeys(bucket: "${bucket}", predicate: (r) => r._measurement == "llm_request")
    `);
    const rows = parseCSV(csv);
    const fields = rows.map(r => r._value).filter(Boolean);
    console.log(`  Fields (${fields.length}): ${fields.join(', ')}`);
  } catch (e) { console.log(`  Error: ${e.message}`); }

  // 4. Aggregates by job_name (toFloat to avoid schema collision)
  console.log('\n--- Totals by job_name ---');
  try {
    const csv = await fluxQuery(`
      from(bucket: "${bucket}")
        |> range(start: 0)
        |> filter(fn: (r) => r._measurement == "llm_request")
        |> filter(fn: (r) => r._field == "prompt_tokens" or r._field == "gen_tokens" or r._field == "gpu_cost_incremental" or r._field == "elapsed_sec")
        |> toFloat()
        |> group(columns: ["job_name", "_field"])
        |> sum()
        |> group(columns: ["job_name"])
        |> pivot(rowKey: ["job_name"], columnKey: ["_field"], valueColumn: "_value")
    `);
    const rows = parseCSV(csv);
    if (rows.length > 0) {
      console.log(`  ${'job_name'.padEnd(30)} ${'prompt'.padStart(10)} ${'gen'.padStart(10)} ${'cost($)'.padStart(10)} ${'elapsed(s)'.padStart(12)}`);
      console.log(`  ${'-'.repeat(30)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(12)}`);
      for (const r of rows) {
        const name = (r.job_name || 'unknown').padEnd(30);
        const prompt = (r.prompt_tokens || '0').padStart(10);
        const gen = (r.gen_tokens || '0').padStart(10);
        const cost = r.gpu_cost_incremental ? parseFloat(r.gpu_cost_incremental).toFixed(6).padStart(10) : 'n/a'.padStart(10);
        const elapsed = r.elapsed_sec ? parseFloat(r.elapsed_sec).toFixed(1).padStart(12) : 'n/a'.padStart(12);
        console.log(`  ${name} ${prompt} ${gen} ${cost} ${elapsed}`);
      }
    } else {
      console.log('  No data returned');
    }
  } catch (e) { console.log(`  Error: ${e.message}`); }

  // 5. Grand totals
  console.log('\n--- Grand Totals ---');
  try {
    const csv = await fluxQuery(`
      from(bucket: "${bucket}")
        |> range(start: 0)
        |> filter(fn: (r) => r._measurement == "llm_request")
        |> filter(fn: (r) => r._field == "prompt_tokens" or r._field == "gen_tokens" or r._field == "gpu_cost_incremental" or r._field == "gpu_energy_wh")
        |> toFloat()
        |> group(columns: ["_field"])
        |> sum()
    `);
    const rows = parseCSV(csv);
    for (const r of rows) {
      console.log(`  ${(r._field || '?').padEnd(25)} = ${r._value}`);
    }
  } catch (e) { console.log(`  Error: ${e.message}`); }

  // 5b. Request count by job_name
  console.log('\n--- Request Count by job_name ---');
  try {
    const csv = await fluxQuery(`
      from(bucket: "${bucket}")
        |> range(start: 0)
        |> filter(fn: (r) => r._measurement == "llm_request")
        |> filter(fn: (r) => r._field == "prompt_tokens")
        |> group(columns: ["job_name"])
        |> count()
        |> sort(columns: ["_value"], desc: true)
    `);
    const rows = parseCSV(csv);
    for (const r of rows) {
      console.log(`  ${(r.job_name || '?').padEnd(35)} ${r._value} requests`);
    }
  } catch (e) { console.log(`  Error: ${e.message}`); }

  // 6. Recent samples
  console.log('\n--- 5 Most Recent Requests ---');
  try {
    const csv = await fluxQuery(`
      from(bucket: "${bucket}")
        |> range(start: 0)
        |> filter(fn: (r) => r._measurement == "llm_request")
        |> filter(fn: (r) => r._field == "prompt_tokens" or r._field == "gen_tokens" or r._field == "tok_per_sec" or r._field == "elapsed_sec")
        |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> group()
        |> sort(columns: ["_time"], desc: true)
        |> limit(n: 5)
        |> keep(columns: ["_time", "model", "job_name", "prompt_tokens", "gen_tokens", "tok_per_sec", "elapsed_sec"])
    `);
    const rows = parseCSV(csv);
    for (const r of rows) {
      const time = r._time ? r._time.replace('T', ' ').replace(/\.\d+Z/, 'Z') : '?';
      console.log(`  ${time}  model=${r.model || '?'}  job=${r.job_name || '?'}  prompt=${r.prompt_tokens || '?'}  gen=${r.gen_tokens || '?'}  tok/s=${r.tok_per_sec || '?'}  elapsed=${r.elapsed_sec || '?'}s`);
    }
    if (rows.length === 0) console.log('  No data');
  } catch (e) { console.log(`  Error: ${e.message}`); }

  console.log('\n=== Done ===\n');
}

run().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
