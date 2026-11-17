// widgets/scriptable/deadlines.js（iPhone のウィジェット）の表示を、Scriptable の部品を偽物にして確かめる。
// スクリプトは Scriptable 用（トップレベルの await と、Scriptable の大域変数を使う）なので、
// 大域変数を引数で渡した async 関数の中に入れて実行する。日付は実行時の今日から相対的に作る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../widgets/scriptable/deadlines.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const DAY = 86400000;
const HEX = { over: '#d83a3a', today: '#e07a10', soon: '#2f7d5b', normal: '#3a3a3a', sub: '#8a8a8a' };

// --- Scriptable の部品の偽物。作られた順に子を記録する ---
class Color {
  constructor(hex) { this.hex = hex; }
  // 明るい時の色を返す（既存の HEX の確認はそのまま通る）。作った色は記録して、ダーク用の組を確かめられるようにする。
  // 実機の Color.dynamic は Color 同士を受けるので、文字列が来たら落として取り違えを防ぐ
  static dynamic(light, dark) {
    if (!(light instanceof Color) || !(dark instanceof Color)) throw new Error('Color.dynamic には Color を渡す');
    light.dark = dark.hex;
    Color.made.push(light);
    return light;
  }
}
Color.made = [];
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

/** 直近の CalendarEvent.between に渡された範囲（start / end） */
let lastRange = null;

/** 今日から k 日後の終日の予定（終了は翌日 0:00。締切は前日として扱われる） */
const allDay = (title, k) => {
  const t = new Date();
  return { title, endDate: new Date(t.getFullYear(), t.getMonth(), t.getDate() + k + 1), isAllDay: true };
};

