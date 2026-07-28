'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.argv.push(
  '--backend', 'llamacpp',
  '--thinking',
  '--cron-parse-patch',
  '--proxy-host', '127.0.0.1',
  '--proxy-port', '8081',
  '--backend-port', '8082',
);
const {
  transformRequestBody,
  deriveLlamaTimingMetrics,
  runtimeConfig,
  compileModelPolicyConfig,
  resolveModelPolicy,
} = require('./proxy.js');

const modelPolicyConfig = compileModelPolicyConfig(require('./proxy-models.json'), 'test config');

function transform(body) {
  return JSON.parse(transformRequestBody(JSON.stringify(body)));
}

function transformWithPolicy(body, detectedModel = null) {
  return JSON.parse(transformRequestBody(JSON.stringify(body), modelPolicyConfig, detectedModel));
}

test('resolves request model, detected model, glob, and safe fallback policies', () => {
  assert.equal(resolveModelPolicy('qwen36-35b', null, modelPolicyConfig).name, 'qwen-reasoning');
  assert.equal(resolveModelPolicy('Qwen3.6-35B-A3B-Q4_K_M.gguf', null, modelPolicyConfig).name, 'qwen-reasoning');
  assert.equal(resolveModelPolicy('qwen3-coder', null, modelPolicyConfig).name, 'qwen-coder');
  assert.equal(resolveModelPolicy('unknown-model', null, modelPolicyConfig).name, 'fallback');

  const detected = transformWithPolicy({ messages: [] }, 'gemma4-31b');
  assert.equal(detected.max_tokens, 8192);
  assert.equal(detected.chat_template_kwargs.enable_thinking, false);
});

test('model policy applies defaults, aliases, and ceilings', () => {
  assert.equal(transformWithPolicy({ model: 'qwen36-35b' }).max_tokens, 16384);
  assert.equal(transformWithPolicy({ model: 'qwen36-35b', max_tokens: 100000 }).max_tokens, 32768);
  assert.equal(transformWithPolicy({ model: 'qwen36-35b', max_completion_tokens: 24000 }).max_tokens, 24000);
  assert.equal(transformWithPolicy({ model: 'qwen36-35b', options: { num_predict: 12000 } }).max_tokens, 12000);
  assert.equal(transformWithPolicy({ model: 'qwen36-35b', max_tokens: 'invalid' }).max_tokens, 16384);
});

test('reasoning policy honors caller thinking controls and budgets', () => {
  const defaults = transformWithPolicy({ model: 'qwen36-35b' });
  assert.equal(defaults.chat_template_kwargs.enable_thinking, true);
  assert.equal(defaults.thinking_budget_tokens, 4096);

  const disabled = transformWithPolicy({
    model: 'qwen36-35b',
    chat_template_kwargs: { enable_thinking: false, thinking_budget_tokens: 7000 },
  });
  assert.equal(disabled.chat_template_kwargs.enable_thinking, false);
  assert.equal('thinking_budget_tokens' in disabled, false);

  const clamped = transformWithPolicy({
    model: 'qwen36-35b',
    chat_template_kwargs: { enable_thinking: true },
    thinking_budget_tokens: 100000,
  });
  assert.equal(clamped.thinking_budget_tokens, 8192);

  assert.equal(transformWithPolicy({ model: 'qwen36-35b', reasoning_effort: 'minimal' })
    .thinking_budget_tokens, 1024);
  assert.equal(transformWithPolicy({ model: 'qwen36-35b', reasoning_effort: 'low' })
    .thinking_budget_tokens, 2048);
  assert.equal(transformWithPolicy({ model: 'qwen36-35b', reasoning_effort: 'medium' })
    .thinking_budget_tokens, 4096);
  assert.equal(transformWithPolicy({ model: 'qwen36-35b', reasoning_effort: 'high' })
    .thinking_budget_tokens, 8192);
});

test('thinking precedence and unsupported-model safety are deterministic', () => {
  const explicit = transformWithPolicy({
    model: 'qwen36-35b',
    think: false,
    reasoning_effort: 'high',
    chat_template_kwargs: { enable_thinking: true },
  });
  assert.equal(explicit.chat_template_kwargs.enable_thinking, true);
  assert.equal(explicit.thinking_budget_tokens, 8192);

  const unsupported = transformWithPolicy({
    model: 'qwen3-coder',
    think: true,
    thinking_budget_tokens: 8192,
  });
  assert.equal(unsupported.chat_template_kwargs.enable_thinking, false);
  assert.equal('thinking_budget_tokens' in unsupported, false);

  const fallback = transformWithPolicy({ model: 'unlisted-model', max_tokens: 50000 });
  assert.equal(fallback.max_tokens, 16384);
  assert.equal(fallback.chat_template_kwargs.enable_thinking, false);
});

