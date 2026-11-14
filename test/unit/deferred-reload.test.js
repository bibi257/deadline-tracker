import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadAppFunctions } from '../support/appFns.js';

function timers() {
  const queue = [];
  return { queue, setTimeout: (fn, ms) => { queue.push({ fn, ms }); return queue.length; }, clearTimeout() {} };
}

test('保留中の再読み込みは編集終了後に待ち、同期完了後に1回だけ行う', async () => {
  const busy = { value: true }, events = [], t = timers();
  let resolveSync;
  const sync = new Promise(resolve => { resolveSync = resolve; });
  let app;
  app = loadAppFunctions(['runDeferredRefresh'], {
    _reloadPending: true, _deferRefresh: false, _autoSyncTimer: 1, _autoSyncInFlight: null,
    editingBusy: () => busy.value, flushAutoSync: () => { events.push('flush'); app._autoSyncInFlight = sync; return sync; },
    location: { reload: () => events.push('reload') }, refreshThenAutoComplete() {},
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });
  app.runDeferredRefresh();
  assert.equal(app._reloadPending, true);
  busy.value = false;
  app.runDeferredRefresh();
  assert.equal(app._reloadPending, false);
  const delay = t.queue.shift();
  assert.equal(delay.ms, 1200);
  delay.fn();
  assert.deepEqual(events, ['flush']);
  resolveSync();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(events, ['flush', 'reload']);
  app.runDeferredRefresh();
  assert.deepEqual(events, ['flush', 'reload']);
});

test('同期が解決しなくても3秒で再読み込みする', async () => {
  const events = [], t = timers();
  const app = loadAppFunctions(['runDeferredRefresh'], {
    _reloadPending: true, _deferRefresh: false, _autoSyncTimer: 1, _autoSyncInFlight: null, editingBusy: () => false,
    flushAutoSync: () => new Promise(() => {}), location: { reload: () => events.push('reload') },
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });
  app.runDeferredRefresh();
  const delay = t.queue.shift();
  delay.fn();
  const timeout = t.queue.shift();
  assert.equal(timeout.ms, 3000);
  timeout.fn();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(events, ['reload']);
});

test('予約タイマーがなくても、進行中の同期が終わるまで再読み込みしない', async () => {
  const events = [], t = timers();
  let resolveSync;
  const sync = new Promise(resolve => { resolveSync = resolve; });
  const app = loadAppFunctions(['runDeferredRefresh'], {
    _reloadPending: true, _deferRefresh: false, _autoSyncTimer: null, _autoSyncInFlight: sync,
    editingBusy: () => false, flushAutoSync: () => { events.push('flush'); },
    location: { reload: () => events.push('reload') }, setTimeout: t.setTimeout,
  });
  app.runDeferredRefresh();
  t.queue.shift().fn();
  const timeout = t.queue.shift();
  assert.equal(timeout.ms, 3000);
  assert.deepEqual(events, []);
  resolveSync();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(events, ['reload']);
  app.runDeferredRefresh();
  assert.deepEqual(events, ['reload']);
});

test('同期待ちの間に編集が再開したら、再読み込みを保留に戻す', async () => {
  const busy = { value: false }, events = [], t = timers();
  let resolveSync;
  const sync = new Promise(resolve => { resolveSync = resolve; });
  const app = loadAppFunctions(['runDeferredRefresh'], {
    _reloadPending: true, _deferRefresh: false, _autoSyncTimer: null, _autoSyncInFlight: sync,
    editingBusy: () => busy.value, location: { reload: () => events.push('reload') }, setTimeout: t.setTimeout,
  });
  app.runDeferredRefresh();
  t.queue.shift().fn();
  busy.value = true;
  resolveSync();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(app._reloadPending, true);
  assert.deepEqual(events, []);
});

test('再チェック時に編集が始まれば保留を戻す', () => {
  const busy = { value: false }, t = timers(), events = [];
  const app = loadAppFunctions(['runDeferredRefresh'], {
    _reloadPending: true, _deferRefresh: false, _autoSyncTimer: null, _autoSyncInFlight: null,
    editingBusy: () => busy.value, location: { reload: () => events.push('reload') },
    setTimeout: t.setTimeout,
  });
  app.runDeferredRefresh(); busy.value = true; t.queue.shift().fn();
  assert.equal(app._reloadPending, true);
  assert.deepEqual(events, []);
});

test('再読み込み保留がない場合も、遅延取り込みを続ける', () => {
  const events = [];
  const app = loadAppFunctions(['runDeferredRefresh'], {
    _reloadPending: false, _deferRefresh: true, editingBusy: () => false,
    refreshThenAutoComplete: block => events.push(block),
  });
  app.runDeferredRefresh();
  assert.deepEqual(Array.from(events), [true]);
});

test('visibilitychange と更新間隔のトリガーはいずれも呼び出し可能な保留処理を含む', () => {
  const source = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  assert.match(source, /document\.addEventListener\("visibilitychange",function\(\)\{\s*runDeferredRefresh\(\);/);
  assert.match(source, /setInterval\(function\(\)\{ checkForUpdate\(\); runDeferredRefresh\(\); \}, 10\*60000\)/);
});

test('更新検知中に編集が始まったら1200ms後に保留し、新版ごとに案内する', async () => {
  const stamps = new Map([
    ['/', '<meta name="build-stamp" content="one">'],
    ['/app.js', 'js-one'], ['/styles.css', 'css-one'],
  ]);
  const events = [], t = timers(), busy = { value: false };
  const app = loadAppFunctions(['checkForUpdate'], {
    APP_BUILD: null, _reloadPending: false, editingBusy: () => busy.value,
    toast: message => events.push(['toast', message]), setTimeout: t.setTimeout,
    location: { protocol: 'https:', pathname: '/', href: 'https://x.test/' },
    fetch: async url => {
      const path = new URL(url, 'https://x.test').pathname;
      return { ok: true, text: async () => stamps.get(path) };
    }, URL,
  }, ['APP_BUILD']);
  const check = async () => { app.checkForUpdate(); await new Promise(resolve => setTimeout(resolve, 0)); };
  await check();
  stamps.set('/', '<meta name="build-stamp" content="two-version">');
  await check();
  busy.value = true;
  assert.equal(t.queue.length, 1, `timer count; build=${app.APP_BUILD}`);
  const delay = t.queue.shift();
  assert.equal(delay.ms, 1200);
  delay.fn();
  assert.equal(app._reloadPending, true);
  const deferredMessage = '新しい版があります。入力が終わったら読み直します';
  assert.equal(events.filter(e => e[1] === deferredMessage).length, 1);
  stamps.set('/', '<meta name="build-stamp" content="three-version">');
  await check();
  assert.equal(events.filter(e => e[1] === deferredMessage).length, 1);
  app._reloadPending = false;
  stamps.set('/', '<meta name="build-stamp" content="four-version">');
  await check();
  assert.equal(events.filter(e => e[1] === deferredMessage).length, 2);
});
