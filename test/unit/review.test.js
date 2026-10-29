// 夜の再通知と週次レビュー。deadline-data-template の send_digest.sh（DIGEST_MODE=evening / weekly、DRY_RUN=1）が作った出力と、
// 1文字まで同じになるかを確かめる。test/expected/review/*.txt は、そのスクリプトにテスト用データを読ませて作った正解
// （メンションのユーザーIDとアプリの URL は、テスト用の固定値）。テンプレートには、Worker と同じ2つの規則を入れてある:
// 自動完了の予定は件数に数えない（夜の見出し・負荷予報）、リンクは <> で囲む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discordBodies } from '../../worker/src/digest.js';
import { buildEvening, buildWeekly } from '../../worker/src/review.js';
import { parseNow } from '../../worker/src/time.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const UID = '100000000000000001';
const cfg = { appUrl: 'https://example.com/app/', mentionUserId: UID };
const dryRun = (bodies) => bodies.map((b) => `----- [DRY_RUN] 送信内容 -----\n${b.content}\n`).join('');
const evening = (data, at, extra = {}) => buildEvening(data, { now: parseNow(at), ...cfg, ...extra });
const weekly = (data, at, extra = {}) => buildWeekly(data, { now: parseNow(at), ...cfg, ...extra });
const bodiesOf = (contents) => [].concat(contents).flatMap((c) => discordBodies(c, UID));

const CASES = [
  ['evening-noon', 'evening', 'fixtures/data.json', '2026-01-30 12:00'], // 今日の締切（17:00）と、繰り返しの今日の回（二重に出ない）
  ['evening-night', 'evening', 'fixtures/data.json', '2026-01-30 20:23'], // 17:00 の締切を過ぎた夜
  ['evening-many', 'evening', 'fixtures/data.json', '2026-02-10 08:00'], // 期限切れが並ぶ日
  ['evening-old-data', 'evening', 'fixtures/data-old.json', '2026-02-03 09:00'],
  ['weekly-first-sunday', 'weekly', 'fixtures/data.json', '2026-02-01 20:23'], // 月の最初の日曜: 支出まとめあり
  ['weekly-mid-month', 'weekly', 'fixtures/data.json', '2026-02-15 20:23'], // 8日以降: 支出まとめなし
  ['weekly-long', 'weekly', 'fixtures/data-long.json', '2026-03-15 20:23'],
  ['weekly-no-completions', 'weekly', 'fixtures/data-old.json', '2026-02-01 20:23'], // 完了の記録が無い古いデータ
  ['weekly-ties', 'weekly', 'fixtures/data-ties.json', '2026-02-01 20:23'], // 同じ値が並んだとき（一番早い・多い時間帯）は後のものを選ぶ（jq の max_by と同じ）
];

for (const [name, kind, file, at] of CASES) {
  test(`${kind === 'evening' ? '夜の再通知' : '週次レビュー'}（${name}）が bash 版と1文字まで同じ`, () => {
    const data = JSON.parse(read(file));
    const out = kind === 'evening' ? evening(data, at) : weekly(data, at);
    assert.equal(dryRun(bodiesOf(out)), read(`expected/review/${name}.txt`));
  });
}

test('夜の再通知: 期限切れも今日の締切も無ければ null（送らない）。bash 版は「対象なし」と表示して送らない', () => {
  assert.equal(evening(JSON.parse(read('fixtures/data-old.json')), '2026-01-10 08:00'), null);
  assert.equal(evening({ items: [] }, '2026-01-30 20:23'), null);
  assert.equal(evening({ items: [{ id: 'x', title: '来週', due: '2026-02-05T03:00:00.000Z' }] }, '2026-01-30 20:23'), null);
  assert.equal(evening({ items: [{ id: 'd', title: '終わった', due: '2026-01-29T03:00:00.000Z', done: true }] }, '2026-01-30 20:23'), null);
});

