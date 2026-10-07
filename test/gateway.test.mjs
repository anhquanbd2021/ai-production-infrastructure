import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGateway, GATEWAY_NODES, MODEL_NODES,
  tierForTask, pickModel, estTokens, costUsd,
} from '../public/gateway.mjs';
import { MODELS, TIER_ORDER } from '../public/models.mjs';
import { KEYS } from '../public/keys.mjs';
import { SCENARIOS } from '../public/scenarios.mjs';

const scenario = (id) => SCENARIOS.find((s) => s.id === id);

function fresh() {
  return createGateway({
    models: MODELS.map((m) => ({ ...m })),
    keys: KEYS,
    now: () => 1_700_000_000_000, // fixed clock — deterministic windows
  });
}

test('gateway path has 10 nodes and exactly one touches the model', () => {
  assert.equal(GATEWAY_NODES.length, 10);
  assert.deepEqual(MODEL_NODES, ['model']);
});

test('routing picks the cheapest tier that fits the task', () => {
  const gw = fresh();
  const cls = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('classify-ticket')) });
  assert.equal(cls.trace.model, 'nano-1');
  const ext = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('extract-fields')) });
  assert.equal(ext.trace.model, 'nano-1');
  const sum = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('summarize-thread')) });
  assert.equal(sum.trace.model, 'standard-1');
  const why = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('plan-migration')) });
  assert.equal(why.trace.model, 'pro-1');
});

function pick(s) {
  return { task: s.task, prompt: s.prompt };
}

test('a long prompt bumps the route one tier up', () => {
  const gw = fresh();
  const r = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('long-summarize')) });
  assert.ok(scenario('long-summarize').prompt.length > 600);
  assert.equal(r.trace.requestedTier, 'pro');
  assert.equal(r.trace.model, 'pro-1');
});

test('when a tier is down the gateway falls back — the caller never knows', () => {
  const gw = fresh();
  gw.setAvailable('standard-1', false);
  const r = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('summarize-thread')) });
  assert.equal(r.trace.verdict, 'answered');
  assert.equal(r.trace.model, 'pro-1');
  assert.equal(r.trace.fallback, true);
});

test('when every tier is down the request fails cleanly', () => {
  const gw = fresh();
  for (const m of MODELS) gw.setAvailable(m.id, false);
  const r = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('classify-ticket')) });
  assert.equal(r.trace.verdict, 'unavailable');
  assert.equal(r.trace.costUsd, 0);
});

test('cache hit serves the repeat for $0.00 at fixed low latency', () => {
  const gw = fresh();
  const first = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('classify-ticket')) });
  const second = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('repeat-classify')) });
  assert.equal(scenario('classify-ticket').prompt, scenario('repeat-classify').prompt);
  assert.equal(first.trace.cacheHit, false);
  assert.ok(first.trace.costUsd > 0);
  assert.equal(second.trace.cacheHit, true);
  assert.equal(second.trace.costUsd, 0);
  assert.equal(second.trace.latencyMs, 6);
});

test('input guardrail blocks injection before any spend', () => {
  const gw = fresh();
  const r = gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('injection-attempt')) });
  assert.equal(r.trace.verdict, 'blocked-input');
  assert.equal(r.trace.guardrailIn.passed, false);
  assert.equal(r.trace.model, null);
  assert.equal(r.trace.costUsd, 0);
  assert.equal(gw.spentUsd('gw-demo-batch'), 0);
});

test('input guardrail blocks card-shaped PII', () => {
  const gw = fresh();
  const r = gw.run({ keyId: 'gw-demo-batch', task: 'summarize', prompt: 'Summarize this receipt: card 4111 1111 1111 1111, total $59' });
  assert.equal(r.trace.verdict, 'blocked-input');
});

