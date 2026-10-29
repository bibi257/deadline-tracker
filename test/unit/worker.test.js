import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { createD1 } from '../support/d1Shim.js';

const KEY = 'k'.repeat(32);

function setup(extra = {}) {
  const clock = { t: 1_000_000 };
  const env = { DB: createD1(), APP_KEY: KEY, NOW: () => clock.t, ...extra };
  const call = async (method, path, { key = KEY, body, headers = {}, ip = '1.1.1.1' } = {}) => {
    const h = { 'CF-Connecting-IP': ip, ...headers };
    if (key) h.Authorization = `Bearer ${key}`;
    const res = await worker.fetch(new Request(`https://x.test${path}`, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { env, clock, call };
}

const sample = (n = 1, at = '2026-10-23T00:00:00.000Z') => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, title: `t${i}`, due: '2026-11-01T00:00:00.000Z' })),
  categories: ['課題'], catReminders: {}, updatedAt: at,
});

test('health は認証なしで答える', async () => {
  const { call } = setup();
  const r = await call('GET', '/api/health', { key: null });
  assert.equal(r.status, 200);
});

test('キー未設定・短すぎるキーは 503', async () => {
  for (const APP_KEY of [undefined, 'short']) {
    const { call } = setup({ APP_KEY });
    assert.equal((await call('GET', '/api/data')).status, 503);
  }
});

test('キーなし・違うキーは 401、正しいキーは通る', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/data', { key: null })).status, 401);
  assert.equal((await call('GET', '/api/data', { key: 'x'.repeat(32) })).status, 401);
  assert.equal((await call('GET', '/api/data')).status, 200);
});

test('シークレットの前後に空白や改行があっても、キー本体で通る', async () => {
  const { call } = setup({ APP_KEY: `  ${KEY}\n` });
  assert.equal((await call('GET', '/api/data')).status, 200);
  assert.equal((await call('GET', '/api/data', { key: 'x'.repeat(32) })).status, 401);
  const blank = setup({ APP_KEY: `${' '.repeat(30)}\n` });
  assert.equal((await blank.call('GET', '/api/data')).status, 503, '空白だけは未設定として扱う');
});

test('正しいキーで入れると、その IP の失敗の記録が消える（古いキーの端末が数えた分で、正しい端末が止まらない）', async () => {
  const { call } = setup();
  const bad = { key: 'x'.repeat(32) };
  for (let i = 0; i < 9; i++) assert.equal((await call('GET', '/api/data', bad)).status, 401);
  assert.equal((await call('GET', '/api/data')).status, 200, '9回失敗のあとでも正しいキーは通る');
  for (let i = 0; i < 9; i++) assert.equal((await call('GET', '/api/data', bad)).status, 401, '記録が消えたので、さらに9回までは 429 にならない');
  assert.equal((await call('GET', '/api/data')).status, 200);
});

test('失敗の記録が無いときは、認証に成功しても D1 に書き込まない', async () => {
  const { env, call } = setup();
  await call('GET', '/api/data'); // 初期化（表の作成）を済ませる
  const writes = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql); return prepare(sql); };
  assert.equal((await call('GET', '/api/data')).status, 200);
  assert.deepEqual(writes, []);
});

test('認証の失敗が続くと 429、別の IP と時間経過で戻る', async () => {
  const { call, clock } = setup();
  for (let i = 0; i < 10; i++) assert.equal((await call('GET', '/api/data', { key: 'x'.repeat(32) })).status, 401);
  assert.equal((await call('GET', '/api/data', { key: 'x'.repeat(32) })).status, 429);
  assert.equal((await call('GET', '/api/data')).status, 429, '正しいキーでも止まる');
  assert.equal((await call('GET', '/api/data', { ip: '2.2.2.2' })).status, 200);
  clock.t += 601;
  assert.equal((await call('GET', '/api/data')).status, 200);
});

test('初回は data が null・rev 0。If-Match: 0 で保存でき rev 1 になる', async () => {
  const { call } = setup();
  const g = await call('GET', '/api/data');
  assert.deepEqual([g.body.rev, g.body.data], [0, null]);
  const p = await call('PUT', '/api/data', { body: sample(2), headers: { 'If-Match': '0' } });
  assert.equal(p.status, 201);
  assert.equal(p.body.rev, 1);
  const g2 = await call('GET', '/api/data');
  assert.equal(g2.body.rev, 1);
  assert.equal(g2.body.data.items.length, 2);
  assert.equal(g2.body.updatedAt, '2026-10-23T00:00:00.000Z');
});

