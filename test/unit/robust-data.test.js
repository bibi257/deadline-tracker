// 壊れたデータ（型が違う値・制御文字・巨大な日本語）で、定時ジョブ・.ics・保存 API が落ちないことを確かめる。
// 再発検出: digest の start / mail の memo / ics の UID・改行 / 保存の型検査 / D1 の上限（バイト）/ app.js の取り込み検査
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../../worker/src/index.js';
import { createD1 } from '../support/d1Shim.js';
import { buildDigest } from '../../worker/src/digest.js';
import { buildFeed } from '../../worker/src/feed.js';
import { buildIcs } from '../../worker/src/ics.js';
import { buildMailBody } from '../../worker/src/mail.js';
import { parseNow } from '../../worker/src/time.js';

const NOW = parseNow('2026-01-30 06:47');
const KEY = 'k'.repeat(32);
const base = { id: 'a1', title: 'テスト課題', due: '2026-02-02T03:00:00.000Z', cat: '課題' };

before(() => { mock.method(console, 'log', () => {}); mock.method(console, 'error', () => {}); });
after(() => mock.restoreAll());

test('digest: start が文字列でない（数値・配列・オブジェクト）項目があっても落ちず、開始なしとして出る', () => {
  for (const bad of [123, [1], { a: 1 }, true]) {
    const { content } = buildDigest({ items: [{ ...base, start: bad }] }, { now: NOW });
    assert.match(content, /テスト課題/, `start=${JSON.stringify(bad)}`);
  }
});

test('feed・メール: 文字列でない memo があっても落ちず、メモは出さない', () => {
  for (const bad of [123, ['x'], { a: 1 }, true]) {
    const { feed } = buildFeed({ items: [{ ...base, memo: bad }] }, { now: NOW });
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].memo, undefined);
    const body = buildMailBody(feed, '2026-02-02');
    assert.match(body, /テスト課題/);
    assert.doesNotMatch(body, /メモ:/);
  }
  const ok = buildFeed({ items: [{ ...base, memo: '持ち物\n筆記用具' }] }, { now: NOW });
  assert.match(buildMailBody(ok.feed, '2026-02-02'), /メモ: 持ち物 筆記用具/, '文字列のメモは従来どおり出る');
});

test('ics: id に改行があっても、UID の行から別の行を作れない', () => {
  const evil = 'x\r\nATTENDEE:mailto:evil@example.com\r\nX-INJECT:1';
  const { ics } = buildIcs({ items: [{ ...base, id: evil }] }, { now: NOW });
  assert.doesNotMatch(ics, /^ATTENDEE/m);
  assert.doesNotMatch(ics, /^X-INJECT/m);
  const uid = ics.split('\r\n').find((l) => l.startsWith('UID:'));
  assert.equal(uid, 'UID:xATTENDEE:mailto:evil@example.comX-INJECT:1@deadline-tracker', '制御文字だけを除く');
  // 全行が改行（CRLF）で区切られ、単独の CR・LF が行の途中に残らない
  for (const line of ics.split('\r\n')) assert.doesNotMatch(line, /[\r\n]/);
});

test('ics: id が空・制御文字だけなら x になる', () => {
  const { ics } = buildIcs({ items: [{ ...base, id: '\r\n\u0000' }] }, { now: NOW });
  assert.ok(ics.split('\r\n').includes('UID:x@deadline-tracker'));
});

test('ics: タイトル・メモの単独の \\r も \\n にする（行を分断して別のプロパティを作れない）', () => {
  const { ics } = buildIcs({ items: [{ ...base, title: 'a\rX-EVIL:1', memo: 'm1\rX-EVIL2:1\r\nm3\nm4' }] }, { now: NOW });
  assert.doesNotMatch(ics, /^X-EVIL/m);
  assert.ok(ics.split('\r\n').some((l) => l.startsWith('SUMMARY:a\\nX-EVIL')), '\\r は \\n になる');
  assert.match(ics, /DESCRIPTION:m1\\nX-EVIL2:1\\nm3\\nm4/);
  for (const line of ics.split('\r\n')) assert.doesNotMatch(line, /[\r\n]/);
});

