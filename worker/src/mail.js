// 締切の一覧を、自分宛てのメールで送る（Claude のルーティンが Gmail から読む）。
// 本文の作り方は deadline-data の send_feed_mail.py と同じ。送信は SMTP ではなく Gmail API（OAuth）で行う。
//
// 件名は「【締切トラッカー】M/D（曜）の締切」で固定し、ルーティンはこの件名で検索する。
// 対象日は実行時刻(JST)で決める: 15時以降なら翌日分、それより前なら当日分。
// 前日の夜（20:23）と当日の早朝（5:23）の2回送る。
import { addDaysStr, cmpStr, dateStr, diffDays, jstParts } from './time.js';

export const SUBJECT_PREFIX = '【締切トラッカー】';
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const TOP_N = 5;
// おすすめの順番で使うカテゴリの重み（無いカテゴリは0）
const CAT_WEIGHT = { 考査: 15, 課題: 10, サブスクなど: -20 };

const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
const jp = (date) => {
  const { y, m, d } = parseDate(date);
  return `${m}/${d}（${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
};

/** 対象日（"YYYY-MM-DD"）。mode は today / tomorrow / auto（15時以降は翌日） */
export function targetDate(nowMs, mode = 'auto') {
  const today = dateStr(nowMs);
  if (mode === 'tomorrow' || (mode === 'auto' && jstParts(nowMs).h >= 15)) return addDaysStr(today, 1);
  return today;
}

export const subjectFor = (target) => `${SUBJECT_PREFIX}${jp(target)}の締切`;

function line(e, today) {
  let when = jp(e.due_date) + (e.due_time ? ` ${e.due_time}` : ' 終日');
  if (e.start_date) when = `${jp(e.start_date)}${e.start_time ? ` ${e.start_time}` : ''} 〜 ${when}`;
  const mark = e.recurring ? '🔁 ' : '';
  let extra = '';
  if (today && e.due_date < today) extra = `（${diffDays(today, e.due_date)}日超過）`;
  else if (today && e.due_date > today) extra = `（あと${diffDays(e.due_date, today)}日）`;
  let s = `- ${mark}${e.title} ［${e.category ?? ''}］ ${when}${extra}`;
  if (e.repeat) s += ` ／${e.repeat}`;
  if (typeof e.memo === 'string' && e.memo) s += `\n    メモ: ${e.memo.replaceAll('\n', ' ')}`;
  return s;
}

function score(e, target) {
  const d = diffDays(e.due_date, target);
  let s;
  let why;
  if (d < 0) {
    s = 100 + Math.min(-d * 5, 50);
    why = `${-d}日超過`;
  } else if (d === 0) {
    s = 80;
    why = '今日が締切';
    if (e.due_time) {
      const h = parseInt(e.due_time.slice(0, 2), 10);
      s += Math.max(0, 10 - Math.max(0, h - 8)); // 午前の締切ほど先に
      why += `（${e.due_time}）`;
    }
  } else if (d <= 3) {
    s = 60 - d * 10;
    why = `あと${d}日`;
  } else if (d <= 7) {
    s = 20 - d;
    why = `あと${d}日`;
  } else {
    return null;
  }
  if (e.recurring) s -= 10;
  const w = CAT_WEIGHT[e.category ?? ''] ?? 0;
  if (w) {
    s += w;
    if (w > 0) why += `・${e.category}を優先`;
  }
  return { s, why };
}

function prioritySection(items, target) {
  const rows = [];
  for (const e of items) {
    const r = score(e, target);
    if (r) rows.push({ s: r.s, why: r.why, e });
  }
  rows.sort((a, b) => (b.s - a.s) || cmpStr(a.e.due_date, b.e.due_date) || cmpStr(a.e.title, b.e.title));
  const out = [`■ おすすめの順番（上位${TOP_N}件）`];
  if (!rows.length) out.push('- 急ぎのものはありません');
  rows.slice(0, TOP_N).forEach((r, i) => out.push(`${i + 1}. ${r.e.title} ［${r.e.category ?? ''}］ … ${r.why}`));
  out.push('');
  return out;
}

/** メール本文。feed は buildFeed の結果、target は "YYYY-MM-DD" */
export function buildMailBody(feed, target) {
  const items = feed.items ?? [];
  const over = items.filter((e) => e.due_date < target);
  const today = items.filter((e) => e.due_date === target);
  const during = items.filter((e) => e.start_date && e.start_date <= target && target < e.due_date);
  const week = addDaysStr(target, 7);
  const soon = items.filter((e) => target < e.due_date && e.due_date <= week && !during.includes(e));

  const out = [`${jp(target)}の締切（締切トラッカーより自動送信）`, ''];
  // 今日の一手（印の付いた締切。印が無ければ何も足さない＝今までの本文と変わらない）
  const picks = items.filter((e) => e.pick === target);
  if (picks.length) {
    out.push(`■ 今日の一手（${picks.length}件）`);
    out.push(...picks.map((e) => line(e, target)));
    out.push('');
  }
  out.push(...prioritySection(items, target));
  // 件数には、自動完了の予定（締切を過ぎると自動で完了になる）を数えない。あれば「＋自動完了N件」と分けて書く
  const section = (title, rows) => {
    const auto = rows.filter((e) => e.auto_complete === true).length;
    out.push(`■ ${title}（${auto ? `${rows.length - auto}件＋自動完了${auto}件` : `${rows.length}件`}）`);
    if (rows.length) out.push(...rows.map((e) => line(e, target)));
    else out.push('- なし');
    out.push('');
  };
  section('今日が締切', today);
  section('期限切れ', over);
  section('期間中', during);
  section('今後7日間の締切', soon);
  out.push('-- ');
  out.push(`この日付: ${target} ／ データ更新: ${feed.source_updated_at || '不明'}`);
  out.push('このメールは deadline-tracker の Cloudflare Worker が自動で送っています。返信不要です。');
  return out.join('\n');
}

// ---- メッセージの組み立て（RFC 5322 / MIME） ----

const encoder = new TextEncoder();

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** URL 向けの base64（Gmail API の raw） */
export const toBase64Url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 日本語を含むヘッダーの値（RFC 2047）。1語が75文字を超えないよう、45バイトごとに文字の切れ目で分ける */
export function encodeHeader(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let cur = [];
  let bytes = 0;
  for (const ch of text) {
    const b = encoder.encode(ch);
    if (bytes + b.length > 45) {
      words.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(...b);
    bytes += b.length;
  }
  if (cur.length) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${toBase64(Uint8Array.from(w))}?=`).join('\r\n ');
}

