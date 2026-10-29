// 締切データの保管 API（Cloudflare Worker + D1）。利用者は自分1人。
//   GET  /api/health            動作確認（認証なし）
//   GET  /api/data              締切データと版（rev）の取得
//   PUT  /api/data              締切データの保存。If-Match: <rev> が今の版と違えば 409（?force=1 で上書き、?backup=1 で上書き前を必ずバックアップ）
//   GET  /api/snapshots         世代バックアップの一覧
//   GET  /api/snapshots/:id     世代バックアップ1件の中身
//   GET  /api/feed              未完了の締切の一覧（feed）。?days=14（確認用）
//   GET  /api/ics               .ics（メモあり。?memo=0 でメモなし）
//   GET  /ics/<FEED_TOKEN>.ics  購読用の .ics（メモなし）。認証は URL の中の長いトークン（シークレット FEED_TOKEN）
//   GET  /api/mail              締切のメールの件名と本文を作る（送らない。確認用）。?target=today|tomorrow|auto
//   POST /api/mail              締切のメールを今すぐ自分宛てに送る（手動）
//   GET  /api/digest            Discord に送る締切一覧の文面を作る（送らない。確認用）
//   POST /api/digest            締切一覧を今すぐ Discord に送る（手動）
//
// 定時の処理（scheduled）: 毎朝 6:47 に締切一覧を Discord へ、20:23 と 5:23 に締切のメールを Gmail API で自分宛てに、
// 毎日 3:10 に世代バックアップの間引きと掃除。

// 認証は Authorization: Bearer <アクセスキー>。キーは Worker のシークレット APP_KEY（24文字以上のランダムな値）。
// キーが長いランダム値なので、パスワードのような重いハッシュは使わず（無料プランの CPU 時間 10ms に収める）、定数時間で比べる。
// 認証の失敗が続いたら、IP ごとに一時的に止める。
import { buildFeed } from './feed.js';
import { buildIcs } from './ics.js';
import { gmailConfig } from './mail.js';
import { previewDigest, previewMail, runScheduled, sendDigest, sendMail } from './jobs.js';

const MIN_KEY_LENGTH = 24;
// D1 の1行の上限は 2,000,000 バイト。日本語は1文字3バイトなので、文字数ではなくバイト数で測る（余裕を残した値）
const MAX_DATA_BYTES = 1_900_000;
const ITEM_STRING_KEYS = ['title', 'due', 'start', 'memo', 'cat', 'rep']; // 項目の中で、あれば文字列でなければならない値
const SNAPSHOT_INTERVAL = 30 * 60; // 世代バックアップを残す間隔（秒）。自動同期の連続保存で増えすぎないようにする
const SNAPSHOT_LIST_LIMIT = 200;
const AUTH_MISS_MAX = 10; // 認証の失敗を許す回数（IP ごと）
const AUTH_MISS_WINDOW = 10 * 60;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, json TEXT NOT NULL, rev INTEGER NOT NULL, updated_at TEXT, saved_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, rev INTEGER NOT NULL, json TEXT NOT NULL)',
  // 保存のたびの MAX(at) が、バックアップの件数だけ行を読まないように（D1 の無料枠は読んだ行数で数える）
  'CREATE INDEX IF NOT EXISTS snapshots_at ON snapshots(at)',
  'CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)',
];

const DOC_ID = 'main';

// どの応答にも付ける。Content-Type と違う種類として解釈させない（ブラウザの推測を止める）
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff' };

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const now = (env) => (env.NOW ? env.NOW() : Math.floor(Date.now() / 1000));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
}

function text(body, contentType, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra } });
}

// ---- 認証 ----

const enc = new TextEncoder();
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'local';

async function isLimited(env, key, max) {
  const row = await env.DB.prepare('SELECT n, until FROM limits WHERE k = ?').bind(key).first();
  return !!row && row.until > now(env) && row.n >= max;
}

async function countHit(env, key, windowSec) {
  const t = now(env);
  const row = await env.DB.prepare('SELECT n, until FROM limits WHERE k = ?').bind(key).first();
  if (!row || row.until <= t) {
    await env.DB.prepare('INSERT OR REPLACE INTO limits (k, n, until) VALUES (?, 1, ?)').bind(key, t + windowSec).run();
  } else {
    await env.DB.prepare('UPDATE limits SET n = n + 1 WHERE k = ?').bind(key).run();
  }
}

/** 前後の空白を除いたシークレットを返す。未設定・短すぎるときは空文字 */
function secret(env, name) {
  const v = typeof env[name] === 'string' ? env[name].trim() : '';
  return v.length >= MIN_KEY_LENGTH ? v : '';
}

