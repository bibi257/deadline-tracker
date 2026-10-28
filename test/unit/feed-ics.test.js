// deadline-data の Python 版（build_feed.py / build_ics.py）が作った出力と、1文字ずつ同じになるかを確かめる。
// test/expected/ は、Python 版でテスト用データ（test/fixtures/data.json）から作った正解（deadline-data の tests/expected と同じもの）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFeed, expand, feedJson } from '../../worker/src/feed.js';
import { buildIcs } from '../../worker/src/ics.js';
import { addRep } from '../../worker/src/recurrence.js';
import { fromJst, parseNow, dateStr } from '../../worker/src/time.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const data = JSON.parse(read('fixtures/data.json'));
const MORNING = parseNow('2026-01-30 06:47');

test('feed.json が Python 版と同じ（自動完了の予定にだけ auto_complete: true を足してある）', () => {
  const { feed } = buildFeed(data, { now: MORNING });
  assert.equal(feedJson(feed), read('expected/feed.json'));
});

test('.ics（メモあり）が Python 版と1文字まで同じ', () => {
  const { ics } = buildIcs(data, { now: MORNING, dayHour: 9 });
  assert.equal(ics, read('expected/deadlines.ics'));
});

test('.ics（購読用・メモなし）が Python 版と1文字まで同じ。メモは出ない', () => {
  const { ics } = buildIcs(data, { now: MORNING, dayHour: 9, noMemo: true });
  assert.equal(ics, read('expected/deadlines-nomemo.ics'));
  assert.doesNotMatch(ics, /DESCRIPTION:(?!.*：)/);
});

test('未完了が0件なら .ics は作らない（null）', () => {
  assert.equal(buildIcs({ items: [{ id: 'a', title: 'x', due: '2026-02-01T00:00:00.000Z', done: true }] }, { now: MORNING }).ics, null);
  assert.equal(buildIcs({}, { now: MORNING }).ics, null);
});

test('読めない日時の締切は除き、警告を返す。開始だけ壊れているときは締切のみにする', () => {
  const d = { items: [
    { id: 'a', title: '壊れた', due: 'xxx' },
    { id: 'b', title: '開始が壊れた', due: '2026-02-03T01:00:00.000Z', start: 'yyy' },
    { id: 'c', title: '正常', due: '2026-02-03T02:00:00.000Z' },
  ] };
  const f = buildFeed(d, { now: MORNING });
  assert.deepEqual(f.feed.items.map((e) => e.title), ['開始が壊れた', '正常']);
  assert.equal(f.feed.items[0].start_date, undefined);
  assert.equal(f.warnings.length, 2);
  const i = buildIcs(d, { now: MORNING });
  assert.equal((i.ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal(i.warnings.length, 2);
});

// ---- 繰り返しの計算（deadline-data の tests/test_recurrence.py と同じ表。正解はアプリの nextOccurrence で求めたもの） ----

const jst = (s) => parseNow(s);
const fmt = (ms) => {
  const t = new Date(ms + 9 * 3600 * 1000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
};

const ADD_REP = [
  ['2026-01-23 19:00', 'weekly', 1, null, '2026-01-30 19:00'],
  ['2026-01-23 19:00', 'weekly', 3, null, '2026-02-13 19:00'],
  ['2026-01-16 23:59', 'biweekly', 2, null, '2026-02-13 23:59'],
  ['2026-01-31 23:59', 'monthly', 1, 31, '2026-02-28 23:59'],
  ['2026-01-31 23:59', 'monthly', 2, 31, '2026-03-31 23:59'],
  ['2026-01-31 23:59', 'monthly', 3, 31, '2026-04-30 23:59'],
  ['2026-01-31 23:59', 'monthly', 13, 31, '2027-02-28 23:59'],
  ['2026-02-28 23:59', 'monthly', 1, 31, '2026-03-31 23:59'],
  ['2026-02-28 23:59', 'monthly', 1, null, '2026-03-28 23:59'],
  ['2026-01-31 00:30', 'monthly', 1, 31, '2026-02-28 00:30'],
  ['2026-12-31 10:00', 'monthly', 2, 31, '2027-02-28 10:00'],
  ['2024-02-29 09:00', 'yearly', 1, 29, '2025-02-28 09:00'],
  ['2024-02-29 09:00', 'yearly', 4, 29, '2028-02-29 09:00'],
  ['2025-02-28 09:00', 'yearly', 3, 29, '2028-02-29 09:00'],
  ['2025-02-28 09:00', 'yearly', 3, null, '2028-02-28 09:00'],
];

test('addRep: 月末の丸め・2/29・年またぎ・JST の0時台が正解表と一致する', () => {
  for (const [base, rep, n, anchor, want] of ADD_REP) {
    assert.equal(fmt(addRep(jst(base), rep, n, anchor)), want, `${base} ${rep} ${n}回 repDay=${anchor}`);
  }
});

const toItem = (spec) => ({ id: 'x', title: 'x', ...spec, due: new Date(jst(spec.due)).toISOString() });

const EXPAND = [
  [{ due: '2026-01-23 19:00', rep: 'weekly', skip: ['2026-01-30'] },
    '2026-01-30 06:47', '2026-01-30', '2026-02-13', ['2026-01-23', '2026-02-06', '2026-02-13']],
  [{ due: '2026-01-09 10:00', rep: 'weekly', repCount: 2, autoComplete: true },
    '2026-01-12 08:00', '2026-01-12', '2026-01-26', ['2026-01-16']],
  [{ due: '2026-01-09 10:00', rep: 'weekly', repCount: 2, autoComplete: true },
    '2026-01-20 08:00', '2026-01-20', '2026-02-03', []],
  [{ due: '2026-01-31 23:59', rep: 'monthly', repDay: 31, autoComplete: true },
    '2026-01-30 06:47', '2026-01-30', '2026-04-30', ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']],
];

test('expand: 取りやめた回・回数の上限・自動完了・月末の丸めが正解表と一致する', () => {
  for (const [spec, now, frm, to, want] of EXPAND) {
    const got = expand(toItem(spec), frm, to, jst(now)).map((e) => e.due_date);
    assert.deepEqual(got, want, JSON.stringify(spec));
  }
});

test('時刻の変換: JST の0時台は暦が前日にならない', () => {
  assert.equal(dateStr(fromJst(2026, 1, 31, 0, 30)), '2026-01-31');
  assert.equal(new Date(fromJst(2026, 1, 31, 0, 30)).toISOString(), '2026-01-30T15:30:00.000Z');
});