/** ウィジェットを作り、組み立てられた ListWidget を返す */
async function run({ family = 'medium', events = [], hasCalendar = true } = {}) {
  let captured = null;
  Color.made = [];
  const globals = {
    Calendar: { forEvents: async () => (hasCalendar ? [{ title: '締切トラッカー' }] : []) },
    // 範囲の中に終わりがある予定だけを返す（実際の between と同じく、範囲で絞る）
    CalendarEvent: {
      between: async (start, end) => {
        lastRange = { start, end };
        return events.filter((e) => e.endDate >= start && e.endDate <= end);
      },
    },
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

test('見出し（中・大）：今日の日付と締切の件数。超過がなければ「・超過」は出さない', async () => {
  const w = await run({ events: [ev('a', 1), ev('b', 2)] });
  assert.equal(texts(w)[0].text, `${md(0)}  締切  2件`);
  assert.ok(!texts(w)[0].text.includes('・超過'));
});

test('見出し（中）：超過がすべてでも「N件・超過N」の形（件数と超過が同じ数）', async () => {
  const events = [1, 2, 3].map((k) => ev(`o${k}`, -k));
  const w = await run({ family: 'medium', events });
  assert.equal(texts(w)[0].text, `${md(0)}  締切  3件・超過3`);
});

test('見出し（大）：日付・締切の件数・超過（中と同じ形）', async () => {
  const events = [-2, -1, 1, 2, 3].map((k) => ev(`t${k}`, k));
  const w = await run({ family: 'large', events });
  assert.equal(texts(w)[0].text, `${md(0)}  締切  5件・超過2`);
  const plain = await run({ family: 'large', events: [ev('a', 1)] });
  assert.equal(texts(plain)[0].text, `${md(0)}  締切  1件`);
});

test('見出し：1行に収める設定（lineLimit 1・縮小は 0.8 まで）', async () => {
  const w = await run({ events: [ev('a', 1)] });
  assert.equal(texts(w)[0].lineLimit, 1);
  assert.equal(texts(w)[0].minimumScaleFactor, 0.8);
});

test('見出し（中）：超過が2件あれば「・超過2」を付ける（件数は全体の9件）', async () => {
  const events = [-2, -1, 1, 2, 3, 4, 5, 6, 7].map((k) => ev(`t${k}`, k));
  const w = await run({ family: 'medium', events });
  assert.equal(texts(w)[0].text, `${md(0)}  締切  9件・超過2`);
});

test('見出し（小）：今日の日付と件数。超過があれば「・超過N」を付ける', async () => {
  const plain = await run({ family: 'small', events: [ev('a', 1), ev('b', 2)] });
  assert.equal(texts(plain)[0].text, `${dd(0)} 2件`);

  const events = [-2, -1, 1, 2, 3, 4, 5, 6, 7].map((k) => ev(`t${k}`, k));
  const over = await run({ family: 'small', events });
  assert.equal(texts(over)[0].text, `${dd(0)} 9件・超過2`);
});

test('空：締切がないときは案内の文字だけを出す（見出しは日付と 0件）', async () => {
  const w = await run({ events: [] });
  assert.equal(rows(w).length, 0);
  assert.equal(texts(w)[0].text, `${md(0)}  締切  0件`);
  assert.ok(texts(w).some((t) => t.text === '未完了の締切はありません'));
});

test('締切の読み取り範囲：先 90 日まで（30日前からは変えない）', async () => {
  // run の中で now を作るので、前後の時刻の間に入ることを確かめる（ずれは数ミリ秒だけ）
  const before = Date.now();
  await run({ events: [] });
  const after = Date.now();
  const { start, end } = lastRange;
  assert.ok(end.getTime() >= before + 90 * DAY && end.getTime() <= after + 90 * DAY, '終わりは今から 90 日後');
  assert.ok(start.getTime() >= before - 30 * DAY && start.getTime() <= after - 30 * DAY, '始まりは 30 日前');
});

test('30日先の締切は行に出て、件数（見出し）にも入る', async () => {
  const w = await run({ family: 'medium', events: [ev('遠い', 30)] });
  assert.equal(rows(w).length, 1);
  assert.equal(rows(w)[0].titleText, '遠い');
  assert.equal(texts(w)[0].text, `${md(0)}  締切  1件`);
});

test('読み取りの先の境界：+89 日の締切は入り、+91 日の締切は入らない（範囲の終わりは +90 日）', async () => {
  // fake の between は受け取った範囲で絞るので、範囲の外の予定は返らない
  const before = Date.now();
  const w = await run({ family: 'medium', events: [ev('入る', 89), ev('入らない', 91)] });
  const after = Date.now();
  const { end } = lastRange;
  assert.ok(end.getTime() >= before + 90 * DAY && end.getTime() <= after + 90 * DAY, '範囲の終わりは今から 90 日後');
  assert.deepEqual(rows(w).map((r) => r.titleText), ['入る'], '+89 日は行に出て、+91 日は出ない');
  assert.equal(texts(w)[0].text, `${md(0)}  締切  1件`, '件数（見出し）にも +91 日は入らない');
});

test('超えた件数の範囲：隠れた 20 日先の締切も範囲の終わりに入る', async () => {
  // 6件まで表示。隠れるのは 20 日先と 25 日先の二件（どちらも 14 日を超える）
  const events = [1, 2, 3, 4, 5, 6, 20, 25].map((k) => ev(`t${k}`, k));
  const last = texts(await run({ family: 'medium', events })).at(-1);
  assert.equal(last.text, `ほか2件 · ${md(20)}〜${md(25)}`);
});

test('時刻の表示：時刻つきの締切が今日・明日なら、タイトルの前に時刻（HH:MM）', async () => {
  const today = rows(await run({ events: [ev('レポート', 0)] }))[0];
  assert.equal(today.titleText, '17:00 レポート');

  const tomorrow = rows(await run({ events: [ev('提出', 1)] }))[0];
  assert.equal(tomorrow.titleText, '17:00 提出');
});

test('時刻の表示：時は 0 埋め（9:05 → 09:05）', async () => {
  const t = new Date();
  const at905 = { title: '朝', endDate: new Date(t.getFullYear(), t.getMonth(), t.getDate(), 9, 5), isAllDay: false };
  assert.equal(rows(await run({ events: [at905] }))[0].titleText, '09:05 朝');
});

test('時刻の表示：終日の予定は今日でも時刻を出さない', async () => {
  const r = rows(await run({ events: [allDay('祝日', 0), allDay('明日の終日', 1)] }));
  assert.equal(r[0].titleText, '祝日');
  assert.equal(r[1].titleText, '明日の終日');
});

test('時刻の表示：時刻つきでも3日後は時刻を出さない', async () => {
  const r = rows(await run({ events: [ev('三日後', 3)] }));
  assert.equal(r[0].titleText, '三日後');
});

test('時刻の表示（境界）：時刻つきの2日後は時刻を出さない（時刻は今日・明日だけ）', async () => {
  const r = rows(await run({ events: [ev('二日後', 2)] }));
  assert.equal(r[0].titleText, '二日後');
});

test('時刻の表示：小サイズでは、時刻つきの今日の締切もタイトルだけを出す', async () => {
  const r = rows(await run({ family: 'small', events: [ev('レポート', 0), ev('提出', 1)] }));
  assert.equal(r[0].titleText, 'レポート');
  assert.equal(r[1].titleText, '提出');
});

test('時刻の表示：時刻つきで無題なら「17:00 (無題)」', async () => {
  const r = rows(await run({ events: [ev('', 0)] }));
  assert.equal(r[0].titleText, '17:00 (無題)');
});

test('ダーク対応：背景と文字の色は Color.dynamic（明るい時・暗い時）で作る', async () => {
  const w = await run({ events: [ev('a', 0), ev('b', 2)] });
  // 作られた順は COLOR の定義順（over, today, soon, normal, sub, bg）
  const pairs = Color.made.map((c) => [c.hex, c.dark]);
  assert.deepEqual(pairs, [
    ['#d83a3a', '#FF7A7A'],
    ['#e07a10', '#F0A050'],
    ['#2f7d5b', '#6CCAAA'],
    ['#3a3a3a', '#F0F0F9'],
    ['#8a8a8a', '#ABABB3'],
    ['#fbf7ee', '#101018'],
  ]);
  // 背景と今日の文字は、Color.dynamic が返したものそのもの
  const bg = Color.made.find((c) => c.dark === '#101018');
  assert.equal(w.backgroundColor, bg);
  assert.equal(rows(w)[0].labelObj.textColor, Color.made.find((c) => c.dark === '#F0A050'));
});

test('カレンダーがないときは購読の案内を出す', async () => {
  const w = await run({ hasCalendar: false });
  assert.equal(texts(w)[0].text, 'カレンダー『締切トラッカー』を購読してください');
});
