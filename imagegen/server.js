// imagegen/server.js - simple Qwen-Image 2.1 front end for ComfyUI behind llama-swap
// Usage: node imagegen/server.js [options]
//   --host HOST      listen host (default: 0.0.0.0)
//   --port N         listen port (default: 8190)
//   --comfy URL      ComfyUI base URL (default: http://127.0.0.1:8080/comfyui)
//   --output DIR     ComfyUI output directory (default: C:\development\ai\ComfyUI\output)
//
// Serves index.html, turns a prompt plus optional reference images into a fixed
// Qwen-Image 2.1 graph, and queues it through llama-swap's /comfyui/ endpoint so
// ComfyUI is loaded on demand. Results are read straight from the output
// directory, so the gallery works while ComfyUI is unloaded.

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}

const HOST    = arg('--host', '0.0.0.0');
const PORT    = parseInt(arg('--port', '8190'), 10);
const COMFY   = arg('--comfy', 'http://127.0.0.1:8080/comfyui').replace(/\/$/, '');
const OUT_DIR = path.join(arg('--output', 'C:\\development\\ai\\ComfyUI\\output'), 'imggen');
const HISTORY = path.join(OUT_DIR, 'history.jsonl');
const PAGE    = path.join(__dirname, 'index.html');
const MAX_BODY = 200 * 1024 * 1024;

const MODELS = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_int8_convrot.safetensors',
  vae:  'qwen_image_2.1_vae_bf16.safetensors',
};

// prompt_id -> job metadata, until its result is written to history.jsonl
const jobs = new Map();

fs.mkdirSync(OUT_DIR, { recursive: true });

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function comfy(pathname, init) {
  const res = await fetch(COMFY + pathname, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const err = new Error(describeComfyError(res.status, body));
    err.status = res.status;
    throw err;
  }
  return body;
}

function describeComfyError(status, body) {
  if (body && typeof body === 'object') {
    const parts = [];
    if (body.error) parts.push(body.error.message || JSON.stringify(body.error));
    for (const n of Object.values(body.node_errors || {})) {
      for (const e of n.errors || []) parts.push(`${n.class_type}: ${e.message} ${e.details || ''}`.trim());
    }
    if (parts.length) return `ComfyUI ${status}: ${parts.join('; ')}`;
  }
  return `ComfyUI ${status}: ${String(body).slice(0, 300)}`;
}

async function uploadReference(dataUrl) {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('reference image must be a base64 data URL');
  const bytes = Buffer.from(m[2], 'base64');
  const ext = m[1].split('/')[1].replace('jpeg', 'jpg').replace(/\W.*/, '');
  const name = `imggen_${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.${ext}`;
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: m[1] }), name);
  form.append('overwrite', 'true');
  const r = await comfy('/api/upload/image', { method: 'POST', body: form });
  return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
}

function buildGraph({ prompt, refs, width, height, matchFirst, seed, steps }) {
  const g = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.unet, weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, type: 'qwen_image', device: 'default' } },
    vae:  { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
    enc:  { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['clip', 0], prompt, negative_prompt: '', resolution: 1024 } },
  };
  refs.forEach((name, i) => {
    g[`ref${i + 1}`] = { class_type: 'LoadImage', inputs: { image: name } };
    g.enc.inputs[`images.image_${i + 1}`] = [`ref${i + 1}`, 0];
  });
  if (refs.length) g.enc.inputs.vae = ['vae', 0];

  let latent;
  if (refs.length && matchFirst) {
    // the encoder's latent is sized from image_1; any other size shifts the edit
    latent = ['enc', 2];
  } else {
    g.latent = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
    latent = ['latent', 0];
  }
  g.ks = {
    class_type: 'KSampler',
    inputs: {
      model: ['unet', 0], positive: ['enc', 0], negative: ['enc', 1], latent_image: latent,
      seed, steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
    },
  };
  g.dec  = { class_type: 'VAEDecode', inputs: { samples: ['ks', 0], vae: ['vae', 0] } };
  g.save = { class_type: 'SaveImage', inputs: { images: ['dec', 0], filename_prefix: 'imggen/img' } };
  return g;
}

