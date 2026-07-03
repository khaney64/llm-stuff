'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.argv.push('--backend', 'llamacpp', '--thinking');
const { transformRequestBody } = require('./proxy.js');

function transform(body) {
  return JSON.parse(transformRequestBody(JSON.stringify(body)));
}

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
