// 締切のメール。本文は deadline-data の send_feed_mail.py が作った出力と同じになるかを確かめる（最後の1行の送信元の文言だけ変えてある）。
// 送信は Gmail API。ここでは偽の fetch で受け、実際には送らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildMailBody, buildRawMessage, cleanAddress, encodeHeader, getAccessToken, gmailConfig, sendGmail, subjectFor, targetDate, toBase64Url,
} from '../../worker/src/mail.js';
import { parseNow } from '../../worker/src/time.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const feed = JSON.parse(read('expected/feed.json'));
const CFG = { clientId: 'cid-123', clientSecret: 'CLIENT-SECRET-xyz', refreshToken: 'REFRESH-TOKEN-abc', to: 'me@example.com', from: 'me@example.com' };

test('メール本文が Python 版と1文字まで同じ', () => {
  const target = '2026-01-30';
  assert.equal(`件名: ${subjectFor(target)}\n${buildMailBody(feed, target)}\n`, read('expected/feed-mail.txt'));
});

test('対象日: auto は15時（JST）以降なら翌日分。today / tomorrow は指定どおり。月末・年末もまたぐ', () => {
  assert.equal(targetDate(parseNow('2026-01-29 14:59'), 'auto'), '2026-01-29');
  assert.equal(targetDate(parseNow('2026-01-29 15:00'), 'auto'), '2026-01-30');
  assert.equal(targetDate(parseNow('2026-01-30 05:23'), 'auto'), '2026-01-30');
  assert.equal(targetDate(parseNow('2026-01-29 20:23'), 'today'), '2026-01-29');
  assert.equal(targetDate(parseNow('2026-01-29 06:00'), 'tomorrow'), '2026-01-30');
  assert.equal(targetDate(parseNow('2026-12-31 20:23'), 'auto'), '2027-01-01');
  assert.equal(targetDate(parseNow('2028-02-28 20:23'), 'auto'), '2028-02-29');
  assert.equal(subjectFor('2026-01-30'), '【締切トラッカー】1/30（金）の締切');
});

test('締切が1件も無い日のメール', () => {
  const body = buildMailBody({ items: [], source_updated_at: null }, '2026-01-30');
  assert.match(body, /■ おすすめの順番（上位5件）\n- 急ぎのものはありません\n/);
  assert.match(body, /■ 今日が締切（0件）\n- なし\n/);
  assert.match(body, /データ更新: 不明/);
});

// ---- メッセージの組み立て ----

