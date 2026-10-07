// AI Gateway Lab — a deterministic, zero-dependency model of an AI gateway:
// the control layer that sits between callers and models. No real model is
// called; token counts, cost, and latency are formulas, which keeps every
// request reproducible and every claim testable.

export const GATEWAY_NODES = [
  'authenticate',
  'rate-limit',
  'guardrail-in',
  'route',
  'cache',
  'budget',
  'model',
  'guardrail-out',
  'answer',
  'log',
];

// The only node that "calls a model" — ten nodes, one touches the model.
export const MODEL_NODES = ['model'];

// Input guardrail rules — checked before any routing spend.
export const INPUT_RULES = [
  { id: 'ignore-instructions', reason: 'prompt-injection',
    pattern: /ignore\s+(all|any)\s+(previous|prior|above)\s+(instructions?|rules?)/i },
  { id: 'disregard-instructions', reason: 'prompt-injection',
    pattern: /disregard\s+(all\s+|any\s+)?(previous\s+|prior\s+)?instructions?/i },
  { id: 'system-prompt-probe', reason: 'system-prompt-probe',
    pattern: /(reveal|print|show|repeat)\s+(me\s+)?(your|the)\s+(system|hidden|developer)\s+(prompt|instructions?)/i },
  { id: 'pii-ssn', reason: 'pii-ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { id: 'pii-card', reason: 'pii-card',
    pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/ },
];

// Output guardrail rules — scan what the model produced, not what the user
// sent. The api-key rule catches the lab's simulated leak; nothing on the
// input list ever matched the prompt that caused it.
export const OUTPUT_RULES = [
  { id: 'api-key', pattern: /sk-demo-[A-Za-z0-9-]+/g, replacement: '[REDACTED-KEY]' },
  { id: 'pii-ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED-SSN]' },
];

// Cheapest tier that can handle the task. In a real gateway this table is
// config + eval data ("nano scores 0.96 on ticket tagging") — not vibes.
export const TASK_TIER = {
  classify: 'nano',
  extract: 'nano',
  summarize: 'standard',
  reason: 'pro',
};

export const TIER_ORDER = ['nano', 'standard', 'pro'];

// Long prompts need a bigger context window than the cheap tier offers —
// input length is a routing signal, not just a line item on the invoice.
export const LONG_PROMPT_CHARS = 600;
export const MAX_PROMPT_CHARS = 4000;

export const CACHE_HIT_LATENCY_MS = 6;
export const BLOCKED_LATENCY_MS = 3;

const TASK_OUT_TOKENS = { classify: 18, extract: 30, summarize: 60, reason: 140 };
const SYSTEM_PROMPT_TOKENS = 12;

export function estTokens(text) {
  return Math.ceil(String(text).length / 4);
}

