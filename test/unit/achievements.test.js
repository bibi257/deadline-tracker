// 達成カレンダー（直近12週のマス）と実績バッジ。完了の記録（db.completions）から毎回計算するので、数え方の境目を表にして確かめる。
// 自動完了（kind:"auto"）と全クリアのボーナス（kind:"bonus"）は「自分で完了にした」には数えない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNow } from '../../worker/src/time.js';
import { loadAppFunctions } from '../support/appFns.js';

process.env.TZ = 'Asia/Tokyo';

const FNS = ['pad', 'toLocalISO', 'startOfDay', 'daysBetween', 'levelOf', 'isOwnCompletion', 'buildActivityGrid', 'longestStreak', 'buildBadges'];
const VARS = ['EXP_PER_LEVEL', 'ACTIVITY_WEEKS', 'BADGE_DEFS'];
const app = loadAppFunctions(FNS, {}, VARS);
const plain = (x) => JSON.parse(JSON.stringify(x));

/** 端末の時刻（JST）での完了の記録。at は 'YYYY-MM-DD HH:MM' */
const done = (at, kind = 'ontime', exp = 10) => ({ id: `c-${at}-${kind}-${Math.random()}`, kind, exp, doneAt: new Date(parseNow(at)).toISOString() });
const TODAY = new Date(parseNow('2026-01-30 12:00')); // 金曜

test('達成カレンダー: 今日を含む週までの12週・84マス。週ごとに日曜はじまりで並び、今日より先は future', () => {
  const g = app.buildActivityGrid([], TODAY);
  assert.equal(g.cells.length, 84);
  assert.equal(g.weeks, 12);
  assert.equal(g.cells[0].key, '2025-11-09', '11週前の日曜');
  assert.equal(g.cells[83].key, '2026-01-31', '今週の土曜');
  assert.deepEqual(g.cells.map((c, i) => c.dow === i % 7).filter((x) => !x).length, 0, 'k 番目のマスの曜日は k % 7（日〜土）');
  assert.deepEqual(plain(g.cells.filter((c) => c.future).map((c) => c.key)), ['2026-01-31'], '明日（土曜）だけが未来');
  assert.deepEqual([g.activeDays, g.total], [0, 0]);
});

test('達成カレンダー: 日ごとの件数と、前倒しの日。自動完了・ボーナス・期間の外・未来は数えない', () => {
  const list = [
    done('2026-01-30 09:00', 'ontime'), done('2026-01-30 23:50', 'early'), done('2026-01-30 10:00', 'auto', 0), done('2026-01-30 10:00', 'bonus', 20),
    done('2026-01-29 08:00', 'late'),
    done('2025-11-09 00:10', 'ontime'),   // いちばん古いマスの日（範囲の内）
    done('2025-11-08 23:50', 'ontime'),   // 1日早い（範囲の外）
    done('2026-01-31 09:00', 'ontime'),   // 未来
  ];
  const g = app.buildActivityGrid(list, TODAY);
  const at = (k) => plain(g.cells.find((c) => c.key === k));
  assert.deepEqual(at('2026-01-30'), { key: '2026-01-30', dow: 5, n: 2, early: true, future: false }, '自分で完了した2件。前倒しを含む');
  assert.deepEqual(at('2026-01-29'), { key: '2026-01-29', dow: 4, n: 1, early: false, future: false });
  assert.equal(at('2025-11-09').n, 1);
  assert.deepEqual(at('2026-01-31'), { key: '2026-01-31', dow: 6, n: 0, early: false, future: true }, '未来は数えない');
  assert.deepEqual([g.activeDays, g.total], [3, 4], '完了した日 3 日・4 件');
});