/** 送られた値がシークレットと同じか。長さの違いから中身が推測されないよう、ハッシュにそろえてから比べる */
async function sameSecret(given, expected) {
  return safeEqual(await sha256Hex(given), await sha256Hex(expected));
}

async function authorize(env, request) {
  // ダッシュボードに貼ったキーの前後に空白や改行が混ざっても通るようにする
  const appKey = secret(env, 'APP_KEY');
  if (!appKey) {
    throw new HttpError(503, `アクセスキー（APP_KEY）が未設定か短すぎます（${MIN_KEY_LENGTH}文字以上）`);
  }
  const ipKey = `auth:${await sha256Hex(clientIp(request))}`;
  const row = await env.DB.prepare('SELECT n, until FROM limits WHERE k = ?').bind(ipKey).first();
  if (row && row.until > now(env) && row.n >= AUTH_MISS_MAX) {
    throw new HttpError(429, '認証の失敗が続いたため、しばらく使えません。10分ほど待ってください');
  }
  const m = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '');
  if (!m || !(await sameSecret(m[1], appKey))) {
    await countHit(env, ipKey, AUTH_MISS_WINDOW);
    throw new HttpError(401, 'アクセスキーが違います');
  }
  // 正しいキーで入れたら、この回線の失敗の記録を消す（同じ回線の古いキーの端末が数えた分で、正しい端末が止まらないように）。記録があるときだけ書く
  if (row) await env.DB.prepare('DELETE FROM limits WHERE k = ?').bind(ipKey).run();
}

// ---- データの検証 ----

const ARRAY_KEYS = ['items', 'templates', 'trash', 'categories', 'completions'];
const OBJECT_KEYS = ['catReminders', 'catColors'];

/** 保存するデータの形を確かめる。値の細かい検査はアプリ側（読み込み時）に任せ、ここでは壊れた形だけを弾く */
function checkData(data) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(data)) throw new HttpError(400, '締切データの形式が正しくありません');
  if (!Array.isArray(data.items)) throw new HttpError(400, 'items（締切の配列）がありません');
  for (const k of ARRAY_KEYS) {
    if (data[k] !== undefined && !Array.isArray(data[k])) throw new HttpError(400, `${k} は配列にしてください`);
  }
  for (const k of OBJECT_KEYS) {
    if (data[k] !== undefined && !isObj(data[k])) throw new HttpError(400, `${k} はオブジェクトにしてください`);
  }
  if (data.updatedAt !== undefined && typeof data.updatedAt !== 'string') throw new HttpError(400, 'updatedAt は文字列にしてください');
  const ids = new Set();
  for (const it of data.items) {
    if (!isObj(it) || typeof it.id !== 'string' || !it.id) throw new HttpError(400, 'id のない締切があります');
    if (ids.has(it.id)) throw new HttpError(400, `id が重複している締切があります（${it.id.slice(0, 20)}）`);
    ids.add(it.id);
    // 壊れた型（数値・配列など）は、定時ジョブ（Discord・メール・.ics）が読めず落ちる原因になるため保存させない
    for (const k of ITEM_STRING_KEYS) {
      if (it[k] !== undefined && it[k] !== null && typeof it[k] !== 'string') {
        throw new HttpError(400, `締切の ${k} は文字列にしてください（${it.id.slice(0, 20)}）`);
      }
    }
  }
}

/** 文字列の UTF-8 でのバイト数。3倍しても上限以下なら、数えずに済ませる（CPU 時間の節約） */
function utf8Bytes(text, limit) {
  return text.length * 3 <= limit ? text.length * 3 : new TextEncoder().encode(text).length;
}

async function readJson(request, maxChars) {
  const text = await request.text();
  if (text.length > maxChars) throw new HttpError(413, 'データが大きすぎます'); // 文字数はバイト数以下なので、これを超えれば確実に大きすぎる
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, '送られたデータの形式が正しくありません');
  }
}

// ---- ハンドラ ----

async function getData(env) {
  const row = await env.DB.prepare('SELECT json, rev, updated_at, saved_at FROM docs WHERE id = ?').bind(DOC_ID).first();
  if (!row) return json({ ok: true, rev: 0, data: null, updatedAt: null, savedAt: null });
  return json({ ok: true, rev: row.rev, data: JSON.parse(row.json), updatedAt: row.updated_at, savedAt: row.saved_at });
}

