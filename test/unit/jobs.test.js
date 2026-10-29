// 定時の処理（Cron）と、手動で試す API。送信先の Discord は、偽の fetch で受ける（実際には送らない）。
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../../worker/src/index.js';
import { CRON_DIGEST, CRON_MAIL_EVENING, CRON_MAIL_MORNING, readConfig, runScheduled, sendDigest } from '../../worker/src/jobs.js';
import { pruneSnapshots, runMaintenance } from '../../worker/src/maintenance.js';
import { parseNow, fromJst } from '../../worker/src/time.js';
import { createD1 } from '../support/d1Shim.js';

// Worker は「未設定のため送りません」などをログに出す。テスト中に出力が混ざると、node --test の結果の受け渡しが
// まれに壊れる（'Unable to deserialize cloned data' で、ファイルごと失敗する）ので、このファイルでは黙らせる
before(() => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
});
after(() => mock.restoreAll());

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
  assert.deepEqual(JSON.parse(text).triggers.crons, [CRON_DIGEST, CRON_MAIL_EVENING, CRON_MAIL_MORNING]);
  assert.equal(JSON.parse(text).triggers.crons.length, 3, '無料プランの Cron Triggers はアカウント全体で5本まで。このWorkerでは3本にまとめる');
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

// ---- 締切のメール（Gmail API で自分宛て） ----

const GOOGLE = { GOOGLE_CLIENT_ID: 'cid-123', GOOGLE_CLIENT_SECRET: 'CLIENT-SECRET-xyz', GOOGLE_REFRESH_TOKEN: 'REFRESH-TOKEN-abc', MAIL_TO: 'me@example.com' };

