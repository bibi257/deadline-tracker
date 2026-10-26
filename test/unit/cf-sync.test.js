// Cloudflare 同期の競合検出（rev ベース）。app.js の同期の関数を、本物の Worker（D1 の代わりに node:sqlite）につないで動かす。
// 再発検出: 端末の時計がずれていても、古い状態から他の端末の更新を上書きしない／409 のとき新しい rev で自動的に送り直さない
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { createD1 } from '../support/d1Shim.js';
import { loadAppFunctions } from '../support/appFns.js';

const KEY = 'k'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(() => { mock.method(console, 'log', () => {}); mock.method(console, 'error', () => {}); });
after(() => mock.restoreAll());

const FNS = [
  'cfKnownRev', 'cfSaveRev', 'cfFetchData', 'cfFetchState', 'cfPut', 'cfAskOverwrite', 'remoteHasUnknownChanges', 'fetchRemoteState',
  'runAutoSync', 'doSync', 'proceedPull', 'getRemoteText', 'autoPullWith', 'backupRemoteBeforeOverwrite', 'ghHint',
  'sanitizeIncomingItems', 'syncPayload',
];

/** 共有の Worker（1つの D1）と、複数の端末 */
function world() {
  const env = { DB: createD1(), APP_KEY: KEY, NOW: () => 1_700_000_000 };
  const log = { puts: [] };
  const fetchToWorker = (url, opts = {}) => {
    const u = new URL(url);
    if ((opts.method || 'GET') === 'PUT') log.puts.push({ search: u.search, ifMatch: opts.headers['If-Match'] });
    return worker.fetch(new Request(url, { method: opts.method, headers: { 'CF-Connecting-IP': '1.1.1.1', ...opts.headers }, body: opts.body }), env);
  };
  const api = async (method, path, body) => {
    const res = await fetchToWorker(`https://x.test${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, 'If-Match': '0' }, body: body && JSON.stringify(body) });
    return res.json();
  };

  /** 端末。updatedAt の時刻は端末ごとの時計で決まる（clock で指定） */
  function device(name, clock) {
    const mem = new Map();
    const d = {
      name, toasts: [], confirms: [], answers: [], status: { textContent: '' },
      db: { items: [], quarantine: [], updatedAt: null },
      store: { get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, String(v)) },
    };
    const g = {
      db: d.db, store: d.store, location: { origin: 'https://x.test' },
      fetch: fetchToWorker,
      toast: (m) => d.toasts.push(m),
      confirm: (m) => { d.confirms.push(m); return d.answers.length ? d.answers.shift() : false; },
      RN: () => 'Cloudflare', markSynced() {}, markPulled() {}, saveRaw() {}, render() {}, softRender() {},
      normalizeTrash: (x) => x, cleanCatReminders: (x) => x, cleanCatColors: (x) => x, adoptCompletions() {},
      sanitizeIncomingMeta: () => ({ templates: null, categories: null }),
      _autoSyncBlockedShown: false, _staleNoticeShown: false, CF_REV_KEY: 'cf-known-rev',
      utf8ToBase64: () => '', hoursSincePulled: () => null,
    };
    d.ctx = loadAppFunctions(FNS, g);
    d.cfg = { kind: 'cf', api: 'https://x.test/api/data', headers: { Authorization: `Bearer ${KEY}` } };
    /** 締切を編集する（この端末の時計で updatedAt が付く） */
    d.edit = (title) => { d.db.items = [{ id: `i-${title}`, title, due: '2026-12-01T00:00:00.000Z' }]; d.db.updatedAt = clock(); };
    d.sync = async () => { d.ctx.doSync(d.cfg, d.status, false); await sleep(150); };
    d.pull = async () => { d.ctx.proceedPull(d.cfg, d.status); await sleep(150); };
    d.auto = async () => { d.ctx.runAutoSync(d.cfg); await sleep(150); };
    d.autoPull = async () => { d.ctx.autoPullWith(d.cfg); await sleep(150); };
    return d;
  }
  return { env, api, log, device, server: () => api('GET', '/api/data'), snapshots: () => api('GET', '/api/snapshots') };
}

const titles = (r) => r.data.items.map((i) => i.title);
const mine = (d) => Array.from(d.db.items, (i) => i.title); // vm の中で作られた配列は、そのままでは deepEqual できない

test('同期に成功すると、応答の rev を「最後に確認した版」として保存する。読み込みでも保存する', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('課題1');
  await A.sync();
  assert.equal(A.ctx.cfKnownRev(), '1');
  assert.deepEqual(w.log.puts[0], { search: '', ifMatch: '0' }, '初回は If-Match: 0');
  A.edit('課題2');
  await A.sync();
  assert.equal(A.ctx.cfKnownRev(), '2');
  assert.equal(w.log.puts[1].ifMatch, '1', 'If-Match には保存済みの rev を送る');
  const B = w.device('B', () => '2026-10-26T10:00:00.000Z');
  await B.pull();
  assert.equal(B.ctx.cfKnownRev(), '2');
  assert.deepEqual(mine(B), ['課題2']);
});

test('時計が進んだ端末 A が、時計の遅れた端末 B の更新を、確認なしで上書きしない（旧: updatedAt の比較で素通りしていた）', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-30T00:00:00.000Z'); // 時計が進んでいる
  const B = w.device('B', () => '2026-10-26T00:00:00.000Z'); // 時計が遅れている
  A.edit('A最初');
  await A.sync(); // rev1。A の known updatedAt は 10/30
  await B.pull();
  B.edit('Bの更新');
  await B.sync(); // rev2。updatedAt は 10/26（A の known より古い）
  assert.equal((await w.server()).rev, 2);

  A.edit('Aの更新');
  A.answers = [false, false]; // 上書きしない → 読み込みの確認も断る
  await A.sync();
  assert.match(A.confirms[0], /まだ読み込んでいない新しい内容/, '確認が出る');
  const s = await w.server();
  assert.deepEqual(titles(s), ['Bの更新'], 'B の更新は残っている');
  assert.equal(s.rev, 2);
  assert.equal(w.log.puts.length, 2, 'A は送っていない');
});

test('自動同期: 他の端末の更新があるときは止めて知らせる（時計がずれていても）', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-30T00:00:00.000Z');
  const B = w.device('B', () => '2026-10-26T00:00:00.000Z');
  A.edit('A最初');
  await A.sync();
  await B.pull();
  B.edit('Bの更新');
  await B.sync();
  const before = w.log.puts.length;
  A.edit('Aの更新');
  await A.auto();
  assert.equal(w.log.puts.length, before, '送らない');
  assert.match(A.toasts.join('\n'), /自動同期を止めました/);
  assert.deepEqual(titles(await w.server()), ['Bの更新']);
});

test('409（確認のあとに他の端末が更新した）のとき、新しい rev で自動的に送り直さない。自動同期は止めて知らせる', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const B = w.device('B', () => '2026-10-26T10:00:00.000Z');
  A.edit('A最初');
  await A.sync();
  await B.pull();
  B.edit('Bの更新');
  await B.sync(); // サーバーは rev2。A の known は 1
  // A の「確認」が、更新の前の古い状態を返した場合（確認と送信の間に B が更新した状況）を作る
  A.ctx.fetchRemoteState = async () => ({ cf: true, sha: '1', updatedAt: null, itemCount: 1 });
  const before = w.log.puts.length;
  A.edit('Aの更新');
  await A.auto();
  assert.equal(w.log.puts.length, before + 1, '送ったのは1回だけ（409 のあと再送しない）');
  assert.equal(w.log.puts.at(-1).ifMatch, '1');
  assert.match(A.toasts.join('\n'), /自動同期を止めました/);
  assert.deepEqual(titles(await w.server()), ['Bの更新']);
});

test('手動同期の 409: 新しい rev で再送せず、読み込みか「バックアップ付きで上書き」を選ばせる', async () => {
  const setup = async () => {
    const w = world();
    const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
    const B = w.device('B', () => '2026-10-26T10:00:00.000Z');
    A.edit('A最初');
    await A.sync();
    await B.pull();
    B.edit('Bの更新');
    await B.sync(); // サーバーは rev2。A の known は 1
    // 最初の「確認」だけ、更新の前の古い状態を返す（確認と送信の間に B が更新した状況）。2回目以降は本当の状態
    const real = A.ctx.fetchRemoteState;
    let first = true;
    A.ctx.fetchRemoteState = (cfg) => (first ? ((first = false), Promise.resolve({ cf: true, sha: '1', updatedAt: null, itemCount: 1 })) : real(cfg));
    A.edit('Aの更新');
    return { w, A };
  };

  // 上書きしない → 読み込みの確認も断る: PUT は 409 の1回だけで、送り直さない。サーバーは変わらない
  let { w, A } = await setup();
  A.answers = [false, false];
  const before = w.log.puts.length;
  await A.sync();
  assert.equal(w.log.puts.length, before + 1, 'PUT は1回だけ（409 のあと自動で再送しない）');
  assert.equal(w.log.puts.at(-1).ifMatch, '1');
  assert.match(A.confirms[0], /世代バックアップ/, '選ばせる確認が出る');
  assert.match(A.confirms[1], /置き換えます/, '「読み込む」を選ぶと、置き換えの確認が出る');
  assert.deepEqual(titles(await w.server()), ['Bの更新']);

  // 読み込みを選ぶ: この端末が Cloudflare の内容になる
  ({ w, A } = await setup());
  A.answers = [false, true];
  await A.sync();
  assert.deepEqual(mine(A), ['Bの更新']);
  assert.equal(A.ctx.cfKnownRev(), '2');

  // バックアップ付きで上書きを選ぶ: 確認した版（2）を If-Match に付け、?backup=1 で送る
  ({ w, A } = await setup());
  A.answers = [true];
  await A.sync();
  assert.equal(w.log.puts.at(-1).search, '?backup=1');
  assert.equal(w.log.puts.at(-1).ifMatch, '2');
  assert.deepEqual(titles(await w.server()), ['Aの更新']);
});

test('バックアップ付きで上書きを選ぶと、上書き前の内容が世代バックアップに残り、新しい rev を保存する', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const B = w.device('B', () => '2026-10-26T10:00:00.000Z');
  A.edit('A最初');
  await A.sync();
  await B.pull();
  B.edit('Bの更新');
  await B.sync(); // rev2（間隔内なので、バックアップは?backup=1 が無いと残らない）
  const snapsBefore = (await w.snapshots()).snapshots.length;
  A.edit('Aの更新');
  A.answers = [true]; // バックアップ付きで上書き
  await A.sync();
  const put = w.log.puts.at(-1);
  assert.equal(put.search, '?backup=1');
  assert.equal(put.ifMatch, '2', '承知の上で上書きする対象は、いま確認した版');
  const s = await w.server();
  assert.deepEqual(titles(s), ['Aの更新']);
  assert.equal(A.ctx.cfKnownRev(), String(s.rev));
  const snaps = (await w.snapshots()).snapshots;
  assert.equal(snaps.length, snapsBefore + 1, '世代バックアップが1つ増える');
  const snap = await w.api('GET', `/api/snapshots/${snaps[0].id}`);
  assert.deepEqual(snap.data.items.map((i) => i.title), ['Bの更新'], '残ったのは上書きされた B の内容');
});

test('一度も読み込み・同期していない端末は、既存の内容を知らない扱い（自動では上書き・反映しない）', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('A最初');
  await A.sync();
  const C = w.device('C', () => '2026-10-26T10:00:00.000Z');
  C.edit('Cの手元');
  assert.equal(C.ctx.remoteHasUnknownChanges({ cf: true, sha: '1' }), true);
  assert.equal(C.ctx.remoteHasUnknownChanges({ cf: true, sha: null }), false, 'サーバーにまだ無ければ問題なし');
  await C.autoPull();
  assert.deepEqual(mine(C), ['Cの手元'], '自動では取り込まない');
});

test('自動反映: この端末に未同期の変更が無ければ、rev が進んだ内容を取り込む（他の端末の時計に左右されない）', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const B = w.device('B', () => '2026-10-20T00:00:00.000Z'); // 時計が遅れている端末の更新
  A.edit('A最初');
  await A.sync();
  await B.pull();
  A.edit('Aの更新');
  await A.sync(); // rev2
  await B.autoPull();
  assert.deepEqual(mine(B), ['Aの更新']);
  assert.equal(B.ctx.cfKnownRev(), '2');
  // この端末に未同期の変更があるときは、自動では上書きしない
  B.edit('Bの手元');
  A.edit('Aの更新2');
  await A.sync(); // rev3
  await B.autoPull();
  assert.deepEqual(mine(B), ['Bの手元']);
  assert.equal(B.ctx.cfKnownRev(), '2');
});
