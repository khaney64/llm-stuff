// Power provider for NVIDIA GPUs via nvidia-smi.
//
// Provider interface (implement to support other GPUs):
//   name      — string, human-readable provider name
//   test(cb)  — call cb({ ok: true, watts: N }) or cb({ ok: false, reason: '...' })
//   sample(cb) — call cb(watts) on success, cb(null) on error
//
// nvidia-smi prints one line per GPU; on a multi-GPU box the reported watts
// are the sum across every card, since a split model draws on all of them.

'use strict';

const { execFile } = require('child_process');

const CMD  = 'nvidia-smi';
const ARGS = ['--query-gpu=power.draw', '--format=csv,noheader,nounits'];

function parsePowerDraw(stdout) {
  const lines = String(stdout).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const perGpu = lines.map(l => parseFloat(l));
  if (perGpu.length === 0 || perGpu.some(w => isNaN(w))) return null;
  return { watts: perGpu.reduce((a, b) => a + b, 0), perGpu };
}

function query(cb) {
  execFile(CMD, ARGS, { timeout: 5000 }, (err, stdout) => {
    if (err) return cb(null, err.message || String(err));
    const parsed = parsePowerDraw(stdout);
    if (!parsed) return cb(null, `unexpected output: ${String(stdout).trim()}`);
    cb(parsed, null);
  });
}

module.exports = {
  name: 'nvidia-smi (NVIDIA GPU)',

  test(cb) {
    query((parsed, errMsg) => {
      if (parsed === null) return cb({ ok: false, reason: errMsg });
      const result = { ok: true, watts: parsed.watts };
      if (parsed.perGpu.length > 1) result.perGpu = parsed.perGpu;
      cb(result);
    });
  },

  sample(cb) {
    query((parsed) => cb(parsed ? parsed.watts : null));
  },

  parsePowerDraw,
};