test('rejects malformed model policy configuration', () => {
  assert.throws(() => compileModelPolicyConfig({ version: 2, fallback: {}, profiles: [] }));
  assert.throws(() => compileModelPolicyConfig({
    version: 1,
    fallback: {
      max_tokens: { default: 20, ceiling: 10 },
      thinking: { supported: false, default_enabled: false, default_budget: 0, ceiling: 0 },
    },
    profiles: [],
  }));
});

test('defaults and clamps max_tokens', () => {
  for (const [value, expected] of [
    [undefined, 8192],
    [0, 8192],
    [-1, 8192],
    [100000, 8192],
    [2000, 2000],
  ]) {
    const input = value === undefined ? {} : { max_tokens: value };
    assert.equal(transform(input).max_tokens, expected);
  }
});

test('resolves token aliases by precedence and removes translated fields', () => {
  const result = transform({
    max_completion_tokens: 3000,
    options: { num_predict: 4000, temperature: 0.5 },
    num_predict: 5000,
  });
  assert.equal(result.max_tokens, 3000);
  assert.equal(result.temperature, 0.5);
  assert.equal(result.max_completion_tokens, undefined);
  assert.equal(result.num_predict, undefined);
  assert.equal(result.options, undefined);

  assert.equal(transform({ options: { num_predict: 4000 } }).max_tokens, 4000);
  assert.equal(transform({ num_predict: 5000 }).max_tokens, 5000);
});

test('invalid numeric types cannot bypass the ceiling', () => {
  assert.equal(transform({ max_tokens: '1000' }).max_tokens, 8192);
  assert.equal(transform({ max_tokens: 1.9 }).max_tokens, 1);
});

test('sets and clamps llama.cpp thinking_budget_tokens', () => {
  assert.equal(transform({}).thinking_budget_tokens, 8192);
  assert.equal(transform({ thinking_budget_tokens: -1 }).thinking_budget_tokens, 8192);
  assert.equal(transform({ thinking_budget_tokens: 100000 }).thinking_budget_tokens, 8192);
  assert.equal(transform({ thinking_budget_tokens: 2000 }).thinking_budget_tokens, 2000);
});

test('preserves model identifiers for llama-swap and llama.cpp', () => {
  assert.equal(transform({ model: 'qwen36-35b-a3b' }).model, 'qwen36-35b-a3b');
});

test('removes only incompatible OpenClaw cron schema constraints', () => {
  const result = transform({
    tools: [{
      type: 'function',
      function: {
        name: 'cron',
        parameters: {
          properties: {
            job: {
              properties: {
                declarationKey: { type: 'string', pattern: '\\S' },
                trigger: {
                  properties: {
                    script: { type: 'string', maxLength: 65536 },
                  },
                },
              },
            },
          },
        },
      },
    }],
  });

  const job = result.tools[0].function.parameters.properties.job.properties;
  assert.equal(job.declarationKey.pattern, undefined);
  assert.equal(job.declarationKey.type, 'string');
  assert.equal(job.trigger.properties.script.maxLength, undefined);
  assert.equal(job.trigger.properties.script.type, 'string');
});

test('parses internal listen and backend ports', () => {
  assert.deepEqual(runtimeConfig, {
    proxyHost: '127.0.0.1',
    proxyPort: 8081,
    backendPort: 8082,
  });
});

test('preserves generation duration precision for Influx metrics', () => {
  const metrics = deriveLlamaTimingMetrics({
    predicted_ms: 1234.567,
    predicted_per_second: 81.25,
    prompt_ms: 500,
    prompt_per_second: 900,
  }, 100);

  assert.equal(metrics.durationSec, 1.234567);
  assert.equal(metrics.totalSec, 1.734567);
  assert.equal(metrics.tokSec, '81.3');
});

test('omits unreliable generation speed without dropping duration', () => {
  for (const [generatedTokens, predictedMs] of [[1, 10], [2, 0.5]]) {
    const metrics = deriveLlamaTimingMetrics({
      predicted_ms: predictedMs,
      predicted_per_second: 1000000,
    }, generatedTokens);

    assert.equal(metrics.tokSec, null);
    assert.equal(metrics.durationSec, predictedMs / 1000);
  }
});