/** Google と Discord を URL で振り分ける偽の fetch。overrides[種類] に status を並べておくと、その順に返す */
function fakeNet(overrides = {}) {
  const calls = [];
  const q = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, [...v]]));
  const fetchFn = async (url, init) => {
    const kind = url.includes('oauth2.googleapis') ? 'token' : url.includes('gmail.googleapis') ? 'send' : 'discord';
    calls.push({ kind, url, init });
    const o = q[kind]?.shift();
    if (o !== undefined) return new Response(JSON.stringify(o.body ?? {}), { status: o.status });
    if (kind === 'token') return new Response(JSON.stringify({ access_token: 'ya29.FAKE' }), { status: 200 });
    if (kind === 'send') return new Response(JSON.stringify({ id: 'gm-1' }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  return { calls, fetchFn };
}

const sentRaw = (call) => Buffer.from(JSON.parse(call.init.body).raw, 'base64url').toString('utf8');
const decodedBody = (raw) => Buffer.from(raw.split('\r\n\r\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf8');
const subjectOf = (raw) => [...raw.match(/Subject: ([\s\S]*?)\r\nDate/)[1].matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8')).join('');

test('夜の Cron（20:23）は翌日分、朝の Cron（5:23）は当日分のメールを、自分宛てに送る', async () => {
  for (const [cron, at, subject, date] of [
    [CRON_MAIL_EVENING, '2026-01-29 20:23', '【締切トラッカー】1/30（金）の締切', '2026-01-30'],
    [CRON_MAIL_MORNING, '2026-01-30 05:23', '【締切トラッカー】1/30（金）の締切', '2026-01-30'],
  ]) {
    const net = fakeNet();
    const { env } = await setup({ ...GOOGLE, FETCH: net.fetchFn });
    const out = await runScheduled(cron, env, parseNow(at) / 1000);
    assert.equal(out.mail.subject, subject);
    const send = net.calls.find((c) => c.kind === 'send');
    const raw = sentRaw(send);
    assert.equal(subjectOf(raw), subject);
    assert.match(raw, /^From: me@example\.com\r\nTo: me@example\.com\r\n/);
    const body = decodedBody(raw);
    assert.match(body, /■ おすすめの順番（上位5件）/);
    assert.match(body, new RegExp(`この日付: ${date} `));
    assert.doesNotMatch(raw, /CLIENT-SECRET|REFRESH-TOKEN|ya29/);
    assert.equal(net.calls.filter((c) => c.kind === 'discord').length, cron === CRON_MAIL_EVENING ? 1 : 0, '夜の Cron だけ、メールのあとに夜の再通知を Discord へ送る。朝の Cron は Discord へ送らない');
  }
});

test('Gmail の設定が未設定・一部だけのとき、データが無いときは、何も送らない（エラーにもしない）', async () => {
  for (const extra of [{}, { ...GOOGLE, GOOGLE_REFRESH_TOKEN: undefined }, { ...GOOGLE, MAIL_TO: 'bad' }]) {
    const net = fakeNet();
    const { env } = await setup({ ...extra, FETCH: net.fetchFn });
    assert.equal((await runScheduled(CRON_MAIL_EVENING, env, MORNING)).mail, null);
    assert.equal(net.calls.filter((c) => c.kind !== 'discord').length, 0, 'Google には何も送らない（夜の再通知は Discord へ届く）');
  }
  const net = fakeNet();
  const { env } = await setup({ ...GOOGLE, FETCH: net.fetchFn }, { data: null });
  assert.equal((await runScheduled(CRON_MAIL_MORNING, env, MORNING)).mail, null);
  assert.equal(net.calls.length, 0);
});

test('メールの送信に失敗したら、Discord に知らせてから例外にする（認証情報は含めない）', async () => {
  const net = fakeNet({ token: [{ status: 400, body: { error: 'invalid_grant' } }] });
  const { env } = await setup({ ...GOOGLE, FETCH: net.fetchFn });
  const e = await runScheduled(CRON_MAIL_MORNING, env, MORNING).catch((x) => x);
  assert.match(e.message, /invalid_grant/);
  const notice = net.calls.filter((c) => c.kind === 'discord');
  assert.equal(notice.length, 1);
  const content = JSON.parse(notice[0].init.body).content;
  assert.match(content, /締切のメールを送れませんでした/);
  assert.doesNotMatch(`${content}${e.message}`, /REFRESH-TOKEN|CLIENT-SECRET|SECRET-TOKEN/);
});

test('GET /api/mail: 認証が要る。件名・本文・設定の有無だけを返す。target の値を検査する', async () => {
  const { call } = await setup({ ...GOOGLE });
  assert.equal((await call('GET', '/api/mail', null)).status, 401);
  const r = await call('GET', '/api/mail?target=tomorrow');
  assert.equal(r.status, 200);
  assert.equal(r.body.subject, '【締切トラッカー】1/31（土）の締切');
  assert.equal(r.body.target, '2026-01-31');
  assert.match(r.body.body, /^1\/31（土）の締切/);
  assert.deepEqual(r.body.config, { google: 'ok' });
  assert.doesNotMatch(JSON.stringify(r.body), /REFRESH-TOKEN|CLIENT-SECRET|cid-123|me@example\.com/);
  assert.equal((await call('GET', '/api/mail?target=bad')).status, 400);
  assert.equal((await (await setup({})).call('GET', '/api/mail')).body.config.google, 'unset');
  assert.equal((await (await setup({ GOOGLE_CLIENT_ID: 'x' })).call('GET', '/api/mail')).body.config.google, 'incomplete');
});

test('POST /api/mail: 今すぐ送る。未設定は 400、Google の失敗は 502（認証情報を含めない）', async () => {
  const net = fakeNet();
  const ok = await setup({ ...GOOGLE, FETCH: net.fetchFn });
  const r = await ok.call('POST', '/api/mail?target=today');
  assert.equal(r.status, 200);
  assert.equal(r.body.subject, '【締切トラッカー】1/30（金）の締切');
  assert.equal(net.calls.filter((c) => c.kind === 'send').length, 1);
  assert.equal((await (await setup({})).call('POST', '/api/mail')).status, 400);
  const bad = await setup({ ...GOOGLE, FETCH: fakeNet({ token: [{ status: 400, body: { error: 'invalid_grant' } }] }).fetchFn });
  const f = await bad.call('POST', '/api/mail');
  assert.equal(f.status, 502);
  assert.doesNotMatch(JSON.stringify(f.body), /REFRESH-TOKEN|CLIENT-SECRET/);
});

test('朝の Cron: DISCORD_USER_ID が未設定でも、送る本文すべてに allowed_mentions（誰もメンションしない）を付ける', async () => {
  const { env, discord } = await setup({ DISCORD_USER_ID: '' });
  await runScheduled(CRON_DIGEST, env, MORNING);
  assert.ok(discord.calls.length > 0);
  for (const c of discord.calls) assert.deepEqual(c.body.allowed_mentions, { parse: [], users: [] });
});


// ---- 夜の再通知・週次レビュー・掃除（Cron の本数を増やさないための振り分け） ----

const THU = '2026-01-29 20:23'; // 木曜
const SUN = '2026-02-01 20:23'; // 日曜

test('夜の Cron（20:23）: 月〜土は夜の再通知、日曜は週次レビューを Discord へ送る', async () => {
  const a = await setup();
  const out = await runScheduled(CRON_MAIL_EVENING, a.env, parseNow(THU) / 1000);
  assert.equal(out.review, 1);
  assert.match(a.discord.calls[0].body.content, /^<@100000000000000001> \n# 🌙 まだ終わっていません/);
  assert.equal(a.discord.calls.length, 1);

  const b = await setup();
  const w = await runScheduled(CRON_MAIL_EVENING, b.env, parseNow(SUN) / 1000);
  assert.equal(w.review, 2);
  assert.match(b.discord.calls[0].body.content, /^# 📅 来週の見通し/);
  assert.match(b.discord.calls[1].body.content, /^# 📈 先々の見通し/);
  for (const c of b.discord.calls) assert.deepEqual(c.body.allowed_mentions, { parse: [], users: [UID] });
});

test('夜の再通知: 対象が0件の日は、何も送らない（エラーにもしない）', async () => {
  const { env, discord } = await setup({}, { data: { items: [{ id: 'f', title: '来月', due: '2026-03-01T03:00:00.000Z' }] } });
  assert.equal((await runScheduled(CRON_MAIL_EVENING, env, parseNow(THU) / 1000)).review, 0);
  assert.equal(discord.calls.length, 0);
});

test('夜の再通知・週次レビュー: Webhook が未設定なら送らない。データが無いときも送らない（朝の一覧のような警告は出さない）', async () => {
  const none = await setup({ DISCORD_WEBHOOK_URL: '' });
  assert.equal((await runScheduled(CRON_MAIL_EVENING, none.env, parseNow(THU) / 1000)).review, null);
  assert.equal(none.discord.calls.length, 0);
  const empty = await setup({}, { data: null });
  assert.equal((await runScheduled(CRON_MAIL_EVENING, empty.env, parseNow(THU) / 1000)).review, 0);
  assert.equal((await runScheduled(CRON_MAIL_EVENING, empty.env, parseNow(SUN) / 1000)).review, 0);
  assert.equal(empty.discord.calls.length, 0);
});

test('朝の Cron（5:23）: メールのあとに世代バックアップの間引きと掃除を行う', async () => {
  const net = fakeNet();
  const { env } = await setup({ ...GOOGLE, FETCH: net.fetchFn });
  await env.DB.prepare('INSERT INTO limits (k, n, until) VALUES (?, 1, ?)').bind('auth:old', 1).run();
  const out = await runScheduled(CRON_MAIL_MORNING, env, parseNow('2026-01-30 05:23') / 1000);
  assert.equal(out.mail.subject, '【締切トラッカー】1/30（金）の締切');
  assert.ok(out.maintenance);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM limits WHERE k = 'auth:old'").first('n'), 0, '期限切れの記録が消える');
});

test('1つの仕事が失敗しても、同じ Cron の残りは実行し、最後に例外を投げる（Cron の履歴に失敗として残る）', async () => {
  // 朝 5:23: メールが失敗しても、掃除は実行する
  const net = fakeNet({ token: [{ status: 400, body: { error: 'invalid_grant' } }] });
  const m = await setup({ ...GOOGLE, FETCH: net.fetchFn });
  await m.env.DB.prepare('INSERT INTO limits (k, n, until) VALUES (?, 1, ?)').bind('auth:old', 1).run();
  const e1 = await runScheduled(CRON_MAIL_MORNING, m.env, parseNow('2026-01-30 05:23') / 1000).catch((x) => x);
  assert.match(e1.message, /invalid_grant/);
  assert.equal(await m.env.DB.prepare("SELECT COUNT(*) AS n FROM limits WHERE k = 'auth:old'").first('n'), 0, '失敗のあとも掃除は実行された');

  // 夜 20:23: メールが失敗しても、夜の再通知は送る。Discord にはメール失敗の知らせも届く
  const net2 = fakeNet({ token: [{ status: 400, body: { error: 'invalid_grant' } }] });
  const n = await setup({ ...GOOGLE, FETCH: net2.fetchFn });
  const e2 = await runScheduled(CRON_MAIL_EVENING, n.env, parseNow(THU) / 1000).catch((x) => x);
  assert.match(e2.message, /invalid_grant/);
  const texts = net2.calls.filter((c) => c.kind === 'discord').map((c) => JSON.parse(c.init.body).content);
  assert.ok(texts.some((t) => /締切のメールを送れませんでした/.test(t)));
  assert.ok(texts.some((t) => /まだ終わっていません/.test(t)), 'メールが失敗しても夜の再通知は届く');
  assert.doesNotMatch(texts.join('') + e2.message, /REFRESH-TOKEN|CLIENT-SECRET|SECRET-TOKEN/);

  // 2つとも失敗したら、両方の理由を1つの例外にまとめる（秘密は含めない）
  const net3 = fakeNet({ token: [{ status: 400, body: { error: 'invalid_grant' } }] });
  const both = await setup({ ...GOOGLE, FETCH: async (url, init) => (String(url).includes('discord.com') ? new Response(null, { status: 500 }) : net3.fetchFn(url, init)) });
  const e3 = await runScheduled(CRON_MAIL_EVENING, both.env, parseNow(THU) / 1000).catch((x) => x);
  assert.ok(e3 instanceof AggregateError);
  assert.equal(e3.errors.length, 2);
  assert.match(e3.message, /invalid_grant/);
  assert.match(e3.message, /HTTP 500/);
  assert.doesNotMatch(e3.message, /SECRET-TOKEN/);
});

test('GET/POST /api/digest?kind=: 夜の再通知・週次レビューの文面を確かめる／今すぐ送る。kind が違えば 400', async () => {
  const t = await setup();
  t.clock.t = parseNow(THU) / 1000;
  const ev = await t.call('GET', '/api/digest?kind=evening');
  assert.equal(ev.status, 200);
  assert.match(ev.body.chunks[0], /# 🌙 まだ終わっていません/);
  const wk = await t.call('GET', '/api/digest?kind=weekly');
  assert.equal(wk.body.chunks.length, 2);
  assert.match((await t.call('GET', '/api/digest')).body.chunks[0], /# 📋 締切トラッカー/, '既定は朝の一覧');
  assert.equal((await t.call('GET', '/api/digest?kind=other')).status, 400);
  assert.equal((await t.call('GET', '/api/digest?kind=evening', null)).status, 401);
  const sent = await t.call('POST', '/api/digest?kind=weekly');
  assert.deepEqual(sent.body, { ok: true, sent: 2 });
  assert.equal(t.discord.calls.length, 2);
  assert.equal((await t.call('POST', '/api/digest?kind=other')).status, 400);
});
