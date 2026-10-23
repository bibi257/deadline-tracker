// 日時の計算。日本時間（JST, UTC+9, 夏時間なし）の暦で数える。
// deadline-data の build_feed.py / build_ics.py（Python の datetime）と同じ結果になるよう、同じ規則で書いてある。
// 時刻はミリ秒（UTC の epoch）で持ち、暦の項目が要るときだけ JST に直す。

export const JST_OFFSET = 9 * 60 * 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** ISO8601（末尾 Z・ミリ秒つきも可）をミリ秒に。読めなければ NaN */
export function parseDt(s) {
  return typeof s === 'string' ? Date.parse(s) : NaN;
}

/** JST の暦の各項目 */
export function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(),
  };
}

/** JST の暦からミリ秒に */
export function fromJst(y, mo, d, h = 0, mi = 0, s = 0, msec = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, s, msec) - JST_OFFSET;
}

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** JST の日付 "YYYY-MM-DD" */
export function dateStr(ms) {
  const p = jstParts(ms);
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`;
}

/** JST の時刻 "HH:MM" */
export function timeStr(ms) {
  const p = jstParts(ms);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** "YYYY-MM-DD" に日数を足す */
export function addDaysStr(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 2つの "YYYY-MM-DD" の日数差（a - b） */
export function diffDays(a, b) {
  const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(a) - t(b)) / DAY);
}

/** "YYYY-MM-DD HH:MM"（JST）をミリ秒に（テストで「今」を固定するための書き方。環境変数 NOW と同じ） */
export function parseNow(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
  if (!m) throw new Error(`日時の形式が正しくありません: ${text}`);
  return fromJst(+m[1], +m[2], +m[3], +m[4], +m[5]);
}

/** UTC の "YYYYMMDDTHHMMSSZ"（.ics 用） */
export function icsUtc(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** 文字列を Unicode のコードポイント順に比べる（Python の str の並び順と同じ） */
export function cmpStr(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
