// Discord の締切一覧。deadline-data の send_digest.sh（bash + jq）が作った出力と、1文字まで同じになるかを確かめる。
// test/expected/digest-*.txt は、send_digest.sh に DRY_RUN=1 でテスト用データを読ませて作った正解
// （メンションのユーザーIDとアプリの URL は、テスト用の固定値に差し替えてある）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDigest, discordBodies, postDiscord, splitForDiscord } from '../../worker/src/digest.js';
import { parseNow } from '../../worker/src/time.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const UID = '100000000000000001';
const APP = 'https://example.com/app/';
const cfg = { appUrl: APP, mentionUserId: UID };

/** send_digest.sh の DRY_RUN の表示と同じ形にする */
const dryRun = (bodies) => bodies.map((b) => `----- [DRY_RUN] 送信内容 -----\n${b.content}\n`).join('');
const len = (s) => Array.from(s).length;

test('テスト用データの締切一覧が bash 版と1文字まで同じ', () => {
  const { content } = buildDigest(JSON.parse(read('fixtures/data.json')), { now: parseNow('2026-01-30 06:47'), ...cfg });
  assert.equal(dryRun(discordBodies(content, UID)), read('expected/digest-daily.txt'));
});

test('長いデータは見出し単位で複数の投稿に分かれ、どれも2000文字以内。長すぎる見出しは切り詰める（bash 版と同じ）', () => {
  const { content } = buildDigest(JSON.parse(read('fixtures/data-long.json')), { now: parseNow('2026-03-15 06:47'), ...cfg });
  const bodies = discordBodies(content, UID);
  assert.equal(dryRun(bodies), read('expected/digest-long.txt'));
  assert.ok(bodies.length >= 3);
  for (const b of bodies) assert.ok(len(b.content) <= 2000, `${len(b.content)} 文字`);
  assert.match(bodies.map((b) => b.content).join('\n'), /件数が多いため省略しました/);
});

test('メンションは指定したユーザーだけ許可する。ユーザーIDが空でも allowed_mentions は必ず付く（誰にもメンションしない）', () => {
  const { content } = buildDigest({ items: [] }, { now: parseNow('2026-01-30 06:47'), ...cfg });
  for (const b of discordBodies(content, UID)) assert.deepEqual(b.allowed_mentions, { parse: [], users: [UID] });
  for (const b of discordBodies(content, '')) assert.deepEqual(b.allowed_mentions, { parse: [], users: [] });
});

test('タイトルに @everyone・@here があっても、本文以外（allowed_mentions）では誰にもメンションされない', () => {
  const items = [{ id: 'e1', title: '@everyone 全員集合 @here', due: '2026-02-01T03:00:00.000Z', cat: '課題' }];
  const { content } = buildDigest({ items }, { now: parseNow('2026-01-30 06:47'), ...cfg });
  assert.match(content, /@everyone/, '本文にはそのまま入る（表示は変えない）');
  // ユーザーID の有無にかかわらず、全体メンション（parse）は空。メンションできるのは指定のユーザーだけ
  for (const uid of ['', UID]) {
    const bodies = discordBodies(content, uid);
    assert.ok(bodies.length > 0);
    for (const b of bodies) {
      assert.deepEqual(b.allowed_mentions.parse, [], `uid=${uid}`);
      assert.deepEqual(b.allowed_mentions.users, uid ? [uid] : []);
      assert.equal('roles' in b.allowed_mentions, false);
    }
  }
});

test('締切が1件も無い日は「予定はありません」。メンションは付かない（bash 版と同じ）', () => {
  const { content } = buildDigest({ items: [] }, { now: parseNow('2026-01-30 06:47'), ...cfg });
  assert.match(content, /^# 📋 締切トラッカー\n### 1月30日（金）の連絡\n\n## ⏳ 7日以内の締切\n-# 予定はありません\n/);
  assert.doesNotMatch(content, /<@/);
  assert.match(content, /\[アプリを開く\]\(<https:\/\/example\.com\/app\/>\)/);
});

test('アプリの URL が無ければ、リンクも完了リンクも出さない。DONE_LINKS をオフにすると完了リンクだけ消える', () => {
  const data = { items: [{ id: 'a', title: '期限切れ', due: '2026-01-29T00:00:00.000Z' }] };
  const now = parseNow('2026-01-30 06:47');
  const none = buildDigest(data, { now, appUrl: '', mentionUserId: '' }).content;
  assert.doesNotMatch(none, /リンク|完了\]/);
  const off = buildDigest(data, { now, ...cfg, doneLinks: false }).content;
  assert.doesNotMatch(off, /完了\]/);
  assert.match(off, /## 🔗 リンク/);
  assert.match(buildDigest(data, { now, ...cfg }).content, /\[✅完了\]\(<https:\/\/example\.com\/app\/\?done=a>\)/);
});

