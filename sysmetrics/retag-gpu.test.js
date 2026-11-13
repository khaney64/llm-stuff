'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  buildCountQuery,
  buildCopyQuery,
  buildDeletePredicate,
  chunkRanges,
  floorToDay,
  parseCsv,
  sumByField,
  compareCounts,
} = require('./retag-gpu.js');

test('parseArgs reads options and applies defaults', () => {
  const opts = parseArgs(['copy', '--host', 'devbox', '--from', '0', '--to', '1']);
  assert.equal(opts.command, 'copy');
  assert.equal(opts.host, 'devbox');
  assert.equal(opts.from, '0');
  assert.equal(opts.to, '1');
  assert.equal(opts.bucket, 'sysmetrics');
  assert.equal(opts['backup-bucket'], 'sysmetrics_gpu_backup');
  assert.equal(opts['chunk-hours'], 24);
});

test('parseArgs rejects a flag without a value', () => {
  assert.throws(() => parseArgs(['count', '--host', '--from', '0']), /missing value for --host/);
});

test('count query filters by host and gpu index', () => {
  const q = buildCountQuery('sysmetrics', 'devbox', '0', '2026-06-28T00:00:00.000Z', '2026-11-07T00:00:00.000Z');
  assert.match(q, /from\(bucket: "sysmetrics"\)/);
  assert.match(q, /r.host == "devbox" and r.gpu == "0"/);
  assert.match(q, /\|> group\(columns: \["_field"\]\)\n {2}\|> count\(\)/);
});

test('copy query rewrites gpu, topic and identity tags, then counts', () => {
  const q = buildCopyQuery({
    bucket: 'sysmetrics', targetBucket: 'sysmetrics', host: 'devbox', from: '0', to: '1',
    uuid: 'GPU-abc', name: 'NVIDIA GeForce RTX 3090', start: 'S', stop: 'E',
  });
  assert.match(q, /r.gpu == "0"/);
  assert.match(q, /gpu: "1", topic: "metrics\/devbox\/gpu\/1", gpu_uuid: "GPU-abc", gpu_name: "NVIDIA GeForce RTX 3090"/);
  assert.match(q, /\|> to\(bucket: "sysmetrics"\)\n {2}\|> map\(fn: \(r\) => \(\{r with _value: 1\}\)\)\n {2}\|> group\(columns: \["_field"\]\)\n {2}\|> count\(\)\n {2}\|> group\(\)\n {2}\|> sum\(\)/);
});

test('backup query copies without a map', () => {
  const q = buildCopyQuery({
    bucket: 'sysmetrics', targetBucket: 'sysmetrics_gpu_backup', host: 'devbox', from: '0', start: 'S', stop: 'E',
  });
  const [beforeWrite] = q.split('|> to(');
  assert.doesNotMatch(beforeWrite, /map\(/);
  assert.match(q, /to\(bucket: "sysmetrics_gpu_backup"\)/);
});

test('delete predicate is limited to the old topic', () => {
  assert.equal(
    buildDeletePredicate('devbox', '0'),
    '_measurement="gpu" AND host="devbox" AND gpu="0" AND topic="metrics/devbox/gpu/0"',
  );
});

test('chunkRanges covers the range and clips the last chunk', () => {
  const ranges = chunkRanges('2026-01-01T00:00:00.000Z', '2026-01-02T12:00:00.000Z', 24);
  assert.deepEqual(ranges, [
    ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'],
    ['2026-01-02T00:00:00.000Z', '2026-01-02T12:00:00.000Z'],
  ]);
});

test('floorToDay truncates to UTC midnight', () => {
  assert.equal(floorToDay('2026-06-28T19:30:41.707Z'), '2026-06-28T00:00:00.000Z');
});

test('parseCsv handles multiple tables with repeated headers', () => {
  const csv = ',result,table,_field,_value\r\n,_result,0,power_w,10\r\n,_result,1,temp_c,5\r\n\r\n,result,table,_field,_value\r\n,_result,2,power_w,3\r\n\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(sumByField(rows), { power_w: 13, temp_c: 5 });
});

test('compareCounts flags mismatched and missing fields', () => {
  assert.equal(compareCounts({ a: 1, b: 2 }, { a: 1, b: 2 }).ok, true);
  const bad = compareCounts({ a: 1, b: 2 }, { a: 1 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.mismatches, [{ field: 'b', source: 2, target: 0 }]);
  assert.equal(compareCounts({}, {}).ok, false);
});
