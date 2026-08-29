// Power provider for Apple Silicon via `macmon`.
//
// Provider interface (see power-nvidia-smi.js):
//   name      — string, human-readable provider name
//   test(cb)  — call cb({ ok: true, watts: N }) or cb({ ok: false, reason: '...' })
//   sample(cb) — call cb(watts) on success, cb(null) on error
//
// Unlike nvidia-smi, a `macmon pipe -s 1` one-shot takes ~1.3s to return, which
// is far slower than the proxy's 250ms poll. Instead we keep one long-lived
// `macmon pipe -s 0 -i N` child streaming NDJSON and have sample() return the
// most recent reading, so the proxy's poll is a cheap memory read.
//
// Install: brew install macmon   (reads the SMC via IOKit; no sudo required)
//
// Env overrides:
//   MACMON_POWER_FIELD  gpu (default) | cpu | ane | sys | all | cpu+gpu | cpu+gpu+ane
//   MACMON_INTERVAL_MS  stream sample interval, default 250
//   MACMON_STALE_MS     discard readings older than this, default 3000
//
// Field notes: `gpu` matches the nvidia-smi providers on the Linux/Windows
// nodes (GPU-only watts), which keeps the $/request column comparable across
// hosts. It undercounts real Apple Silicon energy because the CPU does real
// inference-adjacent work; `sys` (whole-package) or `cpu+gpu+ane` is the honest
// total if cost accuracy ever matters more than cross-host comparability.

'use strict';

const { spawn } = require('child_process');

const CMD = 'macmon';
const FIELD       = (process.env.MACMON_POWER_FIELD || 'gpu').toLowerCase();
const INTERVAL_MS = parseInt(process.env.MACMON_INTERVAL_MS || '250', 10);
const STALE_MS    = parseInt(process.env.MACMON_STALE_MS    || '3000', 10);

// Which macmon JSON keys sum into the reported wattage.
const FIELD_KEYS = {
  'gpu':         ['gpu_power'],
  'cpu':         ['cpu_power'],
  'ane':         ['ane_power'],
  'sys':         ['sys_power'],
  'all':         ['all_power'],
  'cpu+gpu':     ['cpu_power', 'gpu_power'],
  'cpu+gpu+ane': ['cpu_power', 'gpu_power', 'ane_power'],
};

const keys = FIELD_KEYS[FIELD];

let child = null;
let latestWatts = null;
let latestTime = 0;
let lastError = null;
let stdoutBuf = '';
const waiters = [];

function extract(json) {
  let total = 0;
  for (const key of keys) {
    const v = json[key];
    if (typeof v !== 'number' || !isFinite(v)) return null;
    total += v;
  }
  return total;
}

function settle(watts, errMsg) {
  while (waiters.length) waiters.shift()(watts, errMsg);
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return;
  let json;
  try { json = JSON.parse(trimmed); } catch { return; }
  const watts = extract(json);
  if (watts === null) {
    lastError = `missing/invalid field(s) ${keys.join('+')} in macmon output`;
    settle(null, lastError);
    return;
  }
  latestWatts = watts;
  latestTime = Date.now();
  lastError = null;
  settle(watts, null);
}

function start() {
  if (child) return;
  if (!keys) {
    lastError = `unknown MACMON_POWER_FIELD "${FIELD}" (expected one of: ${Object.keys(FIELD_KEYS).join(', ')})`;
    settle(null, lastError);
    return;
  }

  try {
    child = spawn(CMD, ['pipe', '-s', '0', '-i', String(INTERVAL_MS)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    lastError = e.message || String(e);
    child = null;
    settle(null, lastError);
    return;
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handleLine(line);
    }
    // Guard against a runaway partial line if macmon ever stops emitting newlines.
    if (stdoutBuf.length > 1024 * 1024) stdoutBuf = '';
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { lastError = chunk.trim().split('\n').pop() || lastError; });

  child.on('error', (e) => {
    lastError = e.code === 'ENOENT'
      ? `${CMD} not found on PATH (install with: brew install macmon)`
      : (e.message || String(e));
    child = null;
    settle(null, lastError);
  });

  child.on('close', (code, signal) => {
    child = null;
    stdoutBuf = '';
    if (!lastError) lastError = `${CMD} exited (code ${code}, signal ${signal})`;
    settle(null, lastError);
  });

  child.unref();
}

function stop() {
  if (!child) return;
  const c = child;
  child = null;
  try { c.kill('SIGTERM'); } catch { /* already gone */ }
}

process.on('exit', stop);

module.exports = {
  name: `macmon (Apple Silicon, ${FIELD})`,

  test(cb) {
    start();
    if (!child) return cb({ ok: false, reason: lastError || `${CMD} failed to start` });

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cb({ ok: false, reason: lastError || `no sample from ${CMD} within 10s` });
    }, 10000);

    waiters.push((watts, errMsg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (watts !== null) cb({ ok: true, watts: Math.round(watts * 1000) / 1000 });
      else cb({ ok: false, reason: errMsg || 'unknown error' });
    });
  },

  sample(cb) {
    start();
    if (latestWatts !== null && Date.now() - latestTime <= STALE_MS) return cb(latestWatts);
    cb(null);
  },

  // Exposed for tests and for callers that want to shut the stream down early.
  stop,
};
