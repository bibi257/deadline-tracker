// WebClass の成績表 CSV の読み取りと、締切への対応づけ（webclass-import.js）。見本の CSV は架空の科目名・教材名。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemValueProblems } from '../../worker/src/itemrules.js';

const ctx = vm.createContext({ TextDecoder, Date, Math });
vm.runInContext(readFileSync(new URL('../../webclass-import.js', import.meta.url), 'utf8'), ctx);
const W = ctx.DTWebClass;
const bytes = (f) => new Uint8Array(readFileSync(new URL(`../fixtures/${f}`, import.meta.url)));
const NOW = new Date('2026-11-13T05:00:00Z'); // 日本時間 11/13 14:00
const load = (f = 'webclass-sample.csv') => W.wcParse(W.wcDecode(bytes(f)));
const byTitle = (r, t) => r.entries.find((e) => e.title === t);

test('文字コード: BOM つき UTF-8・BOM なし UTF-8・Shift_JIS のどれでも、同じ内容に読める', () => {
  const a = load(), b = load('webclass-sample-nobom.csv'), c = load('webclass-sample-sjis.csv');
  const view = (r) => JSON.stringify(r.entries.map((e) => [e.course, e.title, e.dueText, e.status]));
  assert.equal(view(a), view(b));
  assert.equal(view(a), view(c));
  assert.ok(a.entries.some((e) => e.course.includes('架空統計学（月１クラス）')));
});

test('CSV: フィールド内のカンマ・改行・""（引用符）を扱う', () => {
  const r = load();
  assert.ok(byTitle(r, '課題2, 追加分'));
  assert.ok(byTitle(r, '振り返り\nミニレポート'));
  assert.ok(byTitle(r, '"引用"つきの課題'));
  assert.deepEqual(Array.from(W.wcParseCsv('a,"b,c"\r\n"d""e",\n"x\ny",z'), (x) => Array.from(x)), [['a', 'b,c'], ['d"e', ''], ['x\ny', 'z']]);
});

test('見出しの行は、行番号を決め打ちせず列名で探す。先頭の行（作成者など）は候補に入らない。見つからなければ断る', () => {
  const r = load();
  assert.equal(r.entries.length, 11);
  assert.ok(!JSON.stringify(r).includes('00XX000'), '作成者の行は残さない');
  const shuffled = '"x"\n"状態","締切","教材","コース名","学科","学部","最高点","実施日"\n"未回答","2026-11-20 23:59","課題A","科目(202600000000000009)","","","-","-"\n';
  const s = W.wcParse(shuffled);
  assert.equal(s.entries[0].title, '課題A');
  assert.equal(s.entries[0].status, '未回答');
  assert.throws(() => W.wcParse('"a","b"\n"1","2"\n'), /WebClass の成績表ではない/);
});

test('同じコースの同じ教材名は先の1件だけ。コース名か教材名が空の行は読み飛ばし、数だけ返す', () => {
  const r = load();
  assert.equal(r.entries.filter((e) => e.title === '課題1').length, 1);
  assert.equal(byTitle(r, '課題1').dueText, '2026-11-20 23:59');
  assert.equal(r.skipped, 2);
});

test('締切は日本時間として読む。空欄・実在しない日付は「締切なし」になり、締切の項目にできない', () => {
  const r = load();
  assert.equal(byTitle(r, '課題1').due.toISOString(), '2026-11-20T14:59:00.000Z');
  assert.equal(W.wcParseDue('2026-01-01 08:30').toISOString(), '2025-12-31T23:30:00.000Z');
  for (const bad of ['', '2026-02-30 09:20', '2026-11-20', '2026/11/20 10:00', '2026-11-20 24:00', '-']) assert.equal(W.wcParseDue(bad), null, bad);
  for (const t of ['レポート配布', '日付が変な課題']) {
    const e = byTitle(r, t);
    assert.equal(e.noDue, true);
    assert.equal(W.wcToItem(e, 'x', NOW), null);
    assert.ok(Array.from(W.wcFlags(e, NOW)).includes('締切なし'));
  }
});

test('目印: 期限切れ・提出済み・自習用・任意・授業以外を、文字で返す', () => {
  const r = load();
  const flags = (t) => Array.from(W.wcFlags(byTitle(r, t), NOW));
  assert.deepEqual(flags('課題1'), []);
  assert.deepEqual(flags('課題2, 追加分'), ['期限切れ']);
  assert.deepEqual(flags('小テスト「変数」'), ['提出済み'], '状態が「-」でも、実施日が入っていれば提出済み');
  assert.deepEqual(flags('"引用"つきの課題'), ['提出済み']);
  assert.deepEqual(flags('(自習用) 小テスト「変数」'), ['自習用']);
  assert.deepEqual(flags('学生アンケート'), ['授業以外']);
  assert.deepEqual(flags('修了テスト1'), ['任意', '授業以外']);
});

