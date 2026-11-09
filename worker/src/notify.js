// 定時の通知が届いたかの記録（D1 の notify_log）。届かなかった日に気づけるようにし、同じ日の同じ通知を2回送らない。
// 記録するのは Cron から送るものだけ（手動の POST /api/digest・/api/mail は試しに送る用途なので記録しない）。
import { addDaysStr, dateStr } from './time.js';

export const NOTIFY_KINDS = ['morning', 'evening', 'weekly', 'mail-morning', 'mail-evening'];
export const NOTIFY_LABEL = {
  morning: '朝の締切一覧', evening: '夜の再通知', weekly: '週次レビュー', 'mail-morning': '朝のメール', 'mail-evening': '夜のメール',
};
const KEEP_DAYS = 30;
const LOOKBACK_DAYS = 7;

/**
 * 記録をつけながら1つの通知を送る。send() は送った結果を返す（未設定などで送らなかったときは null）。
 * - 同じ日・同じ種類の行がすでにあれば（成功済み、または同時に動いた別の実行が予約済み）送らずに { skipped: true }
 * - 送れたら ok = 1。送らなかった（null）ときは予約を消す。失敗したら ok = 0 のまま残し、例外をそのまま投げる
 */
export async function withNotifyLog(env, kind, nowSec, send) {
  const day = dateStr(nowSec * 1000);
  const r = await env.DB.prepare('INSERT OR IGNORE INTO notify_log (kind, day, at, ok) VALUES (?, ?, ?, 0)').bind(kind, day, nowSec).run();
  if (!r.meta.changes) return { skipped: true };
  const out = await send(); // 失敗は ok = 0 のまま残る
  if (out === null) {
    await env.DB.prepare('DELETE FROM notify_log WHERE kind = ? AND day = ? AND ok = 0').bind(kind, day).run();
    return null;
  }
  await env.DB.prepare('UPDATE notify_log SET ok = 1, at = ? WHERE kind = ? AND day = ?').bind(nowSec, kind, day).run();
  return out;
}

/** 直近7日で届かなかった通知（ok = 0 のまま残った行）。今まさに送っている行（今日のこの種類）は除く */
export async function recentFailures(env, nowSec, exceptKind) {
  const today = dateStr(nowSec * 1000);
  const since = addDaysStr(today, -LOOKBACK_DAYS);
  const { results } = await env.DB.prepare('SELECT kind, day FROM notify_log WHERE ok = 0 AND day >= ? ORDER BY day, kind').bind(since).all();
  return results.filter((f) => !(f.day === today && f.kind === exceptKind));
}

/** 届かなかった通知を1行にする（例「⚠️ 届いていない通知：11/8 夜の再通知、11/7 朝のメール」）。無ければ null */
export function failureNote(failures) {
  if (!failures.length) return null;
  const items = failures.map((f) => {
    const [, m, d] = f.day.split('-').map(Number);
    return `${m}/${d} ${NOTIFY_LABEL[f.kind] || f.kind}`;
  });
  return `⚠️ 届いていない通知：${items.join('、')}`;
}

/** GET /api/notify-log の中身：種類ごとの最新の成功の時刻（epoch 秒。無ければ null）と、直近7日の失敗 */
export async function notifyStatus(env, nowSec) {
  const { results } = await env.DB.prepare('SELECT kind, MAX(at) AS at FROM notify_log WHERE ok = 1 GROUP BY kind').all();
  const last = Object.fromEntries(NOTIFY_KINDS.map((k) => [k, null]));
  for (const r of results) if (r.kind in last) last[r.kind] = r.at;
  return { last, failures: await recentFailures(env, nowSec) };
}

/** 30日より古い行を消す。消した件数を返す */
export async function pruneNotifyLog(env, nowSec) {
  const cutoff = addDaysStr(dateStr(nowSec * 1000), -KEEP_DAYS);
  const r = await env.DB.prepare('DELETE FROM notify_log WHERE day < ?').bind(cutoff).run();
  return r.meta.changes;
}
