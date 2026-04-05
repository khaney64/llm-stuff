// influxdb-client.js - Zero-dependency InfluxDB v2 line protocol writer
// Uses native http/https modules to POST points via the InfluxDB v2 write API.

const http  = require('http');
const https = require('https');
const url   = require('url');

// Line protocol escaping rules
function escapeTag(s) { return String(s).replace(/[,= ]/g, '\\$&'); }
function escapeFieldString(s) { return String(s).replace(/["\\]/g, '\\$&'); }
function escapeMeasurement(s) { return String(s).replace(/[, ]/g, '\\$&'); }

function formatField(key, spec) {
  if (spec.type === 'i') return `${escapeTag(key)}=${Math.round(spec.value)}i`;
  if (spec.type === 's') return `${escapeTag(key)}="${escapeFieldString(spec.value)}"`;
  return `${escapeTag(key)}=${spec.value}`;  // float
}

function formatPoint({ measurement, tags, fields, timestamp }) {
  const tagPairs = Object.entries(tags || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${escapeTag(k)}=${escapeTag(v)}`)
    .join(',');

  const fieldPairs = Object.entries(fields || {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => formatField(k, v))
    .join(',');

  if (!fieldPairs) return null; // InfluxDB requires at least one field

  const ts = timestamp || (Date.now() * 1_000_000); // nanoseconds
  const tagStr = tagPairs ? `,${tagPairs}` : '';
  return `${escapeMeasurement(measurement)}${tagStr} ${fieldPairs} ${ts}`;
}

function createInfluxClient({ url: influxUrl, org, bucket, token }) {
  const parsed = new URL(influxUrl);
  const transport = parsed.protocol === 'https:' ? https : http;
  const writePath = `/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=ns`;

  function writePoints(points) {
    const lines = points.map(formatPoint).filter(Boolean);
    if (lines.length === 0) return Promise.resolve();

    const body = lines.join('\n');

    return new Promise((resolve, reject) => {
      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: writePath,
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 204) resolve();
          else reject(new Error(`InfluxDB ${res.statusCode}: ${data.trim()}`));
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  return { writePoints, formatPoint };
}

module.exports = { createInfluxClient };
