// 定時の処理（Cron）と、手動で試す API。送信先の Discord は、偽の fetch で受ける（実際には送らない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../../worker/src/index.js';
import { CRON_DIGEST, CRON_MAINTENANCE, readConfig, runScheduled, sendDigest } from '../../worker/src/jobs.js';
import { pruneSnapshots, runMaintenance } from '../../worker/src/maintenance.js';
import { parseNow, fromJst } from '../../worker/src/time.js';
import { createD1 } from '../support/d1Shim.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const KEY = 'k'.repeat(32);
const HOOK = 'https://discord.com/api/webhooks/123456/SECRET-TOKEN-xyz';
const UID = '100000000000000001';
const MORNING = parseNow('2026-01-30 06:47') / 1000;

/** Discord に送った内容を記録する偽の fetch。status を並べておくと、その順に返す */
function fakeDiscord(...statuses) {
  const calls = [];
  const q = [...statuses];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: q.length ? q.shift() : 204 });
  };
  return { calls, fetchFn };
}

async function setup(extra = {}, { data = JSON.parse(read('fixtures/data.json')) } = {}) {
  const clock = { t: MORNING };
  const discord = fakeDiscord();
  const env = {
    DB: createD1(), APP_KEY: KEY, NOW: () => clock.t, FETCH: discord.fetchFn, SLEEP: async () => {},
    DISCORD_WEBHOOK_URL: HOOK, DISCORD_USER_ID: UID, APP_URL: 'https://example.com/app', ...extra,
  };
  await worker.fetch(new Request('https://x.test/api/health'), env); // テーブルを作る（本番では fetch / scheduled が先に作る）
  if (data) {
    const put = await worker.fetch(new Request('https://x.test/api/data', {
      method: 'PUT', headers: { Authorization: `Bearer ${KEY}`, 'If-Match': '0', 'CF-Connecting-IP': '1.1.1.1' }, body: JSON.stringify(data),
    }), env);
    assert.equal(put.status, 201);
  }
  const call = async (method, path, key = KEY) => {
    const res = await worker.fetch(new Request(`https://x.test${path}`, {
      method, headers: { 'CF-Connecting-IP': '1.1.1.1', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    }), env);
    return { status: res.status, body: await res.json() };
  };
  return { env, clock, discord, call };
}

const dry = (calls) => calls.map((c) => `----- [DRY_RUN] 送信内容 -----\n${c.body.content}\n`).join('');

test('設定の読み取り: 前後の空白を除く。Discord の URL の形でなければ使わない。アプリの URL の末尾に / を足す', () => {
  const c = readConfig({ DISCORD_WEBHOOK_URL: `  ${HOOK}\n`, DISCORD_USER_ID: ` ${UID} `, APP_URL: 'https://example.com/app', DONE_LINKS: '0' });
  assert.deepEqual(c, { webhook: HOOK, webhookSet: true, appUrl: 'https://example.com/app/', mentionUserId: UID, doneLinks: false });
  assert.equal(readConfig({ DISCORD_WEBHOOK_URL: 'https://evil.example.com/hook' }).webhook, '');
  assert.equal(readConfig({ DISCORD_WEBHOOK_URL: 'http://discord.com/api/webhooks/1/x' }).webhook, '');
  assert.equal(readConfig({ DISCORD_WEBHOOK_URL: 'https://discord.com.evil.example/api/webhooks/1/x' }).webhook, '');
  assert.equal(readConfig({ DISCORD_WEBHOOK_URL: 'https://canary.discord.com/api/webhooks/1/x' }).webhook, 'https://canary.discord.com/api/webhooks/1/x');
  assert.equal(readConfig({ DISCORD_USER_ID: 'abc' }).mentionUserId, '');
  assert.deepEqual(readConfig({}), { webhook: '', webhookSet: false, appUrl: '', mentionUserId: '', doneLinks: true });
});

test('朝の Cron: 保存した締切データから締切一覧を作り、Webhook に送る', async () => {
  const { env, discord } = await setup({ APP_URL: 'https://example.com/app/', DISCORD_USER_ID: UID });
  const out = await runScheduled(CRON_DIGEST, env, MORNING);
  assert.equal(out.digest, discord.calls.length);
  assert.ok(discord.calls.every((c) => c.url === HOOK));
  assert.equal(dry(discord.calls), read('expected/digest-daily.txt').replace(/<@100000000000000001>/, `<@${UID}>`));
  assert.deepEqual(discord.calls[0].body.allowed_mentions, { parse: [], users: [UID] });
});

test('Webhook が未設定・形が違うときは、何も送らない（エラーにもしない）', async () => {
  for (const extra of [{ DISCORD_WEBHOOK_URL: undefined }, { DISCORD_WEBHOOK_URL: 'https://evil.example.com/x' }]) {
    const { env, discord } = await setup(extra);
    assert.equal(await sendDigest(env, MORNING * 1000), null);
    assert.equal(discord.calls.length, 0);
  }
});

test('締切データがまだ無いときは、その旨を送る', async () => {
  const { env, discord } = await setup({}, { data: null });
  await runScheduled(CRON_DIGEST, env, MORNING);
  assert.equal(discord.calls.length, 1);
  assert.match(discord.calls[0].body.content, /締切データがまだ保存されていません/);
});

test('Discord が一時的に失敗したらやり直す。ずっと失敗したら例外にし、Cron の履歴に失敗として残す', async () => {
  const flaky = fakeDiscord(500, 429, 204, 204, 204, 204);
  const a = await setup({ FETCH: flaky.fetchFn });
  await runScheduled(CRON_DIGEST, a.env, MORNING);
  assert.ok(flaky.calls.length >= 3);
  const down = fakeDiscord(500, 500, 500, 500);
  const b = await setup({ FETCH: down.fetchFn });
  const e = await runScheduled(CRON_DIGEST, b.env, MORNING).catch((x) => x);
  assert.ok(e instanceof Error);
  assert.match(e.message, /HTTP 500/);
  assert.doesNotMatch(e.message, /SECRET-TOKEN/);
});

test('一覧を作る処理が失敗したら、失敗したことを Discord に知らせて例外にする', async () => {
  const { env, discord } = await setup();
  await env.DB.prepare("UPDATE docs SET json = '{壊れた' WHERE id = 'main'").run();
  await assert.rejects(runScheduled(CRON_DIGEST, env, MORNING));
  assert.equal(discord.calls.length, 1);
  assert.match(discord.calls[0].body.content, /締切一覧を作れませんでした/);
});

test('wrangler.jsonc の Cron の式が、コードの定数と同じ', () => {
  const text = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual(JSON.parse(text).triggers.crons, [CRON_DIGEST, CRON_MAINTENANCE]);
});

test('Worker の scheduled() が、Cron の式に応じて動く。知らない式は何もしない', async () => {
  const { env, discord } = await setup();
  await worker.scheduled({ cron: CRON_DIGEST }, env);
  assert.ok(discord.calls.length > 0);
  const n = discord.calls.length;
  await worker.scheduled({ cron: '0 0 1 1 *' }, env);
  assert.equal(discord.calls.length, n);
});

test('GET /api/digest: 認証が要る。文面と設定の有無だけを返し、Webhook の URL・トークンは返さない', async () => {
  const { call, env } = await setup();
  assert.equal((await call('GET', '/api/digest', null)).status, 401);
  const r = await call('GET', '/api/digest');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.config, { webhook: 'ok', appUrl: true, mention: true });
  assert.match(r.body.chunks[0], /# 📋 締切トラッカー/);
  assert.deepEqual(r.body.warnings, []);
  // 文面にはメンションとしてユーザー ID が入るのが正しい。Webhook の URL とトークンは返さない
  assert.doesNotMatch(JSON.stringify(r.body), /SECRET-TOKEN|webhooks|123456\//);
  delete env.DISCORD_WEBHOOK_URL;
  assert.equal((await call('GET', '/api/digest')).body.config.webhook, 'unset');
  env.DISCORD_WEBHOOK_URL = 'https://evil.example.com/x';
  assert.equal((await call('GET', '/api/digest')).body.config.webhook, 'invalid');
});

test('POST /api/digest: 今すぐ送る。未設定は 400、Discord の失敗は 502（URL を含めない）', async () => {
  const { call, env, discord } = await setup();
  const r = await call('POST', '/api/digest');
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, discord.calls.length);
  const unset = await setup({ DISCORD_WEBHOOK_URL: undefined });
  assert.equal((await unset.call('POST', '/api/digest')).status, 400);
  const down = fakeDiscord(500, 500, 500, 500);
  const bad = await setup({ FETCH: down.fetchFn });
  const f = await bad.call('POST', '/api/digest');
  assert.equal(f.status, 502);
  assert.doesNotMatch(JSON.stringify(f.body), /SECRET-TOKEN/);
  assert.equal(env.DISCORD_WEBHOOK_URL, HOOK);
});

// ---- 世代バックアップの間引き（prune_backups.py と同じ規則） ----

const NOW = parseNow('2026-03-15 12:00') / 1000;
const at = (s) => parseNow(s) / 1000;

test('間引き: 直近14日は全部、〜90日は週に1つ（その週の最新）、それ以前は月に1つ', () => {
  const list = [
    { id: 1, at: at('2026-03-15 11:00') }, { id: 2, at: at('2026-03-15 03:00') }, { id: 3, at: at('2026-03-02 09:00') }, // 14日以内（3/1 12:00 以降）
    { id: 4, at: at('2026-02-20 09:00') }, { id: 5, at: at('2026-02-19 09:00') }, // 同じ週（2/16〜2/22）→ 新しい 4 だけ
    { id: 6, at: at('2026-02-10 09:00') }, // 別の週
    { id: 7, at: at('2025-11-20 09:00') }, { id: 8, at: at('2025-11-05 09:00') }, // 90日より前・同じ月 → 新しい 7 だけ
    { id: 9, at: at('2025-10-30 09:00') }, // 別の月
  ];
  const { keep, drop } = pruneSnapshots(list, NOW);
  assert.deepEqual([...keep].sort((a, b) => a - b), [1, 2, 3, 4, 6, 7, 9]);
  assert.deepEqual([...drop].sort((a, b) => a - b), [5, 8]);
});

test('間引き: ISO 週は年またぎでも正しい（2025/12/29〜2026/1/4 は同じ週）', () => {
  const now = parseNow('2026-03-15 12:00') / 1000;
  const list = [{ id: 1, at: at('2026-01-02 09:00') }, { id: 2, at: at('2025-12-30 09:00') }, { id: 3, at: at('2025-12-28 09:00') }];
  // 1・2 は同じ週（ISO 2026年第1週）、3 は前の週。1/2 は 72 日前なので週単位
  assert.deepEqual(pruneSnapshots(list, now).drop, [2]);
});

test('runMaintenance: 古い世代バックアップを消し、期限切れの回数制限の記録も消す', async () => {
  const { env } = await setup({}, { data: null });
  await env.DB.batch([
    ...[['2026-03-15 11:00', 1], ['2026-02-20 09:00', 2], ['2026-02-19 09:00', 3]].map(([t, rev]) => env.DB.prepare('INSERT INTO snapshots (at, rev, json) VALUES (?, ?, ?)').bind(at(t), rev, '{}')),
    env.DB.prepare('INSERT INTO limits (k, n, until) VALUES (?, 1, ?)').bind('old', NOW - 10),
    env.DB.prepare('INSERT INTO limits (k, n, until) VALUES (?, 1, ?)').bind('new', NOW + 600),
  ]);
  const out = await runMaintenance(env, NOW);
  assert.deepEqual(out, { snapshots: 1, kept: 2, limits: 1 });
  const left = (await env.DB.prepare('SELECT rev FROM snapshots ORDER BY rev').all()).results.map((r) => r.rev);
  assert.deepEqual(left, [1, 2]);
  assert.deepEqual((await env.DB.prepare('SELECT k FROM limits').all()).results.map((r) => r.k), ['new']);
  assert.ok(fromJst(2026, 1, 1) > 0);
});
