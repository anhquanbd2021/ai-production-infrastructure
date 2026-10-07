import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../public/models.mjs';
import { KEYS } from '../public/keys.mjs';
import { SCENARIOS, TASKS } from '../public/scenarios.mjs';

const example = (name) => JSON.parse(
  readFileSync(fileURLToPath(new URL(`../examples/${name}`, import.meta.url)), 'utf8'),
);

test('embedded fixtures match examples/ — the JSON is the lab', () => {
  assert.deepEqual(example('models.json'), MODELS);
  assert.deepEqual(example('keys.json'), KEYS);
  const requests = example('requests.json');
  assert.deepEqual(requests.scenarios, SCENARIOS);
  assert.deepEqual(requests.tasks, TASKS);
});

test('scenarios cover every task and every guardrail path', () => {
  const tasks = new Set(SCENARIOS.map((s) => s.task));
  for (const t of TASKS) assert.ok(tasks.has(t.id), `missing scenario for ${t.id}`);
  assert.ok(SCENARIOS.some((s) => /ignore all previous instructions/i.test(s.prompt)));
  assert.ok(SCENARIOS.some((s) => /api key/i.test(s.prompt)));
  assert.equal(
    scenario('repeat-classify').prompt,
    scenario('classify-ticket').prompt,
  );
});

function scenario(id) {
  return SCENARIOS.find((s) => s.id === id);
}