test('If-Match が今の版と違うと 409（版を返す）。付けないと 428', async () => {
  const { call } = setup();
  await call('PUT', '/api/data', { body: sample(1), headers: { 'If-Match': '0' } });
  const stale = await call('PUT', '/api/data', { body: sample(3), headers: { 'If-Match': '0' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 1);
  assert.equal((await call('PUT', '/api/data', { body: sample(3) })).status, 428);
  assert.equal((await call('PUT', '/api/data', { body: sample(3), headers: { 'If-Match': 'abc' } })).status, 400);
  const ok = await call('PUT', '/api/data', { body: sample(3), headers: { 'If-Match': '1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rev, 2);
  assert.equal((await call('GET', '/api/data')).body.data.items.length, 3);
});

test('2回目の初回保存（同時に If-Match: 0 を送る）は片方だけ通る', async () => {
  const { call } = setup();
  const a = await call('PUT', '/api/data', { body: sample(1), headers: { 'If-Match': '0' } });
  const b = await call('PUT', '/api/data', { body: sample(2), headers: { 'If-Match': '0' } });
  assert.deepEqual([a.status, b.status], [201, 409]);
});

test('?force=1 は版が違っても上書きでき、必ず世代バックアップを残す', async () => {
  const { call } = setup();
  await call('PUT', '/api/data', { body: sample(1), headers: { 'If-Match': '0' } });
  const f = await call('PUT', '/api/data?force=1', { body: sample(5) });
  assert.equal(f.status, 200);
  assert.equal(f.body.rev, 2);
  const list = await call('GET', '/api/snapshots');
  assert.equal(list.body.snapshots.length, 1);
  const snap = await call('GET', `/api/snapshots/${list.body.snapshots[0].id}`);
  assert.equal(snap.body.data.items.length, 1, '上書き前の内容');
  assert.equal(snap.body.rev, 1);
});

test('?backup=1 は間隔内でも、上書き前の内容を世代バックアップに残す（版の確認は通常どおり）', async () => {
  const { call } = setup();
  await call('PUT', '/api/data', { body: sample(1), headers: { 'If-Match': '0' } });
  await call('PUT', '/api/data', { body: sample(2), headers: { 'If-Match': '1' } }); // 1件目のバックアップ
  const b = await call('PUT', '/api/data?backup=1', { body: sample(3), headers: { 'If-Match': '2' } });
  assert.equal(b.status, 200);
  assert.equal((await call('GET', '/api/snapshots')).body.snapshots.length, 2);
  const stale = await call('PUT', '/api/data?backup=1', { body: sample(4), headers: { 'If-Match': '1' } });
  assert.equal(stale.status, 409, 'backup は版の確認を飛ばさない');
});

test('世代バックアップは30分以上あいたときだけ残す', async () => {
  const { call, clock } = setup();
  await call('PUT', '/api/data', { body: sample(1), headers: { 'If-Match': '0' } });
  await call('PUT', '/api/data', { body: sample(2), headers: { 'If-Match': '1' } }); // 1件目のバックアップ
  clock.t += 60;
  await call('PUT', '/api/data', { body: sample(3), headers: { 'If-Match': '2' } }); // 間隔内なので残さない
  assert.equal((await call('GET', '/api/snapshots')).body.snapshots.length, 1);
  clock.t += 30 * 60;
  await call('PUT', '/api/data', { body: sample(4), headers: { 'If-Match': '3' } });
  const list = (await call('GET', '/api/snapshots')).body.snapshots;
  assert.equal(list.length, 2);
  assert.equal(list[0].rev, 3);
});

test('壊れた形・id の重複・大きすぎるデータは拒否する', async () => {
  const { call } = setup();
  const put = (body) => call('PUT', '/api/data?force=1', { body });
  assert.equal((await put([])).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ items: {} })).status, 400);
  assert.equal((await put({ items: [{ title: 'x' }] })).status, 400);
  assert.equal((await put({ items: [{ id: 'a' }, { id: 'a' }] })).status, 400);
  assert.equal((await put({ items: [], catColors: [] })).status, 400);
  assert.equal((await put({ items: [], trash: 'x' })).status, 400);
  assert.equal((await put({ items: [{ id: 'a', memo: 'x'.repeat(2_000_000) }] })).status, 413);
  assert.equal((await call('GET', '/api/data')).body.data, null, '拒否したデータは保存されない');
});

test('JSON でない本文は 400', async () => {
  const { env } = setup();
  const res = await worker.fetch(new Request('https://x.test/api/data?force=1', {
    method: 'PUT', headers: { Authorization: `Bearer ${KEY}` }, body: '{broken',
  }), env);
  assert.equal(res.status, 400);
});

test('日本語・絵文字・アプリの全キーがそのまま往復する', async () => {
  const { call } = setup();
  const data = {
    ...sample(1), templates: [{ id: 't', name: '臨時バイト' }], trash: [], completions: [{ id: 'c', exp: 0 }],
    catColors: { 課題: '#B2343E' }, catReminders: { 考査: [14, 7, 1, 0] }, expCarry: 0,
  };
  data.items[0].title = '📚 レポート提出 ✅';
  await call('PUT', '/api/data', { body: data, headers: { 'If-Match': '0' } });
  assert.deepEqual((await call('GET', '/api/data')).body.data, data);
});

test('未知のパス・メソッドは 404、/api/ 以外は静的ファイルへ渡す', async () => {
  const { env, call } = setup();
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  assert.equal((await call('DELETE', '/api/data')).status, 404);
  assert.equal((await call('GET', '/api/snapshots/99')).status, 404);
  env.ASSETS = { fetch: async () => new Response('page') };
  const res = await worker.fetch(new Request('https://x.test/'), env);
  assert.equal(await res.text(), 'page');
});

test('OPTIONS（プリフライト）は認証なしで 204', async () => {
  const { env } = setup();
  const res = await worker.fetch(new Request('https://x.test/api/data', { method: 'OPTIONS' }), env);
  assert.equal(res.status, 204);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /If-Match/);
});

// ---- 締切データから作る出力（feed・.ics） ----

import { readFileSync } from 'node:fs';
import { parseNow } from '../../worker/src/time.js';

const FEED_TOKEN = 't'.repeat(32);
const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/data.json', import.meta.url), 'utf8'));
const expected = (n) => readFileSync(new URL(`../expected/${n}`, import.meta.url), 'utf8');

async function withData(extra = {}) {
  const s = setup({ FEED_TOKEN, ...extra });
  s.clock.t = parseNow('2026-01-30 06:47') / 1000;
  const put = await s.call('PUT', '/api/data', { body: fixture(), headers: { 'If-Match': '0' } });
  assert.equal(put.status, 201);
  return s;
}

const get = (env, path, { ip = '1.1.1.1', key } = {}) => worker.fetch(new Request(`https://x.test${path}`, {
  headers: { 'CF-Connecting-IP': ip, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
}), env);

test('/ics/<トークン>.ics は、認証なしでメールなし・メモなしの .ics を返す（Python 版と同じ内容）', async () => {
  const { env } = await withData();
  const res = await get(env, `/ics/${FEED_TOKEN}.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/calendar/);
  assert.equal(await res.text(), expected('deadlines-nomemo.ics'));
});

test('/ics: 違うトークン・トークン未設定は 404、失敗が続くと 429。正しいトークンも止まる', async () => {
  const { env } = await withData();
  for (let i = 0; i < 10; i++) assert.equal((await get(env, `/ics/${'x'.repeat(32)}.ics`)).status, 404);
  assert.equal((await get(env, `/ics/${'x'.repeat(32)}.ics`)).status, 429);
  assert.equal((await get(env, `/ics/${FEED_TOKEN}.ics`)).status, 429);
  assert.equal((await get(env, `/ics/${FEED_TOKEN}.ics`, { ip: '2.2.2.2' })).status, 200);
  const none = await withData({ FEED_TOKEN: undefined });
  assert.equal((await get(none.env, `/ics/${FEED_TOKEN}.ics`)).status, 404);
  const short = await withData({ FEED_TOKEN: 'short' });
  assert.equal((await get(short.env, '/ics/short.ics')).status, 404);
});

test('/ics: データが空・未完了が0件でも、空のカレンダーを返す', async () => {
  const empty = setup({ FEED_TOKEN });
  const r1 = await get(empty.env, `/ics/${FEED_TOKEN}.ics`);
  assert.equal(r1.status, 200);
  assert.match(await r1.text(), /^BEGIN:VCALENDAR\r\n.*END:VCALENDAR\r\n$/s);
});

test('/ics: トークンの前後の空白は無視する', async () => {
  const { env } = await withData({ FEED_TOKEN: `\n${FEED_TOKEN} ` });
  assert.equal((await get(env, `/ics/${FEED_TOKEN}.ics`)).status, 200);
});

test('/api/ics と /api/feed は認証が要り、Python 版と同じ内容を返す', async () => {
  const { env, call } = await withData();
  assert.equal((await get(env, '/api/ics')).status, 401);
  assert.equal((await get(env, '/api/feed')).status, 401);
  assert.equal(await (await get(env, '/api/ics', { key: KEY })).text(), expected('deadlines.ics'));
  assert.equal(await (await get(env, '/api/ics?memo=0', { key: KEY })).text(), expected('deadlines-nomemo.ics'));
  const f = await call('GET', '/api/feed');
  assert.equal(`${JSON.stringify(f.body.feed, null, 2)}\n`, expected('feed.json'));
  assert.deepEqual(f.body.warnings, []);
  assert.equal((await call('GET', '/api/feed?days=abc')).status, 400);
  assert.equal((await call('GET', '/api/feed?days=999')).status, 400);
});
