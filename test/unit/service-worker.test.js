// Service Worker（service-worker.js）の、キャッシュの片付けと、個人データを保存しない約束。
// 偽の self・caches・fetch を渡した vm の中で、イベントのハンドラを直接動かして確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../service-worker.js', import.meta.url), 'utf8');

/** service-worker.js を読み込み、登録されたハンドラを返す。caches.keys() は names を返す */
function load(names) {
  const handlers = {};
  const deleted = [];
  const ctx = vm.createContext({
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, clients: { claim() {} } },
    caches: {
      keys: async () => names,
      delete: async (name) => { deleted.push(name); return true; },
      open: async () => ({ put: async () => {}, addAll: async () => {} }),
      match: async () => undefined,
    },
    location: { origin: 'https://x.test' },
    fetch: async () => new Response('ok', { status: 200 }),
    URL, Request, Response, Promise, Math, Date, Object, Array, String, JSON,
  });
  vm.runInContext(SRC, ctx);
  return { handlers, deleted };
}

test('古いキャッシュは、このアプリ（deadline-tracker-）のものだけ消す。同じオリジンの他のアプリのキャッシュは消さない', async () => {
  const current = /const CACHE_NAME = "([^"]+)"/.exec(SRC)[1]; // 今のキャッシュ名（版を上げるたびに変わるので、ソースから読む）
  const { handlers, deleted } = load(['deadline-tracker-v0', current, 'other-app-v1', 'shared-cache']);
  let waiting;
  handlers.activate({ waitUntil: (p) => { waiting = p; } });
  await waiting;
  assert.deepEqual(deleted, ['deadline-tracker-v0'], '今のキャッシュと、他のアプリのキャッシュは残す');
});

test('締切データ（/api/）と購読用の .ics（/ics/）は、Service Worker が取り扱わない（保存もしない）', () => {
  const { handlers } = load([]);
  for (const url of ['https://x.test/api/data', 'https://x.test/api/ics?dayHour=9', 'https://x.test/ics/secret-token.ics']) {
    let responded = false;
    handlers.fetch({ request: { method: 'GET', url }, respondWith: () => { responded = true; } });
    assert.equal(responded, false, `${url} は素通し（キャッシュしない）`);
  }
  let responded = false;
  handlers.fetch({ request: { method: 'GET', url: 'https://x.test/index.html' }, respondWith: () => { responded = true; } });
  assert.equal(responded, true, '画面の殻（index.html）は取り扱う');
});

/** fetch ハンドラを動かし、{ response, cached }（cache.put された [キー, 応答]）を返す。net は fetch の挙動、hit は caches.match の結果 */
async function runFetch(url, { net, hit } = {}) {
  const handlers = {};
  const cached = [];
  const ctx = vm.createContext({
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, clients: { claim() {} } },
    caches: {
      keys: async () => [], delete: async () => true,
      open: async () => ({ put: async (k, v) => { cached.push([k, v]); }, addAll: async () => {} }),
      match: async (req, opts) => { ctx.__matchArgs = { url: req.url, opts }; return hit; },
    },
    location: { origin: 'https://x.test' },
    fetch: net,
    URL, Request, Response, Promise, Math, Date, Object, Array, String, JSON,
  });
  vm.runInContext(SRC, ctx);
  let response; const waits = [];
  handlers.fetch({ request: { method: 'GET', url }, respondWith: (p) => { response = p; }, waitUntil: (p) => waits.push(p) });
  const res = await response;
  await Promise.all(waits);
  return { res, cached, ctx };
}

test('オンライン: 正常な応答だけを保存する。クエリ（?_=時刻）は外した1件として保存し、404 などは保存しない', async () => {
  let r = await runFetch('https://x.test/index.html?_=123', { net: async () => new Response('<html>', { status: 200 }) });
  assert.equal(await r.res.text(), '<html>');
  assert.deepEqual(r.cached.map(([k]) => k), ['https://x.test/index.html'], 'クエリを外した1件');
  r = await runFetch('https://x.test/nothing.js', { net: async () => new Response('nf', { status: 404 }) });
  assert.equal(r.res.status, 404, '404 はそのまま返す');
  assert.deepEqual(r.cached, [], '404 は保存しない');
});

test('オフライン: 通信できないときは、保存済みの殻を（クエリを無視して）返す。無ければ、白紙にせず理由を 503 で返す', async () => {
  const cachedPage = new Response('cached', { status: 200 });
  let r = await runFetch('https://x.test/?export=all', { net: async () => { throw new TypeError('offline'); }, hit: cachedPage });
  assert.equal(await r.res.text(), 'cached');
  assert.equal(r.ctx.__matchArgs.opts.ignoreSearch, true, '?export=all などクエリ付きでも同じページを返す');
  r = await runFetch('https://x.test/never-opened.html', { net: async () => { throw new TypeError('offline'); }, hit: undefined });
  assert.equal(r.res.status, 503);
  assert.match(await r.res.text(), /オフライン/);
  assert.match(r.res.headers.get('Content-Type'), /^text\/plain/);
});

test('POST など GET 以外・別オリジン（フォントなど）には関与しない', () => {
  const { handlers } = load([]);
  let responded = false;
  handlers.fetch({ request: { method: 'POST', url: 'https://x.test/index.html' }, respondWith: () => { responded = true; } });
  handlers.fetch({ request: { method: 'GET', url: 'https://fonts.gstatic.com/x.woff2' }, respondWith: () => { responded = true; } });
  assert.equal(responded, false);
});
