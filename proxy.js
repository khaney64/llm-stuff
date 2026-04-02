// proxy.js - Ollama / llama.cpp debug proxy
// Usage: node proxy.js [options]
//   --filter-thinking    suppress thinking chunks from log output entirely
//   --buffer-thinking    buffer and reassemble thinking into larger chunks (default)
//   --raw                show every raw chunk as-is (original behavior)
//   --dump-messages      print full messages array for each request
//   --dump-request       print full transformed request body (params + all messages)
//   --message-size N     max chars per message preview (default 300, 0 = no limit)
//   --default-ctx N      fallback context size for pressure calc (default: none)
//   --thinking           inject think:true into requests (default: injects think:false)
//   --log-file [path]    append [done] lines to file (default: ./proxy-done.log)
//   --backend ollama|llamacpp   force backend mode (default: auto-detect from port)
//   --power              enable GPU power monitoring and energy cost tracking
//   --power-provider P   path to power provider module (default: ./power-nvidia-smi.js)
//   --electric-rate N    electricity rate in $/kWh (default: 0.18947)
//   --gpu-idle N         GPU idle watts to subtract for incremental cost (default: 0)
//   --power-interval N   power sampling interval in ms (default: 1000)
//
// Port config:
//   Ollama mode:    PROXY_PORT=11434, BACKEND_PORT=11435
//   llama.cpp mode: PROXY_PORT=8080,  BACKEND_PORT=8081
//   Override with --proxy-port N and --backend-port N

const http = require('http');
const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function argVal(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

const FILTER_THINKING = args.includes('--filter-thinking');
const RAW_MODE        = args.includes('--raw');
const DUMP_MESSAGES   = args.includes('--dump-messages');
const DUMP_REQUEST    = args.includes('--dump-request');
const MESSAGE_SIZE    = argVal('--message-size') != null ? parseInt(argVal('--message-size'), 10) : 300;
const DEFAULT_CTX     = argVal('--default-ctx')  != null ? parseInt(argVal('--default-ctx'),  10) : null;
const INJECT_THINKING = args.includes('--thinking');
const DEBUG_LABELS    = args.includes('--debug-labels');
const LOG_FILE        = argVal('--log-file') ?? (args.includes('--log-file') ? './proxy-done.log' : null);
const BACKEND_ARG     = argVal('--backend'); // 'ollama' | 'llamacpp' | null

// Power monitoring
const POWER_ENABLED    = args.includes('--power');
const POWER_PROVIDER_PATH = argVal('--power-provider') || './power-nvidia-smi.js';
const ELECTRIC_RATE    = argVal('--electric-rate') != null ? parseFloat(argVal('--electric-rate')) : 0.18947;
const GPU_IDLE         = argVal('--gpu-idle')      != null ? parseFloat(argVal('--gpu-idle'))      : 0;
const POWER_INTERVAL   = argVal('--power-interval') != null ? parseInt(argVal('--power-interval'), 10) : 1000;

let powerProvider = null;
if (POWER_ENABLED) {
  try { powerProvider = require(path.resolve(POWER_PROVIDER_PATH)); }
  catch (e) { console.error(`⚠ Power provider not found: ${POWER_PROVIDER_PATH} (${e.message})`); }
}

// Port overrides
const PROXY_PORT_ARG   = argVal('--proxy-port')   ? parseInt(argVal('--proxy-port'),   10) : null;
const BACKEND_PORT_ARG = argVal('--backend-port') ? parseInt(argVal('--backend-port'), 10) : null;

// Detect backend: explicit arg > port heuristic (needed before port defaults)
// We do a preliminary check on BACKEND_ARG and PROXY_PORT_ARG to set defaults
const IS_LLAMACPP_ARG = BACKEND_ARG === 'llamacpp';
const IS_OLLAMA_ARG   = BACKEND_ARG === 'ollama';

// Default ports depend on backend:
//   llama.cpp: proxy=8080, backend=8081
//   ollama:    proxy=11434, backend=11435
const DEFAULT_PROXY_PORT   = PROXY_PORT_ARG   ?? (IS_LLAMACPP_ARG ? 8080  : 11434);
const DEFAULT_BACKEND_PORT = BACKEND_PORT_ARG ?? (IS_LLAMACPP_ARG ? 8081  : 11435);

const PROXY_PORT   = PROXY_PORT_ARG   ?? DEFAULT_PROXY_PORT;
const BACKEND_PORT = BACKEND_PORT_ARG ?? DEFAULT_BACKEND_PORT;

// Final backend determination: explicit arg > port heuristic
const IS_LLAMACPP = IS_LLAMACPP_ARG || (!BACKEND_ARG && PROXY_PORT === 8080);
const IS_OLLAMA   = !IS_LLAMACPP; // derived

const BUFFER_THINKING = !FILTER_THINKING && !RAW_MODE;

// ── ANSI colors ───────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  cyan:    '\x1b[36m',
  yellow:  '\x1b[33m',
  green:   '\x1b[32m',
  gray:    '\x1b[90m',
  magenta: '\x1b[35m',
  red:     '\x1b[31m',
  blue:    '\x1b[34m',
};

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

