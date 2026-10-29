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
  'sanitizeIncomingItems', 'syncPayload', 'refreshThenAutoComplete', 'autoCompleteOverdueItems', 'cfAutoBlocked', 'cfNoteAuthFailure',
  'cfSnapUrl', 'cfGetJson', 'cfFetchSnapshots', 'cfReadSnapshot', 'fmtSnapAt', 'cfRestoreSnapshot',
];

/** 共有の Worker（1つの D1）と、複数の端末 */
function world() {
  const env = { DB: createD1(), APP_KEY: KEY, NOW: () => 1_700_000_000 };
  const log = { puts: [], calls: 0 };
  const fetchToWorker = (url, opts = {}) => {
    const u = new URL(url);
    log.calls += 1;
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
      // 起動時の「取り込み → 自動完了」用（本物の applyCompletion / save は画面まわりに依存するので、同じ効果だけ再現する）
      _cfAuthStopped: false, _cfLimitShown: false, _refreshing: null, autoPullIfStale: () => d.ctx.autoPullWith(d.cfg),
      parseItemDate: (it) => new Date(it.due), applyCompletion: (it) => { it.done = true; },
      save: () => { d.db.updatedAt = clock(); }, scheduleAutoSync() {},
    };
    d.ctx = loadAppFunctions(FNS, g);
    d.cfg = { kind: 'cf', api: 'https://x.test/api/data', headers: { Authorization: `Bearer ${KEY}` } };
    /** 締切を編集する（この端末の時計で updatedAt が付く） */
    d.edit = (title) => { d.db.items = [{ id: `i-${title}`, title, due: '2026-12-01T00:00:00.000Z' }]; d.db.updatedAt = clock(); };
    d.sync = async () => { d.ctx.doSync(d.cfg, d.status, false); await sleep(150); };
    d.pull = async () => { d.ctx.proceedPull(d.cfg, d.status); await sleep(150); };
    d.auto = async () => { d.ctx.runAutoSync(d.cfg); await sleep(150); };
    d.start = async () => { await d.ctx.refreshThenAutoComplete(); }; // 起動時の処理
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

test('起動時: 自動完了より先に他の端末の更新を取り込む。端末 B は A の内容を取り込み、続く同期も 409 にならない', async () => {
  const w = world();
  let t = 0;
  const A = w.device('A', () => new Date(Date.UTC(2026, 9, 26, 10, 0, t++)).toISOString());
  const B = w.device('B', () => new Date(Date.UTC(2026, 9, 26, 10, 0, t++)).toISOString());
  const overdue = (d) => { d.db.items = [{ id: 'i1', title: '期限切れ', due: '2020-01-01T00:00:00.000Z', autoComplete: true }]; d.db.updatedAt = '2026-10-26T09:00:00.000Z'; };
  overdue(A);
  await A.sync();
  await B.pull(); // B も同じ予定を持っている（期限切れ・自動完了つき）
  await A.start(); // A が起動して自動完了 → 同期
  assert.equal(A.db.items[0].done, true);
  await A.sync();
  await B.start(); // B が起動: 先に A の更新を取り込んでから、自動完了を確かめる
  assert.equal(B.db.items[0].done, true, 'A の自動完了を取り込めている');
  assert.ok(!B.toasts.some((m) => m.includes('自動反映していません')), '未同期の変更ありとして止められていない');
  await B.sync(); // 続く同期（rev が一致するので 409 にならない）
  assert.equal(B.confirms.length, 0, '上書きの確認が出ない');
  assert.equal(B.ctx.cfKnownRev(), String((await w.server()).rev));
});

test('起動時: 取り込む内容が無い端末でも、期限切れの自動完了は行う', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.db.items = [{ id: 'i1', title: '期限切れ', due: '2020-01-01T00:00:00.000Z', autoComplete: true }];
  await A.start(); // 同期の記録が無い端末（取り込みは何もしない）
  assert.equal(A.db.items[0].done, true);
});

test('アクセスキーが違う端末: 401 を受けたら自動の通信を止め、一度だけ知らせる（同じ回線の端末を締め出さない）', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.cfg.headers = { Authorization: `Bearer ${'x'.repeat(32)}` }; // 古い・違うキー
  A.edit('手元');
  await A.autoPull();
  assert.equal(w.log.calls, 1);
  assert.equal(A.toasts.filter((m) => m.includes('アクセスキーが違う')).length, 1);
  await A.autoPull();
  await A.auto(); // 自動同期
  await A.autoPull();
  assert.equal(w.log.calls, 1, '止めたあとは fetch しない');
  assert.equal(A.toasts.filter((m) => m.includes('アクセスキーが違う')).length, 1, '知らせるのは一度だけ');
  // 正しいキーを入れ直した（cfConfigFromUI が止めた印を戻す）あとは、また通信する
  A.ctx._cfAuthStopped = false;
  A.cfg.headers = { Authorization: `Bearer ${KEY}` };
  await A.autoPull();
  assert.ok(w.log.calls > 1);
});

