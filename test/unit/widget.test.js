// widgets/scriptable/deadlines.js（iPhone のウィジェット）の表示を、Scriptable の部品を偽物にして確かめる。
// スクリプトは Scriptable 用（トップレベルの await と、Scriptable の大域変数を使う）なので、
// 大域変数を引数で渡した async 関数の中に入れて実行する。日付は実行時の今日から相対的に作る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../widgets/scriptable/deadlines.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const HEX = { over: '#d83a3a', today: '#e07a10', soon: '#2f7d5b', normal: '#3a3a3a', sub: '#8a8a8a' };

// --- Scriptable の部品の偽物。作られた順に子を記録する ---
class Color {
  constructor(hex) { this.hex = hex; }
}
class Size {
  constructor(width, height) { this.width = width; this.height = height; }
}
class Box {
  constructor() { this.children = []; }
  addText(text) { const t = { kind: 'text', text }; this.children.push(t); return t; }
  addStack() { const s = new Stack(); this.children.push(s); return s; }
  addSpacer(length) { this.children.push({ kind: 'spacer', length }); }
  centerAlignContent() {}
  setPadding() {}
}
class Stack extends Box {}
class ListWidget extends Box {}
const Font = {
  systemFont: (size) => ({ weight: 'regular', size }),
  boldSystemFont: (size) => ({ weight: 'bold', size }),
};

/** 今日から k 日後の 17:00（暦日で作る。時刻は締切の判定に影響しない） */
function dayFromToday(k) {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() + k, 17, 0, 0);
}
/** 締切の予定（時刻つき）。予定の終了が締切 */
const ev = (title, k) => ({ title, endDate: dayFromToday(k), isAllDay: false });
/** 中・大の日付：「M/D(曜)」（0 埋めしない） */
const md = (k) => { const d = dayFromToday(k); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
/** 小の日付：「D(曜)」 */
const dd = (k) => { const d = dayFromToday(k); return `${d.getDate()}(${WD[d.getDay()]})`; };
const wd = (k) => `${WD[dayFromToday(k).getDay()]}曜`;

/** ウィジェットを作り、組み立てられた ListWidget を返す */
async function run({ family = 'medium', events = [], hasCalendar = true } = {}) {
  let captured = null;
  const globals = {
    Calendar: { forEvents: async () => (hasCalendar ? [{ title: '締切トラッカー' }] : []) },
    CalendarEvent: { between: async () => events },
    Color,
    Font,
    ListWidget,
    Size,
    config: { runsInWidget: true, widgetFamily: family },
    args: { widgetParameter: '' },
    Script: { setWidget(w) { captured = w; }, complete() {} },
  };
  const names = Object.keys(globals);
  const fn = new AsyncFunction(...names, SRC);
  await fn(...names.map((n) => globals[n]));
  assert.ok(captured, 'Script.setWidget で widget が渡されること');
  return captured;
}

/** 行（締切の行）を、日付の欄・タイトルに分けて返す */
function rows(w) {
  return w.children.filter((c) => c instanceof Stack).map((row) => {
    const [cell, spacer, title] = row.children;
    assert.equal(spacer.kind, 'spacer', '日付の欄の後ろは間隔');
    return {
      cell,
      labelText: cell.children.length ? cell.children[0].text : '',
      labelObj: cell.children[0],
      titleText: title.text,
      titleObj: title,
    };
  });
}
/** 直下の文字（ヘッダー・空の表示・ほかN件の行） */
const texts = (w) => w.children.filter((c) => c.kind === 'text');

test('ラベル：超過・今日・明日・曜日（2〜3日は緑、4〜6日は通常）・日付（7日以上）', async () => {
  const w = await run({
    family: 'large',
    events: [ev('a', -2), ev('b', 0), ev('c', 1), ev('d', 2), ev('e', 3), ev('f', 5), ev('g', 7)],
  });
  const r = rows(w);
  assert.equal(r.length, 7);
  assert.equal(r[0].labelText, '超過2日');
  assert.equal(r[0].labelObj.textColor.hex, HEX.over);
  assert.equal(r[1].labelText, '今日');
  assert.equal(r[1].labelObj.textColor.hex, HEX.today);
  assert.equal(r[2].labelText, '明日');
  assert.equal(r[2].labelObj.textColor.hex, HEX.soon);
  assert.equal(r[3].labelText, wd(2));
  assert.equal(r[3].labelObj.textColor.hex, HEX.soon);
  assert.equal(r[4].labelText, wd(3));
  assert.equal(r[4].labelObj.textColor.hex, HEX.soon);
  assert.equal(r[5].labelText, wd(5));
  assert.equal(r[5].labelObj.textColor.hex, HEX.normal);
  assert.equal(r[6].labelText, md(7));
  assert.equal(r[6].labelObj.textColor.hex, HEX.normal);
  assert.equal(r[6].titleText, 'g');
});

test('7日以上の日付は曜日つき：中・大は「M/D(曜)」、小は「D(曜)」', async () => {
  const medium = rows(await run({ family: 'medium', events: [ev('a', 7)] }))[0];
  assert.equal(medium.labelText, md(7));
  assert.match(medium.labelText, /^\d{1,2}\/\d{1,2}\([日月火水木金土]\)$/);

  const large = rows(await run({ family: 'large', events: [ev('a', 9)] }))[0];
  assert.equal(large.labelText, md(9));

  const small = rows(await run({ family: 'small', events: [ev('a', 7)] }))[0];
  assert.equal(small.labelText, dd(7));
  assert.match(small.labelText, /^\d{1,2}\([日月火水木金土]\)$/);
});

test('ラベルの文字：medium は日付欄 60 幅・12 pt 太字、small は 46 幅・11 pt、タイトルは 12 pt（small は 11 pt）', async () => {
  const medium = rows(await run({ events: [ev('a', 1)] }))[0];
  assert.equal(medium.cell.size.width, 60);
  assert.equal(medium.labelObj.font.size, 12);
  assert.equal(medium.labelObj.font.weight, 'bold');
  assert.equal(medium.labelObj.lineLimit, 1);
  assert.equal(medium.labelObj.minimumScaleFactor, 0.8);
  assert.equal(medium.titleObj.font.size, 12);

  const small = rows(await run({ family: 'small', events: [ev('a', 1)] }))[0];
  assert.equal(small.cell.size.width, 46);
  assert.equal(small.labelObj.font.size, 11);
  assert.equal(small.labelObj.font.weight, 'bold');
  assert.equal(small.titleObj.font.size, 11);
});

test('同じ日の二行目は日付の欄が空（欄の幅は残る）', async () => {
  const r = rows(await run({ events: [ev('一つ目', 3), ev('二つ目', 3), ev('三つ目', 4)] }));
  assert.equal(r[0].labelText, wd(3));
  assert.equal(r[1].labelText, '', '同じラベルの二行目は文字を出さない');
  assert.equal(r[1].cell.children.length, 0, '欄は空（テキストを置かない）');
  assert.equal(r[1].cell.size.width, 60, '欄の幅は一行目と同じ');
  assert.equal(r[1].titleText, '二つ目', 'タイトルは出る');
  assert.equal(r[2].labelText, wd(4), '別の日の行は文字を出す');
});

test('超えた件数：中は最後の行の下に「ほかN件 · 範囲」', async () => {
  // 8件のうち、先頭6件を表示。残りは 7 日後と 8 日後（どちらも日付形式）
  const events = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => ev(`t${k}`, k));
  const w = await run({ family: 'medium', events });
  assert.equal(rows(w).length, 6);
  const last = texts(w).at(-1);
  assert.equal(last.text, `ほか2件 · ${md(7)}〜${md(8)}`);
  assert.equal(last.font.size, 10);
  assert.equal(last.font.weight, 'regular');
  assert.equal(last.textColor.hex, HEX.sub);
  assert.equal(last.lineLimit, 1);
});