function logDoneLine(line) {
  if (!LOG_FILE) return;
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${stripAnsi(line)}\n`);
}

function modeLabel() {
  const parts = [];
  const backendTag = IS_LLAMACPP ? `${C.cyan}llama.cpp${C.reset}` : `${C.yellow}ollama${C.reset}`;
  parts.push(backendTag);
  if (FILTER_THINKING)  parts.push(`${C.yellow}filter-thinking${C.reset}`);
  else if (RAW_MODE)    parts.push(`${C.gray}raw${C.reset}`);
  else                  parts.push(`${C.magenta}buffer-thinking${C.reset}`);
  if (DUMP_MESSAGES)    parts.push(`${C.cyan}dump-messages${C.reset}`);
  parts.push(INJECT_THINKING ? `${C.green}think:true${C.reset}` : `${C.red}think:false${C.reset}`);
  if (DEBUG_LABELS) parts.push(`${C.yellow}debug-labels${C.reset}`);
  if (LOG_FILE) parts.push(`${C.green}log-file${C.reset}`);
  if (powerProvider) parts.push(`${C.blue}power${C.reset}`);
  return `[${parts.join(' + ')}]`;
}

// ── Session tracking ──────────────────────────────────────────────────────────
const sessions    = new Map();
const SESSION_GAP = 60000;

function getSession(label, requestStart) {
  let s = sessions.get(label);
  if (!s || (s.lastDoneTime && (requestStart || Date.now()) - s.lastDoneTime > SESSION_GAP)) {
    s = { sessionStart: requestStart || Date.now(), lastDoneTime: 0, sessionGen: 0, sessionPrompt: 0, requestCount: 0, sessionEnergyWh: 0, sessionCost: 0 };
    sessions.set(label, s);
  }
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.lastDoneTime > 5 * 60 * 1000) sessions.delete(k);
}, 5 * 60 * 1000).unref();

// ── Power tracker ────────────────────────────────────────────────────────────
function createPowerTracker(provider) {
  const samples = [];
  let interval = null;
  let startTime = null;
  let stopTime = null;
  let stopped = false;

  function takeSample() {
    provider.sample((watts) => { if (watts !== null) samples.push(watts); });
  }

  return {
    start() {
      startTime = Date.now();
      takeSample();
      interval = setInterval(takeSample, POWER_INTERVAL);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (interval) { clearInterval(interval); interval = null; }
      stopTime = Date.now();
      takeSample();
    },
    summary() {
      const durationSec = ((stopTime || Date.now()) - (startTime || Date.now())) / 1000;
      if (!samples.length) return null;
      const avgWatts  = samples.reduce((a, b) => a + b, 0) / samples.length;
      const peakWatts = Math.max(...samples);
      const energyWh  = avgWatts * durationSec / 3600;
      const incrWatts = Math.max(0, avgWatts - GPU_IDLE);
      const incrWh    = incrWatts * durationSec / 3600;
      return {
        avgWatts:  Math.round(avgWatts * 10) / 10,
        peakWatts: Math.round(peakWatts * 10) / 10,
        sampleCount: samples.length,
        durationSec: Math.round(durationSec * 100) / 100,
        energyWh:    Math.round(energyWh * 10000) / 10000,
        incrementalWh: Math.round(incrWh * 10000) / 10000,
        costTotal:       energyWh / 1000 * ELECTRIC_RATE,
        costIncremental: incrWh   / 1000 * ELECTRIC_RATE,
      };
    }
  };
}

// ── Thinking buffer flush ─────────────────────────────────────────────────────
function flushThinkingBuffer(buf) {
  if (!buf.length) return;
  console.log(`${C.magenta}<think>${C.reset} ${C.gray}${buf.join('')}${C.reset}`);
}

// ── Request body transform ────────────────────────────────────────────────────
// Translates OpenClaw's Ollama-flavoured fields to what each backend expects.
function transformRequestBody(bodyStr) {
  let p;
  try { p = JSON.parse(bodyStr); } catch { return bodyStr; }

  if (IS_OLLAMA) {
    // Original Ollama behaviour: inject think, ensure num_predict
    p.think = INJECT_THINKING;
    if (!p.options) p.options = {};
    if (p.options.num_predict == null) p.options.num_predict = 8192;

  } else {
    // llama.cpp / OpenAI-compat mode
    // 1. think -> (llama.cpp ignores it, but keep for logging; strip options wrapper)
    p.think = INJECT_THINKING;

    // 2. Ollama options block -> top-level OpenAI fields
    if (p.options) {
      if (p.options.temperature != null && p.temperature == null)
        p.temperature = p.options.temperature;
      if (p.options.num_predict != null && p.max_tokens == null)
        p.max_tokens = p.options.num_predict;
      if (p.options.top_p != null && p.top_p == null)
        p.top_p = p.options.top_p;
      if (p.options.top_k != null && p.top_k == null)
        p.top_k = p.options.top_k;
      // num_ctx ignored at request level for llama.cpp (set at server launch)
      delete p.options;
    }

    // 3. Ensure max_tokens has a sensible default
    if (p.max_tokens == null) p.max_tokens = 8192;

    // 4. num_predict at top level (some OpenClaw versions send it top-level)
    if (p.num_predict != null && p.max_tokens == null) {
      p.max_tokens = p.num_predict;
    }
    delete p.num_predict;
    delete p.num_ctx;
  }

  return JSON.stringify(p);
}

// ── [done] line logger (shared between Ollama and llama.cpp paths) ────────────
function logDone({ jobLabel, modelName, requestStart, prompt, gen, doneReason, durationSec, tokSec, promptTokSec, promptMs, totalMs, numCtx, power }) {
  const elapsed = ((Date.now() - requestStart) / 1000).toFixed(2);
  const session = getSession(jobLabel, requestStart);
  session.lastDoneTime = Date.now();
  session.requestCount += 1;
  if (prompt) session.sessionPrompt += prompt;
  if (gen)    session.sessionGen    += gen;
  if (power)  { session.sessionEnergyWh += power.energyWh; session.sessionCost += power.costTotal; }
  const sessionElapsed = ((Date.now() - session.sessionStart) / 1000).toFixed(2);

  let pressurePart = '';
  if (numCtx && prompt) {
    const pct = (prompt / numCtx) * 100;
    const [label, color] =
      pct > 100 ? ['OVER LIMIT', C.red] :
      pct > 90  ? ['HIGH',       C.yellow] :
      pct > 75  ? ['MODERATE',   C.yellow] :
                  ['OK',         C.green];
    pressurePart = ` (${pct.toFixed(1)}% of ${numCtx} ctx) ${color}${label}${C.reset}`;
  }

  const ratio    = prompt && gen ? ((gen / prompt) * 100).toFixed(1) : null;
  const doneColor = doneReason === 'stop' ? C.green : C.yellow;

  // Build timing string — richer for llama.cpp (has promptTokSec), compact for ollama
  let timingStr = '';
  if (promptTokSec && tokSec) {
    timingStr = ` pp=${promptTokSec}tok/s(${promptMs}ms) tg=${tokSec}tok/s(${durationSec}s)${totalMs ? ` total=${totalMs}s` : ''}`;
  } else if (tokSec) {
    timingStr = ` tok/s=${tokSec}${durationSec ? ` duration=${durationSec}s` : ''}`;
  }

  // Build power/energy string
  let powerStr = '';
  let powerStrPlain = '';
  if (power) {
    const incrPart = GPU_IDLE ? `(+${(power.avgWatts - GPU_IDLE).toFixed(1)}W) ` : '';
    const incrWhPart = GPU_IDLE ? `(+${power.incrementalWh}Wh)` : '';
    const costStr = `$${power.costTotal.toFixed(6)}`;
    const incrCostPart = GPU_IDLE ? `(+$${power.costIncremental.toFixed(6)})` : '';
    powerStr = ` ${C.blue}gpu=${power.avgWatts}W${incrPart}peak=${power.peakWatts}W ${power.energyWh}Wh${incrWhPart} ${costStr}${incrCostPart} (${power.sampleCount}samples)${C.reset}`;
    powerStrPlain = ` gpu=${power.avgWatts}W${incrPart}peak=${power.peakWatts}W ${power.energyWh}Wh${incrWhPart} ${costStr}${incrCostPart} (${power.sampleCount}samples)`;
  }

  const sessionEnergyPart = session.sessionEnergyWh > 0
    ? ` energy=${session.sessionEnergyWh.toFixed(4)}Wh cost=$${session.sessionCost.toFixed(6)}`
    : '';
  const sessionPart = ` ${C.yellow}session: prompt=${session.sessionPrompt} gen=${session.sessionGen} elapsed=${sessionElapsed}s${sessionEnergyPart}${C.reset}`;

  const line =
    `${C.gray}[done]${jobLabel}${modelName ? ` ${C.cyan}${modelName}${C.reset}` : ''} ` +
    `${doneColor}reason=${doneReason}${C.reset} ` +
    `${C.gray}prompt=${prompt ?? '?'}${C.reset}${pressurePart} ` +
    `${C.gray}gen=${gen ?? '?'}${ratio ? ` ratio=${ratio}%` : ''}` +
    `${timingStr} elapsed=${elapsed}s${C.reset}` +
    powerStr +
    sessionPart;

  console.log(line);
  logDoneLine(
    `[done]${jobLabel}${modelName ? ` ${modelName}` : ''} reason=${doneReason} ` +
    `prompt=${prompt ?? '?'}${numCtx && prompt ? ` (${((prompt/numCtx)*100).toFixed(1)}% of ${numCtx} ctx)` : ''} ` +
    `gen=${gen ?? '?'}${ratio ? ` ratio=${ratio}%` : ''}` +
    `${stripAnsi(timingStr)} elapsed=${elapsed}s` +
    `${powerStrPlain} ` +
    `session: prompt=${session.sessionPrompt} gen=${session.sessionGen} elapsed=${sessionElapsed}s${sessionEnergyPart}`
  );
}

// ── SSE / llama.cpp response handler ─────────────────────────────────────────
function handleLlamaCppStream(proxyRes, res, { requestStart, jobLabel, numCtx, powerTracker }) {
  let rawBuf      = '';
  let thinkingBuf = [];
  let contentBuf  = [];
  let flushTimer  = null;
  let doneLogged  = false;
  // Tool call accumulator: map of index -> {name, arguments}
  const toolCallBufs = new Map();

  // Accumulate content and flush on natural boundaries
  function scheduleContentFlush(token) {
    contentBuf.push(token);
    const text = contentBuf.join('');
    const shouldFlush =
      text.endsWith('.') || text.endsWith('!') || text.endsWith('?') ||
      text.endsWith(':')  || text.endsWith('\n') || contentBuf.length > 20;
    if (shouldFlush) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      console.log(`${C.green}<content>${C.reset} ${text}`);
      contentBuf = [];
    } else {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (contentBuf.length) {
          console.log(`${C.green}<content>${C.reset} ${contentBuf.join('')}`);
          contentBuf = [];
        }
        flushTimer = null;
      }, 300);
    }
  }

  proxyRes.on('data', chunk => {
    res.write(chunk); // always forward unmodified

    if (RAW_MODE) {
      console.log(chunk.toString());
      return;
    }

    rawBuf += chunk.toString();
    const lines = rawBuf.split('\n');
    rawBuf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // SSE format: strip "data: " prefix
      const dataStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
      if (dataStr === '[DONE]') continue;

      let json;
      try { json = JSON.parse(dataStr); }
      catch { console.log(`${C.gray}(unparseable) ${trimmed}${C.reset}`); continue; }

      // Extract content from OpenAI-compat delta
      const delta        = json.choices?.[0]?.delta ?? {};
      const contentToken = delta.content ?? '';
      const finishReason = json.choices?.[0]?.finish_reason;

      // llama.cpp puts thinking tokens in delta.reasoning_content (some builds)
      // or inside <think>...</think> in content itself — handle both
      const thinkToken = delta.reasoning_content ?? '';

      if (thinkToken) {
        if (!FILTER_THINKING) {
          if (contentBuf.length) {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            console.log(`${C.green}<content>${C.reset} ${contentBuf.join('')}`);
            contentBuf = [];
          }
          thinkingBuf.push(thinkToken);
        }
      }

      if (contentToken) {
        if (thinkingBuf.length) { flushThinkingBuffer(thinkingBuf); thinkingBuf = []; }
        scheduleContentFlush(contentToken);
      }

      // Tool calls — accumulate streamed fragments by index, flush on finish
      const toolCallChunks = delta.tool_calls;
      if (toolCallChunks?.length) {
        for (const tc of toolCallChunks) {
          const idx = tc.index ?? 0;
          if (!toolCallBufs.has(idx)) toolCallBufs.set(idx, { name: '', arguments: '' });
          const buf = toolCallBufs.get(idx);
          if (tc.function?.name)      buf.name      += tc.function.name;
          if (tc.function?.arguments) buf.arguments += tc.function.arguments;
        }
      }

      // Done — llama.cpp sends finish_reason on last chunk, then [DONE]
      if (finishReason && !doneLogged) {
        doneLogged = true;
        if (thinkingBuf.length) { flushThinkingBuffer(thinkingBuf); thinkingBuf = []; }
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (contentBuf.length) {
          console.log(`${C.green}<content>${C.reset} ${contentBuf.join('')}`);
          contentBuf = [];
        }
        // Flush all accumulated tool calls
        if (toolCallBufs.size) {
          for (const [, tc] of [...toolCallBufs.entries()].sort(([a], [b]) => a - b)) {
            console.log(`${C.cyan}<tool_call>${C.reset} ${C.yellow}${tc.name || '(unknown)'}${C.reset}`);
            if (tc.arguments) {
              try { console.log(`${C.gray}${JSON.stringify(JSON.parse(tc.arguments), null, 2)}${C.reset}`); }
              catch { console.log(`${C.gray}${tc.arguments}${C.reset}`); }
            }
          }
          toolCallBufs.clear();
        }

        // llama.cpp puts timing in the final chunk's `timings` field
        const t = json.timings ?? {};
        const prompt        = t.prompt_n            ?? null;
        const gen           = t.predicted_n         ?? null;
        const promptTokSec  = t.prompt_per_second   ? t.prompt_per_second.toFixed(1)   : null;
        const tokSec        = t.predicted_per_second ? t.predicted_per_second.toFixed(1) : null;
        const promptMs      = t.prompt_ms           ? t.prompt_ms.toFixed(0)           : null;
        const durationSec   = t.predicted_ms        ? (t.predicted_ms / 1000).toFixed(2) : null;
        const totalMs       = (t.prompt_ms && t.predicted_ms) ? ((t.prompt_ms + t.predicted_ms) / 1000).toFixed(2) : null;
        const modelName     = json.model ?? '';

        if (powerTracker) powerTracker.stop();
        const power = powerTracker ? powerTracker.summary() : null;
        logDone({ jobLabel, modelName, requestStart, prompt, gen, doneReason: finishReason,
                  durationSec, tokSec, promptTokSec, promptMs, totalMs, numCtx, power });
      }
    }
  });

  proxyRes.on('end', () => {
    if (rawBuf.trim() && !RAW_MODE) {
      // process any leftover line
      const dataStr = rawBuf.trim().startsWith('data: ') ? rawBuf.trim().slice(6) : rawBuf.trim();
      if (dataStr && dataStr !== '[DONE]') {
        try {
          const json = JSON.parse(dataStr);
          const delta = json.choices?.[0]?.delta ?? {};
          if (delta.content) contentBuf.push(delta.content);
        } catch {}
      }
    }
    if (!RAW_MODE) {
      if (thinkingBuf.length) flushThinkingBuffer(thinkingBuf);
      if (flushTimer) clearTimeout(flushTimer);
      if (contentBuf.length) console.log(`${C.green}<content>${C.reset} ${contentBuf.join('')}`);
    }
    if (powerTracker) powerTracker.stop(); // safety: ensure interval is cleared
    console.log(`${C.cyan}<== [stream end]${C.reset}`);
    res.end();
  });
}

// ── NDJSON / Ollama response handler (original logic) ─────────────────────────
function handleOllamaStream(proxyRes, res, { requestStart, jobLabel, numCtx, powerTracker }) {
  let rawBuf      = '';
  let thinkingBuf = [];
  let contentBuf  = [];
  let flushTimer  = null;
  let doneLogged  = false;

  function scheduleContentFlush(token) {
    contentBuf.push(token);
    const text = contentBuf.join('');
    const shouldFlush =
      text.endsWith('.') || text.endsWith('!') || text.endsWith('?') ||
      text.endsWith(':')  || text.endsWith('\n') || contentBuf.length > 20;
    if (shouldFlush) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      console.log(`${C.green}<content>${C.reset} ${text}`);
      contentBuf = [];
    } else {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (contentBuf.length) {
          console.log(`${C.green}<content>${C.reset} ${contentBuf.join('')}`);
          contentBuf = [];
        }
        flushTimer = null;
      }, 300);
    }
  }

  proxyRes.on('data', chunk => {
    res.write(chunk);

    if (RAW_MODE) {
      const str = chunk.toString();
      try { console.log(JSON.stringify(JSON.parse(str), null, 2)); }
      catch { console.log(str); }
      return;
    }

    rawBuf += chunk.toString();
    const lines = rawBuf.split('\n');
    rawBuf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let json;
      try { json = JSON.parse(trimmed); }
      catch { console.log(`${C.gray}(unparseable) ${trimmed}${C.reset}`); continue; }

      const thinkToken   = json.message?.thinking ?? '';
      const contentToken = json.message?.content  ?? '';
      const done         = json.done;

      if (thinkToken) {
        if (!FILTER_THINKING) {
          if (contentBuf.length) {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            console.log(`${C.green}<content>${C.reset} ${contentBuf.join('')}`);
            contentBuf = [];
          }
          thinkingBuf.push(thinkToken);
        }
      }

      if (contentToken) {
        if (thinkingBuf.length) { flushThinkingBuffer(thinkingBuf); thinkingBuf = []; }
        scheduleContentFlush(contentToken);
      }

      const toolCalls = json.message?.tool_calls;
      if (toolCalls?.length) {
        if (contentBuf.length) {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          console.log(`${C.green}<content>${C.reset} ${contentBuf.join('')}`);
          contentBuf = [];
        }
        for (const tc of toolCalls) {
          const name = tc.function?.name ?? '(unknown)';
          const tcArgs = JSON.stringify(tc.function?.arguments ?? {}, null, 2);
          console.log(`${C.cyan}<tool_call>${C.reset} ${C.yellow}${name}${C.reset}`);
          console.log(`${C.gray}${tcArgs}${C.reset}`);
        }
      }

      if (done && !doneLogged) {
        doneLogged = true;
        if (thinkingBuf.length) { flushThinkingBuffer(thinkingBuf); thinkingBuf = []; }
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (contentBuf.length) {
          console.log(`${C.green}<content>${C.reset} ${contentBuf.join('')}`);
          contentBuf = [];
        }

        const prompt      = json.prompt_eval_count ?? null;
        const gen         = json.eval_count ?? null;
        const tokSec      = json.eval_duration ? (gen / (json.eval_duration / 1e9)).toFixed(1) : null;
        const durationSec = json.total_duration ? (json.total_duration / 1e9).toFixed(2) : null;
        const doneReason  = json.done_reason ?? 'stop';
        const modelName   = json.model ?? '';

        if (powerTracker) powerTracker.stop();
        const power = powerTracker ? powerTracker.summary() : null;
        logDone({ jobLabel, modelName, requestStart, prompt, gen, doneReason, durationSec, tokSec, numCtx, power });
      }
    }
  });

  proxyRes.on('end', () => {
    if (rawBuf.trim() && !RAW_MODE) {
      try {
        const json = JSON.parse(rawBuf.trim());
        if (json.message?.thinking && !FILTER_THINKING) thinkingBuf.push(json.message.thinking);
        if (json.message?.content) contentBuf.push(json.message.content);
      } catch {}
    }
    if (!RAW_MODE) {
      if (thinkingBuf.length) flushThinkingBuffer(thinkingBuf);
      if (flushTimer) clearTimeout(flushTimer);
      if (contentBuf.length) console.log(`${C.green}<content>${C.reset} ${contentBuf.join('')}`);
    }
    if (powerTracker) powerTracker.stop(); // safety: ensure interval is cleared
    console.log(`${C.cyan}<== [stream end]${C.reset}`);
    res.end();
  });
}

// ── Main proxy server ─────────────────────────────────────────────────────────
const proxy = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {

    body = transformRequestBody(body);

    let numCtx       = DEFAULT_CTX;
    let jobLabel     = '';
    const requestStart = Date.now();

    console.log(`\n${C.cyan}==> ${req.method} ${req.url}${C.reset}`);
    try {
      const parsed = JSON.parse(body);

      // numCtx: for llama.cpp use max_tokens as proxy; for ollama use options.num_ctx
      numCtx = IS_LLAMACPP
        ? (DEFAULT_CTX || 4096)
        : (parsed.options?.num_ctx || DEFAULT_CTX || 4096);

      const summary = {
        model:       parsed.model,
        stream:      parsed.stream,
        think:       parsed.think ?? '(not set)',
        temperature: IS_LLAMACPP
          ? (parsed.temperature ?? '(not set)')
          : (parsed.options?.temperature ?? '(not set)'),
        max_tokens:  IS_LLAMACPP
          ? (parsed.max_tokens ?? '(not set)')
          : (parsed.options?.num_predict ?? '(not set)'),
        messages: parsed.messages
          ? `[${parsed.messages.length} messages, last role: ${parsed.messages.at(-1)?.role}]`
          : undefined,
      };
      console.log(JSON.stringify(summary, null, 2));

      // --dump-request: print full transformed request body with complete message content
      if (DUMP_REQUEST) {
        const dumpBody = JSON.parse(body);
        // Pretty print with message content limited by MESSAGE_SIZE
        if (dumpBody.messages && MESSAGE_SIZE > 0) {
          dumpBody.messages = dumpBody.messages.map(m => ({
            ...m,
            content: typeof m.content === 'string' && m.content.length > MESSAGE_SIZE
              ? m.content.slice(0, MESSAGE_SIZE) + `... [+${m.content.length - MESSAGE_SIZE} chars]`
              : m.content,
          }));
        }
        console.log(`${C.yellow}--- full request ---${C.reset}`);
        console.log(JSON.stringify(dumpBody, null, 2));
        console.log(`${C.yellow}--- end request ---${C.reset}`);
      }

      try {
        if (parsed.messages) {
          const firstUser = parsed.messages.find(m => m.role === 'user');
        if (firstUser) {
          // content may be string, array, or null
          const content = typeof firstUser.content === 'string'
            ? firstUser.content
            : Array.isArray(firstUser.content)
              ? firstUser.content.map(p => p.text ?? '').join(' ')
              : '';
          if (DEBUG_LABELS) console.log(`${C.yellow}[debug-labels]${C.reset}\n${content.slice(0, 500)}`);
          const cronMatch    = content.match(/\[cron:[^\s]+ ([^\]]+)\]/);
          const agentMatch   = content.match(/\[agent:[^\s]+ ([^\]]+)\]/);
          const sessionMatch = content.match(/\[session:[^\s]+ ([^\]]+)\]/);
          if (cronMatch)         jobLabel = ` job=${cronMatch[1]}`;
          else if (agentMatch)   jobLabel = ` agent=${agentMatch[1]}`;
          else if (sessionMatch) jobLabel = ` session=${sessionMatch[1]}`;
          else                   jobLabel = ' session=chat';
        }
      }

      if (DUMP_MESSAGES && parsed.messages) {
        console.log(`${C.cyan}--- messages ---${C.reset}`);
        for (const [i, msg] of parsed.messages.entries()) {
          // content can be: string | array of {type,text} | null (tool calls)
          let raw;
          if (msg.content == null) {
            raw = '(null)';
          } else if (typeof msg.content === 'string') {
            raw = msg.content;
          } else if (Array.isArray(msg.content)) {
            // OpenAI multipart: extract text parts
            raw = msg.content
              .map(p => p.type === 'text' ? p.text : `[${p.type}]`)
              .join(' ');
          } else {
            raw = JSON.stringify(msg.content);
          }
          const preview = MESSAGE_SIZE === 0 ? raw : raw.slice(0, MESSAGE_SIZE) + (raw.length > MESSAGE_SIZE ? '...' : '');
          console.log(`${C.yellow}[${i}] ${msg.role}${C.reset}: ${preview}`);
          if (msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
              console.log(`  ${C.cyan}tool_call: ${C.yellow}${tc.function?.name ?? '(unknown)'}${C.reset}`);
              const args = tc.function?.arguments;
              if (args) {
                try { console.log(`  ${C.gray}${JSON.stringify(JSON.parse(args), null, 2)}${C.reset}`); }
                catch { console.log(`  ${C.gray}${args}${C.reset}`); }
              }
            }
          }
          // tool result messages
          if (msg.role === 'tool') {
            console.log(`  ${C.gray}tool_call_id: ${msg.tool_call_id ?? '?'}${C.reset}`);
          }
        }
        console.log(`${C.cyan}--- end messages ---${C.reset}`);
        }
      } catch (innerErr) {
        console.log(`${C.red}(message parse error: ${innerErr.message})${C.reset}`);
      }
    } catch {
      if (RAW_MODE && body) console.log(body);
      else console.log(`${C.red}(request body is not JSON)${C.reset}`);
    }

    const options = {
      hostname: 'localhost',
      port:     BACKEND_PORT,
      path:     req.url,
      method:   req.method,
      headers:  { ...req.headers, host: `localhost:${BACKEND_PORT}`, 'content-length': Buffer.byteLength(body) },
    };

    const proxyReq = http.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      console.log(`${C.green}<== Status: ${proxyRes.statusCode}${C.reset}`);

      const powerTracker = powerProvider ? createPowerTracker(powerProvider) : null;
      if (powerTracker) powerTracker.start();
      const ctx = { requestStart, jobLabel, numCtx, powerTracker };
      if (IS_LLAMACPP) {
        handleLlamaCppStream(proxyRes, res, ctx);
      } else {
        handleOllamaStream(proxyRes, res, ctx);
      }
    });

    proxyReq.on('error', e => {
      console.error(`${C.red}Proxy error: ${e.message}${C.reset}`);
      res.writeHead(502);
      res.end('Proxy error: ' + e.message);
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

proxy.listen(PROXY_PORT, () => {
  const backendName = IS_LLAMACPP ? 'llama.cpp' : 'Ollama';
  console.log(`\nDebug proxy ${modeLabel()}`);
  console.log(`Listening on :${PROXY_PORT}  ->  ${backendName} :${BACKEND_PORT}\n`);
  console.log('Options:');
  console.log('  --backend ollama|llamacpp   force backend mode (default: auto from port)');
  console.log('  --proxy-port N              proxy listen port (default: 11434)');
  console.log('  --backend-port N            backend port (default: 11435)');
  console.log('  --filter-thinking           hide thinking chunks entirely');
  console.log('  --buffer-thinking           reassemble thinking into blocks (default)');
  console.log('  --raw                       show every raw chunk');
  console.log('  --dump-messages             print full messages array');
  console.log('  --dump-request              print full transformed request body');
  console.log('  --message-size N            max chars per message preview (default 300)');
  console.log('  --default-ctx N             fallback context size for pressure calc');
  console.log('  --thinking                  inject think:true (default: think:false)');
  console.log('  --debug-labels              dump first user message for label tuning');
  console.log('  --log-file [path]           append [done] lines to file');
  console.log('  --power                     enable GPU power monitoring');
  console.log('  --power-provider P          power provider module (default: ./power-nvidia-smi.js)');
  console.log('  --electric-rate N           electricity rate in $/kWh (default: 0.18947)');
  console.log('  --gpu-idle N                GPU idle watts to subtract (default: 0)');
  console.log('  --power-interval N          sampling interval in ms (default: 1000)\n');
  if (LOG_FILE) console.log(`Log file: ${path.resolve(LOG_FILE)}`);
  if (powerProvider) {
    powerProvider.test((result) => {
      if (result.ok) {
        console.log(`Power: ${powerProvider.name} — current ${result.watts}W | rate $${ELECTRIC_RATE}/kWh | idle baseline ${GPU_IDLE}W | poll ${POWER_INTERVAL}ms`);
      } else {
        console.error(`Power: ${powerProvider.name} — FAILED: ${result.reason} (power tracking disabled)`);
        powerProvider = null;
      }
    });
  }
});