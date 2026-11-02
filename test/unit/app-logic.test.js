// app.js の日付・繰り返し・入力解析・完了の計算（残り日数・EXP・.ics）。コードは変えず、境目のケースを表にして確かめる。
// 画面まわりに依存しない関数だけを test/support/appFns.js で取り出して、「今」を固定した vm の中で動かす。
// 月末・うるう年・取りやめた回・回数指定は、間違えやすい境目。Worker の .ics（buildIcs）とのずれも、ここで気づけるようにする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs } from '../../worker/src/ics.js';
import { parseNow } from '../../worker/src/time.js';
import { extractFunction, loadAppFunctions } from '../support/appFns.js';

process.env.TZ = 'Asia/Tokyo'; // app.js は端末の時刻（ローカル）で計算する。日本時間に固定する

const FNS = [
  'pad', 'toLocalISO', 'startOfDay', 'daysBetween', 'parseItemDate', 'refDate', 'isRepeating', 'statusOf', 'remainText',
  'anchorDayOf', 'nextOccurrence', 'advanceRepeating', 'expandOccurrences', 'upcomingDue', 'monthEndRule',
  'toHalfWidth', 'parseQuick', 'trimCompletions', 'logCompletion', 'applyCompletionCore', 'levelOf', 'rewardOf',
  'parseChecklist', 'toggleChecklist', 'checklistProgress', 'picksFor', 'canPick', 'addPickDay', 'pickDaysIn', 'sanitizeIncomingItems', 'headerCount', 'needsKeyCard', 'versionInfo', 'metaContent', 'escHtml', 'prevOccurrence', 'progressOf', 'esc', 'utc', 'dateOnly', 'fold', 'alarm', 'relAlarm', 'remindersFor', 'reminderLabel', 'veventOf', 'buildICS',
];
const VARS = ['CHECK_RE', 'PICK_MAX', 'DOW', 'QUICK_DOW', 'EXP_PER_LEVEL', 'KIND_LABEL', 'REMINDER_DEFAULT', 'COMPLETION_LIMIT'];

/** 「今」を固定した Date（引数なしの new Date() と Date.now() だけが固定される） */
function fixedDate(nowMs) {
  return class FixedDate extends Date {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  };
}