export function normalizePrompt(prompt) {
  return String(prompt).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function cacheKey(modelId, task, prompt) {
  return `${modelId}|${task}|${normalizePrompt(prompt)}`;
}

export function tierForTask(task, prompt) {
  const base = TASK_TIER[task] ?? 'standard';
  let idx = TIER_ORDER.indexOf(base);
  if (String(prompt).length > LONG_PROMPT_CHARS && idx < TIER_ORDER.length - 1) {
    idx += 1;
  }
  return TIER_ORDER[idx];
}

// Pick the requested tier's model; if it is down, walk up for quality
// first, then down — the gateway's fallback chain, not the caller's problem.
export function pickModel(models, requestedTier) {
  const byTier = (t) => models.find((m) => m.tier === t && m.available !== false);
  const start = TIER_ORDER.indexOf(requestedTier);
  for (let i = start; i < TIER_ORDER.length; i += 1) {
    const m = byTier(TIER_ORDER[i]);
    if (m) return { model: m, requestedTier, fallback: m.tier !== requestedTier };
  }
  for (let i = start - 1; i >= 0; i -= 1) {
    const m = byTier(TIER_ORDER[i]);
    if (m) return { model: m, requestedTier, fallback: true };
  }
  return { model: null, requestedTier, fallback: false };
}

export function costUsd(model, tokensIn, tokensOut) {
  const usd = (tokensIn / 1000) * model.priceInPer1k
    + (tokensOut / 1000) * model.priceOutPer1k;
  return Math.round(usd * 1e6) / 1e6;
}

export function latencyMs(model, tokensOut) {
  return model.baseLatencyMs + tokensOut * model.msPerOutputToken;
}

// Simulated model. Deterministic per task — and it "leaks" a fixture key
// whenever a prompt asks about credentials, so the output guardrail has
// real work to do.
function simulateModel(task, prompt) {
  const bodies = {
    classify: 'Label: billing-dispute. Confidence: 0.94.',
    extract: 'Extracted 3 fields — order: #4821; amount: $59.00; status: shipped.',
    summarize: 'Summary — the customer was promised a 5-7 day refund, it is now day 9, and they want escalation. Next step: expedite and confirm in writing.',
    reason: 'Recommendation: blue-green migration — it costs a parallel environment but caps downtime and makes rollback a routing change, not a restore job.',
  };
  let text = bodies[task] ?? bodies.summarize;
  if (/(api|secret|access|private|upstream)\s+key|what\s+key/i.test(prompt)) {
    text += ' Diagnostic detail: upstream credential sk-demo-7F3K-ALPHA-FAKE.';
  }
  const tokensOut = (TASK_OUT_TOKENS[task] ?? 60) + Math.floor(String(prompt).length / 80);
  return { text, tokensOut };
}

export function createGateway({ models, keys, now = () => Date.now() } = {}) {
  const state = {
    hits: new Map(),        // keyId -> [timestamps]
    cache: new Map(),       // cacheKey -> { text, tokensOut }
    spent: new Map(),       // keyId -> usd
    trace: [],              // every request leaves a record
    seq: 0,
  };

  const keyById = (id) => keys.find((k) => k.id === id);

  function setAvailable(modelId, available) {
    const m = models.find((x) => x.id === modelId);
    if (m) m.available = available;
  }

  function reset() {
    state.hits.clear();
    state.cache.clear();
    state.spent.clear();
    state.trace.length = 0;
    state.seq = 0;
  }

  function run({ keyId, task = 'summarize', prompt = '' } = {}) {
    const t0 = now();
    const steps = [];
    const push = (node, detail) => {
      const step = { node, ...detail };
      steps.push(step);
      return step;
    };
    state.seq += 1;
    const requestId = `req-${state.seq}`;

    const finish = (verdict, response, extra = {}) => {
      const trace = {
        seq: state.seq,
        requestId,
        keyId,
        task,
        promptChars: String(prompt).length,
        model: null,
        tier: null,
        requestedTier: null,
        fallback: false,
        cacheHit: false,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: BLOCKED_LATENCY_MS,
        verdict,
        guardrailIn: { passed: true, rule: null },
        guardrailOut: { redactions: 0, rules: [] },
        at: new Date(t0).toISOString(),
        ...extra,
      };
      push('log', { verdict, trace });
      state.trace.push(trace);
      return { steps, response, trace };
    };

    // 1 — AUTHENTICATE: the gateway, not the app, holds the tenant list.
    const key = keyById(keyId);
    push('authenticate', { key: keyId, ok: Boolean(key) });
    if (!key) {
      return finish('denied', { status: 'denied', text: 'Unknown API key.' });
    }

    // 2 — RATE LIMIT: sliding window per key.
    const hits = (state.hits.get(keyId) ?? []).filter((t) => t0 - t < key.windowMs);
    push('rate-limit', { limit: key.rateLimit, windowMs: key.windowMs, used: hits.length });
    if (hits.length >= key.rateLimit) {
      state.hits.set(keyId, hits);
      return finish('rate-limited', {
        status: 'refused',
        text: `Rate limit: ${key.rateLimit} requests per ${Math.round(key.windowMs / 1000)}s for this key. Slow down or ask for a bigger quota.`,
      });
    }
    hits.push(t0);
    state.hits.set(keyId, hits);

    // 3 — GUARDRAIL-IN: policy before spend.
    const long = String(prompt).length > MAX_PROMPT_CHARS;
    const hitRule = INPUT_RULES.find((r) => r.pattern.test(prompt));
    const inVerdict = long
      ? { passed: false, rule: 'prompt-too-long' }
      : { passed: !hitRule, rule: hitRule ? hitRule.id : null };
    push('guardrail-in', inVerdict);
    if (!inVerdict.passed) {
      return finish('blocked-input', {
        status: 'refused',
        text: `Blocked by input policy (${inVerdict.rule}). The request never reached a model — cost: $0.00.`,
      }, { guardrailIn: inVerdict });
    }

    // 4 — ROUTE: cheapest tier for the task, with a length bump.
    const requestedTier = tierForTask(task, prompt);
    const { model, fallback } = pickModel(models, requestedTier);
    push('route', {
      task,
      requestedTier,
      model: model ? model.id : null,
      tier: model ? model.tier : null,
      fallback,
    });
    if (!model) {
      return finish('unavailable', {
        status: 'refused',
        text: 'No model tier is currently available. The gateway failed the request cleanly instead of hanging a client on a dead provider.',
      }, { requestedTier });
    }

    // 5 — CACHE: identical (model, task, prompt) served from memory.
    const ck = cacheKey(model.id, task, prompt);
    const cached = state.cache.get(ck);
    push('cache', { key: ck.slice(0, 60), hit: Boolean(cached), entries: state.cache.size });
    if (cached) {
      const trace = {
        model: model.id, tier: model.tier, requestedTier, fallback,
        cacheHit: true, tokensIn: estTokens(prompt) + SYSTEM_PROMPT_TOKENS,
        tokensOut: cached.tokensOut, costUsd: 0, latencyMs: CACHE_HIT_LATENCY_MS,
      };
      const response = { status: 'answered', text: cached.text, redactions: 0, cached: true };
      push('budget', { skipped: 'cache hit — no spend' });
      push('model', { model: model.id, skipped: true });
      push('guardrail-out', { redactions: 0, rules: [], skipped: 'cached response already checked' });
      push('answer', { status: 'answered', cached: true });
      return finish('answered', response, trace);
    }

    // 6 — BUDGET: per-key spend cap, checked before the metered call.
    const tokensIn = estTokens(prompt) + SYSTEM_PROMPT_TOKENS;
    const sim = simulateModel(task, prompt);
    const projected = costUsd(model, tokensIn, sim.tokensOut);
    const spent = state.spent.get(keyId) ?? 0;
    const overBudget = spent + projected > key.dailyCapUsd;
    push('budget', { spent, cap: key.dailyCapUsd, projected, ok: !overBudget });
    if (overBudget) {
      return finish('over-budget', {
        status: 'refused',
        text: `Daily cap for this key ($${key.dailyCapUsd.toFixed(2)}) would be exceeded — request denied before a cent was spent.`,
      }, {
        model: model.id, tier: model.tier, requestedTier, fallback, tokensIn,
      });
    }

    // 7 — MODEL: the only node that "calls" one.
    const cost = projected;
    const latency = latencyMs(model, sim.tokensOut);
    push('model', {
      model: model.id, tier: model.tier,
      tokensIn, tokensOut: sim.tokensOut, costUsd: cost, latencyMs: latency,
    });
    state.cache.set(ck, { text: sim.text, tokensOut: sim.tokensOut });
    state.spent.set(keyId, spent + cost);

    // 8 — GUARDRAIL-OUT: scan what the model produced.
    let text = sim.text;
    const firedRules = [];
    for (const rule of OUTPUT_RULES) {
      if (rule.pattern.test(text)) {
        firedRules.push(rule.id);
        text = text.replace(rule.pattern, rule.replacement);
      }
    }
    push('guardrail-out', { redactions: firedRules.length, rules: firedRules });

    // 9 — ANSWER
    const response = { status: 'answered', text, redactions: firedRules.length, cached: false };
    push('answer', { status: 'answered', redacted: firedRules.length > 0 });

    // 10 — LOG: every request, denied or served, leaves a trace record.
    return finish('answered', response, {
      model: model.id, tier: model.tier, requestedTier, fallback,
      tokensIn, tokensOut: sim.tokensOut, costUsd: cost, latencyMs: latency,
      guardrailOut: { redactions: firedRules.length, rules: firedRules },
    });
  }

  function ledger(keyId) {
    const key = keyById(keyId);
    const hits = (state.hits.get(keyId) ?? []).filter((t) => now() - t < key.windowMs);
    return {
      keyId,
      label: key.label,
      spent: state.spent.get(keyId) ?? 0,
      cap: key.dailyCapUsd,
      rateUsed: hits.length,
      rateLimit: key.rateLimit,
    };
  }

  return {
    models,
    keys,
    run,
    setAvailable,
    reset,
    ledger,
    get trace() { return state.trace; },
    get cacheSize() { return state.cache.size; },
    spentUsd: (keyId) => state.spent.get(keyId) ?? 0,
  };
}
