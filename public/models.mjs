// Model catalog — embedded copy of examples/models.json (sync-tested).
// Prices are plausible-orders-of-magnitude fixtures, not a quote from any
// provider; the point is the ~10x step between tiers.

export const MODELS = [
  {
    id: 'nano-1',
    tier: 'nano',
    label: 'nano-1 · cheap classifier tier',
    priceInPer1k: 0.05,
    priceOutPer1k: 0.15,
    baseLatencyMs: 40,
    msPerOutputToken: 1,
    available: true,
  },
  {
    id: 'standard-1',
    tier: 'standard',
    label: 'standard-1 · general workhorse',
    priceInPer1k: 0.50,
    priceOutPer1k: 1.50,
    baseLatencyMs: 120,
    msPerOutputToken: 2,
    available: true,
  },
  {
    id: 'pro-1',
    tier: 'pro',
    label: 'pro-1 · frontier reasoning',
    priceInPer1k: 5.00,
    priceOutPer1k: 15.00,
    baseLatencyMs: 400,
    msPerOutputToken: 4,
    available: true,
  },
];

export const TIER_ORDER = ['nano', 'standard', 'pro'];
