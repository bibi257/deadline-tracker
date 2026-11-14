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
  'cfKnownRev', 'cfSaveRev', 'cfFetchData', 'cfFetchState', 'cfPut', 'cfAskOverwrite', 'remoteHasUnknownChanges',
  'runAutoSync', 'doSync', 'proceedPull', 'getRemoteText', 'autoPullWith', 'backupRemoteBeforeOverwrite', 'syncHint',
  'sanitizeIncomingItems', 'syncPayload', 'refreshThenAutoComplete', 'autoCompleteOverdueItems', 'cfAutoBlocked', 'cfNoteAuthFailure',
  'cfSnapUrl', 'cfGetJson', 'cfFetchSnapshots', 'cfReadSnapshot', 'fmtSnapAt', 'cfRestoreSnapshot',
  'icsViaWorkerOk', 'cfFetchIcs', 'downloadIcsPreferWorker', 'noteAutoSyncFailure', 'normalizeItemTypes', 'markClean', 'hasUnsyncedChanges', 'overwriteLosses', 'conflictLog', 'noteConflict', 'conflictStats', 'runDeferredRefresh',
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
      name, toasts: [], confirms: [], dialogs: [], answers: [], states: [], busy: false, delay: 0, down: false, status: { textContent: '' },
      db: { items: [], quarantine: [], updatedAt: null, settings: { dayHour: 9 } },
      saved: [], local: [], storedCfg: undefined,
      store: { get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, String(v)) },
    };
    const g = {
      db: d.db, store: d.store, location: { origin: 'https://x.test' },
      fetch: (u, o) => (d.down ? Promise.reject(new Error('offline')) : d.delay ? sleep(d.delay).then(() => fetchToWorker(u, o)) : fetchToWorker(u, o)),
      toast: (m) => d.toasts.push(m),
      confirm: (m) => { d.confirms.push(m); return d.answers.length ? d.answers.shift() : false; },
      editingBusy: () => d.busy, setSrvState: (st) => d.states.push(st), autoSyncIfConfigured() {},
      _srvState: 'fresh', _deferRefresh: false, _reloadPending: false, _lastRefreshAt: 0, SRV_WAIT_MS: 60,
      _autoSyncTimer: null, _autoSyncInFlight: null,
      askOverwriteDialog: (losses) => { d.dialogs.push(losses); return Promise.resolve(d.answers.length ? d.answers.shift() : false); },
      RN: () => 'Cloudflare', markSynced() {}, markPulled() {}, saveRaw() {}, render() {}, softRender() {},
      normalizeTrash: (x) => x, cleanCatReminders: (x) => x, cleanCatColors: (x) => x, adoptCompletions() {},
      sanitizeIncomingMeta: () => ({ templates: null, categories: null }),
      _autoSyncBlockedShown: false, _autoSyncFailShown: '', _lastAutoSyncError: null, _staleNoticeShown: false, CF_REV_KEY: 'cf-known-rev', CONFLICT_KEY: 'conflict-log',
      hoursSincePulled: () => null,
      // 起動時の「取り込み → 自動完了」用（本物の applyCompletion / save は画面まわりに依存するので、同じ効果だけ再現する）
      // .ics の書き出し（Worker 優先）用
      CF: true, cfDetect: async () => true, activeItems: () => d.db.items.filter((i) => !i.done),
      getStoredCfConfig: async () => (d.storedCfg === undefined ? d.cfg : d.storedCfg),
      saveIcsFile: (text, name) => d.saved.push({ text, name }), downloadICS: (list, name) => d.local.push({ list, name }),
      _cfAuthStopped: false, _cfLimitShown: false, _refreshing: null, autoPullIfStale: () => d.ctx.autoPullWith(d.cfg),
      parseItemDate: (it) => new Date(it.due), applyCompletion: (it) => { it.done = true; },
      _editSeq: 0,
      save: () => { d.db.updatedAt = clock(); d.ctx._editSeq += 1; d.store.set('sync-dirty', '1'); }, saveAuto: () => { d.db.updatedAt = clock(); }, scheduleAutoSync() {},
    };
    d.ctx = loadAppFunctions(FNS, g);
    d.cfg = { kind: 'cf', api: 'https://x.test/api/data', headers: { Authorization: `Bearer ${KEY}` } };
    /** 締切を編集する（この端末の時計で updatedAt が付く） */
    d.edit = (title) => { d.db.items = [{ id: `i-${title}`, title, due: '2026-12-01T00:00:00.000Z' }]; d.db.updatedAt = clock(); d.ctx._editSeq += 1; d.store.set('sync-dirty', '1'); };
    d.sync = async () => { d.ctx.doSync(d.cfg, d.status, false); await sleep(150); };
    d.pull = async () => { d.ctx.proceedPull(d.cfg, d.status); await sleep(150); };
    d.auto = async () => { d.ctx.runAutoSync(d.cfg); await sleep(150); };
    d.startBlock = async () => { await d.ctx.refreshThenAutoComplete(true); };
    d.start = async () => { await d.ctx.refreshThenAutoComplete(); }; // 起動時の処理
    d.autoPull = async () => { d.ctx.autoPullWith(d.cfg); await sleep(150); };
    return d;
  }
  return { env, api, log, device, fetchToWorker, server: () => api('GET', '/api/data'), snapshots: () => api('GET', '/api/snapshots') };
}

