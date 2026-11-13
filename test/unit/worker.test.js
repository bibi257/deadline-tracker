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
  assert.equal((await put({ items: [{ id: 'a', pick: 5 }] })).status, 400, '今日の一手の印が文字列でない');
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

test('CORS は許可しない: どの API の応答にも Access-Control-* が付かず、OPTIONS（プリフライト）も許可しない', async () => {
  const { env } = setup();
  const origin = { Origin: 'https://evil.test', 'CF-Connecting-IP': '1.1.1.1' };
  const calls = [
    worker.fetch(new Request('https://x.test/api/health', { headers: origin }), env),
    worker.fetch(new Request('https://x.test/api/data', { headers: origin }), env), // 401
    worker.fetch(new Request('https://x.test/api/data', { headers: { ...origin, Authorization: `Bearer ${KEY}` } }), env),
    worker.fetch(new Request('https://x.test/api/data', { method: 'OPTIONS', headers: { ...origin, 'Access-Control-Request-Method': 'PUT' } }), env),
  ];
  for (const res of await Promise.all(calls)) {
    for (const [name] of res.headers) assert.doesNotMatch(name, /^access-control-/i, `${res.status}: ${name}`);
  }
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

// 購読用だけに足す3行（カレンダー名・更新間隔）。それ以外は Python 版の .ics（メモなし）と1文字まで同じ
const SUBSCRIBE_LINES = 'X-WR-CALNAME:締切トラッカー\r\nREFRESH-INTERVAL;VALUE=DURATION:PT1H\r\nX-PUBLISHED-TTL:PT1H\r\n';
const withSubscribeLines = (ics) => ics.replace('METHOD:PUBLISH\r\n', `METHOD:PUBLISH\r\n${SUBSCRIBE_LINES}`);

test('/ics/<トークン>.ics は、認証なしでメールなし・メモなしの .ics を返す（Python 版の内容に、カレンダー名と更新間隔の3行だけを足したもの）', async () => {
  const { env } = await withData();
  const res = await get(env, `/ics/${FEED_TOKEN}.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/calendar/);
  const body = await res.text();
  assert.equal(body, withSubscribeLines(expected('deadlines-nomemo.ics')));
  assert.notEqual(body, expected('deadlines-nomemo.ics'), '3行が足されている');
});

test('/api/ics（アプリの書き出し）には、購読用の3行を足さない。出力は今までと同じ', async () => {
  const { env, call } = await withData();
  const res = await get(env, '/api/ics?memo=0', { key: KEY });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.doesNotMatch(body, /X-WR-CALNAME|REFRESH-INTERVAL|X-PUBLISHED-TTL/);
  assert.equal(body, expected('deadlines-nomemo.ics'));
});

test('GET /api/feed-url: 認証が必要。FEED_TOKEN があれば購読用 URL を返す。未設定・短すぎるときは ok:false', async () => {
  const { env } = await withData();
  assert.equal((await get(env, '/api/feed-url')).status, 401, '認証なしは通らない');
  const res = await get(env, '/api/feed-url', { key: KEY });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: true, url: `https://x.test/ics/${FEED_TOKEN}.ics` });
  // 返した URL で、実際に購読用の .ics が取れる
  assert.equal((await get(env, `/ics/${FEED_TOKEN}.ics`)).status, 200);
  for (const FEED of [undefined, 'short', '   ']) {
    const s = setup({ FEED_TOKEN: FEED });
    const r = await get(s.env, '/api/feed-url', { key: KEY });
    assert.deepEqual(await r.json(), { ok: false }, String(FEED));
  }
  const spaced = setup({ FEED_TOKEN: `\n${FEED_TOKEN} ` });
  assert.equal((await (await get(spaced.env, '/api/feed-url', { key: KEY })).json()).url, `https://x.test/ics/${FEED_TOKEN}.ics`, '前後の空白は取り除く');
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
  const empty1 = await r1.text();
  assert.match(empty1, /^BEGIN:VCALENDAR\r\n.*END:VCALENDAR\r\n$/s);
  assert.ok(empty1.includes(SUBSCRIBE_LINES), '空でも、カレンダー名と更新間隔は付ける');
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

test('snapshots の at に索引がある。保存時の MAX(at) は全行を読まず、索引で引く', async () => {
  const { env, call } = setup();
  assert.equal((await call('PUT', '/api/data', { body: { items: [] }, headers: { 'If-Match': '0' } })).status, 201);
  const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'snapshots'").all();
  assert.ok(idx.results.some((r) => r.name === 'snapshots_at'), '索引 snapshots_at');
  const plan = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT MAX(at) AS at FROM snapshots').all();
  assert.match(plan.results.map((r) => r.detail).join(' '), /snapshots_at/, 'MAX(at) が索引を使う');
});

test('GET /api/ics?dayHour=: 当日リマインドの時刻を指定できる（アプリの設定は端末ごとなので、アプリが渡す）。範囲外は 400', async () => {
  const { env } = setup();
  const data = { items: [{ id: 'd1', title: '当日の通知', due: '2026-02-03T08:00:00.000Z', cat: '課題' }] }; // 17:00 JST
  await worker.fetch(new Request('https://x.test/api/data', { method: 'PUT', headers: { Authorization: `Bearer ${KEY}`, 'If-Match': '0', 'CF-Connecting-IP': '1.1.1.1' }, body: JSON.stringify(data) }), env);
  const get = async (q) => worker.fetch(new Request(`https://x.test/api/ics${q}`, { headers: { Authorization: `Bearer ${KEY}`, 'CF-Connecting-IP': '1.1.1.1' } }), env);
  const nine = await (await get('')).text();
  const eight = await (await get('?dayHour=8')).text();
  assert.match(nine, /TRIGGER;VALUE=DATE-TIME:20260203T000000Z/, '既定は 9 時（UTC 0 時）');
  assert.match(eight, /TRIGGER;VALUE=DATE-TIME:20260202T230000Z/, '8 時（UTC 前日 23 時）');
  assert.equal(await (await get('?dayHour=9')).text(), nine, '9 を明示しても同じ');
  for (const bad of ['?dayHour=24', '?dayHour=-1', '?dayHour=x', '?dayHour=', '?dayHour=9.5']) assert.equal((await get(bad)).status, 400, bad);
});

test('GET /api/data: 保存してある JSON を解析し直さずに返す。中身・rev・時刻は変わらず、記号・絵文字・改行を含んでも壊れない', async () => {
  const { env, call } = setup();
  const data = {
    items: [{ id: 'a', title: '改行\n引用"と\\と</script>と と😀と𠮷', due: '2026-11-01T00:00:00.000Z', memo: '{"入れ子":[1,2,{"x":null}]}' }],
    categories: ['課題'], catReminders: {}, updatedAt: '2026-10-23T00:00:00.000Z',
  };
  assert.equal((await call('PUT', '/api/data', { body: data, headers: { 'If-Match': '0' } })).status, 201);
  const r = await call('GET', '/api/data');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, data);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.rev, 1);
  assert.equal(r.body.updatedAt, '2026-10-23T00:00:00.000Z');
  assert.ok(r.body.savedAt, '保存した時刻');
  // JSON の解析・再変換をしない（Worker の CPU 時間のため）。巨大なデータの GET で JSON.parse が呼ばれない
  const real = JSON.parse;
  let parsed = 0;
  JSON.parse = (...a) => { parsed += 1; return real(...a); };
  try {
    const res = await worker.fetch(new Request('https://x.test/api/data', { headers: { Authorization: `Bearer ${KEY}`, 'CF-Connecting-IP': '1.1.1.1' } }), env);
    await res.text(); // 応答の本文を読む（テスト側の解析は含めない）
  } finally { JSON.parse = real; }
  assert.equal(parsed, 0, 'GET /api/data は JSON.parse を呼ばない');
});

test('Z の無い日時（端末の時刻＝JST で書かれたもの）は JST として数える。feed・.ics・朝の一覧が9時間ずれない', async () => {
  const { env, call, clock } = setup();
  clock.t = Date.parse('2026-10-24T00:00:00.000Z') / 1000; // JST の 10/24 9:00
  const data = { items: [{ id: 'z1', title: 'Z無し', due: '2026-10-25T09:00', cat: '仕事' }], categories: ['仕事'], catReminders: {}, updatedAt: '2026-10-24T00:00:00.000Z' };
  assert.equal((await call('PUT', '/api/data', { body: data, headers: { 'If-Match': '0' } })).status, 201);
  const feed = await call('GET', '/api/feed?days=14');
  assert.deepEqual([feed.body.feed.items[0].due_date, feed.body.feed.items[0].due_time], ['2026-10-25', '09:00']);
  const digest = await call('GET', '/api/digest?kind=morning');
  assert.ok(digest.body.chunks.join('\n').includes('Z無し'), '朝の一覧に出る');
  assert.deepEqual(digest.body.warnings, [], '読めない項目として外さない');
  const ics = await worker.fetch(new Request('https://x.test/api/ics', { headers: { Authorization: `Bearer ${KEY}`, 'CF-Connecting-IP': '1.1.1.1' } }), env);
  assert.match(await ics.text(), /DTEND:20261025T000000Z/, '締切 9:00 JST は 0:00Z');
});

test('保存: 繰り返し・回数・基準日・取りやめ・完了などの型が合わないものは 400 で保存しない。アプリが書く正しい形は通る', async () => {
  const { call } = setup();
  const data = (extra) => ({ items: [{ id: 'a', title: 't', due: '2026-11-01T00:00:00.000Z', cat: '仕事', ...extra }], categories: ['仕事'], catReminders: {}, updatedAt: '2026-10-23T00:00:00.000Z' });
  const bad = [{ rep: 'daily' }, { repCount: '3' }, { repDay: '15' }, { seq: 1.5 }, { skip: ['2026/10/25'] }, { skip: 'x' }, { pick: '10/25' }, { done: 'yes' }, { allDay: 1 }, { autoComplete: 'true' }, { calHide: 0 }];
  for (const extra of bad) {
    assert.equal((await call('PUT', '/api/data', { body: data(extra), headers: { 'If-Match': '0' } })).status, 400, JSON.stringify(extra));
  }
  const good = { rep: 'monthly', repCount: 4, repDay: 15, seq: 2, skip: ['2026-10-25'], pick: '2026-10-25', done: false, allDay: true, autoComplete: true, calHide: false };
  assert.equal((await call('PUT', '/api/data', { body: data(good), headers: { 'If-Match': '0' } })).status, 201);
});

test('保存: 既存のデータの形（テスト用のフィクスチャ）は、すべて保存できる', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['data.json', 'data-old.json', 'data-long.json', 'data-ties.json']) {
    const { call } = setup();
    const body = JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));
    assert.equal((await call('PUT', '/api/data', { body, headers: { 'If-Match': '0' } })).status, 201, f);
  }
});

