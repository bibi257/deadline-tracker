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
  const { handlers, deleted } = load(['deadline-tracker-v32', 'deadline-tracker-v33', 'other-app-v1', 'shared-cache']);
  let waiting;
  handlers.activate({ waitUntil: (p) => { waiting = p; } });
  await waiting;
  assert.deepEqual(deleted, ['deadline-tracker-v32'], '今のキャッシュ（v33）と、他のアプリのキャッシュは残す');
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