test('429（すでに止められている）のときは、理由を一度だけ知らせる。自動の通信は止めない（10分で戻るため）', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.cfg.headers = { Authorization: `Bearer ${'x'.repeat(32)}` };
  for (let i = 0; i < 10; i++) { A.ctx._cfAuthStopped = false; await A.autoPull(); } // 同じ IP で失敗を10回重ねる
  A.toasts.length = 0;
  A.ctx._cfAuthStopped = false;
  await A.autoPull(); // 429
  await A.autoPull();
  assert.equal(A.toasts.filter((m) => m.includes('しばらく使えません')).length, 1);
  assert.equal(A.ctx._cfAuthStopped, false, '429 では止めない');
});

test('世代バックアップ: 一覧 → 中身 → 戻す。戻す前の内容も世代バックアップに残り、使ったバックアップは消えない', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('v1');
  await A.sync(); // rev1（初回の保存では世代バックアップは作らない）
  A.edit('v2');
  await A.sync(); // rev2。上書きされる v1 が世代バックアップに残る
  A.edit('v3');
  await A.sync(); // rev3（前回から30分以内なので、新しいバックアップは作らない）

  const list = await A.ctx.cfFetchSnapshots(A.cfg);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].rev, typeof list[0].size], [1, 'number']);
  const snap = await A.ctx.cfReadSnapshot(A.cfg, list[0].id);
  assert.deepEqual(snap.data.items.map((i) => i.title), ['v1']);

  const before = w.log.puts.length;
  const r = await A.ctx.cfRestoreSnapshot(A.cfg, snap.data);
  assert.equal(r.n, 1);
  const put = w.log.puts[before];
  assert.equal(put.search, '?backup=1', '戻すときは、今の内容を必ず世代バックアップに残す');
  assert.equal(put.ifMatch, '3', '今の版を確かめたうえで置き換える');
  assert.deepEqual(titles(await w.server()), ['v1'], 'Cloudflare は v1 の内容に戻る');
  assert.equal((await w.server()).rev, 4);
  assert.deepEqual(mine(A), ['v1'], 'この端末のデータも置き換わる');
  assert.equal(A.ctx.cfKnownRev(), '4');
  assert.equal(A.store.get('gh-known-updatedAt'), A.db.updatedAt, '同期済みの状態になる');

  const after = (await w.snapshots()).snapshots;
  assert.equal(after.length, 2, '戻す前の内容（v3）が新しい世代バックアップに残る');
  assert.ok(after.some((s) => s.id === list[0].id), '使ったバックアップは消えない');
  const kept = await w.api('GET', `/api/snapshots/${after.find((s) => s.id !== list[0].id).id}`);
  assert.deepEqual(kept.data.items.map((i) => i.title), ['v3']);
});

test('世代バックアップ: 戻すのに失敗したら、この端末のデータは変えない。キー違いは 401、無い世代は 404', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('v1');
  await A.sync();
  A.edit('v2');
  await A.sync();
  const [first] = await A.ctx.cfFetchSnapshots(A.cfg);
  const snap = await A.ctx.cfReadSnapshot(A.cfg, first.id);

  const wrong = { ...A.cfg, headers: { Authorization: `Bearer ${'x'.repeat(32)}` } };
  const e1 = await A.ctx.cfRestoreSnapshot(wrong, snap.data).catch((x) => x);
  assert.equal(e1.status, 401);
  assert.deepEqual(mine(A), ['v2'], '失敗したときは、この端末のデータを変えない');
  assert.deepEqual(titles(await w.server()), ['v2']);

  const e2 = await A.ctx.cfReadSnapshot(A.cfg, 9999).catch((x) => x);
  assert.equal(e2.status, 404);
});

test('世代バックアップ: 日時は日本時間の「YYYY/M/D HH:MM」', () => {
  const A = world().device('A', () => '2026-10-26T10:00:00.000Z');
  assert.equal(A.ctx.fmtSnapAt(1_700_000_000), '2023/11/15 07:13'); // 2023-11-14T22:13:20Z
  assert.equal(A.ctx.fmtSnapAt(Date.UTC(2026, 0, 1, 14, 59) / 1000), '2026/1/1 23:59');
  assert.equal(A.ctx.cfSnapUrl({ api: 'https://x.test/api/data' }), 'https://x.test/api/snapshots');
  assert.equal(A.ctx.cfSnapUrl({ api: 'https://x.test/api/data' }, 12), 'https://x.test/api/snapshots/12');
});