async function putData(env, request, url) {
  const force = url.searchParams.get('force') === '1';
  const backup = url.searchParams.get('backup') === '1'; // 上書き前の内容を、間隔に関わらず必ず世代バックアップに残す
  const ifMatch = request.headers.get('If-Match');
  if (!force && ifMatch === null) throw new HttpError(428, 'If-Match（読み込んだときの rev）を付けてください');
  const base = Number(ifMatch);
  if (!force && !Number.isInteger(base)) throw new HttpError(400, 'If-Match は整数にしてください');

  const data = await readJson(request, MAX_DATA_BYTES + 1000);
  checkData(data);
  const text = JSON.stringify(data);
  if (utf8Bytes(text, MAX_DATA_BYTES) > MAX_DATA_BYTES) throw new HttpError(413, '締切データが大きすぎます');

  const t = now(env);
  const cur = await env.DB.prepare('SELECT json, rev FROM docs WHERE id = ?').bind(DOC_ID).first();
  if (!force && (cur ? cur.rev : 0) !== base) {
    throw new HttpError(409, '他の端末の更新があります。読み込んでからやり直してください', { rev: cur ? cur.rev : 0 });
  }

  if (!cur) {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO docs (id, json, rev, updated_at, saved_at) VALUES (?, ?, 1, ?, ?)')
      .bind(DOC_ID, text, data.updatedAt ?? null, t).run();
    if (r.meta.changes !== 1) throw new HttpError(409, '他の端末の更新があります。読み込んでからやり直してください', { rev: 1 });
    return json({ ok: true, rev: 1, savedAt: t }, 201);
  }

  // 上書きされる前の内容を、一定の間隔で世代バックアップに残す（?force=1 のときは必ず残す）
  const last = await env.DB.prepare('SELECT MAX(at) AS at FROM snapshots').first('at');
  const stmts = [];
  if (force || backup || last === null || t - last >= SNAPSHOT_INTERVAL) {
    stmts.push(env.DB.prepare('INSERT INTO snapshots (at, rev, json) VALUES (?, ?, ?)').bind(t, cur.rev, cur.json));
  }
  // 版番号は DB 側で +1 する。条件に rev を入れて、同時に送られた別の保存と衝突したら 409 にする
  const cond = force ? '' : ' AND rev = ?';
  const upd = env.DB.prepare(`UPDATE docs SET json = ?, rev = rev + 1, updated_at = ?, saved_at = ? WHERE id = ?${cond}`)
    .bind(text, data.updatedAt ?? null, t, DOC_ID, ...(force ? [] : [base]));
  const results = await env.DB.batch([...stmts, upd]);
  if (results[results.length - 1].meta.changes !== 1) {
    // 世代バックアップだけ残って更新が空振りした場合も、バックアップは無害（次の保存で間引かれる）
    const now2 = await env.DB.prepare('SELECT rev FROM docs WHERE id = ?').bind(DOC_ID).first('rev');
    throw new HttpError(409, '他の端末の更新があります。読み込んでからやり直してください', { rev: now2 });
  }
  const rev = await env.DB.prepare('SELECT rev FROM docs WHERE id = ?').bind(DOC_ID).first('rev');
  return json({ ok: true, rev, savedAt: t });
}

async function listSnapshots(env) {
  const { results } = await env.DB.prepare('SELECT id, at, rev, LENGTH(json) AS size FROM snapshots ORDER BY id DESC LIMIT ?')
    .bind(SNAPSHOT_LIST_LIMIT).all();
  return json({ ok: true, snapshots: results });
}

