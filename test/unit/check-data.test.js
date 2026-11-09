// scripts/check-data.mjs と worker/src/itemrules.js：書き出したデータで、値の意味が合わない項目を数える（37 の手順1）。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemValueProblems, startAfterDue } from '../../worker/src/itemrules.js';
import { checkFile } from '../../scripts/check-data.mjs';

const ok = { id: 'a1', title: 'レポート', due: '2026-11-10T08:00:00.000Z', cat: '仕事', done: false };

test('itemValueProblems: 正しい項目は問題なし。範囲の端（repCount 0・repDay 1/31・seq 0）も通る', () => {
  assert.deepEqual(itemValueProblems(ok), []);
  assert.deepEqual(itemValueProblems({ ...ok, start: '2026-11-09T08:00:00.000Z', repCount: 0, repDay: 31, seq: 0 }), []);
  assert.deepEqual(itemValueProblems({ ...ok, repDay: 1, repCount: 12, seq: 7 }), []);
});

test('itemValueProblems: 表の各行の「だめな値」を1つずつ見つける', () => {
  const cases = [
    [{ title: '  ' }, 'title'], [{ title: '' }, 'title'], [{ due: 'あした' }, 'due'], [{ due: undefined }, 'due'],
    [{ start: 'x' }, 'start'], [{ start: '2026-02-30' }, 'start'], [{ repCount: -1 }, 'repCount'], [{ repDay: 99 }, 'repDay'], [{ repDay: 0 }, 'repDay'], [{ seq: -3 }, 'seq'],
  ];
  for (const [patch, key] of cases) {
    const p = itemValueProblems({ ...ok, ...patch });
    assert.equal(p.length, 1, key);
    assert.ok(p[0].startsWith(key), p[0]);
  }
});

test('itemValueProblems: ISO 日付の実在日と、うるう年を確認する', () => {
  for (const due of ['2026-02-30', '2026-02-29', '1900-02-29', '2100-02-29', '2026-13-01', '2026-04-31', '2026-02-30T09:00']) {
    assert.ok(itemValueProblems({ ...ok, due }).some((reason) => reason.startsWith('due')), due);
  }
  for (const due of ['2000-02-29', '2024-02-29', '2026-02-28', '2026-04-30', '2026-11-10T09:00', '2026-11-10T00:00:00.000Z']) {
    assert.deepEqual(itemValueProblems({ ...ok, due }), [], due);
  }
});

test('startAfterDue: 開始日が締切日より後のときだけ true（参考の数え）', () => {
  assert.equal(startAfterDue({ ...ok, start: '2026-11-11T00:00:00.000Z' }), true);
  assert.equal(startAfterDue({ ...ok, start: '2026-11-09T00:00:00.000Z' }), false);
  assert.equal(startAfterDue(ok), false);
});

test('checkFile: 合わない項目の id と理由だけを返し、題名・メモは含めない', () => {
  const r = checkFile({ items: [ok, { ...ok, id: 'b2-ひみつの題名', title: 'ひみつの題名', memo: 'ひみつのメモ', due: 'x', repDay: 99 }, { ...ok, id: 'c3', start: '2026-12-01T00:00:00.000Z' }] });
  assert.equal(r.total, 3);
  assert.equal(r.bad.length, 1);
  assert.equal(r.bad[0].id, 'b2-ひみつの題名');
  assert.deepEqual(r.bad[0].reasons.map((s) => s.split(' ')[0]), ['due', 'repDay']);
  assert.equal(r.startAfterDue, 1);
  assert.ok(!JSON.stringify(r).includes('ひみつのメモ'));
});

test('checkFile: いまの Worker の検査（型と形）に通らない項目も拾う（重複 id・数値の題名など）', () => {
  const r = checkFile({ items: [{ id: 'n1', title: 5, due: '2026-11-10T00:00:00.000Z' }, { ...ok, rep: 'daily' }] });
  assert.equal(r.bad.length, 2);
});

test('scripts/check-data.mjs: 問題なければ終了コード 0、あれば 1。内容は出さない', () => {
  const dir = mkdtempSync(`${tmpdir()}/chk-`);
  const good = `${dir}/good.json`, bad = `${dir}/bad.json`;
  writeFileSync(good, JSON.stringify({ items: [ok] }));
  writeFileSync(bad, JSON.stringify({ data: { items: [{ ...ok, title: 'ひみつ', due: 'x' }] } })); // 世代バックアップの返り値の形
  const out = execFileSync(process.execPath, ['scripts/check-data.mjs', good], { cwd: new URL('../../', import.meta.url).pathname }).toString();
  assert.match(out, /合わない項目: 0 件/);
  const r = spawnSync(process.execPath, ['scripts/check-data.mjs', bad], { cwd: new URL('../../', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /合わない項目: 1 件/);
  assert.ok(!r.stdout.includes('ひみつ'));
});