test('夜の再通知: 自動完了の予定は件数に数えず「N件＋自動完了M件」と分けて書く。一覧には出す', () => {
  const items = [
    { id: 'a', title: '通常', due: '2026-01-29T03:00:00.000Z' },
    { id: 'b', title: '自動で完了', due: '2026-01-29T04:00:00.000Z', autoComplete: true },
  ];
  const text = evening({ items }, '2026-01-30 20:23');
  assert.match(text, /# 🌙 まだ終わっていません（1件＋自動完了1件）/);
  assert.match(text, /\*\*自動で完了\*\*/);
  assert.match(evening({ items: [items[1]] }, '2026-01-30 20:23'), /（0件＋自動完了1件）/);
  assert.match(evening({ items: [items[0]] }, '2026-01-30 20:23'), /（1件）/);
});

test('週次レビューの負荷予報: 自動完了の予定は数えない', () => {
  const mk = (n, auto) => Array.from({ length: n }, (_, i) => ({ id: `w${auto ? 'a' : 'n'}${i}`, title: `予定${i}`, cat: '課題', due: '2026-02-03T03:00:00.000Z', ...(auto ? { autoComplete: true } : {}) }));
  const [, second] = weekly({ items: [...mk(2, false), ...mk(5, true)] }, '2026-02-01 20:23');
  assert.match(second, /- 来週 2\/2〜2\/8：2件　課題 2\n/);
  assert.doesNotMatch(second, /⚠️/);
});

test('メンションと完了リンク: 夜の再通知はユーザーIDがあるときだけ呼び、リンクはアプリの URL が無ければ出さない。週次はメンションしない', () => {
  const data = { items: [{ id: 'a b', title: '期限切れ', due: '2026-01-29T03:00:00.000Z' }] };
  assert.match(evening(data, '2026-01-30 20:23'), /^<@100000000000000001> \n# 🌙/);
  assert.match(evening(data, '2026-01-30 20:23'), /\?done=a%20b>\)/);
  const bare = evening(data, '2026-01-30 20:23', { appUrl: '', mentionUserId: '' });
  assert.doesNotMatch(bare, /<@|完了\]|アプリで完了/);
  assert.doesNotMatch(weekly(data, '2026-02-01 20:23').join('\n'), /<@/);
  assert.doesNotMatch(weekly(data, '2026-02-01 20:23', { appUrl: '' }).join('\n'), /リンク/);
  assert.equal(evening(data, '2026-01-30 20:23', { doneLinks: false }).includes('完了]('), false);
});

test('壊れたデータでも止まらない: 締切が読めない・型が違う項目は除く', () => {
  const data = {
    items: [null, 5, { id: 'x', title: 'due なし' }, { id: 'y', title: 'due 壊れ', due: 'あした' }, { id: 'z', title: '正常', due: '2026-01-29T03:00:00.000Z', memo: 5, rep: 'weekly', start: 5 }],
    completions: [null, 'x', { doneAt: 5 }, { doneAt: 'いつか', lead: 'x', exp: [] }, { doneAt: '2026-01-31T03:00:00.000Z', lead: '3', exp: '10', kind: 'early', title: 7 }],
    expCarry: 'abc',
  };
  assert.doesNotThrow(() => { evening(data, '2026-01-30 20:23'); weekly(data, '2026-02-01 20:23'); });
  assert.match(weekly(data, '2026-02-01 20:23')[0], /獲得EXP：\+10（Lv\.1・累計 10 EXP）/);
});

test('どちらの本文も、Discord の上限（2000文字）に収まる大きさに分けて送る。@everyone でも誰にもメンションしない', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, title: `@everyone ${'長いタイトル'.repeat(8)}${i}`, cat: '課題', due: '2026-01-25T03:00:00.000Z' }));
  const bodies = bodiesOf([evening({ items }, '2026-01-30 20:23'), ...weekly({ items }, '2026-02-01 20:23')]);
  assert.ok(bodies.length >= 2);
  for (const b of bodies) {
    assert.ok(Array.from(b.content).length <= 2000);
    assert.deepEqual(b.allowed_mentions, { parse: [], users: [UID] });
  }
});