async function getSnapshot(env, id) {
  const row = await env.DB.prepare('SELECT id, at, rev, json FROM snapshots WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, '見つかりません');
  return json({ ok: true, id: row.id, at: row.at, rev: row.rev, data: JSON.parse(row.json) });
}

async function loadData(env) {
  const row = await env.DB.prepare('SELECT json FROM docs WHERE id = ?').bind(DOC_ID).first();
  return row ? JSON.parse(row.json) : { items: [] };
}

const EMPTY_CALENDAR = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//deadline-tracker//JP\r\nEND:VCALENDAR\r\n';
const ICS_TYPE = 'text/calendar; charset=utf-8';

async function getFeed(env, url) {
  const days = Number(url.searchParams.get('days') ?? 14);
  if (!Number.isInteger(days) || days < 0 || days > 400) throw new HttpError(400, 'days は 0〜400 の整数にしてください');
  const { feed, warnings } = buildFeed(await loadData(env), { now: now(env) * 1000, days });
  return json({ ok: true, feed, warnings });
}

async function getIcs(env, url) {
  const { ics } = buildIcs(await loadData(env), { now: now(env) * 1000, dayHour: 9, noMemo: url.searchParams.get('memo') === '0' });
  return text(ics ?? EMPTY_CALENDAR, ICS_TYPE, 200, { 'Content-Disposition': 'inline; filename="deadlines.ics"' });
}

/** 購読用の .ics。URL の中のトークンで守る（メモは書き出さない）。違うトークンは「無い」として扱い、失敗が続けば IP ごとに止める */
async function serveIcs(env, request, token) {
  const feedToken = secret(env, 'FEED_TOKEN');
  const notFound = () => text('Not found', 'text/plain; charset=utf-8', 404);
  if (!feedToken) return notFound();
  const ipKey = `ics:${await sha256Hex(clientIp(request))}`;
  if (await isLimited(env, ipKey, AUTH_MISS_MAX)) return text('Too many requests', 'text/plain; charset=utf-8', 429);
  if (!(await sameSecret(token, feedToken))) {
    await countHit(env, ipKey, AUTH_MISS_WINDOW);
    return notFound();
  }
  const { ics } = buildIcs(await loadData(env), { now: now(env) * 1000, dayHour: 9, noMemo: true });
  return text(ics ?? EMPTY_CALENDAR, ICS_TYPE, 200, { 'Content-Disposition': 'inline; filename="deadlines.ics"' });
}

function mailMode(url) {
  const t = url.searchParams.get('target') ?? 'auto';
  if (!['today', 'tomorrow', 'auto'].includes(t)) throw new HttpError(400, 'target は today / tomorrow / auto のどれかにしてください');
  return t;
}

async function getMail(env, url) {
  const p = await previewMail(env, now(env) * 1000, mailMode(url));
  const cfg = gmailConfig(env);
  return json({
    ok: true, target: p.target, subject: p.subject, body: p.body, warnings: p.warnings,
    // 設定の有無だけを返す（値は返さない）
    config: { google: cfg.ok ? 'ok' : cfg.anySet ? 'incomplete' : 'unset' },
  });
}

async function postMail(env, url) {
  let sent;
  try {
    sent = await sendMail(env, now(env) * 1000, mailMode(url));
  } catch (e) {
    throw new HttpError(502, e.message);
  }
  if (sent === null) throw new HttpError(400, 'Gmail の設定が未設定か、締切データがまだありません');
  return json({ ok: true, subject: sent.subject });
}

async function getDigest(env) {
  const { cfg, warnings, bodies } = await previewDigest(env, now(env) * 1000);
  return json({
    ok: true,
    chunks: bodies.map((b) => b.content),
    warnings,
    // 設定の有無だけを返す（URL やユーザー ID の値は返さない）
    config: { webhook: cfg.webhook ? 'ok' : cfg.webhookSet ? 'invalid' : 'unset', appUrl: !!cfg.appUrl, mention: !!cfg.mentionUserId },
  });
}

async function postDigest(env) {
  let sent;
  try {
    sent = await sendDigest(env, now(env) * 1000);
  } catch (e) {
    throw new HttpError(502, e.message);
  }
  if (sent === null) throw new HttpError(400, 'DISCORD_WEBHOOK_URL が未設定か、Discord の URL の形ではありません');
  return json({ ok: true, sent });
}

async function route(env, request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  if (path === '/api/health' && method === 'GET') return json({ ok: true });

  await authorize(env, request);
  if (path === '/api/mail' && method === 'GET') return getMail(env, url);
  if (path === '/api/mail' && method === 'POST') return postMail(env, url);
  if (path === '/api/digest' && method === 'GET') return getDigest(env);
  if (path === '/api/digest' && method === 'POST') return postDigest(env);
  if (path === '/api/feed' && method === 'GET') return getFeed(env, url);
  if (path === '/api/ics' && method === 'GET') return getIcs(env, url);
  if (path === '/api/data' && method === 'GET') return getData(env);
  if (path === '/api/data' && method === 'PUT') return putData(env, request, url);
  if (path === '/api/snapshots' && method === 'GET') return listSnapshots(env);
  const m = /^\/api\/snapshots\/(\d+)$/.exec(path);
  if (m && method === 'GET') return getSnapshot(env, Number(m[1]));
  throw new HttpError(404, '見つかりません');
}

const ready = new WeakSet();

async function initDb(db) {
  if (ready.has(db)) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  ready.add(db);
}

export default {
  /** Cron Triggers。失敗したら例外のまま返す（ダッシュボードの Cron の履歴に失敗として残る） */
  async scheduled(event, env) {
    await initDb(env.DB);
    await runScheduled(event.cron, env, now(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const ics = /^\/ics\/([^/]+)\.ics$/.exec(url.pathname);
    if (ics && request.method === 'GET') {
      try {
        await initDb(env.DB);
        return await serveIcs(env, request, ics[1]);
      } catch (e) {
        console.error(e);
        return text('Server error', 'text/plain; charset=utf-8', 500);
      }
    }
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    // CORS は許可しない（アプリは同じオリジンから配信される）。プリフライトは CORS ヘッダーなしで返し、ブラウザに拒否させる
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    try {
      await initDb(env.DB);
      return await route(env, request);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message, ...e.extra }, e.status);
      console.error(e);
      return json({ ok: false, error: 'サーバーでエラーが発生しました' }, 500);
    }
  },
};