async function handleGenerate(req, res) {
  const body = JSON.parse((await readBody(req)).toString('utf8'));
  const userPrompt = String(body.prompt || '').trim();
  if (!userPrompt) return sendJson(res, 400, { error: 'prompt is required' });

  const refs = Array.isArray(body.images) ? body.images : [];
  const [w, h] = String(body.size || '1024x1024').split('x').map(n => parseInt(n, 10));
  const matchFirst = body.size === 'match';
  const seed = Number.isInteger(body.seed) && body.seed >= 0 ? body.seed : crypto.randomInt(2 ** 47);
  const steps = [25, 40, 50].includes(body.steps) ? body.steps : 25;
  const prompt = body.transparent
    ? `This is an RGBA format image with transparency. ${userPrompt}. The image has an alpha channel and a transparent background.`
    : userPrompt;

  const t0 = Date.now();
  const refNames = [];
  for (const r of refs) refNames.push(await uploadReference(r));
  const graph = buildGraph({
    prompt, refs: refNames, seed, steps, matchFirst,
    width: matchFirst ? 1024 : w || 1024, height: matchFirst ? 1024 : h || 1024,
  });
  const queued = await comfy('/api/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph }),
  });
  const id = queued.prompt_id;
  jobs.set(id, {
    id, prompt: userPrompt, transparent: !!body.transparent, refs: refNames, seed, steps,
    size: matchFirst ? 'match' : `${w}x${h}`, started: t0,
  });
  log(`[queued] ${id} refs=${refNames.length} size=${body.size} seed=${seed} (${Date.now() - t0}ms incl. ComfyUI load)`);
  sendJson(res, 200, { id, seed });
}

async function handleJob(res, id) {
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { error: 'unknown job' });

  const hist = (await comfy(`/api/history/${encodeURIComponent(id)}`))[id];
  if (!hist || !hist.status?.completed && hist.status?.status_str !== 'error') {
    const q = await comfy('/api/queue');
    const running = (q.queue_running || []).some(e => e[1] === id);
    const pending = (q.queue_pending || []).findIndex(e => e[1] === id);
    return sendJson(res, 200, { state: running ? 'running' : 'queued', ahead: pending, elapsed: Date.now() - job.started });
  }

  if (hist.status.status_str === 'error') {
    const msg = (hist.status.messages || []).find(m => m[0] === 'execution_error');
    const error = msg ? `${msg[1].node_type}: ${msg[1].exception_message}` : 'generation failed';
    jobs.delete(id);
    log(`[error] ${id} ${error}`);
    return sendJson(res, 200, { state: 'error', error });
  }

  const files = Object.values(hist.outputs).flatMap(o => o.images || []).map(i => i.filename);
  const record = { ...job, files, seconds: +((Date.now() - job.started) / 1000).toFixed(1), created: new Date().toISOString() };
  delete record.started;
  fs.appendFileSync(HISTORY, JSON.stringify(record) + '\n');
  jobs.delete(id);
  log(`[done] ${id} ${files.join(',')} ${record.seconds}s`);
  sendJson(res, 200, { state: 'done', item: record });
}

function readHistory() {
  if (!fs.existsSync(HISTORY)) return [];
  return fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.files.every(f => fs.existsSync(path.join(OUT_DIR, f))))
    .reverse();
}

function deleteItem(res, name) {
  const file = path.basename(name);
  const lines = fs.existsSync(HISTORY) ? fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean) : [];
  const keep = [];
  let found = null;
  for (const l of lines) {
    let r;
    try { r = JSON.parse(l); } catch { keep.push(l); continue; }
    if (!found && r.files.includes(file)) found = r;
    else keep.push(l);
  }
  if (!found) return sendJson(res, 404, { error: 'image not found' });
  for (const f of found.files) fs.rmSync(path.join(OUT_DIR, path.basename(f)), { force: true });
  fs.writeFileSync(HISTORY, keep.map(l => l + '\n').join(''));
  log(`[deleted] ${found.files.join(',')}`);
  sendJson(res, 200, { deleted: found.files });
}

function serveOutput(res, name) {
  const file = path.join(OUT_DIR, path.basename(name));
  if (!/\.(png|jpe?g|webp)$/i.test(file) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'image/' + path.extname(file).slice(1).replace('jpg', 'jpeg'), 'cache-control': 'max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(PAGE).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') return await handleGenerate(req, res);
    if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) return await handleJob(res, url.pathname.slice(10));
    if (req.method === 'GET' && url.pathname === '/api/gallery') return sendJson(res, 200, readHistory());
    if (req.method === 'GET' && url.pathname.startsWith('/out/')) return serveOutput(res, decodeURIComponent(url.pathname.slice(5)));
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/images/')) return deleteItem(res, decodeURIComponent(url.pathname.slice(12)));
    res.writeHead(404);
    res.end();
  } catch (err) {
    log(`[fail] ${req.method} ${url.pathname}: ${err.message}`);
    if (!res.headersSent) sendJson(res, err.status && err.status < 500 ? 502 : 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => log(`imagegen listening on http://${HOST}:${PORT} -> ${COMFY}, output ${OUT_DIR}`));
