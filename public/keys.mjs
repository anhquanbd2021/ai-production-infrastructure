// Tenant keys — embedded copy of examples/keys.json (sync-tested).
// Fixture only — not real credentials. Each key gets a rate limit (requests
// per window) and a daily spend cap: the two economic controls a gateway
// enforces before a request ever reaches a model.

export const KEYS = [
  {
    id: 'gw-demo-frontend',
    label: 'gw-demo-frontend · chat UI traffic',
    windowMs: 60000,
    rateLimit: 4,
    dailyCapUsd: 2.50,
  },
  {
    id: 'gw-demo-batch',
    label: 'gw-demo-batch · nightly batch jobs',
    windowMs: 60000,
    rateLimit: 8,
    dailyCapUsd: 10.00,
  },
  {
    id: 'gw-demo-sandbox',
    label: 'gw-demo-sandbox · intern experiments',
    windowMs: 60000,
    rateLimit: 3,
    dailyCapUsd: 0.10,
  },
];