test('GET /api/snapshots/:id: 保存してある JSON を解析し直さずに返す。中身・版・時刻は変わらず、記号・絵文字・改行も壊れない', async () => {
  const { call, env, clock } = setup();
  const data = { ...sample(1), items: [{ id: 'a', title: '日本語🎌 "引用" \\ \u2028 </script>', due: '2026-11-01T00:00:00.000Z', memo: 'a\nb\tc' }] };
  await call('PUT', '/api/data', { body: data, headers: { 'If-Match': '0' } });
  clock.t += 3600;
  await call('PUT', '/api/data', { body: sample(2), headers: { 'If-Match': '1' } }); // 1回目の内容が世代バックアップに残る
  const list = (await call('GET', '/api/snapshots')).body.snapshots;
  assert.equal(list.length, 1);
  const r = await call('GET', `/api/snapshots/${list[0].id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, id: list[0].id, at: list[0].at, rev: 1, data });
  const res = await worker.fetch(new Request(`https://x.test/api/snapshots/${list[0].id}`, { headers: { Authorization: `Bearer ${KEY}`, 'CF-Connecting-IP': '1.1.1.1' } }), env);
  assert.match(res.headers.get('Content-Type'), /^application\/json/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal((await call('GET', '/api/snapshots/99999')).status, 404);
});

/** D1 の各操作の前に他の処理へ順番を譲る（同時に届いた2つの要求が、確認と書き込みの間で本当に割り込み合うようにする） */
function yielding(db) {
  const tick = () => new Promise((r) => setImmediate(r));
  const wrap = (st) => ({
    _inner: st,
    bind: (...p) => wrap(st.bind(...p)),
    first: async (c) => { await tick(); return st.first(c); },
    all: async () => { await tick(); return st.all(); },
    run: async () => { await tick(); return st.run(); },
  });
  return { prepare: (sql) => wrap(db.prepare(sql)), batch: async (l) => { await tick(); return db.batch(l.map((s) => s._inner)); } };
}

test('同時保存: 同じ rev を If-Match に付けた2つの保存が確認と書き込みの間で割り込み合っても、片方だけ通り、もう片方は 409。版は1つだけ進む', async () => {
  const { call } = setup({ DB: yielding(createD1()) });
  await call('PUT', '/api/data', { body: sample(1), headers: { 'If-Match': '0' } });
  const [a, b] = await Promise.all([
    call('PUT', '/api/data', { body: sample(2), headers: { 'If-Match': '1' } }),
    call('PUT', '/api/data', { body: sample(3), headers: { 'If-Match': '1' } }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const s = (await call('GET', '/api/data')).body;
  assert.equal(s.rev, 2, '版は1つだけ進む');
  assert.equal(s.data.items.length, a.status === 200 ? 2 : 3, '通った側の内容が残る（もう片方に上書きされない）');
  // 初回（If-Match: 0）の同時保存も、片方だけ
  const w = setup({ DB: yielding(createD1()) });
  const [c, d] = await Promise.all([
    w.call('PUT', '/api/data', { body: sample(1), headers: { 'If-Match': '0' } }),
    w.call('PUT', '/api/data', { body: sample(2), headers: { 'If-Match': '0' } }),
  ]);
  assert.deepEqual([c.status, d.status].sort(), [201, 409]);
  assert.equal((await w.call('GET', '/api/data')).body.rev, 1);
});

test('カテゴリーのアイコン: PNG・WebP の data URL で上限以下なら保存できる。SVG・http の URL・大きすぎる値・文字列でない値は 400', async () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const { call } = setup();
  const put = (catIcons, rev) => call('PUT', '/api/data', { headers: { 'If-Match': String(rev) }, body: { ...sample(), catIcons } });
  assert.equal((await put({ 課題: PNG, 仕事: 'data:image/webp;base64,UklGRg==' }, 0)).status, 201);
  assert.deepEqual((await call('GET', '/api/data')).body.data.catIcons, { 課題: PNG, 仕事: 'data:image/webp;base64,UklGRg==' });
  for (const bad of [
    { a: 'data:image/svg+xml;base64,PHN2Zz4=' }, { a: 'https://example.com/x.png' }, { a: 'data:image/png;base64,iVBOR"onerror=x' },
    { a: `data:image/png;base64,${'A'.repeat(11000)}` }, { a: 5 }, ['x'],
  ]) assert.equal((await put(bad, 1)).status, 400, JSON.stringify(bad).slice(0, 40));
  assert.equal((await put(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, PNG])), 1)).status, 400, '多すぎる');
});

test('カテゴリーのアイコン: catIcons を送らない古い版のアプリが保存しても、保存してあるアイコンは残る。新しい版が {} を送れば消える', async () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const { call } = setup();
  const put = (body, rev) => call('PUT', '/api/data', { headers: { 'If-Match': String(rev) }, body });
  assert.equal((await put({ ...sample(), catIcons: { 課題: PNG } }, 0)).status, 201);
  assert.equal((await put(sample(2), 1)).status, 200); // 古い版：catIcons なし
  const got = (await call('GET', '/api/data')).body.data;
  assert.deepEqual(got.catIcons, { 課題: PNG });
  assert.equal(got.items.length, 2, 'ほかの内容は送られたもので置き換わる');
  assert.equal((await put({ ...sample(), catIcons: {} }, 2)).status, 200);
  assert.deepEqual((await call('GET', '/api/data')).body.data.catIcons, {});
});

