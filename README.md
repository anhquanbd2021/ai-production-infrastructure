# AI Gateway Lab — companion demo

Interactive lab for the article *The 8 Concepts Between Your AI Demo and
Production*. Every request walks the ten-node gateway path — authenticate,
rate limit, input guardrail, route, cache, budget, model, output guardrail,
answer, trace — and only one of those nodes touches a model.

Zero dependencies — Node 20+ only. The gateway engine, model catalog, key
fixtures, and scenarios are plain ES modules shared by the browser UI, the
CLI report, and the test suite.

## What it proves

| Control | What you see |
|---|---|
| **Routing** | classify/extract → `nano`, summarize → `standard`, reason → `pro`; prompts over 600 chars bump a tier; mark standard down and requests fall back to pro — flagged in the trace. |
| **Cache** | run "Classify a support ticket" then "Same ticket, again" — the repeat is a cache hit: `$0.00`, `6ms`. |
| **Rate limit** | burst ×5 on the sandbox key (3/minute): the fourth and fifth requests are denied — and still traced. |
| **Budget** | sandbox key (`$0.10/day`) tries the pro-tier task: denied at the budget node before a cent is spent. |
| **Guardrails** | an injection prompt is blocked on input at `$0.00`; a clean-looking prompt asking about the upstream API key is *answered* — after the output guardrail redacts the leaked `sk-demo-…` credential. |
| **Trace** | every request — denied or served — leaves a record: model, tier, tokens, cost, latency, verdict. |

## Run it

```text
npm start       # serve the lab on :3000
npm test        # routing + cache + guardrails + limits + server
npm run scan    # side-by-side report of all scenarios
npm run check   # both
```

## Examples

- `examples/models.json` — three tiers with per-1K prices and simulated
  latency bases (~10x per tier).
- `examples/keys.json` — fixture tenant keys with window rate limits and
  daily spend caps. Not real credentials.
- `examples/requests.json` — the preset scenarios and task list.
- The `public/*.mjs` fixtures are embedded copies of these files — a test
  asserts they stay identical.

## Honest limits

- No real model is called: token counts, prices, and latency are formulas.
  The numbers are plausible orders of magnitude, not a provider quote.
- The rate limiter is a fixed window per key; real gateways use token
  buckets and distributed counters.
- Caching is exact-match on a normalized prompt; production semantic caches
  are fuzzier — and riskier.
- The routing table is static; a real gateway derives it from eval scores
  and live pricing.
- In-memory state only — restart resets the ledger, cache, and windows.

This is an educational demo, not production infrastructure.