test('output guardrail redacts a key the input rules never matched', () => {
  const gw = fresh();
  const r = gw.run({ keyId: 'gw-demo-frontend', ...pick(scenario('key-probe')) });
  assert.equal(r.trace.verdict, 'answered');
  assert.equal(r.trace.guardrailIn.passed, true); // input looked clean
  assert.match(r.response.text, /\[REDACTED-KEY\]/);
  assert.doesNotMatch(r.response.text, /sk-demo-7F3K-ALPHA-FAKE/);
  assert.deepEqual(r.trace.guardrailOut.rules, ['api-key']);
});

test('rate limit denies request N+1 inside the window', () => {
  const gw = fresh();
  const sandbox = KEYS.find((k) => k.id === 'gw-demo-sandbox');
  const results = [];
  for (let i = 0; i < sandbox.rateLimit + 2; i += 1) {
    results.push(gw.run({ keyId: 'gw-demo-sandbox', task: 'classify', prompt: `burst ${i}` }));
  }
  assert.ok(results.slice(0, sandbox.rateLimit).every((r) => r.trace.verdict === 'answered'));
  assert.ok(results.slice(sandbox.rateLimit).every((r) => r.trace.verdict === 'rate-limited'));
  assert.equal(results[sandbox.rateLimit].trace.costUsd, 0);
});

test('spend cap denies a request whose projected cost exceeds it', () => {
  const gw = fresh();
  const r = gw.run({ keyId: 'gw-demo-sandbox', ...pick(scenario('plan-migration')) });
  assert.equal(r.trace.verdict, 'over-budget');
  assert.equal(r.trace.model, 'pro-1');
  assert.equal(gw.spentUsd('gw-demo-sandbox'), 0);
  const budget = r.steps.find((s) => s.node === 'budget');
  assert.equal(budget.ok, false);
  assert.ok(budget.spent + budget.projected > budget.cap);
});

test('unknown key is denied at authenticate, still traced', () => {
  const gw = fresh();
  const r = gw.run({ keyId: 'gw-demo-nope', task: 'classify', prompt: 'hello' });
  assert.equal(r.trace.verdict, 'denied');
  assert.equal(r.trace.model, null);
});

test('every request — denied or served — leaves a trace record', () => {
  const gw = fresh();
  gw.run({ keyId: 'gw-demo-nope', task: 'classify', prompt: 'x' });
  gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('injection-attempt')) });
  gw.run({ keyId: 'gw-demo-sandbox', ...pick(scenario('plan-migration')) });
  gw.run({ keyId: 'gw-demo-batch', ...pick(scenario('classify-ticket')) });
  assert.equal(gw.trace.length, 4);
  assert.deepEqual(gw.trace.map((t) => t.verdict),
    ['denied', 'blocked-input', 'over-budget', 'answered']);
  for (const t of gw.trace) {
    assert.ok(t.requestId && t.at && typeof t.costUsd === 'number');
  }
});

test('cost ordering matches the price table — roughly 10x per tier', () => {
  for (let i = 0; i < TIER_ORDER.length - 1; i += 1) {
    const cheap = MODELS.find((m) => m.tier === TIER_ORDER[i]);
    const dear = MODELS.find((m) => m.tier === TIER_ORDER[i + 1]);
    assert.ok(dear.priceInPer1k / cheap.priceInPer1k >= 10);
  }
  const nano = MODELS.find((m) => m.tier === 'nano');
  assert.equal(costUsd(nano, 100, 50), 0.0125);
  const pro = MODELS.find((m) => m.tier === 'pro');
  assert.equal(costUsd(pro, 100, 50), 1.25);
});

test('helpers: estTokens and tierForTask edge cases', () => {
  assert.equal(estTokens('abcd'), 1);
  assert.equal(tierForTask('classify', 'short'), 'nano');
  assert.equal(tierForTask('reason', 'x'.repeat(700)), 'pro'); // already top
  assert.equal(tierForTask('unknown-task', 'hi'), 'standard');
  const { model } = pickModel(MODELS, 'standard');
  assert.equal(model.id, 'standard-1');
});
