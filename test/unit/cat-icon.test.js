// カテゴリーのアイコン（app-calc.js）：保存できる値の検査、切り抜きの範囲、上限に収まる書き出し。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../../app-calc.js', import.meta.url), 'utf8'), ctx);
const { isIconData, cleanCatIcons, iconCropRect, encodeIcon, ICON_MAX_CHARS, ICON_PX } = ctx.DTCalc;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const webp = (n) => `data:image/webp;base64,${'A'.repeat(n)}`;

test('isIconData: PNG・WebP の data URL で上限以下だけを通す（SVG・JPEG・URL・属性を壊す文字は通さない）', () => {
  assert.equal(ICON_PX, 64);
  assert.ok(isIconData(PNG) && isIconData(webp(100)));
  assert.ok(isIconData(webp(ICON_MAX_CHARS - 'data:image/webp;base64,'.length)));
  for (const bad of [webp(ICON_MAX_CHARS), 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,AAAA', 'https://example.com/a.png',
    'data:image/png;base64,AA"onerror="x', 'data:image/png;base64,', '', null, 5, {}]) assert.equal(isIconData(bad), false, String(bad).slice(0, 30));
});

test('cleanCatIcons: 壊れた値・大きすぎる値を捨て、プロトタイプの無い入れ物で返す。カテゴリーに無い名前も捨てられる', () => {
  const out = cleanCatIcons({ 課題: PNG, 仕事: 'x', 大: webp(ICON_MAX_CHARS), toString: PNG });
  assert.deepEqual(Object.keys(out).sort(), ['toString', '課題']);
  assert.equal(Object.getPrototypeOf(out), null);
  assert.deepEqual(Object.keys(cleanCatIcons({ 課題: PNG, 消した: PNG }, ['課題'])), ['課題']);
  for (const bad of [null, undefined, 'x', [PNG]]) assert.deepEqual(Object.keys(cleanCatIcons(bad)), []);
});

test('iconCropRect: 中央の正方形を切り抜く（横長・縦長・正方形）', () => {
  assert.deepEqual({ ...iconCropRect(400, 200) }, { sx: 100, sy: 0, side: 200 });
  assert.deepEqual({ ...iconCropRect(200, 401) }, { sx: 0, sy: 100, side: 200 });
  assert.deepEqual({ ...iconCropRect(64, 64) }, { sx: 0, sy: 0, side: 64 });
});

test('encodeIcon: 上限に収まるまで WebP の画質を下げる。収まらなければ null', () => {
  const sizes = { 0.9: 20000, 0.75: 15000, 0.6: 9000 };
  const tried = [];
  const out = encodeIcon((type, q) => { tried.push(q); return type === 'image/webp' ? webp(sizes[q] ?? 1000) : PNG; });
  assert.equal(out, webp(9000));
  assert.deepEqual(tried, [0.9, 0.75, 0.6]);
  assert.equal(encodeIcon((type) => (type === 'image/webp' ? webp(20000) : `data:image/png;base64,${'A'.repeat(20000)}`)), null);
});

test('encodeIcon: WebP を書き出せないブラウザ（PNG が返る）では PNG を使う', () => {
  assert.equal(encodeIcon(() => PNG), PNG);
});