/** app.js の関数を、今（JST の "YYYY-MM-DD HH:MM"）と db を指定して読み込む */
function load(now = '2026-01-30 12:00', dbExtra = {}) {
  const db = {
    items: [], templates: [], trash: [], completions: [], expCarry: 0, categories: ['仕事', 'バイト', '課題', 'その他'],
    catReminders: {}, settings: { dayHour: 9, theme: 'auto' }, ...dbExtra,
  };
  const app = loadAppFunctions(FNS, { Date: fixedDate(parseNow(now)), db }, VARS);
  return { app, db, now: new Date(parseNow(now)) };
}
/** 端末の時刻（JST）での ISO 文字列。app.js は締切を toISOString() で持つ */
const iso = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();
/** vm の中で作られた値（配列・オブジェクト）を、deepEqual で比べられる形にする */
const plain = (x) => JSON.parse(JSON.stringify(x));
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const keyTime = (d) => `${key(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// ---- 取り出しの仕組み ----

test('取り出しの仕組み: 1行で書かれた関数も、そこで終わる（後ろの関数まで巻き込まない）。見つからなければ失敗する', () => {
  const code = extractFunction('esc');
  assert.match(code, /^function esc\(s\)\{.*\}$/s);
  assert.equal(code.split('\n').length, 1, '1行');
  assert.throws(() => extractFunction('noSuchFunction'), /見つかりません/);
  // 取り出した範囲は、読み込むとちょうどその関数が1つ定義される
  const { app } = load();
  for (const n of FNS) assert.equal(typeof app[n], 'function', n);
});

// ---- 繰り返しの次の回 ----

test('nextOccurrence: 週・隔週は日数どおり。月・年は基準日を保ち、その月に無い日は月末に丸める（1/31 の翌月が 3/3 にならない）', () => {
  const { app } = load();
  const t = (d, rep, anchor) => keyTime(app.nextOccurrence(d, rep, anchor));
  const d = (y, m, day, h = 17, mi = 30) => new Date(y, m - 1, day, h, mi);
  const table = [
    // [起点, 繰り返し, 基準日, 期待]
    [d(2026, 1, 30), 'weekly', undefined, '2026-02-06 17:30'],
    [d(2026, 1, 30), 'biweekly', undefined, '2026-02-13 17:30'],
    [d(2026, 12, 28), 'weekly', undefined, '2027-01-04 17:30'], // 年またぎ
    [d(2026, 1, 31), 'monthly', 31, '2026-02-28 17:30'],       // 2月は月末
    [d(2026, 2, 28), 'monthly', 31, '2026-03-31 17:30'],       // 基準日 31 に戻る
    [d(2026, 3, 31), 'monthly', 31, '2026-04-30 17:30'],
    [d(2028, 1, 31), 'monthly', 31, '2028-02-29 17:30'],       // うるう年の2月
    [d(2026, 1, 30), 'monthly', 30, '2026-02-28 17:30'],
    [d(2026, 1, 31), 'monthly', undefined, '2026-02-28 17:30'], // 基準日が無ければ起点の日
    [d(2026, 12, 31), 'monthly', 31, '2027-01-31 17:30'],      // 年またぎ
    [d(2028, 2, 29), 'yearly', 29, '2029-02-28 17:30'],        // うるう日の翌年は 2/28
    [d(2029, 2, 28), 'yearly', 29, '2030-02-28 17:30'],
    [d(2031, 2, 28), 'yearly', 29, '2032-02-29 17:30'],        // 次のうるう年は 2/29 に戻る
    [d(2026, 5, 15, 0, 0), 'yearly', undefined, '2027-05-15 00:00'],
  ];
  for (const [from, rep, anchor, want] of table) assert.equal(t(from, rep, anchor), want, `${keyTime(from)} ${rep} 基準${anchor}`);
  assert.equal(keyTime(app.nextOccurrence(d(2026, 1, 30), 'none')), '2026-01-30 17:30', '繰り返しでなければ動かさない');
});

test('anchorDayOf: 基準日（repDay）があればそれ、無ければ締切の日', () => {
  const { app } = load();
  assert.equal(app.anchorDayOf({ due: iso(2026, 2, 28, 10), repDay: 31 }), 31);
  assert.equal(app.anchorDayOf({ due: iso(2026, 2, 28, 10) }), 28);
});

test('advanceRepeating: 1回分進める。月末の丸めのあとも基準日（repDay）で元の日に戻れる。seq が1つ増える', () => {
  const { app } = load();
  const it = { id: 'm', rep: 'monthly', due: iso(2026, 1, 31, 17, 0), seq: 0 };
  assert.equal(app.advanceRepeating(it), true);
  assert.equal(keyTime(new Date(it.due)), '2026-02-28 17:00');
  assert.equal(it.repDay, 31, '基準日を覚える');
  assert.equal(it.seq, 1);
  app.advanceRepeating(it);
  assert.equal(keyTime(new Date(it.due)), '2026-03-31 17:00', '基準日 31 に戻る');
  assert.equal(it.seq, 2);
  // 週次は基準日を持たない
  const w = { id: 'w', rep: 'weekly', due: iso(2026, 1, 30, 9, 0) };
  app.advanceRepeating(w);
  assert.equal(w.repDay, undefined);
  assert.equal(keyTime(new Date(w.due)), '2026-02-06 09:00');
});

test('advanceRepeating: 取りやめた回（skip）は飛ばす。続けて取りやめていれば、その先まで進む', () => {
  const { app } = load();
  const it = { id: 'w', rep: 'weekly', due: iso(2026, 1, 30, 9, 0), skip: ['2026-02-06', '2026-02-13'] };
  app.advanceRepeating(it);
  assert.equal(keyTime(new Date(it.due)), '2026-02-20 09:00');
  assert.equal(it.seq, 1, '飛ばしても seq は1回分だけ増える');
});

test('advanceRepeating: 回数指定（repCount は今の回を含む残り回数）。最終回は false を返し、何も変えない。取りやめた回も回数を使う', () => {
  const { app } = load();
  const it = { id: 'c', rep: 'weekly', due: iso(2026, 1, 30, 9, 0), repCount: 3 };
  assert.equal(app.advanceRepeating(it), true);
  assert.equal(it.repCount, 2);
  assert.equal(app.advanceRepeating(it), true);
  assert.equal(it.repCount, 1);
  const before = plain(it);
  assert.equal(app.advanceRepeating(it), false, '残り1回＝今の回が最終回');
  assert.deepEqual(plain(it), before, '最終回では何も変えない');
  // 取りやめた回も1回分として数える
  const s = { id: 's', rep: 'weekly', due: iso(2026, 1, 30, 9, 0), repCount: 3, skip: ['2026-02-06'] };
  assert.equal(app.advanceRepeating(s), true);
  assert.equal(keyTime(new Date(s.due)), '2026-02-13 09:00');
  assert.equal(s.repCount, 1, '2回分進んだので、残りは3 → 1');
  // 取りやめで回数を使い切るなら、進めない
  const e = { id: 'e', rep: 'weekly', due: iso(2026, 1, 30, 9, 0), repCount: 2, skip: ['2026-02-06'] };
  assert.equal(app.advanceRepeating(e), false);
});

test('advanceRepeating: 期間つき（start）は、開始と締切の間隔を保って進む', () => {
  const { app } = load();
  const it = { id: 'p', rep: 'weekly', start: iso(2026, 1, 30, 9, 0), due: iso(2026, 1, 30, 17, 0) };
  app.advanceRepeating(it);
  assert.equal(keyTime(new Date(it.start)), '2026-02-06 09:00');
  assert.equal(keyTime(new Date(it.due)), '2026-02-06 17:00');
});

// ---- 展開（カレンダー表示用） ----

test('expandOccurrences: 繰り返しでなければそのまま。週次は範囲内の回だけ、複製には isExpanded が付く（元は変えない）', () => {
  const { app, now } = load();
  const once = { id: 'o', due: iso(2026, 2, 1, 10) };
  assert.deepEqual(plain(app.expandOccurrences(once, now, new Date(2026, 5, 1))), [once]);
  const it = { id: 'w', rep: 'weekly', due: iso(2026, 1, 30, 17, 0), title: 't' };
  const out = app.expandOccurrences(it, new Date(2026, 1, 1), new Date(2026, 1, 28, 23, 59));
  assert.deepEqual(Array.from(out, (o) => keyTime(new Date(o.due))), ['2026-02-06 17:00', '2026-02-13 17:00', '2026-02-20 17:00', '2026-02-27 17:00']);
  assert.ok(out.every((o) => o.isExpanded === true && o.title === 't'));
  assert.equal(it.due, iso(2026, 1, 30, 17, 0), '元のデータは変えない');
  assert.equal(it.isExpanded, undefined);
});

test('expandOccurrences: 古い締切の無期限の繰り返しも、範囲の手前まで送って数える（60回分が過去で尽きない）', () => {
  const { app } = load();
  const it = { id: 'old', rep: 'weekly', due: iso(2020, 1, 3, 9, 0) }; // 6年前から放置
  const out = app.expandOccurrences(it, new Date(2026, 1, 1), new Date(2026, 1, 28, 23, 59));
  assert.deepEqual(Array.from(out, (o) => key(new Date(o.due))), ['2026-02-06', '2026-02-13', '2026-02-20', '2026-02-27']);
});

test('expandOccurrences: 回数指定の上限。無期限でも60回で打ち切る。取りやめた回は出ない。月末の丸め・期間つきの start も保つ', () => {
  const { app } = load();
  const far = new Date(2040, 0, 1);
  const counted = { id: 'c', rep: 'weekly', due: iso(2026, 1, 30, 9, 0), repCount: 3 };
  assert.equal(app.expandOccurrences(counted, new Date(2026, 0, 1), far).length, 3);
  const endless = { id: 'e', rep: 'weekly', due: iso(2026, 1, 30, 9, 0) };
  assert.equal(app.expandOccurrences(endless, new Date(2026, 0, 1), far).length, 60);
  const skipped = { id: 's', rep: 'weekly', due: iso(2026, 1, 30, 9, 0), skip: ['2026-02-06'] };
  assert.deepEqual(Array.from(app.expandOccurrences(skipped, new Date(2026, 0, 1), new Date(2026, 1, 20, 23, 59)), (o) => key(new Date(o.due))),
    ['2026-01-30', '2026-02-13', '2026-02-20']);
  const monthly = { id: 'm', rep: 'monthly', due: iso(2026, 1, 31, 23, 59) };
  assert.deepEqual(Array.from(app.expandOccurrences(monthly, new Date(2026, 0, 1), new Date(2026, 4, 31, 23, 59)), (o) => key(new Date(o.due))),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  const period = { id: 'p', rep: 'weekly', start: iso(2026, 1, 30, 9, 0), due: iso(2026, 1, 30, 17, 0) };
  const [a, b] = app.expandOccurrences(period, new Date(2026, 0, 1), new Date(2026, 1, 8));
  assert.equal(keyTime(new Date(b.start)), '2026-02-06 09:00');
  assert.equal(keyTime(new Date(b.due)), '2026-02-06 17:00');
  assert.equal(a.occurrence, undefined);
  assert.equal(b.occurrence, 1, '2回目以降は occurrence が付き、未完了として扱う');
  assert.equal(b.done, false);
});

test('upcomingDue: 完了し忘れて過ぎた繰り返しは「今より先の最初の回」を返す。元は変えない。回数を使い切っていれば null', () => {
  const { app } = load('2026-01-30 12:00');
  const it = { id: 'w', rep: 'weekly', due: iso(2026, 1, 9, 9, 0) };
  assert.equal(keyTime(app.upcomingDue(it)), '2026-02-06 09:00');
  assert.equal(it.due, iso(2026, 1, 9, 9, 0), '元のデータは変えない');
  const future = { id: 'f', rep: 'weekly', due: iso(2026, 2, 3, 9, 0) };
  assert.equal(keyTime(app.upcomingDue(future)), '2026-02-03 09:00', 'まだ先ならそのまま');
  assert.equal(app.upcomingDue({ id: 'x', rep: 'weekly', due: iso(2026, 1, 9, 9, 0), repCount: 1 }), null);
});

// ---- 完了と EXP ----

test('logCompletion: 前倒し（1日以上前）・期限内・遅れ・自動の EXP と種類。前倒しは 10＋5×日数（最大 +40）', () => {
  const H = 3600000;
  const table = [
    // [締切までの時間, 種類, EXP]
    [-0.1, 'late', 5],
    [-100, 'late', 5],
    [0, 'ontime', 10],        // ちょうど今は遅れではない
    [23.9, 'ontime', 10],
    [24, 'early', 15],        // 24時間前から前倒し（10 + 5×1）
    [47.9, 'early', 15],
    [48, 'early', 20],
    [24 * 8, 'early', 50],    // 上限（10 + 40）
    [24 * 30, 'early', 50],
  ];
  for (const [hours, kind, exp] of table) {
    const { app, db, now } = load();
    const it = { id: 'i', title: 'T', due: new Date(now.getTime() + hours * H).toISOString(), cat: '課題' };
    const c = app.logCompletion(it, 'manual');
    assert.deepEqual([c.kind, c.exp], [kind, exp], `${hours}時間前`);
    assert.equal(c.lead, Math.round(hours * 10) / 10);
    assert.equal(c.itemId, 'i');
    assert.equal(c.src, 'manual');
    assert.equal(db.completions.length, 1);
  }
  const { app, now } = load();
  const auto = app.logCompletion({ id: 'a', title: 'A', due: new Date(now.getTime() - 5 * H).toISOString() }, 'auto');
  assert.deepEqual([auto.kind, auto.exp, auto.cat], ['auto', 0, 'その他'], '自動完了は記録だけで EXP は付けない。カテゴリが無ければ「その他」');
  const rep = app.logCompletion({ id: 'r', title: 'R', rep: 'weekly', due: new Date(now.getTime() + 2 * H).toISOString() }, 'manual');
  assert.equal(rep.rep, true, '繰り返しの記録には rep が付く');
});

test('logCompletion: 記録が上限（500件）を超えたら、古いものから EXP を繰越に移して消す', () => {
  const { app, db, now } = load('2026-01-30 12:00', { completions: Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, exp: 10 })), expCarry: 7 });
  app.logCompletion({ id: 'n', title: 'N', due: new Date(now.getTime() + 3600000).toISOString() }, 'manual');
  assert.equal(db.completions.length, 500);
  assert.equal(db.completions[0].id, 'c1', '最も古い1件が消える');
  assert.equal(db.expCarry, 17, '消した分の EXP（10）が繰越に入る');
});

test('applyCompletionCore: 通常は完了に。繰り返しは完了にせず次の回へ進む。最終回は完了になる', () => {
  const { app, now } = load('2026-01-30 12:00');
  const once = { id: 'o', due: iso(2026, 2, 1, 10, 0) };
  assert.deepEqual(plain(app.applyCompletionCore(once)), { repeating: false });
  assert.equal(once.done, true);
  assert.equal(once.doneAt, now.toISOString());

  const w = { id: 'w', rep: 'weekly', due: iso(2026, 1, 30, 17, 0) };
  const r = app.applyCompletionCore(w);
  assert.equal(r.repeating, true);
  assert.equal(keyTime(r.next), '2026-02-06 17:00');
  assert.equal(w.done, false, '繰り返しは完了のままにしない');
  assert.equal(w.doneAt, undefined);

  const last = { id: 'l', rep: 'weekly', due: iso(2026, 1, 30, 17, 0), repCount: 1 };
  assert.deepEqual(plain(app.applyCompletionCore(last)), { repeating: true, final: true });
  assert.equal(last.done, true, '最終回は完了になる');
});

test('applyCompletionCore: 自動完了の繰り返しは、しばらく開かなかった間の回も含めて「今より先の回」まで一度に進む', () => {
  const { app } = load('2026-01-30 12:00');
  const it = { id: 'a', rep: 'weekly', autoComplete: true, due: iso(2026, 1, 2, 9, 0), seq: 0 };
  const r = app.applyCompletionCore(it);
  assert.equal(keyTime(r.next), '2026-02-06 09:00');
  assert.equal(it.seq, 5, '1/9・1/16・1/23・1/30・2/6 と5回進む');
  // 自動完了でなければ、1回分だけ（過ぎたままの回が残る）
  const manual = { id: 'm', rep: 'weekly', due: iso(2026, 1, 2, 9, 0) };
  app.applyCompletionCore(manual);
  assert.equal(keyTime(new Date(manual.due)), '2026-01-09 09:00');
});

test('levelOf・rewardOf: 100 EXP ごとにレベルが1上がる。上がったか・ゲージの位置も返す', () => {
  const { app } = load();
  const lv = (e) => app.levelOf(e);
  assert.deepEqual([lv(0), lv(99), lv(100), lv(199), lv(200), lv(undefined), lv(250)], [1, 1, 2, 2, 3, 1, 3]);
  assert.deepEqual(plain(app.rewardOf({ exp: 10, kind: 'early' }, 95)),
    { gain: 10, bonus: '前倒しボーナス', level: 2, levelUp: true, into: 5, fromInto: 95 });
  assert.deepEqual(plain(app.rewardOf({ exp: 5, kind: 'late' }, 10)),
    { gain: 5, bonus: '遅れてもクリア', level: 1, levelUp: false, into: 15, fromInto: 10 });
  assert.equal(app.rewardOf({ exp: 0, kind: 'auto' }, 0).bonus, '自動完了');
  assert.equal(app.rewardOf({ exp: 0, kind: 'other' }, 0).bonus, '', '知らない種類は空');
});

// ---- 残り日数・状態 ----

test('remainText・statusOf: 今日・明日・期間の途中・期限切れ（今日の過ぎた時刻・何日超過）の表示と状態', () => {
  const { app } = load('2026-01-30 12:00'); // 金曜の昼
  const R = (it) => plain(app.remainText(it));
  const S = (it) => app.statusOf(it);
  const t = (d, h = 0, mi = 0) => iso(2026, 1, d, h, mi);
  const table = [
    // [項目, 残り日数の表示, 状態]
    [{ due: t(30, 9) }, { n: '—', u: '期限切れ' }, 'over'],                 // 今日の過ぎた時刻
    [{ due: t(27, 9) }, { n: 3, u: '日 超過' }, 'over'],
    [{ due: t(30, 17), allDay: false }, { n: 5, u: '時間後・今日' }, 'today'],
    [{ due: t(30, 12, 30) }, { n: 0, u: '時間後・今日' }, 'today'],           // 1時間未満は 0
    [{ due: t(30, 23, 59), allDay: true }, { n: '今日', u: '締切' }, 'today'],
    [{ due: t(30, 23, 59), allDay: true, start: t(30, 0) }, { n: '今日', u: '開始' }, 'today'],
    [{ due: t(31, 9) }, { n: 1, u: '日後' }, 'soon'],
    [{ due: iso(2026, 2, 2, 9) }, { n: 3, u: '日後' }, 'soon'],                  // 2/2 = あと3日
    [{ due: iso(2026, 2, 3, 9) }, { n: 4, u: '日後' }, 'near'],
    [{ due: iso(2026, 2, 6, 9) }, { n: 7, u: '日後' }, 'near'],
    [{ due: iso(2026, 2, 7, 9) }, { n: 8, u: '日後' }, 'far'],
    [{ due: iso(2026, 2, 10, 9), start: iso(2026, 2, 3, 9) }, { n: 4, u: '日後に開始' }, 'near'], // 期間つきは開始日まで
    [{ due: iso(2026, 2, 5, 9), start: t(29, 9) }, { n: '—', u: '進行中' }, 'today'],           // 期間の途中
  ];
  for (const [it, remain, status] of table) {
    assert.deepEqual(R(it), remain, JSON.stringify(it));
    assert.equal(S(it), status, JSON.stringify(it));
  }
});

// ---- クイック入力 ----

test('toHalfWidth: 全角の数字・英字・記号と全角スペースを半角にする', () => {
  const { app } = load();
  assert.equal(app.toHalfWidth('１７：３０　Ａｂ／＃'), '17:30 Ab/#');
  assert.equal(app.toHalfWidth('明日 17時'), '明日 17時');
});

test('parseQuick: 日付・時刻・繰り返し・カテゴリ・テンプレートを1行から読み取る（README・入力欄の書き方の例）', () => {
  const { app, now } = load('2026-01-30 12:00', { templates: [{ id: 'tp1', name: '週報' }] }); // 金曜の昼
  const P = (text) => {
    const r = app.parseQuick(text, now);
    return { title: r.title, date: r.date ? key(r.date) : null, time: r.time, allDay: r.allDay, rep: r.rep, cat: r.cat, tpl: r.tpl ? r.tpl.name : null };
  };
  const base = { title: '', date: null, time: null, allDay: false, rep: 'none', cat: null, tpl: null };
  const table = [
    ['明日 17時 レポート提出', { title: 'レポート提出', date: '2026-01-31', time: '17:00' }],
    ['毎週水曜 17:00 バイト #バイト', { title: 'バイト', date: '2026-02-04', time: '17:00', rep: 'weekly', cat: 'バイト' }],
    ['10/20 レポート提出', { title: 'レポート提出', date: '2026-10-20', allDay: true }],
    ['10月15日 提出', { title: '提出', date: '2026-10-15', allDay: true }],
    ['2027/1/5 提出', { title: '提出', date: '2027-01-05', allDay: true }],
    ['2027年1月5日 提出', { title: '提出', date: '2027-01-05', allDay: true }],
    ['1/5 提出', { title: '提出', date: '2027-01-05', allDay: true }],         // 過ぎた日付は来年
    ['1/30 提出', { title: '提出', date: '2026-01-30', allDay: true }],        // 今日はそのまま
    ['今日 提出', { title: '提出', date: '2026-01-30', allDay: true }],
    ['きょう 提出', { title: '提出', date: '2026-01-30', allDay: true }],
    ['明後日 提出', { title: '提出', date: '2026-02-01', allDay: true }],
    ['あさって 提出', { title: '提出', date: '2026-02-01', allDay: true }],
    ['あした 提出', { title: '提出', date: '2026-01-31', allDay: true }],
    ['3日後 提出', { title: '提出', date: '2026-02-02', allDay: true }],
    ['金曜 提出', { title: '提出', date: '2026-01-30', allDay: true }],        // 曜日だけなら今日を含めて次のその曜日
    ['月曜 提出', { title: '提出', date: '2026-02-02', allDay: true }],
    ['来週水曜 提出', { title: '提出', date: '2026-02-04', allDay: true }],     // 週は月曜はじまり
    ['再来週月曜 提出', { title: '提出', date: '2026-02-09', allDay: true }],
    ['今週日曜 提出', { title: '提出', date: '2026-02-01', allDay: true }],
    ['明日 17時半 会議', { title: '会議', date: '2026-01-31', time: '17:30' }],
    ['明日 17:30 会議', { title: '会議', date: '2026-01-31', time: '17:30' }],
    ['明日 午後5時 会議', { title: '会議', date: '2026-01-31', time: '17:00' }],
    ['明日 午前12時 会議', { title: '会議', date: '2026-01-31', time: '00:00' }],
    ['明日 午前9時15分 会議', { title: '会議', date: '2026-01-31', time: '09:15' }],
    ['明日 正午 会議', { title: '会議', date: '2026-01-31', time: '12:00' }],
    ['明日 24:00 会議', { title: '会議', date: '2026-01-31', time: '23:59' }],
    ['明日 １７：３０ 会議', { title: '会議', date: '2026-01-31', time: '17:30' }], // 全角
    ['明日 終日 出張', { title: '出張', date: '2026-01-31', allDay: true }],
    ['毎月 15日 支払い', { title: '15日 支払い', rep: 'monthly' }],             // 「15日」は日付として読まない
    ['毎年 3/1 記念日', { title: '記念日', date: '2026-03-01', allDay: true, rep: 'yearly' }],
    ['17時 会議', { title: '会議', date: '2026-01-30', time: '17:00' }],        // 時刻だけ: まだ来ていなければ今日
    ['9時 会議', { title: '会議', date: '2026-01-31', time: '09:00' }],         // 過ぎていれば明日
    ['明日 週報', { title: '週報', date: '2026-01-31', tpl: '週報' }],           // テンプレート名だけなら、テンプレートの設定を使う（終日にしない）
    ['週報', { title: '週報', tpl: '週報' }],
    ['2/30 提出', { title: '2/30 提出' }],                                       // 無い日付は読まない
    ['明日 25時 会議', { title: '25時 会議', date: '2026-01-31', allDay: true }], // 無い時刻は読まない
    ['#未登録 提出', { title: '#未登録 提出' }],                                 // 登録していないカテゴリは読まない
    ['明日までにレポート', { title: 'レポート', date: '2026-01-31', allDay: true }],
    ['', {}],
  ];
  for (const [text, want] of table) assert.deepEqual(P(text), { ...base, ...want }, JSON.stringify(text));
});

// ---- .ics ----

const ICS_ITEMS = [
  { id: 'i1', title: 'レポート提出', due: iso(2026, 2, 3, 17, 0), cat: '課題', memo: '範囲;1章,2章\n3章\\終わり', seq: 3 },
  { id: 'i2', title: '終日の締切', due: iso(2026, 2, 10, 23, 59), allDay: true, cat: 'その他' },
  { id: 'i3', title: '合宿', start: iso(2026, 2, 12, 9, 0), due: iso(2026, 2, 14, 17, 0), cat: '仕事' },
  { id: 'i4', title: '週次の定例', rep: 'weekly', due: iso(2026, 2, 4, 18, 0), skip: ['2026-02-11', '2026-02-18'], seq: 2, cat: '仕事' },
  { id: 'i5', title: '月末の支払い', rep: 'monthly', repDay: 31, due: iso(2026, 1, 31, 23, 59), allDay: true, cat: '課題' },
  { id: 'i6', title: 'うるう日の更新', rep: 'yearly', due: iso(2028, 2, 29, 23, 59), allDay: true, cat: 'その他' },
  { id: 'i7', title: '隔週・5回まで', rep: 'biweekly', repCount: 5, due: iso(2026, 2, 6, 9, 30), cat: '課題' },
  { id: 'i8', title: 'とても長い日本語のタイトルの予定で、一行が75オクテットを超えるので折り返される必要があります', due: iso(2026, 3, 1, 8, 0), cat: '仕事', memo: 'メモ' },
  { id: 'i9', title: '期間つきの週次', rep: 'weekly', start: iso(2026, 2, 5, 9, 0), due: iso(2026, 2, 5, 17, 0), skip: ['2026-02-12'], cat: '課題' },
  { id: 'i10', title: '終日の期間つき', start: iso(2026, 3, 3, 0, 0), due: iso(2026, 3, 5, 23, 59), allDay: true, cat: 'その他' },
];
const CAT_REMINDERS = { 課題: [3, 1, 0], 仕事: [14, 3, 0] };

test('buildICS: UID・RRULE・EXDATE・VALARM の行が、予定の種類ごとに期待どおり（月末の丸め・取りやめた回・通知の相対/絶対）', () => {
  const { app } = load('2026-01-30 12:00', { catReminders: CAT_REMINDERS });
  const ics = app.buildICS(ICS_ITEMS);
  const lines = ics.replace(/\r\n /g, '').split('\r\n');
  const events = [];
  for (const l of lines) { if (l === 'BEGIN:VEVENT') events.push([]); else if (events.length && l !== 'END:VEVENT') events[events.length - 1].push(l); }
  assert.equal(events.length, ICS_ITEMS.length);
  const ev = (id) => events.find((e) => e.includes(`UID:${id}@deadline-tracker`));
  // 日本時間 17:00 = UTC 08:00
  assert.ok(ev('i1').includes('SEQUENCE:3'));
  assert.ok(ev('i1').includes('DTSTART:20260203T073000Z'), '17:00 の締切は 30 分前（UTC 07:30）から');
  assert.ok(ev('i1').includes('DTEND:20260203T080000Z'));
  assert.ok(ev('i1').includes('DESCRIPTION:範囲\\;1章\\,2章\\n3章\\\\終わり'), 'メモは ; , 改行 \\ をエスケープする');
  assert.equal(ev('i1').filter((l) => l.startsWith('TRIGGER')).length, 3, '課題は 3日前・前日・当日');
  assert.ok(ev('i1').includes('TRIGGER;VALUE=DATE-TIME:20260131T080000Z'), '3日前は締切と同じ時刻（絶対時刻）');
  assert.ok(ev('i1').includes('TRIGGER;VALUE=DATE-TIME:20260203T000000Z'), '当日は 9:00（UTC 0:00）');
  // 終日
  assert.ok(ev('i2').includes('DTSTART;VALUE=DATE:20260210') && ev('i2').includes('DTEND;VALUE=DATE:20260211'), '終日の DTEND は翌日');
  // 月末の丸め（毎月・基準日31）
  assert.ok(ev('i5').includes('RRULE:FREQ=MONTHLY;BYMONTHDAY=31,-1;BYSETPOS=1'));
  assert.ok(ev('i6').includes('RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29,-1;BYSETPOS=1'));
  assert.ok(ev('i7').includes('RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=5'));
  // 終日の繰り返しの通知: 終了（DTEND）は翌日 0 時なので、締切（23:59）との差 1 分を足して、繰り返しでない予定と同じ時刻に鳴らす
  assert.ok(ev('i5').includes('TRIGGER;RELATED=END:-PT4321M'), '3日前: 3×1440 + 1');
  assert.ok(ev('i5').includes('TRIGGER;RELATED=END:-PT900M'), '当日 9:00: 14時間59分 + 1');
  // 取りやめた回は EXDATE（開始時刻に合わせる。17:30〜18:00 の定例は 17:30 開始 = UTC 09:00 ではなく 08:30）
  assert.deepEqual(ev('i4').filter((l) => l.startsWith('EXDATE')), ['EXDATE:20260211T083000Z', 'EXDATE:20260218T083000Z']);
  assert.ok(ev('i4').includes('RRULE:FREQ=WEEKLY'));
  assert.ok(ev('i4').every((l) => !l.startsWith('TRIGGER;VALUE=DATE-TIME')), '繰り返しの通知は相対時間（毎回鳴る）');
  assert.ok(ev('i4').includes('TRIGGER;RELATED=END:-PT20160M'), '14日前（= 20160 分）');
  // 折り返し: どの行も 75 オクテット以内
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, `${Buffer.byteLength(l)} バイト: ${l.slice(0, 30)}`);
  assert.ok(ics.includes('\r\n '), '長い行は折り返す');
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('buildICS: アプリの .ics と Worker（購読用）の .ics が、同じデータで1文字まで同じ。ずれたら二重実装（項目8）が崩れている', () => {
  const { app } = load('2026-01-30 12:00', { catReminders: CAT_REMINDERS });
  // Worker はアプリと同じ並び順（期間つきは開始日、同じなら締切の早い順）で書き出す
  const sorted = [...ICS_ITEMS].sort((a, b) => (new Date(a.start || a.due) - new Date(b.start || b.due)) || (new Date(a.due) - new Date(b.due)));
  const fromApp = app.buildICS(sorted);
  const { ics: fromWorker } = buildIcs({ items: ICS_ITEMS, catReminders: CAT_REMINDERS }, { now: parseNow('2026-01-30 12:00'), dayHour: 9 });
  assert.equal(fromApp, fromWorker);
});

// ---- ヘッダーの件数（D1: 「7日以内 0」なのに一覧に定期予定が並んで、食い違って見えないように） ----

test('headerCount: 7日以内は繰り返さない締切だけを数え、定期予定は「＋定期 N」と添える。数え方は変えない', () => {
  const { app, now } = load('2026-01-30 12:00');
  const it = (id, due, extra = {}) => ({ id, title: id, due: iso(...due), rep: 'none', ...extra });
  const items = [
    it('once-soon', [2026, 2, 3, 9]),                          // 締切: 数える
    it('once-far', [2026, 3, 1, 9]),                           // 8日より先: 数えない
    it('rep-soon', [2026, 2, 2, 9], { rep: 'weekly' }),        // 定期: 数字には入れず、補足に
    it('rep-soon2', [2026, 2, 4, 9], { rep: 'monthly' }),
    it('rep-far', [2026, 3, 5, 9], { rep: 'weekly' }),         // 7日より先の定期: 補足にも入れない
  ];
  assert.deepEqual(plain(app.headerCount(items, now, 'list')), { num: 1, label: '締切 7日以内', sub: '＋定期 2' });
  // 定期が無ければ補足は空（「＋定期 0」とは出さない）
  assert.deepEqual(plain(app.headerCount(items.filter((i) => i.rep === 'none'), now, 'list')), { num: 1, label: '締切 7日以内', sub: '' });
  // 何も無い日: 0 と、補足なし
  assert.deepEqual(plain(app.headerCount([], now, 'list')), { num: 0, label: '締切 7日以内', sub: '' });
});

test('headerCount: 期限切れがあれば期限切れの数を出す。超過・定期予定の画面は、それぞれの数のまま', () => {
  const { app, now } = load('2026-01-30 12:00');
  const it = (id, due, extra = {}) => ({ id, title: id, due: iso(...due), rep: 'none', ...extra });
  const items = [
    it('late', [2026, 1, 29, 9]),                              // 期限切れ（完了にし忘れた定期も含める）
    it('late-rep', [2026, 1, 28, 9], { rep: 'weekly' }),
    it('soon', [2026, 2, 1, 9]),
    it('rep', [2026, 2, 2, 9], { rep: 'weekly' }),
  ];
  assert.deepEqual(plain(app.headerCount(items, now, 'list')), { num: 2, label: '期限切れ', sub: '' });
  assert.deepEqual(plain(app.headerCount(items, now, 'over')), { num: 2, label: '超過', sub: '' });
  assert.deepEqual(plain(app.headerCount(items, now, 'rep')), { num: 2, label: '定期予定', sub: '' });
});

// ---- 初めての端末の案内カード（D6） ----

test('needsKeyCard: Cloudflare 配信で、キー未入力（またはキー違いと分かった）端末にだけ出す。読み込めたら消す', () => {
  const { app } = load();
  const t = (...a) => app.needsKeyCard(...a);
  //      (CF,    キー保存済み, 認証停止, 読み込み済み)
  assert.equal(t(true, false, false, false), true, '初めての端末');
  assert.equal(t(true, true, true, false), true, 'キーが違うと分かった端末');
  assert.equal(t(true, true, false, false), false, 'キーがあって通れている端末には出さない');
  assert.equal(t(true, false, false, true), false, '読み込めた後は、保存できない端末でも消す');
  assert.equal(t(true, true, true, true), false, '入れ直して読み込めたら消す');
  assert.equal(t(false, false, false, false), false, 'GitHub 配信では出さない');
  assert.equal(t(null, false, false, false), false, '保存先の判定前は出さない');
});

// ---- 登録画面の「詳しい設定」（D4: たまにしか使わない項目は閉じておく。設定済みなら開いて、見えないまま効かせない） ----

test('dlgMoreActive: 期間・自動完了・この締切だけの色・帯を隠す、のどれかが既定から変わっていれば開く', () => {
  const state = { fSpan: false, fAutoComplete: false, fRep: 'none', fCalShow: true };
  const doc = { getElementById: (id) => ({ checked: state[id], value: state[id] }) };
  const run = (over = {}, color = null) => {
    Object.assign(state, { fSpan: false, fAutoComplete: false, fRep: 'none', fCalShow: true }, over);
    return loadAppFunctions(['dlgMoreActive'], { document: doc, dlgColor: color }).dlgMoreActive();
  };
  assert.equal(run(), false, '既定のまま');
  assert.equal(run({ fSpan: true }), true, '期間つき');
  assert.equal(run({ fAutoComplete: true }), true, '自動完了');
  assert.equal(run({}, '#336699'), true, 'この締切だけの色');
  assert.equal(run({ fRep: 'weekly', fCalShow: false }), true, '繰り返しで帯を隠している');
  assert.equal(run({ fRep: 'none', fCalShow: false }), false, '繰り返さない予定では、帯の設定は効かない');
  assert.equal(run({ fRep: 'weekly', fCalShow: true }), false, '繰り返しでも、帯を出すのは既定');
});

// ---- 経過メーター（D11: 繰り返しの予定は「前の回から次の回まで」で測る） ----

test('prevOccurrence: nextOccurrence の逆。月・年は基準日を保ち、その月に無い日は月末に丸める', () => {
  const { app } = load();
  const t = (d, rep, anchor) => keyTime(app.prevOccurrence(d, rep, anchor));
  assert.equal(t(new Date(2026, 1, 6, 12), 'weekly'), '2026-01-30 12:00');
  assert.equal(t(new Date(2026, 1, 6, 12), 'biweekly'), '2026-01-23 12:00');
  assert.equal(t(new Date(2026, 2, 31, 9), 'monthly', 31), '2026-02-28 09:00', '3/31 の前は 2/28（うるう年でなければ）');
  assert.equal(t(new Date(2028, 2, 31, 9), 'monthly', 31), '2028-02-29 09:00', 'うるう年');
  assert.equal(t(new Date(2026, 0, 15, 9), 'monthly', 15), '2025-12-15 09:00', '年をまたぐ');
  assert.equal(t(new Date(2028, 1, 29, 9), 'yearly', 29), '2027-02-28 09:00', '2/29 の前の年');
  // nextOccurrence と往復できる
  const d = new Date(2026, 4, 20, 8, 30);
  for (const rep of ['weekly', 'biweekly', 'monthly', 'yearly']) {
    assert.equal(keyTime(app.prevOccurrence(app.nextOccurrence(d, rep, 20), rep, 20)), keyTime(d), rep);
  }
});

test('progressOf: 繰り返さない予定は登録日から締切まで（登録日が無ければ14日前）。繰り返す予定は前の回から次の回まで', () => {
  const { app } = load('2026-02-03 12:00');
  const it = (extra) => ({ id: 'x', title: 'x', due: iso(2026, 2, 6, 12), rep: 'none', ...extra });
  // 繰り返さない
  assert.equal(app.progressOf(it({ created: iso(2026, 1, 24, 12) }), new Date(2026, 1, 3, 12)), 77, '登録から締切まで13日のうち10日が過ぎた（10/13）');
  assert.equal(app.progressOf(it({}), new Date(2026, 1, 3, 12)), 79, '登録日なし: 14日前から。11/14');
  // 繰り返す: 毎週の締切 2/6 の前の回は 1/30。2/3 は 7日のうち4日
  const weekly = it({ rep: 'weekly', created: iso(2025, 6, 1, 12) }); // 登録は何か月も前。ここから測ると毎回ほぼいっぱいになる
  assert.equal(app.progressOf(weekly, new Date(2026, 1, 3, 12)), 57, '毎週: 4/7');
  assert.equal(app.progressOf(it({ rep: 'biweekly', created: iso(2025, 6, 1, 12) }), new Date(2026, 1, 3, 12)), 79, '隔週: 11/14');
  // 範囲外は 0〜100 に収める。完了は 100
  assert.equal(app.progressOf(weekly, new Date(2026, 1, 7, 12)), 100, '締切を過ぎた');
  assert.equal(app.progressOf(weekly, new Date(2026, 0, 20, 12)), 0, '前の回より前（カレンダーの先の回）');
  assert.equal(app.progressOf({ ...weekly, done: true }, new Date(2026, 1, 3, 12)), 100);
});

// ---- 設定の「バージョン」の表示（日時と v3.1。ハッシュは表に出さない） ----

test('versionInfo: 「日時 v版」の文字を作る。ハッシュ（[…]）と説明は表に出さず、ビルドの特定用に返す', () => {
  const { app } = load();
  const t = (stamp, v) => plain(app.versionInfo(stamp, v));
  assert.deepEqual(t('2026-10-31 08:00 [d21065ddfb] 達成カレンダーを草のように', '3.1'), { label: '2026-10-31 08:00 v3.1', build: 'd21065ddfb' });
  assert.deepEqual(t('2026-10-31 08:00 [d21065ddfb]', '3.1'), { label: '2026-10-31 08:00 v3.1', build: 'd21065ddfb' });
  assert.deepEqual(t('2026-10-30 07:00 手書きの説明', '3.1'), { label: '2026-10-30 07:00 v3.1', build: '' }, 'ハッシュが無い（旧環境・手書き）');
  assert.deepEqual(t('2026-10-31 08:00 [d21065ddfb]', undefined), { label: '2026-10-31 08:00', build: 'd21065ddfb' }, '版番号が無いときは日時だけ');
  assert.deepEqual(t('不明', '3.1'), { label: '不明', build: '' }, '読めないときはそのまま');
  assert.deepEqual(t('', '3.1'), { label: '不明', build: '' });
});

test('metaContent: HTML の meta の値を取り出す（サーバー上の版の比較に使う）', () => {
  const { app } = load();
  const html = '<meta name="build-stamp" content="2026-10-31 08:00 [abc]">\n<meta name="app-version" content="3.1">';
  assert.equal(app.metaContent(html, 'app-version'), '3.1');
  assert.equal(app.metaContent(html, 'build-stamp'), '2026-10-31 08:00 [abc]');
  assert.equal(app.metaContent(html, 'nothing'), '');
});

// ---- 今日の一手（項目17・19） ----

test('picksFor / canPick: その日の印の付いた未完了だけを締切の早い順に返す。昨日の印・完了済みは数えない。1日3件まで', () => {
  const { app } = load();
  const items = [
    { id: 'a', title: 'a', due: iso(2026, 2, 5, 10), pick: '2026-01-30' },
    { id: 'b', title: 'b', due: iso(2026, 2, 1, 10), pick: '2026-01-30' },
    { id: 'c', title: 'c', due: iso(2026, 2, 2, 10), pick: '2026-01-29' },   // 昨日の印は無視
    { id: 'd', title: 'd', due: iso(2026, 2, 3, 10), pick: '2026-01-30', done: true }, // 完了済み
    { id: 'e', title: 'e', due: iso(2026, 2, 4, 10) },
  ];
  assert.deepEqual(plain(app.picksFor(items, '2026-01-30')).map((i) => i.id), ['b', 'a']);
  assert.deepEqual(plain(app.picksFor(items, '2026-01-31')), []);
  assert.deepEqual(plain(app.picksFor(undefined, '2026-01-30')), []);
  assert.equal(app.canPick(items, '2026-01-30'), true, '2件なので、あと1件');
  assert.equal(app.canPick(items.concat({ id: 'f', title: 'f', due: iso(2026, 2, 6), pick: '2026-01-30' }), '2026-01-30'), false, '3件で上限');
  assert.equal(app.canPick(items, '2026-01-30', 1), false, '済んだ一手1件を数えると上限');
  assert.equal(app.canPick(items, '2026-01-29'), true);
});

test('addPickDay / pickDaysIn: 印の日付を重ねず足し、新しい60日分だけ残す。直近n日（今日を含む）の日数を数える', () => {
  const { app } = load();
  assert.deepEqual(plain(app.addPickDay(['2026-01-28'], '2026-01-30', 60)), ['2026-01-28', '2026-01-30']);
  assert.deepEqual(plain(app.addPickDay(['2026-01-30'], '2026-01-30', 60)), ['2026-01-30'], '同じ日は重ねない');
  const many = Array.from({ length: 70 }, (_, i) => `2025-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`);
  const kept = plain(app.addPickDay(many, '2026-01-30', 60));
  assert.equal(kept.length, 60);
  assert.equal(kept[59], '2026-01-30');
  assert.equal(kept[0] > many[0], true, '古いものから捨てる');
  const days = ['2026-01-16', '2026-01-18', '2026-01-30', '2026-01-31', '2026-01-30', 'x'];
  assert.equal(app.pickDaysIn(days, '2026-01-30', 14), 2, '16日は14日の外（30日から13日前の17日までが入る）。明日の31日・重複・壊れた値は数えない');
  assert.equal(app.pickDaysIn(['2026-01-17'], '2026-01-30', 14), 1, '13日前は入る');
  assert.equal(app.pickDaysIn([], '2026-01-30', 14), 0);
  assert.equal(app.pickDaysIn(undefined, '2026-01-30', 14), 0);
});

test('sanitizeIncomingItems: pick は "YYYY-MM-DD" の文字列だけ残す', () => {
  const { app } = load();
  const base = { id: 'x', title: 't', due: iso(2026, 2, 1, 10) };
  const keep = (pick) => plain(app.sanitizeIncomingItems([{ ...base, pick }]).kept[0]).pick;
  assert.equal(keep('2026-01-30'), '2026-01-30');
  for (const bad of [5, '', 'あした', '2026-1-3', ['2026-01-30'], null]) assert.equal(keep(bad), undefined, String(bad));
});

test('applyCompletionCore: 完了・繰り返しで次の回へ進んだときは、今日の一手の印を消す', () => {
  const { app } = load();
  const one = { id: 'a', title: 'a', due: iso(2026, 2, 1, 10), pick: '2026-01-30' };
  app.applyCompletionCore(one);
  assert.equal(one.done, true);
  assert.equal('pick' in one, false);
  const rep = { id: 'b', title: 'b', due: iso(2026, 2, 1, 10), rep: 'weekly', pick: '2026-01-30' };
  const r = app.applyCompletionCore(rep);
  assert.equal(r.repeating, true);
  assert.equal(rep.done, false);
  assert.equal('pick' in rep, false);
});

// ---- メモ内チェックリスト（項目18） ----

test('parseChecklist: チェックの行（- / * の箇条・[ ] [x] [X]・行頭の空白）を見つけ、ふつうの行はそのまま返す', () => {
  const { app } = load();
  const p = (m) => plain(app.parseChecklist(m));
  assert.deepEqual(p('提出先：職員室\n- [ ] 写真のクレジット\n- [x] 見出しの字数\n  * [X] PDF の書き出し\n終わり'), [
    { line: 0, check: false, text: '提出先：職員室' },
    { line: 1, check: true, checked: false, text: '写真のクレジット' },
    { line: 2, check: true, checked: true, text: '見出しの字数' },
    { line: 3, check: true, checked: true, text: 'PDF の書き出し' },
    { line: 4, check: false, text: '終わり' },
  ]);
  // チェックの行ではないもの：箇条が無い・カッコの中が空白でも x でもない・] の後に空白が無い・文の途中
  for (const memo of ['[ ] 手順', '- [] 手順', '- [-] 手順', '- [ ]手順', '- [ ]', '文の途中に - [ ] がある', '- [xx] 手順']) {
    assert.equal(p(memo).some((r) => r.check), false, memo);
  }
  assert.deepEqual(p('- [ ] a\r\n- [x] b\r\n'), [
    { line: 0, check: true, checked: false, text: 'a' },
    { line: 1, check: true, checked: true, text: 'b' },
    { line: 2, check: false, text: '' },
  ], '\\r\\n でも本文に \\r が混ざらない');
  for (const bad of ['', undefined, null, 5, ['- [ ] a'], {}]) assert.deepEqual(p(bad), [], String(bad));
});

test('toggleChecklist: その行の [ ] と [x] だけを入れ替える。他の行・空白・改行コードは1文字も変えない', () => {
  const { app } = load();
  const memo = '手順\n- [ ] a\n  * [x] b  \n\n- [X] c\nおわり';
  assert.equal(app.toggleChecklist(memo, 1), '手順\n- [x] a\n  * [x] b  \n\n- [X] c\nおわり');
  assert.equal(app.toggleChecklist(memo, 2), '手順\n- [ ] a\n  * [ ] b  \n\n- [X] c\nおわり', '末尾の空白も保つ');
  assert.equal(app.toggleChecklist(memo, 4), '手順\n- [ ] a\n  * [x] b  \n\n- [ ] c\nおわり', '大文字 X は外す');
  // 2回押すと元に戻る（大文字 X は小文字になるので、小文字の [x] で確かめる）
  assert.equal(app.toggleChecklist(app.toggleChecklist(memo, 1), 1), memo);
  // チェックの行でない・範囲外・メモが文字列でないときは何もしない
  for (const line of [0, 3, 5, 99, -1]) assert.equal(app.toggleChecklist(memo, line), memo, String(line));
  assert.equal(app.toggleChecklist(undefined, 0), undefined);
  assert.equal(app.toggleChecklist(5, 0), 5);
  assert.equal(app.toggleChecklist('', 0), '');
  // 改行コード \r\n は保つ
  assert.equal(app.toggleChecklist('- [ ] a\r\n- [ ] b\r\n', 1), '- [ ] a\r\n- [x] b\r\n');
});

test('checklistProgress: {done, total}。チェックの行が無ければ null', () => {
  const { app } = load();
  const p = (m) => { const r = app.checklistProgress(m); return r && plain(r); };
  assert.deepEqual(p('- [x] a\n- [ ] b\n- [X] c\n普通の文'), { done: 2, total: 3 });
  assert.deepEqual(p('- [x] a'), { done: 1, total: 1 });
  for (const m of ['', '普通のメモ', undefined, null, 5, '- 箇条書きだけ']) assert.equal(p(m), null, String(m));
});

test('チェックを押しても、他の行のメモの文字は変わらない（全行を順に押して確かめる）', () => {
  const { app } = load();
  const memo = '見出し\n- [ ] a\n- [x] b\n途中の文\n- [ ] c\n  - [ ] d\n';
  const rows = plain(app.parseChecklist(memo)).filter((r) => r.check);
  for (const r of rows) {
    const next = app.toggleChecklist(memo, r.line);
    const before = memo.split('\n'), after = next.split('\n');
    assert.equal(after.length, before.length);
    after.forEach((l, i) => { if (i !== r.line) assert.equal(l, before[i], `行 ${i}`); });
    assert.notEqual(after[r.line], before[r.line]);
  }
});