test('超えた件数：範囲の始めと終わりが同じ日なら「ほかN件 · 日付」', async () => {
  const events = [1, 2, 3, 4, 5, 6, 7].map((k) => ev(`t${k}`, k));
  const last = texts(await run({ family: 'medium', events })).at(-1);
  assert.equal(last.text, `ほか1件 · ${md(7)}`);
});

test('超えた件数：小は「ほかN件」だけ', async () => {
  const events = [1, 2, 3, 4, 5, 6, 7].map((k) => ev(`t${k}`, k));
  const w = await run({ family: 'small', events });
  assert.equal(rows(w).length, 5);
  assert.equal(texts(w).at(-1).text, 'ほか2件');
});

test('超えた件数：隠れた中に超過があれば先頭に「超過含む」、色は超過の色', async () => {
  // 締切は古い順に並ぶので、超過が7件あると、いちばん新しい超過（1日前）が隠れる
  const events = [1, 2, 3, 4, 5, 6, 7].map((k) => ev(`o${k}`, -k));
  const last = texts(await run({ family: 'medium', events })).at(-1);
  assert.equal(last.text, `超過含む ほか1件 · ${md(-1)}`);
  assert.equal(last.textColor.hex, HEX.over);
});

test('超えた件数：小で隠れた中に超過があれば「超過含む ほかN件」、色は超過の色', async () => {
  const events = [1, 2, 3, 4, 5, 6, 7].map((k) => ev(`o${k}`, -k));
  const last = texts(await run({ family: 'small', events })).at(-1);
  assert.equal(last.text, '超過含む ほか2件');
  assert.equal(last.textColor.hex, HEX.over);
});

test('件数の上限：中は6件、大は16件、小は5件まで表示', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ev(`t${i}`, i + 1));
  assert.equal(rows(await run({ family: 'medium', events: many(10) })).length, 6);
  assert.equal(rows(await run({ family: 'large', events: many(17) })).length, 16);
  assert.equal(rows(await run({ family: 'small', events: many(9) })).length, 5);
});

test('行の間隔：行と行の間は 2、ヘッダーの後は 3、最後は上そろえのための間隔（引数なし）', async () => {
  const w = await run({ events: [ev('a', 1), ev('b', 2)] });
  const spacers = w.children.filter((c) => c.kind === 'spacer');
  assert.deepEqual(spacers.map((s) => s.length), [3, 2, undefined]);
});

test('見出しは変えない：締切の件数', async () => {
  const w = await run({ events: [ev('a', 1), ev('b', 2)] });
  assert.equal(texts(w)[0].text, '締切  2件');
});

test('空：締切がないときは案内の文字だけを出す', async () => {
  const w = await run({ events: [] });
  assert.equal(rows(w).length, 0);
  assert.ok(texts(w).some((t) => t.text === '未完了の締切はありません'));
});

test('カレンダーがないときは購読の案内を出す', async () => {
  const w = await run({ hasCalendar: false });
  assert.equal(texts(w)[0].text, 'カレンダー『締切トラッカー』を購読してください');
});
