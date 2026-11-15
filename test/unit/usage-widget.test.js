import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../../widgets/scriptable/usage.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
class Color { constructor(hex) { this.hex = hex; } static dynamic(a) { return a; } }
class Size { constructor(width, height) { this.width = width; this.height = height; } }
class Box { constructor() { this.children = []; this.size = null; this.backgroundColor = null; } addText(text) { const t = { kind: 'text', text, rightAlignText() {} }; this.children.push(t); return t; } addStack() { const s = new Box(); this.children.push(s); return s; } addSpacer(length) { this.children.push({ kind: 'spacer', length }); } centerAlignContent() {} rightAlignText() {} setPadding() {} }
let presented = null;
class ListWidget extends Box { async presentMedium() { presented = this; } }
const values = new Map(); let fileText = null;
const Font = { systemFont: (size) => ({ size }), boldSystemFont: (size) => ({ size, bold: true }) };
async function run(payload, { family = 'medium', token = 'yes', error = null, status = 200, cached = null, parameter = 'https://example.test', app = false, alertResults = [], alertText = '' } = {}) {
  values.clear(); if (token) values.set('deadline-usage-token', token); fileText = cached ? JSON.stringify(cached) : null;
  let captured; presented = null;
  const results = [...alertResults];
  class FakeAlert { addSecureTextField() {} addAction() {} addCancelAction() {} textFieldValue() { return alertText; } async present() { return results.length ? results.shift() : -1; } }
  const globals = {
    Color, Size, Font, ListWidget,
    Keychain: { contains: (k) => values.has(k), get: (k) => values.get(k), set: (k, v) => values.set(k, v) },
    FileManager: { local: () => ({ documentsDirectory: () => '/docs', joinPath: (_, p) => p, fileExists: () => !!fileText, readString: () => fileText, writeString: (_, v) => { fileText = v; } }) },
    Request: class { constructor(url) { this.url = url; } async loadString() { if (error) throw error; this.response = { statusCode: status }; return typeof payload === 'string' ? payload : JSON.stringify(payload); } },
    Alert: FakeAlert, config: { runsInWidget: !app, widgetFamily: family }, args: { widgetParameter: parameter },
    Script: { setWidget(w) { captured = w; }, complete() {} },
  };
  await new AsyncFunction(...Object.keys(globals), SRC)(...Object.values(globals));
  return captured || presented;
}
const collect = (box) => box.children.flatMap((x) => x.kind === 'text' ? [x] : x.children ? collect(x) : []);
const future = (days) => new Date(Date.now() + days * 86400000).toISOString();
const payload = (extra = {}) => ({ ok: true, usage: { v: 1, updatedAt: new Date().toISOString(), codex: { usedPercent: 11, resetsAt: future(5), measuredAt: new Date().toISOString() }, muse: { usedPercent: 6, resetsAt: future(2), measuredAt: new Date().toISOString() }, claudeCode: { loginExpiresAt: future(27), measuredAt: new Date().toISOString() }, ...extra } });

test('usage widget renders service values, dates, warnings and bar widths', async () => {
  const w = await run(payload()); const t = collect(w).map((x) => x.text).join('\n');
  for (const s of ['Codex', 'Muse', 'Claude Code', '11%', '6%', 'あと27日', 'リセット', '更新']) assert.match(t, new RegExp(s));
  const claude = collect(w).find((x) => x.text === 'あと27日'); assert.ok(claude); assert.doesNotMatch(claude.text, /%/);
  const stacks = []; const walk = (b) => { for (const c of b.children || []) { if (c.size) stacks.push(c); if (c.children) walk(c); } }; walk(w);
  const tracks = stacks.filter((s) => s.size.height === 6 && s.backgroundColor && s.backgroundColor.hex === '#e6e0d2');
  assert.deepEqual(tracks.map((s) => s.size.width), [150, 150]);
  const fills = stacks.filter((s) => s.size.height === 6 && s.backgroundColor && s.backgroundColor.hex === '#2f7d5b');
  assert.deepEqual(fills.map((s) => s.size.width).sort((a, b) => a - b), [9, 17]);
  const warn = await run(payload({ codex: { usedPercent: 90, resetsAt: future(3), measuredAt: new Date().toISOString() } }));
  assert.match(collect(warn).map((x) => x.text).join(' '), /⚠ 残りわずか/);
  const expired = await run(payload({ claudeCode: { loginExpiresAt: future(-2), measuredAt: new Date().toISOString() } }));
  assert.match(collect(expired).map((x) => x.text).join(' '), /期限切れ/);
  const noBar = await run(payload({ codex: { usedPercent: 0, resetsAt: future(5), measuredAt: new Date().toISOString() } }));
  const bars = noBar.children.flatMap((x) => x.children || []).flatMap((x) => x.children || []).filter((x) => x.size && x.size.height === 6);
  assert.equal(bars.length, 1);
  const reset = await run(payload({ codex: { usedPercent: 99, resetsAt: new Date(Date.now() - 1000).toISOString(), measuredAt: new Date().toISOString() } }));
  assert.match(collect(reset).map((x) => x.text).join(' '), /リセット済み（次の更新待ち）/);
});

