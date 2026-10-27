// カレンダーの負荷（マスの濃さ・週の件数・⚠）は、自動完了の予定を締切として数えない。
// 再発検出: buildLoadByDay が自動完了を数えると、日の件数・週の合計・カテゴリ別の ⚠ が実際より多くなる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppFunctions } from '../support/appFns.js';

const ctx = loadAppFunctions(['pad', 'toLocalISO', 'buildLoadByDay']);
const load = (items) => ctx.buildLoadByDay(items);
const at = (day) => `2026-11-${day}T03:00:00.000Z`; // JST の同じ日の昼

test('自動完了の予定は、その日の締切の件数に数えない', () => {
  const r = load([
    { id: 'a', title: '課題', due: at('05'), cat: '課題' },
    { id: 'b', title: '英語演習', due: at('05'), cat: '課題', autoComplete: true },
    { id: 'c', title: '考査SQL', due: at('05'), cat: '課題', autoComplete: true },
    { id: 'd', title: '別の日', due: at('06'), cat: '課題', autoComplete: true },
  ]);
  assert.deepEqual(Array.from(Object.keys(r)), ['2026-11-05'], '自動完了だけの日は、件数ごと出ない');
  assert.equal(r['2026-11-05'].length, 1);
  assert.equal(r['2026-11-05'][0].id, 'a');
});

test('完了済みも数えない。自動完了でない予定は従来どおり数える', () => {
  const r = load([
    { id: 'a', title: 'a', due: at('05') },
    { id: 'b', title: 'b', due: at('05'), done: true },
    { id: 'c', title: 'c', due: at('05'), autoComplete: false },
    { id: 'd', title: 'd', due: at('05'), autoComplete: true, done: false },
  ]);
  assert.deepEqual(Array.from(r['2026-11-05'], (i) => i.id), ['a', 'c']);
});