test('longestStreak: いちばん長い連続日数（月・年をまたぐ。重複する日は1日。空なら0）', () => {
  assert.equal(app.longestStreak([]), 0);
  assert.equal(app.longestStreak(['2026-01-01']), 1);
  assert.equal(app.longestStreak(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05', '2026-01-06']), 3);
  assert.equal(app.longestStreak(['2026-01-06', '2026-01-05', '2026-01-05', '2026-01-03', '2026-01-02', '2026-01-01', '2026-01-03']), 3, '順不同・重複');
  assert.equal(app.longestStreak(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']), 4, '年をまたぐ');
  assert.equal(app.longestStreak(['2026-01-31', '2026-02-01']), 2, '月をまたぐ');
  assert.equal(app.longestStreak(['2028-02-28', '2028-02-29', '2028-03-01']), 3, 'うるう日');
});

const badge = (list, carry = 0) => Object.fromEntries(app.buildBadges(list, carry).map((b) => [b.id, plain(b)]));

test('バッジ: 記録が無ければ、すべて未達成（進み具合は 0 または Lv.1）', () => {
  const b = badge([]);
  assert.deepEqual(Object.keys(b), ['streak7', 'early10', 'clear5', 'lv10']);
  assert.deepEqual(Object.values(b).map((x) => [x.done, x.current, x.goal]), [[false, 0, 7], [false, 0, 10], [false, 0, 5], [false, 1, 10]]);
});

test('バッジ: 連続7日は、自分で完了した日が7日続いたとき。自動完了・ボーナスだけの日は日に数えない', () => {
  const days = (n, kind = 'ontime') => Array.from({ length: n }, (_, i) => done(`2026-01-${String(10 + i).padStart(2, '0')} 09:00`, kind));
  assert.deepEqual([badge(days(6)).streak7.done, badge(days(6)).streak7.current], [false, 6]);
  assert.equal(badge(days(7)).streak7.done, true);
  assert.equal(badge(days(9)).streak7.current, 7, '進み具合は目標を超えない');
  assert.equal(badge(days(7, 'auto')).streak7.current, 0, '自動完了だけでは連続にならない');
  assert.equal(badge(days(7, 'bonus')).streak7.current, 0, 'ボーナスだけでは連続にならない');
  const gap = [...days(3), ...days(4).map((c, i) => done(`2026-01-${String(20 + i).padStart(2, '0')} 09:00`))]; // 10-12 と 20-23 の2つに分かれる
  assert.equal(badge(gap).streak7.current, 4, '途切れたら、長いほうだけ');
});

test('バッジ: 前倒し10回は kind:"early" の件数。全クリア5日は、ボーナスを記録した日の数（同じ日は1日）', () => {
  const early = (n) => Array.from({ length: n }, (_, i) => done(`2026-01-${String(1 + i).padStart(2, '0')} 09:00`, 'early', 20));
  assert.deepEqual([badge(early(9)).early10.done, badge(early(9)).early10.current], [false, 9]);
  assert.equal(badge(early(10)).early10.done, true);
  assert.equal(badge([...early(9), done('2026-02-01 09:00', 'ontime')]).early10.done, false, '期限内は前倒しに数えない');
  const bonus = (n) => Array.from({ length: n }, (_, i) => done(`2026-01-${String(1 + i).padStart(2, '0')} 21:00`, 'bonus', 20));
  assert.deepEqual([badge(bonus(4)).clear5.done, badge(bonus(4)).clear5.current], [false, 4]);
  assert.equal(badge(bonus(5)).clear5.done, true);
  assert.equal(badge([...bonus(4), done('2026-01-01 22:00', 'bonus', 20)]).clear5.current, 4, '同じ日のボーナスは1日として数える');
});

test('バッジ: Lv.10 は累計 EXP（繰り越し分を含む）が 900 以上', () => {
  assert.equal(badge([done('2026-01-01 09:00', 'ontime', 899)]).lv10.done, false);
  assert.equal(badge([done('2026-01-01 09:00', 'ontime', 900)]).lv10.done, true);
  assert.equal(badge([done('2026-01-01 09:00', 'ontime', 400)], 500).lv10.done, true, '古い記録を捨てたときの繰り越し（expCarry）も足す');
  assert.deepEqual([badge([], 0).lv10.current, badge([done('2026-01-01 09:00', 'ontime', 250)]).lv10.current], [1, 3]);
});