test('usage widget handles empty data, missing token, stale reset, old cache and offline state', async () => {
  assert.match(collect(await run(payload(), { token: '' })).map((x) => x.text).join(' '), /Scriptable アプリでこのスクリプト/);
  assert.match(collect(await run({ ok: true, usage: null })).map((x) => x.text).join(' '), /まだデータがありません/);
  const old = payload(); old.usage.updatedAt = new Date(Date.now() - 48 * 3600000).toISOString();
  assert.match(collect(await run(old)).map((x) => x.text).join(' '), /⚠ 古い/);
  const cache = payload();
  assert.match(collect(await run(payload(), { error: Error('offline'), cached: cache })).map((x) => x.text).join(' '), /オフライン/);
  assert.match(collect(await run(payload(), { status: 401 })).map((x) => x.text).join(' '), /トークンが違います/);
  assert.match(collect(await run(payload(), { status: 401, cached: cache })).map((x) => x.text).join(' '), /トークンが違います/);
  assert.match(collect(await run(payload(), { status: 500 })).map((x) => x.text).join(' '), /取得できませんでした/);
  assert.match(collect(await run(payload(), { status: 404 })).map((x) => x.text).join(' '), /取得できませんでした（HTTP 404）/);
  assert.match(collect(await run({ ok: true, usage: { v: 2 } })).map((x) => x.text).join(' '), /ウィジェットを更新してください/);
  assert.match(collect(await run(payload(), { parameter: '' })).map((x) => x.text).join(' '), /パラメータにアプリの URL/);
  assert.match(collect(await run('{', { status: 503 })).map((x) => x.text).join(' '), /取得できませんでした/);
  assert.match(collect(await run({ error: '鍵が無効' }, { status: 503 })).map((x) => x.text).join(' '), /鍵が無効/);
  assert.match(collect(await run(payload(), { status: 429, cached: cache })).map((x) => x.text).join(' '), /制限中/);
  assert.doesNotMatch(collect(await run(payload(), { status: 429, cached: cache })).map((x) => x.text).join(' '), /オフライン/);
  const small = await run(payload(), { family: 'small' });
  const noBarSmall = small.children.flatMap((x) => x.children || []).some((x) => x.size && x.size.height === 6);
  assert.equal(noBarSmall, false);
  const oldSmall = payload(); oldSmall.usage.updatedAt = new Date(Date.now() - 48 * 3600000).toISOString();
  assert.match(collect(await run(oldSmall, { family: 'small' })).at(-1).text, /^⚠ /);
  const laterToday = new Date(Date.now() + 4 * 3600000).toISOString();
  assert.match(collect(await run(payload({ claudeCode: { loginExpiresAt: laterToday, measuredAt: new Date().toISOString() } }))).map((x) => x.text).join(' '), /今日まで/);
  const expiredHour = new Date(Date.now() - 3600000).toISOString();
  assert.match(collect(await run(payload({ claudeCode: { loginExpiresAt: expiredHour, measuredAt: new Date().toISOString() } }))).map((x) => x.text).join(' '), /期限切れ/);
  const threeDays = new Date(Date.now() + 3 * 86400000).toISOString();
  assert.match(collect(await run(payload({ claudeCode: { loginExpiresAt: threeDays, measuredAt: new Date().toISOString() } }))).map((x) => x.text).join(' '), /⚠ 期限間近/);
});

test('usage widget shows missing services, per-row staleness and large details', async () => {
  const partial = payload(); delete partial.usage.muse;
  const missingTexts = collect(await run(partial)).map((x) => x.text).join(' ');
  assert.match(missingTexts, /未取得/);
  assert.match(missingTexts, /まだ届いていません/);
  const staleRow = payload({ codex: { usedPercent: 11, resetsAt: future(5), measuredAt: new Date(Date.now() - 48 * 3600000).toISOString() } });
  const details = collect(await run(staleRow)).map((x) => x.text).filter((t) => t.includes('リセット'));
  assert.equal(details.length, 2);
  assert.match(details[0], /（古い）/);
  assert.doesNotMatch(details[1], /（古い）/);
  const large = payload({
    codex: { usedPercent: 11, windowDays: 30, resetsAt: future(5), measuredAt: new Date().toISOString() },
    muse: { usedPercent: 6, resetsAt: future(2), measuredAt: new Date().toISOString(), extraInUse: false },
  });
  const largeTexts = collect(await run(large, { family: 'large' })).map((x) => x.text).join(' ');
  assert.match(largeTexts, /30日枠/);
  assert.match(largeTexts, /追加分 未使用/);
  assert.match(largeTexts, /（あと5日）/);
});

test('usage widget in-app token flow', async () => {
  const saved = await run(payload(), { app: true, token: '', alertResults: [0], alertText: 'tok123' });
  assert.equal(values.get('deadline-usage-token'), 'tok123');
  assert.match(collect(saved).map((x) => x.text).join(' '), /11%/);
  const shown = await run(payload(), { app: true, alertResults: [0] });
  assert.equal(values.get('deadline-usage-token'), 'yes');
  assert.match(collect(shown).map((x) => x.text).join(' '), /11%/);
  const changed = await run(payload(), { app: true, alertResults: [1, 0], alertText: 'newtok' });
  assert.equal(values.get('deadline-usage-token'), 'newtok');
  assert.match(collect(changed).map((x) => x.text).join(' '), /11%/);
  const cancelled = await run(payload(), { app: true, token: '', alertResults: [-1] });
  assert.match(collect(cancelled).map((x) => x.text).join(' '), /使用量のトークンを入れてください/);
});
