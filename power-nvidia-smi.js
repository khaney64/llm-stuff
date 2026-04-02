// Power provider for NVIDIA GPUs via nvidia-smi.
//
// Provider interface (implement to support other GPUs):
//   name      — string, human-readable provider name
//   test(cb)  — call cb({ ok: true, watts: N }) or cb({ ok: false, reason: '...' })
//   sample(cb) — call cb(watts) on success, cb(null) on error

'use strict';

const { execFile } = require('child_process');

const CMD  = 'nvidia-smi';
const ARGS = ['--query-gpu=power.draw', '--format=csv,noheader,nounits'];

function query(cb) {
  execFile(CMD, ARGS, { timeout: 5000 }, (err, stdout) => {
    if (err) return cb(null, err.message || String(err));
    const watts = parseFloat(stdout);
    if (isNaN(watts)) return cb(null, `unexpected output: ${stdout.trim()}`);
    cb(watts, null);
  });
}

module.exports = {
  name: 'nvidia-smi (NVIDIA GPU)',

  test(cb) {
    query((watts, errMsg) => {
      if (watts !== null) cb({ ok: true, watts });
      else cb({ ok: false, reason: errMsg });
    });
  },

  sample(cb) {
    query((watts) => cb(watts));
  }
};
