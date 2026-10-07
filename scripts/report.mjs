// Side-by-side report: every scenario through the gateway, then a burst and
// a fallback run — the same numbers the article quotes.
import { createGateway } from '../public/gateway.mjs';
import { MODELS } from '../public/models.mjs';
import { KEYS } from '../public/keys.mjs';
import { SCENARIOS } from '../public/scenarios.mjs';

const fmt = (n) => (n === 0 ? '$0.00' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

function fresh() {
  return createGateway({ models: MODELS.map((m) => ({ ...m })), keys: KEYS });
}

console.log('AI Gateway Lab — scenarios through the 10-node path\n');
console.log(
  `${'scenario'.padEnd(34)}${'key'.padEnd(18)}${'model'.padStart(12)}${'cache'.padStart(7)}${'tok i/o'.padStart(10)}${'cost'.padStart(10)}  verdict`,
);

const gw = fresh();
for (const s of SCENARIOS) {
  const keyId = s.id === 'key-probe' ? 'gw-demo-frontend' : 'gw-demo-batch';
  const r = gw.run({ keyId, task: s.task, prompt: s.prompt });
  const t = r.trace;
  console.log(
    `${s.id.padEnd(34)}${keyId.padEnd(18)}${String(t.model ?? '—').padStart(12)}${(t.cacheHit ? 'HIT' : '—').padStart(7)}${`${t.tokensIn}/${t.tokensOut}`.padStart(10)}${fmt(t.costUsd).padStart(10)}  ${t.verdict}`,
  );
}

console.log('\nSpend cap: sandbox key ($0.10/day) tries the pro-tier task');
const gw2 = fresh();
const cap = gw2.run({ keyId: 'gw-demo-sandbox', task: 'reason', prompt: SCENARIOS.find((s) => s.id === 'plan-migration').prompt });
const budgetStep = cap.steps.find((s) => s.node === 'budget');
console.log(`  verdict: ${cap.trace.verdict} — projected ${fmt(budgetStep.projected)} > cap ${fmt(budgetStep.cap)}, denied before spend`);

console.log('\nRate limit: sandbox key (3/min) bursts 5 requests');
const gw3 = fresh();
for (let i = 0; i < 5; i += 1) {
  const r = gw3.run({ keyId: 'gw-demo-sandbox', task: 'classify', prompt: `burst test ${i}` });
  console.log(`  ${r.trace.requestId}: ${r.trace.verdict}`);
}

console.log('\nFallback: standard tier marked down, summarize reroutes');
const gw4 = fresh();
gw4.setAvailable('standard-1', false);
const fb = gw4.run({ keyId: 'gw-demo-batch', task: 'summarize', prompt: SCENARIOS.find((s) => s.id === 'summarize-thread').prompt });
console.log(`  requested standard → served by ${fb.trace.model} (fallback: ${fb.trace.fallback})`);

console.log('\nEvery request — denied or served — left a trace record.');