test('既定の選択: 未提出・締切がこれから・自習用でも任意でもないものだけ', () => {
  const r = load();
  const picked = Array.from(r.entries).filter((e) => W.wcDefaultSelected(e, NOW)).map((e) => e.title.slice(0, 12));
  assert.deepEqual(picked, ['課題1', '振り返り\nミニレポート', '第1回 とても長い名前の', '学生アンケート']);
});

test('締切の項目への対応づけ: カテゴリーは「課題」、メモにコース名（ID を除く）、取り込み元のキーを wc に持つ。成績・学部・学科は入れない', () => {
  const r = load();
  const it = W.wcToItem(byTitle(r, '課題1'), 'id1', NOW);
  assert.deepEqual({ ...it }, {
    id: 'id1', title: '課題1', due: '2026-11-20T14:59:00.000Z', cat: '課題', rep: 'none', repCount: 0,
    memo: 'コース：架空プログラミング', done: false, created: '2026-11-13T05:00:00.000Z', wc: '架空プログラミング(202600000000000001)\n課題1',
  });
  assert.deepEqual(itemValueProblems(it), [], '保存 API の値の検査を通る');
  assert.equal(W.wcCourseName('架空統計学（月１クラス）(2026000000000V0002)'), '架空統計学（月１クラス）');
  assert.equal(W.wcCourseName('2026年度_架空アンケート'), '2026年度_架空アンケート');
});

test('題名は 80字まで。超えた分は切り、全文をメモの先頭に入れる', () => {
  const r = load();
  const e = r.entries.find((x) => x.title.startsWith('第1回 とても長い'));
  assert.ok(e.title.length > 80);
  const it = W.wcToItem(e, 'id2', NOW);
  assert.equal(it.title.length, 80);
  assert.ok(it.title.endsWith('…'));
  assert.equal(it.memo, `${e.title}\nコース：架空統計学（月１クラス）`);
});

test('同一の判定キー: 全角・半角と空白のゆれを吸収する。ハッシュは 16 桁で、名前そのものを含まない', () => {
  assert.equal(W.wcKey('科目Ａ (123456789012)', ' 課題　１ '), W.wcKey('科目A (123456789012)', '課題 1'));
  assert.notEqual(W.wcKey('科目A', '課題1'), W.wcKey('科目A', '課題2'));
  const r = load();
  const hashes = r.entries.map((e) => e.hash);
  assert.ok(hashes.every((h) => /^[0-9a-f]{16}$/.test(h)));
  assert.equal(new Set(hashes).size, hashes.length);
  assert.equal(W.wcHash('abc'), W.wcHash('abc'));
});

test('上限: 2MB を超えるファイル・2,000行を超える CSV は断る', () => {
  assert.throws(() => W.wcDecode(new Uint8Array(W.WC_MAX_BYTES + 1)), /大きすぎ/);
  const head = '"学部","学科","コース名","教材","締切","実施日","最高点","状態"\n';
  const rows = Array.from({ length: 2001 }, (_, i) => `"","","科目(202600000000000001)","課題${i}","2026-11-20 23:59","-","-","-"`).join('\n');
  assert.throws(() => W.wcParse(head + rows), /行が多すぎ/);
});

test('見本の CSV に、実在の学籍番号の形（数字2桁＋英字2文字＋数字3桁）が無い', () => {
  for (const f of ['webclass-sample.csv', 'webclass-sample-nobom.csv']) assert.ok(!/\d{2}[A-Z]{2}\d{3}/.test(new TextDecoder().decode(bytes(f)).replace('00XX000', '')), f);
});

