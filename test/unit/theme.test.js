// テーマの仕組み（D21）：theme-boot.js の選び方と、styles.css が「見た目の値は変数」の約束を守っているかを確かめる。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const read = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const BOOT = read('theme-boot.js');
const CSS = read('styles.css');

/** theme-boot.js を、偽の window の中で動かす */
function boot({ saved, dark = false, lsThrows = false, mmThrows = false } = {}) {
  const attrs = {};
  const store = saved === undefined ? {} : { 'deadline-tracker-theme': saved };
  const win = {
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
    localStorage: {
      getItem: (k) => { if (lsThrows) throw new Error('denied'); return k in store ? store[k] : null; },
      setItem: (k, v) => { if (lsThrows) throw new Error('denied'); store[k] = String(v); },
    },
    matchMedia: () => { if (mmThrows) throw new Error('no mm'); return { matches: dark }; },
  };
  vm.runInNewContext(BOOT, win);
  return { win, attrs, store };
}

test('テーマ: まだ選んでいない端末は、端末がダークなら墨、それ以外は抹茶', () => {
  assert.equal(boot({ dark: true }).attrs['data-theme'], 'dark');
  assert.equal(boot({ dark: false }).attrs['data-theme'], 'matcha');
});

test('テーマ: 選んだテーマは保存され、次回は端末の設定より優先する', () => {
  const b = boot({ dark: true });
  assert.equal(b.win.saveTheme('stone'), true);
  assert.equal(b.store['deadline-tracker-theme'], 'stone');
  assert.equal(boot({ saved: 'stone', dark: true }).attrs['data-theme'], 'stone');
  assert.equal(boot({ saved: 'matcha', dark: true }).attrs['data-theme'], 'matcha');
});

test('テーマ: 旧設定の値や知らない値が保存されていても既定で開く。3つ以外は保存しない', () => {
  for (const v of ['light', 'auto', '', 'x']) {
    assert.equal(boot({ saved: v, dark: false }).attrs['data-theme'], 'matcha', v);
    assert.equal(boot({ saved: v, dark: true }).attrs['data-theme'], 'dark', v);
  }
  const b = boot();
  assert.equal(b.win.saveTheme('light'), false);
  assert.deepEqual(b.store, {});
});

test('テーマ: localStorage や matchMedia が使えない環境でも、例外を出さずに既定で開く', () => {
  assert.equal(boot({ lsThrows: true, dark: true }).attrs['data-theme'], 'dark');
  assert.equal(boot({ lsThrows: true }).attrs['data-theme'], 'matcha');
  assert.equal(boot({ mmThrows: true }).attrs['data-theme'], 'matcha');
  const b = boot({ lsThrows: true });
  assert.equal(b.win.saveTheme('stone'), false);
  assert.equal(b.win.readSavedTheme(), null);
});

/* ---- styles.css ---- */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripComments(CSS);
const split = css.indexOf('*{box-sizing');
const head = css.slice(0, split);
const components = css.slice(split);

/** セレクタに完全一致するブロックの中身（先頭のブロック群から探す） */
function block(selector) {
  const i = head.indexOf(`${selector}{`);
  assert.ok(i >= 0, `${selector} のブロックがある`);
  return head.slice(i + selector.length + 1, head.indexOf('\n}', i));
}
const declared = (b) => Object.fromEntries([...b.matchAll(/(--[a-z0-9-]+):([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const THEME_BLOCKS = {
  matcha: declared(block(':root, html[data-theme="matcha"]')),
  stone: declared(block('html[data-theme="stone"]')),
  dark: declared(block('html[data-theme="dark"]')),
};

test('styles.css: 部品の CSS に、色コードと px の文字サイズを書かない', () => {
  assert.deepEqual(components.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || [], []);
  assert.deepEqual(components.match(/font-size:\s*[\d.]+px/g) || [], []);
});

test('styles.css: 3つのテーマのブロックが、同じ名前の色・影の変数をすべて定義している', () => {
  const names = Object.keys(THEME_BLOCKS.matcha);
  assert.ok(names.length > 30, '変数の数');
  for (const [t, vars] of Object.entries(THEME_BLOCKS)) {
    assert.deepEqual(names.filter((n) => !(n in vars)), [], `${t} に無い変数`);
    assert.deepEqual(Object.keys(vars).filter((n) => !names.includes(n)), [], `${t} だけにある変数`);
  }
});

test('styles.css: 部品が参照している変数は、すべて定義されている（部品の中の局所の変数と、app.js が data-st で渡す変数を除く）', () => {
  const defined = new Set([...css.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+):/g)].map((m) => m[1]));
  const LOCAL = new Set(['--cc', '--d', '--from', '--to', '--x', '--y', '--hh', '--wrap']);
  const used = new Set([...components.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((v) => !defined.has(v) && !LOCAL.has(v)), []);
});

/* ---- 配色の比（WCAG） ---- */
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('styles.css: どのテーマも、文字・状態色・バッジ・ボタンが WCAG AA（本文 4.5 以上・枠とフォーカス 3 以上）を満たす', () => {
  for (const [t, v] of Object.entries(THEME_BLOCKS)) {
    const body = v['--color-background-body'];
    const surf = v['--color-background-surface'];
    const check = (fg, bg, min, what) => assert.ok(ratio(v[fg], v[bg]) >= min, `${t}: ${what} ${fg} on ${bg} = ${ratio(v[fg], v[bg]).toFixed(2)}`);
    for (const f of ['text-primary', 'text-secondary', 'text-tertiary', 'danger', 'warning', 'info', 'routine']) {
      check(`--color-${f}`, '--color-background-body', 4.5, 'ページ');
      check(`--color-${f}`, '--color-background-surface', 4.5, 'カード');
    }
    check('--color-border-strong', '--color-background-surface', 3, '入力欄の枠');
    check('--color-focus', '--color-background-body', 3, 'フォーカス');
    check('--color-on-accent', '--color-accent', 4.5, '主ボタン');
    check('--color-on-danger', '--color-danger', 4.5, '赤い地');
    check('--color-on-mark', '--color-mark', 4.5, '蛍光ペン');
    for (const s of ['overdue', 'today', 'soon', 'later']) check(`--color-status-${s}-text`, `--color-status-${s}-bg`, 4.5, 'バッジ');
    assert.ok(body && surf);
  }
});

test('styles.css: ボタンのホバーの動きは、ホバーできる端末（hover:hover と pointer:fine）の中だけにあり、transform を使わない', () => {
  const at = css.indexOf('@media (hover:hover) and (pointer:fine){');
  assert.ok(at >= 0, 'ホバーの端末だけのメディアがある');
  const block = css.slice(at, css.indexOf('\n}', at));
  for (const sel of ['.btn:hover', '.chip:hover', '.fab:hover', '.gear:hover', '.nav:hover', '.tab:hover', '.act.main:hover']) assert.ok(block.includes(sel), sel);
  assert.ok(!/animation:btn-hop/.test(css.slice(0, at)), 'メディアの外でホバーの動きを付けない');
  const kf = /@keyframes btn-hop\{([^}]*\}){3}\}/.exec(css);
  assert.ok(kf && !kf[0].includes('transform'), '.fab の位置決め（transform）を上書きしない');
});
