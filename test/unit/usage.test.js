import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { createD1 } from '../support/d1Shim.js';

const APP = 'a'.repeat(32), USAGE = 'u'.repeat(32);
function setup(extra = {}) {
  const env = { DB: createD1(), APP_KEY: APP, USAGE_TOKEN: USAGE, NOW: () => 1_800_000_000, ...extra };
  const call = async (method, path, { key = USAGE, body, raw } = {}) => {
    const res = await worker.fetch(new Request(`https://x.test${path}`, { method, headers: key ? { Authorization: `Bearer ${key}` } : {}, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env);
    return { status: res.status, body: await res.json() };
  };
  return { env, call };
}
const codex = { usedPercent: 11, resetsAt: '2026-12-01T00:00:00Z', measuredAt: '2026-11-16T00:00:00Z' };

test('usage GET, dedicated auth, merge and validation', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/usage')).body.usage, null);
  assert.equal((await call('GET', '/api/usage', { key: APP })).status, 401);
  assert.equal((await call('GET', '/api/data', { key: USAGE })).status, 401);
  await call('PUT', '/api/usage', { body: { codex } });
  const put = await call('PUT', '/api/usage', { body: { muse: { usedPercent: 6, resetsAt: codex.resetsAt, measuredAt: codex.measuredAt } } });
  assert.ok(Number.isFinite(Date.parse(put.body.updatedAt)) && put.body.updatedAt.endsWith('Z'));
  const stored = (await call('GET', '/api/usage')).body.usage;
  assert.deepEqual(Object.keys(stored).sort(), ['codex', 'muse', 'updatedAt', 'v']);
  assert.deepEqual(stored.codex, codex);
  assert.equal(stored.updatedAt, '2027-01-15T08:00:00.000Z');
  const claudeCode = { loginExpiresAt: '2026-12-01T00:00:00Z', measuredAt: codex.measuredAt };
  await call('PUT', '/api/usage', { body: { claudeCode } });
  assert.deepEqual((await call('GET', '/api/usage')).body.usage.claudeCode, claudeCode);
  for (const body of [{ codex: null }, { nope: 1 }, { codex: { ...codex, nope: 1 } }, { claudeCode: { loginExpiresAt: codex.resetsAt, measuredAt: codex.measuredAt, usedPercent: 1 } }, { codex: { ...codex, usedPercent: 101 } }, { codex: { ...codex, resetsAt: 'bad' } }]) assert.equal((await call('PUT', '/api/usage', { body })).status, 400);
  assert.equal((await call('PUT', '/api/usage', { raw: ' '.repeat(4097) })).status, 413);
  for (const body of [{}, { v: 1 }, { codex: { ...codex, usedPercent: '11' } }, { codex: { ...codex, usedPercent: -1 } }, { codex: { ...codex, measuredAt: '2026-11-16T00:00:00' } }, { v: 2, codex }]) assert.equal((await call('PUT', '/api/usage', { body })).status, 400);
  assert.equal((await call('PUT', '/api/usage', { raw: '' })).status, 400);
  assert.equal((await call('PUT', '/api/usage', { body: { codex: { ...codex, measuredAt: new Date(1_800_003_600_000).toISOString() } } })).status, 400);
  assert.equal((await call('POST', '/api/usage')).status, 401);
  assert.equal((await call('GET', '/api/snapshots', { key: USAGE })).status, 401);
});

test('usage token configuration is required and must differ from APP_KEY', async () => {
  assert.equal((await setup({ USAGE_TOKEN: undefined }).call('GET', '/api/usage')).status, 503);
  assert.equal((await setup({ USAGE_TOKEN: APP }).call('GET', '/api/usage')).status, 503);
});