const fetch_ = (w, path) => w.fetchToWorker(`https://x.test${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
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
  assert.equal(A.dialogs.length, 1, '上書きの確認が出る');
  assert.equal(A.dialogs[0].gone.length + A.dialogs[0].older.length > 0, true, '失われる内容が見つかる');
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
  // 先に読み直さず、手元の rev（1）を If-Match に付けて送る。サーバーは rev 2 なので 409 で断る（上書きされない）
  assert.equal(w.log.puts.length, before + 1, '送ろうとして、断られる');
  assert.equal(w.log.puts.at(-1).ifMatch, '1');
  assert.match(A.toasts.join('\n'), /自動同期を止めました/);
  assert.deepEqual(titles(await w.server()), ['Bの更新']);
  assert.equal((await w.server()).rev, 2);
});

test('自動同期: 全データを先に読み直さない（通信は PUT の1回だけ）。成功すると新しい rev を保存する', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('最初');
  await A.sync();
  const calls = w.log.calls;
  A.edit('次');
  await A.auto();
  assert.equal(w.log.calls, calls + 1, 'GET を挟まず、PUT の1回だけ');
  assert.equal(A.ctx.cfKnownRev(), '2');
  assert.deepEqual(titles(await w.server()), ['次']);
});

test('自動同期: 一度も読み込み・同期していない端末は、サーバーに内容があれば送らない（If-Match: 0 で断られる）。空なら初回として送れる', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('A');
  await A.sync();                                    // サーバーに内容がある
  const C = w.device('C', () => '2026-10-26T10:00:00.000Z'); // 一度も読み込んでいない端末
  C.edit('C');
  await C.auto();
  assert.equal(w.log.puts.at(-1).ifMatch, '0');
  assert.deepEqual(titles(await w.server()), ['A'], '上書きされない');
  assert.match(C.toasts.join('\n'), /自動同期を止めました/);
  const w2 = world();                                // サーバーが空なら、初回として送れる
  const D = w2.device('D', () => '2026-10-26T10:00:00.000Z');
  D.edit('D');
  await D.auto();
  assert.deepEqual(titles(await w2.server()), ['D']);
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
    const real = A.ctx.cfFetchState;
    let first = true;
    A.ctx.cfFetchState = (cfg) => (first ? ((first = false), Promise.resolve({ cf: true, sha: '1', updatedAt: null, itemCount: 1 })) : real(cfg));
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
  assert.equal(A.dialogs.length, 1, '選ばせる画面が出る');
  assert.deepEqual(Array.from(A.dialogs[0].gone), ['Bの更新'], '上書きすると消える締切が見える');
  assert.match(A.confirms[0], /置き換えます/, '「読み込む」を選ぶと、置き換えの確認が出る');
  assert.equal(A.ctx.conflictStats().total, 1, '競合が1回記録される');
  assert.equal(A.ctx.conflictStats().overwrote, 0);
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
  assert.deepEqual({ ...A.ctx.conflictStats() }, { total: 1, overwrote: 1, lost: 1 }, '上書きと失われた件数が記録される');
});

test('overwriteLosses: 保存先にだけある締切は「消える」、保存先のほうが新しい（seq が大きい）ものは「置き換わる」', () => {
  const d = world().device('X', () => 'x');
  const r = d.ctx.overwriteLosses(
    [{ id: 'a', title: 'A', seq: 1 }, { id: 'b', title: 'B', seq: 3 }, { id: 'c', title: 'C', seq: 1 }],
    [{ id: 'a', title: 'A', seq: 2 }, { id: 'b', title: 'B', seq: 3 }, { id: 'z', title: 'Z' }, null],
  );
  assert.deepEqual(Array.from(r.older), ['A']);
  assert.deepEqual(Array.from(r.gone), ['Z']);
  assert.deepEqual(Array.from(d.ctx.overwriteLosses(null, undefined).gone), []);
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

test('.ics の書き出し（Cloudflare）: 未完了の全件で、未同期の変更が無ければ Worker の /api/ics から取る。当日リマインドの時刻も渡す', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('v1');
  await A.sync();
  A.db.settings.dayHour = 8;
  await A.ctx.downloadIcsPreferWorker(A.db.items, 'deadlines-all');
  assert.equal(A.local.length, 0, 'この端末では作らない');
  assert.equal(A.saved.length, 1);
  assert.equal(A.saved[0].name, 'deadlines-all');
  assert.match(A.saved[0].text, /^BEGIN:VCALENDAR\r\n/);
  assert.match(A.saved[0].text, /SUMMARY:v1/);
  assert.match(A.saved[0].text, /TRIGGER;VALUE=DATE-TIME:20261130T230000Z/, '当日リマインドは 8 時（端末の設定）。Worker の既定の 9 時ではない');
  // Worker の購読用 .ics と同じ規則・同じ文面（同じデータ・同じ時刻・同じ当日リマインドの時刻）
  const direct = await (await fetch_(w, '/api/ics?dayHour=8')).text();
  assert.equal(A.saved[0].text, direct);
});

test('.ics の書き出し（Cloudflare）: 条件がそろわないとき・失敗したときは、この端末で作る（オフラインでも書き出せる）', async () => {
  const w = world();
  let t = 0;
  const A = w.device('A', () => new Date(Date.UTC(2026, 9, 26, 10, 0, t++)).toISOString()); // 編集のたびに updatedAt が進む
  A.edit('v1');
  await A.sync();
  const all = () => A.db.items;
  const check = async (label, fn) => {
    A.saved.length = 0; A.local.length = 0;
    await fn();
    assert.equal(A.saved.length, 0, `${label}: Worker の .ics は使わない`);
    assert.equal(A.local.length, 1, `${label}: この端末で作る`);
  };
  await check('一部だけ（件数が全件と違う）', () => A.ctx.downloadIcsPreferWorker(all().concat([{ id: 'x2', title: 'もう1件', due: '2026-12-01T00:00:00.000Z' }]), 'x'));
  A.storedCfg = null;
  await check('アクセスキーが無い', () => A.ctx.downloadIcsPreferWorker(all(), 'x'));
  A.storedCfg = { ...A.cfg, headers: { Authorization: `Bearer ${'x'.repeat(32)}` } };
  await check('キーが違う（401）', () => A.ctx.downloadIcsPreferWorker(all(), 'x'));
  A.storedCfg = undefined;
  A.ctx.CF = false;
  await check('Cloudflare から配信されていない', () => A.ctx.downloadIcsPreferWorker(all(), 'x'));
  A.ctx.CF = true;
  A.edit('v2'); // 未同期の変更
  await check('この端末に未同期の変更がある', () => A.ctx.downloadIcsPreferWorker(all(), 'x'));
  await A.sync();
  await w.env.DB.prepare('DELETE FROM docs').run(); // Worker のデータが空 → 中身の無いカレンダーが返る
  await check('Worker の .ics に予定が無い', () => A.ctx.downloadIcsPreferWorker(all(), 'x'));
});

test('同期の確認と送信の間に、自動の取り込みで版が進んでも、準備したときの版（If-Match）で送る。他の端末の更新を消さない', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const B = w.device('B', () => '2026-10-26T10:00:00.000Z');
  A.edit('A最初');
  await A.sync(); // rev 1
  await B.pull();
  const realFetch = A.ctx.fetch;
  let raced = false;
  A.ctx.fetch = async (url, opts = {}) => {
    // A が同期の確認の GET を送る直前に、B が更新し（rev 2）、A が自動の取り込みで rev 2 を受け取る
    if (!raced && (opts.method || 'GET') === 'GET' && String(url).startsWith('https://x.test/api/data?')) {
      raced = true;
      B.edit('Bの更新');
      await B.sync();
      await A.autoPull();
    }
    return realFetch(url, opts);
  };
  await A.sync(); // A は内容を変えていない（rev 1 の内容を送ろうとする）
  await sleep(500); // フックの中の B の同期と A の取り込みが終わり、A の送信まで済むのを待つ
  assert.equal(w.log.puts.at(-1).ifMatch, '1', '準備したとき（rev 1）の版で送る');
  assert.deepEqual(titles(await w.server()), ['Bの更新'], 'B の更新は残っている');
  assert.equal((await w.server()).rev, 2);
});

test('自動同期: 端末内に古い型の項目があると Worker が 400 で断る。理由を1回だけトーストで出し、設定用に残す。型をそろえれば送れて、記録が消える', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('課題1');
  A.db.items[0].seq = '3';           // 古い型（保存の検査より前の版が書いた形）
  A.db.items[0].skip = ['x'];
  await A.auto();
  const failures = () => A.toasts.filter((m) => /自動同期に失敗しました/.test(m));
  assert.equal(failures().length, 1, '黙って止まらず、理由を知らせる');
  assert.match(failures()[0], /seq/, 'Worker が返す理由（どの項目が合わないか）');
  assert.match(failures()[0], /設定.*同期から送り直せます/);
  assert.match(A.ctx._lastAutoSyncError.reason, /seq/);
  assert.equal(await w.server().then((s) => s.data), null, '保存されていない');
  // 同じ理由の失敗が続く間は、トーストを繰り返さない
  await A.auto();
  assert.equal(failures().length, 1);
  // 型をそろえると送れる。成功したら失敗の記録は消え、そのあとの失敗はまた知らせる
  A.db.items = Array.from(A.db.items, (it) => A.ctx.normalizeItemTypes(it));
  await A.auto();
  assert.equal((await w.server()).rev, 1, '保存できた');
  assert.equal(A.ctx._lastAutoSyncError, null);
  assert.match(A.toasts.at(-1), /自動同期しました/);
  A.db.items[0].seq = 'x';
  await A.auto();
  assert.equal(failures().length, 2, '成功したあとの新しい失敗は、また知らせる');
});

test('端末内の古い型の項目は、normalizeItemTypes を通すと、Worker の保存の検査をすべて通る（実際に保存して 200）', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const old = [
    { id: 'a', title: 't', due: '2026-12-01T00:00:00.000Z', seq: '3', skip: ['x', 5], allDay: 'true', autoComplete: 1, calHide: 'no', pick: 7, rep: 'daily', repCount: '2', repDay: 1.5, memo: 5, cat: 9 },
    { id: 'b', title: 't', due: '2026-12-01T00:00:00.000Z', done: 'yes' },
  ];
  const put = (items) => w.fetchToWorker('https://x.test/api/data', { method: 'PUT', headers: { Authorization: `Bearer ${KEY}`, 'If-Match': '0' }, body: JSON.stringify({ items }) }).then((r) => r.status);
  assert.equal(await put(old), 400, '補正しないと断られる');
  assert.equal(await put(Array.from(old, (it) => A.ctx.normalizeItemTypes(it))), 201, '補正すると保存できる');
});

test('自動同期の失敗の表示は、手動の同期・読み込みが成功したときにも消える', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('課題1');
  A.db.items[0].seq = '3';
  await A.auto();
  assert.ok(A.ctx._lastAutoSyncError, '失敗が記録される');
  A.db.items = Array.from(A.db.items, (it) => A.ctx.normalizeItemTypes(it));
  await A.sync(); // 手動の同期が成功
  assert.equal(A.ctx._lastAutoSyncError, null, '手動の同期の成功で消える');
  A.db.items[0].seq = 'x';
  await A.auto();
  assert.ok(A.ctx._lastAutoSyncError);
  A.answers = [true]; // 「この端末の締切を置き換えます」の確認に、はいと答える
  await A.pull(); // 読み込みが成功
  assert.equal(A.ctx._lastAutoSyncError, null, '読み込みの成功で消える');
});

test('自動完了は「人の未送信の変更」にならない：自動完了した端末も、他の端末の更新を自動で取り込める（旧: 自動完了の保存で取り込みが止まった）', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const B = w.device('B', () => '2026-10-26T12:00:00.000Z');
  A.db.items = [{ id: 'sub', title: 'サブスク', due: '2026-10-01T00:00:00.000Z', autoComplete: true }];
  A.db.updatedAt = '2026-10-26T10:00:00.000Z'; A.store.set('sync-dirty', '1');
  await A.sync(); // rev1
  await B.pull(); // B も rev1。人の未送信の変更なし
  assert.equal(B.ctx.hasUnsyncedChanges(), false);
  B.ctx.autoCompleteOverdueItems(); // B で期限切れの自動完了（機械の処理）
  assert.equal(B.db.items[0].done, true);
  assert.notEqual(B.db.updatedAt, '2026-10-26T10:00:00.000Z', '保存はして、updatedAt は進む');
  assert.equal(B.ctx.hasUnsyncedChanges(), false, '自動完了は人の未送信の変更にならない');
  A.edit('Aの更新'); // A で人が編集して同期（rev2）
  await A.sync();
  await B.autoPull();
  assert.deepEqual(mine(B), ['Aの更新'], 'B は A の更新を自動で取り込む');
  assert.equal(B.ctx.cfKnownRev(), '2');
  assert.match(B.toasts.join('\n'), /自動で反映しました/);
});

test('人の操作の未送信の変更は印が立ち、取り込みで置き換わらない。送信が成功するまで印は残り、成功したら消える。失敗（409）では消えない', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const B = w.device('B', () => '2026-10-26T12:00:00.000Z');
  A.edit('A最初'); await A.sync();
  await B.pull();
  assert.equal(B.ctx.hasUnsyncedChanges(), false);
  B.edit('Bの人の編集');           // 人の操作（チェック・今日の一手の印なども同じ save）
  assert.equal(B.ctx.hasUnsyncedChanges(), true);
  A.edit('A二番目'); await A.sync(); // 保存先が進む
  await B.autoPull();
  assert.deepEqual(mine(B), ['Bの人の編集'], '未送信の変更があるので、置き換えない');
  await B.auto();                    // 送信は 409 で断られる
  assert.match(B.toasts.join('\n'), /自動同期を止めました/);
  assert.equal(B.ctx.hasUnsyncedChanges(), true, '送信が失敗したら、印は残る');
  // 読み込みで置き換えると消える
  B.answers = [true]; await B.pull();
  assert.equal(B.ctx.hasUnsyncedChanges(), false);
  // 送信が成功したら消える
  B.edit('Bの次の編集');
  await B.auto();
  assert.equal((await w.server()).rev, 3);
  assert.equal(B.ctx.hasUnsyncedChanges(), false, '送信の成功で消える');
});

test('送信中に新しい人の編集が入ったら、送信が成功しても印は消さない（その編集はまだ送っていない）', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  A.edit('A最初');
  const p = A.ctx.runAutoSync(A.cfg); // 送信を始める（内容は作り終えている）
  A.edit('送信中の編集');            // 送信の最中に、人が編集
  await sleep(200);
  assert.equal((await w.server()).rev, 1, '最初の内容は保存された');
  assert.equal(A.ctx.hasUnsyncedChanges(), true, '送信中の編集は未送信のまま、印が残る');
  void p;
});

test('起動（読み込みを待つ）: 保存先の新しい内容を読み終えてから編集できる。読み込み中の印が付き、終わると消える', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const B = w.device('B', () => '2026-10-26T11:00:00.000Z');
  B.store.set('cf-key', 'enc1:x');
  A.edit('古い');
  await A.sync();
  await B.pull();
  A.edit('新しい');
  await A.sync(); // 他の端末で更新
  await B.startBlock();
  assert.deepEqual(Array.from(B.states), ['loading', 'fresh']);
  assert.deepEqual(mine(B), ['新しい'], '編集できるようになる前に、保存先の内容に置き換わっている');
});

test('起動: 4秒（テストでは60ms）を過ぎたら待たせず「前回の内容」にし、遅れて読めたら元に戻す。圏外なら戻らない', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const B = w.device('B', () => '2026-10-26T11:00:00.000Z');
  B.store.set('cf-key', 'enc1:x');
  A.edit('古い');
  await A.sync();
  await B.pull();
  B.delay = 200; // 通信が遅い
  await B.startBlock();
  assert.deepEqual(Array.from(B.states), ['loading', 'offline'], '上限で待つのをやめ、編集できる状態にする');
  await sleep(500);
  assert.deepEqual(Array.from(B.states), ['loading', 'offline', 'fresh'], '遅れて読めたら帯を消す');

  B.states.length = 0; B.delay = 0; B.down = true; // 圏外
  B.ctx._lastRefreshAt = 0;
  await B.startBlock();
  assert.deepEqual(Array.from(B.states), ['loading', 'offline']);
  B.edit('圏外で編集'); // 編集はでき、手元に残る
  assert.deepEqual(mine(B), ['圏外で編集']);
});

test('起動: 登録・編集のダイアログ（や入力）を開いている間は置き換えず、閉じてから行う。キー未保存の端末は待たせない', async () => {
  const w = world();
  const A = w.device('A', () => '2026-10-26T10:00:00.000Z');
  const B = w.device('B', () => '2026-10-26T11:00:00.000Z');
  B.store.set('cf-key', 'enc1:x');
  A.edit('古い');
  await A.sync();
  await B.pull();
  A.edit('新しい');
  await A.sync();
  B.busy = true;
  await B.startBlock();
  assert.deepEqual(Array.from(B.states), [], '開いている間は何もしない');
  assert.deepEqual(mine(B), ['古い']);
  B.busy = false;
  B.ctx.runDeferredRefresh();
  await sleep(150);
  assert.deepEqual(mine(B), ['新しい'], '閉じた後に置き換わる');

  const C = w.device('C', () => '2026-10-26T12:00:00.000Z'); // アクセスキーが無い
  await C.startBlock();
  assert.deepEqual(Array.from(C.states), ['fresh'], '読み込み中の帯は出さない');
});