// ---- 保存 API ----

function setup() {
  const env = { DB: createD1(), APP_KEY: KEY, NOW: () => 1_000_000 };
  const put = async (body) => {
    const res = await worker.fetch(new Request('https://x.test/api/data?force=1', {
      method: 'PUT', headers: { Authorization: `Bearer ${KEY}`, 'CF-Connecting-IP': '1.1.1.1' }, body: JSON.stringify(body),
    }), env);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { env, put };
}

test('保存 API: title/due/start/memo/cat/rep が文字列でない項目は 400（保存されない）', async () => {
  const { put } = setup();
  for (const k of ['title', 'due', 'start', 'memo', 'cat', 'rep']) {
    for (const bad of [123, ['x'], { a: 1 }, true]) {
      const r = await put({ items: [{ ...base, [k]: bad }] });
      assert.equal(r.status, 400, `${k}=${JSON.stringify(bad)}`);
      assert.match(r.body.error, new RegExp(k));
    }
  }
  assert.equal((await put({ items: [{ ...base, start: '2026-02-01T00:00:00.000Z', memo: 'm', rep: 'none' }] })).status, 201, '正しい型は保存できる');
  assert.equal((await put({ items: [{ id: 'n1', title: 't', due: 'd', memo: null }] })).status, 200, 'null は「無い」と同じ扱い（2回目の保存は更新なので 200）');
});

test('保存 API: 日本語の巨大データはバイト数で測り、D1 の上限を超える前に 413（500 にならない）', async () => {
  const { put } = setup();
  // 70万文字 = 210万バイト。文字数（70万）だけ見ると通ってしまい、D1 の 2,000,000 バイトの上限で 500 になっていた
  const r = await put({ items: [{ ...base, memo: 'あ'.repeat(700_000) }] });
  assert.equal(r.status, 413);
  // 60万文字 = 180万バイトは上限内。計測を省く経路（文字数×3 が上限以下）でも、計測する経路でも通る
  assert.equal((await put({ items: [{ ...base, memo: 'あ'.repeat(600_000) }] })).status, 201);
  assert.equal((await put({ items: [{ ...base, memo: 'x'.repeat(1_800_000) }] })).status, 200, 'ASCII は1文字1バイト');
  assert.equal((await put({ items: [{ ...base, memo: 'x'.repeat(2_000_000) }] })).status, 413);
});

// ---- app.js の取り込み検査（ブラウザ用の関数なので、ソースから取り出して実行する） ----

function loadSanitize() {
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function sanitizeIncomingItems');
  const end = src.indexOf('/* 取り込んだテンプレート', start);
  assert.ok(start > 0 && end > start, 'sanitizeIncomingItems が見つからない');
  const ctx = vm.createContext({ Date, Math, Object, Array });
  vm.runInContext(src.slice(start, end), ctx);
  return ctx.sanitizeIncomingItems;
}

test('app.js 取り込み: due が数値などの項目は隔離する（new Date(123) を有効にしない）', () => {
  const sanitize = loadSanitize();
  for (const bad of [123, 0, ['2026-02-02'], true]) {
    const r = sanitize([{ ...base, due: bad }]);
    assert.equal(r.kept.length, 0, `due=${JSON.stringify(bad)}`);
    assert.equal(r.quarantined.length, 1);
  }
  assert.equal(sanitize([base]).kept.length, 1, '正しい項目は取り込む');
});

test('app.js 取り込み: start・memo・cat・rep が文字列でなければ補正する', () => {
  const sanitize = loadSanitize();
  const r = sanitize([{ ...base, start: 123, memo: ['x'], cat: 5, rep: 7 }]).kept[0];
  assert.equal(r.start, undefined);
  assert.equal(r.memo, undefined);
  assert.equal(r.cat, 'その他');
  assert.equal(r.rep, 'none');
  const ok = sanitize([{ ...base, start: '2026-02-01T00:00:00.000Z', memo: 'm', rep: 'weekly' }]).kept[0];
  assert.equal(ok.start, '2026-02-01T00:00:00.000Z');
  assert.equal(ok.memo, 'm');
  assert.equal(ok.rep, 'weekly');
});