test('除外リスト: 形の合わない値を捨て、同じキーは後のものを使い、上限を超えたら古いものから捨てる', () => {
  const h = 'a'.repeat(16);
  const out = W.wcCleanExcluded([{ k: h, due: '2026-11-20 23:59', at: '2026-11-13' }, { k: 'XYZ', due: '', at: '' }, null, 5,
    { k: h, due: '2026-11-21 23:59', at: '2026-11-14' }, { k: 'b'.repeat(16), due: 7, at: 'x' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [{ k: h, due: '2026-11-21 23:59', at: '2026-11-14' }, { k: 'b'.repeat(16), due: '', at: '' }]);
  assert.deepEqual(Array.from(W.wcCleanExcluded('x')), []);
  const many = Array.from({ length: W.WC_EXCLUDED_MAX + 3 }, (_, i) => ({ k: i.toString(16).padStart(16, '0'), due: '', at: '' }));
  const kept = W.wcCleanExcluded(many);
  assert.equal(kept.length, W.WC_EXCLUDED_MAX);
  assert.equal(kept[0].k, (3).toString(16).padStart(16, '0'));
});

test('プレビューの行: 登録済みは出さない。締切が変わったものは「changed」。除外済みは締切が同じなら隠し、変わったらまた新しい候補にする', () => {
  const r = load();
  const e1 = byTitle(r, '課題1'), e2 = byTitle(r, '学生アンケート'), e3 = byTitle(r, '振り返り\nミニレポート'), e4 = byTitle(r, '"引用"つきの課題');
  const items = [
    { id: 'x1', title: '課題1', due: e1.due.toISOString(), wc: e1.key },
    { id: 'x2', title: 'アンケート', due: '2026-11-29T14:59:00.000Z', wc: e2.key },
  ];
  const excluded = [{ k: e3.hash, due: e3.dueText, at: '2026-11-01' }, { k: e4.hash, due: '2026-10-01 09:20', at: '2026-10-01' }];
  const plan = Array.from(W.wcPlan(r.entries, items, excluded, NOW));
  const of = (e) => plan.find((p) => p.e === e);
  assert.equal(of(e1).state, 'registered');
  assert.equal(of(e2).state, 'changed');
  assert.equal(of(e2).item.id, 'x2');
  assert.equal(of(e2).selected, true, '未提出で締切がこれからなら、最初から選ぶ');
  assert.equal(of(e3).state, 'excluded');
  assert.equal(of(e3).selected, false);
  assert.equal(of(e4).state, 'new', '除外したときと締切が違えば、また出す');
  assert.equal(of(byTitle(r, '課題2, 追加分')).state, 'new');
});

test('締切の変更を見送ったもの: 除外リストに同じ締切で入っていれば、次回は除外済みとして隠し、既存の締切を覚えておく', () => {
  const r = load();
  const e2 = byTitle(r, '学生アンケート');
  const items = [{ id: 'x2', title: 'アンケート', due: '2026-11-29T14:59:00.000Z', wc: e2.key }];
  const p1 = Array.from(W.wcPlan(r.entries, items, [], NOW)).find((p) => p.e === e2);
  assert.equal(p1.state, 'changed');
  const p2 = Array.from(W.wcPlan(r.entries, items, [{ k: e2.hash, due: e2.dueText, at: '2026-11-13' }], NOW)).find((p) => p.e === e2);
  assert.equal(p2.state, 'excluded');
  assert.equal(p2.item.id, 'x2', '選べば既存の締切を更新できる');
  const p3 = Array.from(W.wcPlan(r.entries, items, [{ k: e2.hash, due: '2026-11-01 00:00', at: '2026-11-01' }], NOW)).find((p) => p.e === e2);
  assert.equal(p3.state, 'changed', '見送ったときと締切がまた違えば、もう一度出す');
});

test('プレビューの並び替え: 各モード・締切なし・同値の順序・入力を変更しない', () => {
  const d1 = new Date('2026-11-20T00:00:00Z'), d2 = new Date('2026-11-21T00:00:00Z');
  const make = (course, title, due) => ({ e: { course, courseName: course, title, due, noDue: !due } });
  const a = make('B', 'Z', d2), b = make('A', 'Y', d1), c = make('A', 'X', d1), d = make('A', 'A', null), e = make('A', 'X', d1);
  const input = [a, b, c, d, e];
  const original = input.slice();
  const titles = (mode) => Array.from(W.wcSortRows(input, mode), (r) => r.e.title);
  assert.deepEqual(titles('csv'), ['Z', 'Y', 'X', 'A', 'X']);
  assert.deepEqual(titles('dueAsc'), ['X', 'X', 'Y', 'Z', 'A']);
  assert.deepEqual(titles('dueDesc'), ['Z', 'X', 'X', 'Y', 'A']);
  assert.deepEqual(titles('title'), ['A', 'X', 'X', 'Y', 'Z']);
  assert.deepEqual(Array.from(W.wcSortRows(input, 'course'), (r) => r.e.course + r.e.title), ['AX', 'AX', 'AY', 'AA', 'BZ']);
  assert.equal(W.wcSortRows(input, 'dueAsc')[4], d, '締切なしは最後');
  assert.equal(W.wcSortRows(input, 'dueAsc')[0], c, '同じ締切・コースでは教材名順');
  assert.equal(W.wcSortRows(input, 'dueAsc')[1], e, '完全同値では元の順序を保つ');
  assert.deepEqual(input, original, '入力配列は変更しない');
});

test('プレビューの並び替え: 日本語の数字順と未知モードの元順を保つ', () => {
  const make = (title) => ({ e: { course: 'コース', courseName: 'コース', title, due: null } });
  const input = [make('第10回'), make('第2回'), make('あ'), make('ア')];
  assert.deepEqual(Array.from(W.wcSortRows(input, 'title'), (r) => r.e.title), ['あ', 'ア', '第2回', '第10回']);
  assert.deepEqual(W.wcSortRows(input, 'unknown'), input);
  assert.deepEqual(W.wcSortRows(input), input);
});

test('コース順はコース名、締切昇順、教材名、元順で並ぶ', () => {
  const make = (course, title, due) => ({ e: { course, courseName: course, title, due: due && new Date(due) } });
  const input = [make('第10コース', '課題', '2026-11-20'), make('第2コース', '第10回', '2026-11-21'), make('第2コース', '第2回', '2026-11-21'), make('第2コース', '早い締切', '2026-11-19'), make('第2コース', '締切なし', null)];
  assert.deepEqual(Array.from(W.wcSortRows(input, 'course'), (r) => r.e.course + ':' + r.e.title), [
    '第2コース:早い締切', '第2コース:第2回', '第2コース:第10回', '第2コース:締切なし', '第10コース:課題'
  ]);
});