test('完了リンクの ID は jq の @uri と同じ表記にする（空白・引用符・括弧・日本語）', () => {
  const data = { items: [{ id: "a b'c(1)*é", title: 'x', due: '2026-01-29T00:00:00.000Z' }] };
  const { content } = buildDigest(data, { now: parseNow('2026-01-30 06:47'), ...cfg });
  assert.match(content, /\?done=a%20b%27c%281%29%2A%C3%A9>/);
});

test('締切日時が読めない項目は除いて警告を返す。開始だけ壊れていれば締切のみで出す', () => {
  const data = { items: [
    { id: 'a', title: '壊れた締切', due: 'xxx' },
    { id: 'b', title: '開始が壊れた', due: '2026-02-02T03:00:00.000Z', start: 'yyy' },
    { id: 'c', title: '締切なし' },
  ] };
  const { content, warnings } = buildDigest(data, { now: parseNow('2026-01-30 06:47'), ...cfg });
  assert.deepEqual(warnings, ['締切日時が読めない項目を除外しました: 壊れた締切、締切なし']);
  assert.match(content, /\*\*開始が壊れた\*\*/);
  assert.doesNotMatch(content, /壊れた締切/);
  assert.doesNotMatch(content, /〜/);
});

test('タイトルの改行は空白にする（1項目が複数行にならない）', () => {
  const data = { items: [{ id: 'a', title: '1行目\n2行目\r3行目', due: '2026-02-02T03:00:00.000Z' }] };
  assert.match(buildDigest(data, { now: parseNow('2026-01-30 06:47'), ...cfg }).content, /\*\*1行目 2行目 3行目\*\*/);
});

test('splitForDiscord: 見出し単位でまとめ、上限を超える見出しは切り詰める', () => {
  const sec = (n) => `## ${n}\n${'あ'.repeat(10)}`;
  assert.deepEqual(splitForDiscord(`# 題\n${sec('A')}\n${sec('B')}`, 1850), [`# 題\n${sec('A')}\n${sec('B')}`]);
  const parts = splitForDiscord(`# 題\n${sec('A')}\n${sec('B')}\n${sec('C')}`, 30);
  // 「題」と A は合わせて19文字で上限内なので1通。B を足すと35文字、C を足すと31文字になるので、それぞれ別の1通
  assert.deepEqual(parts, [`# 題\n${sec('A')}`, sec('B'), sec('C')]);
  const cut = splitForDiscord(`# 題\n## 長い\n${'あ'.repeat(100)}`, 40);
  assert.match(cut[1], /^## 長い\n/);
  assert.match(cut[1], /…（件数が多いため省略しました。詳しくはアプリでご確認ください）$/);
  assert.equal(len(cut[1].split('\n\n…')[0]), 40);
});

// ---- Discord への送信 ----

const WEBHOOK = 'https://discord.com/api/webhooks/123/SECRET-TOKEN';
const ok = () => new Response(null, { status: 204 });

test('postDiscord: 本文を順番に送る。メンションの許可も一緒に送る', async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), type: init.headers['Content-Type'] }); return ok(); };
  const bodies = discordBodies(buildDigest(JSON.parse(read('fixtures/data-long.json')), { now: parseNow('2026-03-15 06:47'), ...cfg }).content, UID);
  assert.equal(await postDiscord(WEBHOOK, bodies, { fetchFn }), bodies.length);
  assert.deepEqual(calls.map((c) => c.body), bodies);
  assert.ok(calls.every((c) => c.url === WEBHOOK && c.type === 'application/json'));
});

test('postDiscord: 429・5xx・通信エラーはやり直す。4xx（その他）はやり直さない', async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const seq = (...r) => { const q = [...r]; return async () => { const x = q.shift(); if (x instanceof Error) throw x; return new Response(null, { status: x }); }; };
  await postDiscord(WEBHOOK, [{ content: 'a' }], { fetchFn: seq(429, 500, new Error('net'), 204), sleep });
  assert.deepEqual(slept, [2000, 2000, 2000]);
  await assert.rejects(postDiscord(WEBHOOK, [{ content: 'a' }], { fetchFn: seq(500, 500, 500, 500), sleep }), /HTTP 500/);
  let n = 0;
  await assert.rejects(postDiscord(WEBHOOK, [{ content: 'a' }], { fetchFn: async () => { n++; return new Response(null, { status: 404 }); }, sleep }), /HTTP 404/);
  assert.equal(n, 1);
});

test('postDiscord: エラー文に Webhook の URL（トークン）を含めない', async () => {
  const e = await postDiscord(WEBHOOK, [{ content: 'a' }], { fetchFn: async () => { throw new Error(`failed ${WEBHOOK}`); }, sleep: async () => {}, retries: 1 }).catch((x) => x);
  assert.ok(e instanceof Error);
  assert.doesNotMatch(e.message, /SECRET-TOKEN|webhooks/);
});