const decodeWords = (h) => [...h.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8')).join('');

test('日本語のヘッダー: ASCII はそのまま。日本語は RFC 2047 で、1語75文字以内。長くても元に戻る', () => {
  assert.equal(encodeHeader('Hello 123'), 'Hello 123');
  for (const t of ['【締切トラッカー】1/30（金）の締切', '長い件名'.repeat(30), '📚 絵文字つき 🎉'.repeat(5)]) {
    const h = encodeHeader(t);
    assert.equal(decodeWords(h), t);
    for (const w of h.split('\r\n ')) assert.ok(w.length <= 75, `${w.length}文字`);
    assert.doesNotMatch(h, /[^\x20-\x7e\r\n]/);
  }
});

test('アドレス: 改行・複数指定・引用符など、ヘッダーに混ぜられるものは使わない', () => {
  assert.equal(cleanAddress(' me@example.com \n'), 'me@example.com');
  for (const bad of ['a@b.com\r\nBcc: x@y.com', 'a@b.com, c@d.com', 'a b@c.example', '"x"@y.example', 'noatmark', '', undefined, null, 5, 'a@b']) {
    assert.equal(cleanAddress(bad), '', String(bad));
  }
});

test('メッセージ全体: ヘッダー・UTF-8 の base64 本文（76文字ごとに改行・CRLF）', () => {
  const body = '1行目\n日本語の本文 📚\n3行目';
  const raw = buildRawMessage({ from: 'me@example.com', to: 'me@example.com', subject: '【テスト】件名', body, date: Date.UTC(2026, 0, 30, 6, 47, 0), messageId: 'abc-123' });
  const [head, ...rest] = raw.split('\r\n\r\n');
  const lines = head.split('\r\n');
  assert.deepEqual(lines.filter((l) => !l.startsWith(' ')).map((l) => l.split(':')[0]),
    ['From', 'To', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding']);
  assert.ok(lines.includes('Date: Fri, 30 Jan 2026 06:47:00 +0000'));
  assert.ok(lines.includes('Message-ID: <abc-123@deadline-tracker>'));
  assert.ok(lines.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.equal(decodeWords(head.match(/Subject: ([\s\S]*?)\r\nDate/)[1]), '【テスト】件名');
  const b64 = rest.join('\r\n\r\n');
  assert.ok(b64.split('\r\n').every((l) => l.length <= 76));
  assert.equal(Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8'), body.replace(/\n/g, '\r\n'));
  assert.doesNotMatch(raw, /[^\x00-\x7f]/); // 全体が ASCII
});

test('toBase64Url: + / = を使わない', () => {
  const s = toBase64Url(Uint8Array.from([251, 255, 254, 253, 252]));
  assert.doesNotMatch(s, /[+/=]/);
  assert.equal(Buffer.from(s, 'base64url').toString('hex'), 'fbfffefdfc');
});

// ---- Gmail API ----

test('設定: 前後の空白を除く。そろっていなければ ok でない。MAIL_FROM が無ければ MAIL_TO と同じ', () => {
  const env = { GOOGLE_CLIENT_ID: ' cid\n', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'rt ', MAIL_TO: ' me@example.com ' };
  const c = gmailConfig(env);
  assert.deepEqual([c.ok, c.clientId, c.to, c.from], [true, 'cid', 'me@example.com', 'me@example.com']);
  assert.equal(gmailConfig({ ...env, MAIL_FROM: 'alias@example.com' }).from, 'alias@example.com');
  assert.deepEqual([gmailConfig({}).ok, gmailConfig({}).anySet], [false, false]);
  assert.deepEqual([gmailConfig({ ...env, GOOGLE_REFRESH_TOKEN: '' }).ok, gmailConfig({ ...env, GOOGLE_REFRESH_TOKEN: '' }).anySet], [false, true]);
  assert.equal(gmailConfig({ ...env, MAIL_TO: 'bad\r\nBcc: x@y.example' }).ok, false);
});

/** 偽の Google。token と send の呼び出しを記録し、status を並べておくとその順に返す */
function fakeGoogle({ token = [{ access_token: 'ya29.FAKE' }], send = [{ id: 'gm-1' }] } = {}) {
  const calls = [];
  const queues = { token: [...token], send: [...send] };
  const fetchFn = async (url, init) => {
    const kind = url.includes('oauth2') ? 'token' : 'send';
    calls.push({ kind, url, init });
    const next = queues[kind].shift();
    if (next instanceof Error) throw next;
    const status = next?.status ?? 200;
    const { status: _s, ...body } = next ?? {};
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}
const quick = { sleep: async () => {} };

test('送信: アクセストークンを取り、Gmail API に raw で送る。認証情報はメッセージに入らない', async () => {
  const g = fakeGoogle();
  const out = await sendGmail(CFG, { subject: '【締切トラッカー】1/30（金）の締切', body: '本文', nowMs: Date.UTC(2026, 0, 30), messageId: 'm1' }, { fetchFn: g.fetchFn, ...quick });
  assert.equal(out, 'gm-1');
  const [tok, send] = g.calls;
  const form = new URLSearchParams(tok.init.body);
  assert.deepEqual([form.get('grant_type'), form.get('client_id'), form.get('client_secret'), form.get('refresh_token')], ['refresh_token', 'cid-123', 'CLIENT-SECRET-xyz', 'REFRESH-TOKEN-abc']);
  assert.equal(tok.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(send.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(send.init.headers.Authorization, 'Bearer ya29.FAKE');
  const raw = Buffer.from(JSON.parse(send.init.body).raw, 'base64url').toString('utf8');
  assert.match(raw, /^From: me@example\.com\r\nTo: me@example\.com\r\n/);
  assert.doesNotMatch(raw, /CLIENT-SECRET|REFRESH-TOKEN|ya29/);
});

test('認証エラー: invalid_grant は原因の手がかりを添える。エラー文に認証情報を含めない', async () => {
  const g = fakeGoogle({ token: [{ status: 400, error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }] });
  const e = await sendGmail(CFG, { subject: 's', body: 'b', nowMs: 0, messageId: 'm' }, { fetchFn: g.fetchFn, ...quick }).catch((x) => x);
  assert.match(e.message, /invalid_grant/);
  assert.match(e.message, /リフレッシュトークンが無効/);
  assert.doesNotMatch(e.message, /REFRESH-TOKEN|CLIENT-SECRET|cid-123/);
  assert.equal(g.calls.length, 1, '認証エラーはやり直さない');
  const c = fakeGoogle({ token: [{ status: 401, error: 'invalid_client' }] });
  assert.match((await getAccessToken(CFG, { fetchFn: c.fetchFn, ...quick, retries: 2 }).catch((x) => x)).message, /クライアント ID かシークレット/);
});

test('一時的な失敗（429・5xx・通信エラー）はやり直す。その他の 4xx はやり直さない', async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const g = fakeGoogle({ token: [{ status: 503 }, new Error('net'), { access_token: 'ya29.FAKE' }], send: [{ status: 429 }, { id: 'gm-2' }] });
  assert.equal(await sendGmail(CFG, { subject: 's', body: 'b', nowMs: 0, messageId: 'm' }, { fetchFn: g.fetchFn, sleep }), 'gm-2');
  assert.deepEqual(slept, [2000, 2000, 2000]);
  const bad = fakeGoogle({ send: [{ status: 403, error: { message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } }] });
  const e = await sendGmail(CFG, { subject: 's', body: 'b', nowMs: 0, messageId: 'm' }, { fetchFn: bad.fetchFn, ...quick }).catch((x) => x);
  assert.match(e.message, /HTTP 403: Request had insufficient authentication scopes/);
  assert.equal(bad.calls.filter((c) => c.kind === 'send').length, 1);
});

test('ずっと失敗するときは、つながらなかったことだけを伝える（エラー文にトークンを含めない）', async () => {
  const g = fakeGoogle({ token: [new Error(`boom ${CFG.clientSecret}`), new Error('x'), new Error('y')] });
  const e = await sendGmail(CFG, { subject: 's', body: 'b', nowMs: 0, messageId: 'm' }, { fetchFn: g.fetchFn, ...quick }).catch((x) => x);
  assert.match(e.message, /接続できませんでした/);
  assert.doesNotMatch(e.message, /CLIENT-SECRET/);
});