test('保存 API: 値の意味も確かめる。題名が空・実在しない日付・範囲外の回数や日・開始が締切より後は 400。範囲の端と正しいデータは通る', async () => {
  const { call } = setup();
  const item = { id: 'v1', title: 't', due: '2026-11-20T08:00:00.000Z' };
  let rev = 0;
  const put = async (patch) => call('PUT', '/api/data', { headers: { 'If-Match': String(rev) }, body: { items: [{ ...item, ...patch }] } });
  for (const [patch, word] of [
    [{ title: '  ' }, 'title'], [{ due: '2026-02-30T00:00:00.000Z' }, 'due'], [{ due: 'あした' }, 'due'], [{ start: '2026-13-01T00:00:00.000Z' }, 'start'],
    [{ repCount: -1 }, 'repCount'], [{ repDay: 0 }, 'repDay'], [{ repDay: 32 }, 'repDay'], [{ seq: -1 }, 'seq'],
    [{ start: '2026-11-21T00:00:00.000Z' }, 'start が due より後'],
  ]) {
    const r = await put(patch);
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.ok(r.body.error.includes(word) && r.body.error.includes('v1'), r.body.error);
    assert.ok(!r.body.error.includes('あした'), '値そのものは返さない');
  }
  for (const patch of [{}, { start: '2026-11-19T08:00:00.000Z', repCount: 0, repDay: 31, seq: 0 }, { repDay: 1, repCount: 12, rep: 'monthly' }, { start: item.due }]) {
    const r = await put(patch);
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(patch));
    rev += 1;
  }
});