/** 宛先・差出人のアドレス。改行や制御文字が混ざっていたら使わない（ヘッダーへの混入を防ぐ） */
export function cleanAddress(v) {
  const a = typeof v === 'string' ? v.trim() : '';
  return /^[^@\s<>",;:\\]+@[^@\s<>",;:\\]+\.[^@\s<>",;:\\]+$/.test(a) ? a : '';
}

/** 送信するメッセージ全体（RFC 5322）。本文は UTF-8 の base64 */
export function buildRawMessage({ from, to, subject, body, date, messageId }) {
  const b64 = toBase64(encoder.encode(body.replace(/\r?\n/g, '\r\n')));
  const lines = b64.match(/.{1,76}/g) ?? [];
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date(date).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}@deadline-tracker>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${lines.join('\r\n')}\r\n`;
}

// ---- Gmail API ----

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** 設定（シークレット）を読む。そろっていなければ ok が false */
export function gmailConfig(env) {
  const get = (k) => (typeof env[k] === 'string' ? env[k].trim() : '');
  const to = cleanAddress(get('MAIL_TO'));
  const from = cleanAddress(get('MAIL_FROM')) || to;
  const cfg = {
    clientId: get('GOOGLE_CLIENT_ID'), clientSecret: get('GOOGLE_CLIENT_SECRET'), refreshToken: get('GOOGLE_REFRESH_TOKEN'), to, from,
  };
  return { ...cfg, ok: !!(cfg.clientId && cfg.clientSecret && cfg.refreshToken && to), anySet: !!(cfg.clientId || cfg.clientSecret || cfg.refreshToken || get('MAIL_TO')) };
}

async function withRetry(fn, { sleep, retries }) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2000);
    try {
      const res = await fn();
      if (!RETRY_STATUS.has(res.status)) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** リフレッシュトークンから、メール送信用のアクセストークンを受け取る。エラー文に認証情報を含めない */
export async function getAccessToken(cfg, { fetchFn, sleep, retries }) {
  const res = await withRetry(() => fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken,
    }).toString(),
  }), { sleep, retries }).catch(() => { throw new Error('Google の認証サーバーに接続できませんでした'); });
  const j = await readJson(res);
  if (!res.ok || !j.access_token) {
    const code = typeof j.error === 'string' ? j.error.slice(0, 40) : `HTTP ${res.status}`;
    const hint = code === 'invalid_grant'
      ? '。リフレッシュトークンが無効です（取り消し・期限切れ。OAuth 同意画面が「テスト」のままだと7日で切れます）'
      : code === 'invalid_client' ? '。クライアント ID かシークレットが違います' : '';
    throw new Error(`Google の認証に失敗しました（${code}）${hint}`);
  }
  return j.access_token;
}

/** メールを1通送る。送れたら Gmail のメッセージ ID を返す */
export async function sendGmail(cfg, { subject, body, nowMs, messageId }, { fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 2 } = {}) {
  const token = await getAccessToken(cfg, { fetchFn, sleep, retries });
  const raw = toBase64Url(encoder.encode(buildRawMessage({ from: cfg.from, to: cfg.to, subject, body, date: nowMs, messageId })));
  const res = await withRetry(() => fetchFn(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  }), { sleep, retries }).catch(() => { throw new Error('Gmail に接続できませんでした'); });
  const j = await readJson(res);
  if (!res.ok) {
    const msg = typeof j?.error?.message === 'string' ? j.error.message.slice(0, 150) : '';
    throw new Error(`Gmail への送信に失敗しました（HTTP ${res.status}${msg ? `: ${msg}` : ''}）`);
  }
  return j.id ?? null;
}
