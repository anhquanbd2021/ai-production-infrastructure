import { createGateway, GATEWAY_NODES, MODEL_NODES } from './gateway.mjs';
import { MODELS } from './models.mjs';
import { KEYS } from './keys.mjs';
import { SCENARIOS, TASKS } from './scenarios.mjs';

const $ = (id) => document.getElementById(id);

const gateway = createGateway({
  models: MODELS.map((m) => ({ ...m })),
  keys: KEYS,
});

const keySel = $('key');
const scenarioSel = $('scenario');
const taskSel = $('task');
const promptBox = $('prompt');

for (const k of gateway.keys) keySel.add(new Option(k.label, k.id));
for (const s of SCENARIOS) scenarioSel.add(new Option(s.label, s.id));
for (const t of TASKS) taskSel.add(new Option(t.label, t.id));

function loadScenario(id) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) return;
  taskSel.value = s.task;
  promptBox.value = s.prompt;
}
scenarioSel.addEventListener('change', () => loadScenario(scenarioSel.value));
loadScenario(SCENARIOS[0].id);

$('standard-down').addEventListener('change', (e) => {
  gateway.setAvailable('standard-1', !e.target.checked);
});

const NODE_LABELS = {
  'authenticate': 'AUTHENTICATE',
  'rate-limit': 'RATE LIMIT',
  'guardrail-in': 'GUARDRAIL (in)',
  'route': 'ROUTE',
  'cache': 'CACHE',
  'budget': 'BUDGET',
  'model': 'MODEL',
  'guardrail-out': 'GUARDRAIL (out)',
  'answer': 'ANSWER',
  'log': 'LOG / TRACE',
};

function fmtUsd(n) {
  return n === 0 ? '$0.00' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function stepDetail(step) {
  switch (step.node) {
    case 'authenticate': return step.ok ? 'key recognized' : 'unknown key — request rejected';
    case 'rate-limit': return `${step.used}/${step.limit} in window`;
    case 'guardrail-in': return step.passed ? 'clean' : `BLOCKED — ${step.rule}`;
    case 'route': return step.model
      ? `${step.task} → ${step.model} (${step.tier})${step.fallback ? ' — fallback, requested tier down' : ''}`
      : 'no tier available';
    case 'cache': return step.hit ? `HIT — serve from memory, $0.00` : `miss — ${step.entries} entries`;
    case 'budget': return step.skipped ? step.skipped
      : step.ok ? `spent ${fmtUsd(step.spent)} + ${fmtUsd(step.projected)} ≤ cap ${fmtUsd(step.cap)}`
      : `DENIED — ${fmtUsd(step.spent)} + ${fmtUsd(step.projected)} > cap ${fmtUsd(step.cap)}`;
    case 'model': return step.skipped ? 'cache served it — no model call'
      : `${step.tokensIn}→${step.tokensOut} tokens · ${fmtUsd(step.costUsd)} · ${step.latencyMs}ms (simulated)`;
    case 'guardrail-out': return step.skipped ? step.skipped
      : step.redactions ? `${step.redactions} rule(s) fired: ${step.rules.join(', ')}` : 'clean';
    case 'answer': return step.cached ? 'served from cache' : step.redacted ? 'answered — output redacted' : 'answered';
    case 'log': return `record written — verdict ${step.verdict}`;
    default: return '';
  }
}

function render(result) {
  const trace = $('trace');
  trace.innerHTML = '';
  result.steps.forEach((step, i) => {
    const li = document.createElement('li');
    if (MODEL_NODES.includes(step.node)) li.classList.add('model');
    if ((step.node === 'guardrail-in' && step.passed === false)
      || (step.node === 'budget' && step.ok === false)
      || (step.node === 'rate-limit' && result.trace.verdict === 'rate-limited')
      || (step.node === 'authenticate' && !step.ok)) li.classList.add('gate-fail');
    if (step.node === 'cache' && step.hit) li.classList.add('cache-hit');
    li.innerHTML = `<span class="node-name">${NODE_LABELS[step.node] ?? step.node}</span> — <span class="node-detail">${stepDetail(step)}</span>`;
    trace.append(li);
    setTimeout(() => li.classList.add('active'), 120 * i);
  });

  const t = result.trace;
  $('m-model').textContent = t.model ? `${t.model}${t.fallback ? ' ⇄' : ''}` : '—';
  $('m-cost').textContent = fmtUsd(t.costUsd) + (t.cacheHit ? ' (cache)' : '');
  $('m-latency').textContent = `${t.latencyMs}ms`;
  $('m-tokens').textContent = t.tokensIn || t.tokensOut ? `${t.tokensIn} / ${t.tokensOut}` : '—';
  $('answer-text').textContent = result.response.text;

  const badge = $('verdict');
  badge.textContent = t.verdict;
  badge.className = 'badge ' + (t.verdict === 'answered' ? 'ok' : 'warn');

  renderLedger();
}

function renderLedger() {
  const body = $('ledger').querySelector('tbody');
  body.innerHTML = '';
  for (const k of gateway.keys) {
    const l = gateway.ledger(k.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.keyId}</td><td>${fmtUsd(l.spent)}</td><td>${fmtUsd(l.cap)}</td><td>${l.rateUsed}/${l.rateLimit}</td>`;
    body.append(tr);
  }
  $('cache-size').textContent = `cache ${gateway.cacheSize}`;

  const logBody = $('log').querySelector('tbody');
  logBody.innerHTML = '';
  for (const t of gateway.trace.slice(-8).reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${t.requestId}</td><td>${t.verdict}</td><td>${t.model ?? '—'}</td><td>${t.cacheHit ? 'hit' : '—'}</td><td>${fmtUsd(t.costUsd)}</td>`;
    logBody.append(tr);
  }
  $('log-count').textContent = `${gateway.trace.length} records`;
}

$('run').addEventListener('click', () => {
  const result = gateway.run({
    keyId: keySel.value,
    task: taskSel.value,
    prompt: promptBox.value,
  });
  render(result);
});

$('burst').addEventListener('click', () => {
  let result;
  for (let i = 0; i < 5; i += 1) {
    result = gateway.run({
      keyId: keySel.value,
      task: taskSel.value,
      prompt: `${promptBox.value} (burst ${i + 1})`,
    });
  }
  render(result);
});

$('reset').addEventListener('click', () => {
  gateway.reset();
  renderLedger();
  $('trace').innerHTML = '';
  $('answer-text').textContent = '—';
  for (const id of ['m-model', 'm-cost', 'm-latency', 'm-tokens']) $(id).textContent = '—';
  $('verdict').textContent = 'Ready';
  $('verdict').className = 'badge';
});

$('run').click();