test('取り込みの除外リスト（wcExcluded）: 形と上限を確かめる。古い版のアプリが送らなくても、保存してある分は残る', async () => {
  const { call } = setup();
  const put = (body, rev) => call('PUT', '/api/data', { headers: { 'If-Match': String(rev) }, body });
  const ex = [{ k: '0123456789abcdef', due: '2026-11-20 23:59', at: '2026-11-13' }];
  assert.equal((await put({ ...sample(), wcExcluded: ex }, 0)).status, 201);
  for (const bad of [[{ k: 'xyz', due: '', at: '' }], [{ k: '0123456789abcdef', due: 5, at: '' }], ['s'], { a: 1 }]) {
    assert.equal((await put({ ...sample(), wcExcluded: bad }, 1)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await put({ ...sample(), wcExcluded: Array.from({ length: 5001 }, () => ex[0]) }, 1)).status, 400, '多すぎる');
  assert.equal((await put(sample(2), 1)).status, 200); // 古い版：wcExcluded なし
  assert.deepEqual((await call('GET', '/api/data')).body.data.wcExcluded, ex);
  assert.equal((await put({ ...sample(), wcExcluded: [] }, 2)).status, 200);
  assert.deepEqual((await call('GET', '/api/data')).body.data.wcExcluded, []);
  assert.equal((await put({ ...sample(), items: [{ id: 'w1', title: 't', due: '2026-11-20T00:00:00.000Z', wc: 5 }] }, 3)).status, 400, 'wc は文字列');
});
