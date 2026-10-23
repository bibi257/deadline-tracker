// 毎日の掃除。世代バックアップ（snapshots）を間引き、期限切れの回数制限の記録（limits）を消す。
// 間引きの規則は deadline-data の prune_backups.py と同じ（直近14日は全部、〜90日は週1つ、それ以前は月1つ）。
import { jstParts } from './time.js';

const DAY_S = 86400;
const BATCH = 50;

/** JST の日付からISO週（年・週）を求める（Python の isocalendar と同じ） */
function isoWeek(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7; // 月曜=1 … 日曜=7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // その週の木曜日
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-${week}`;
}

/**
 * 残す・消すを決める。list は [{ id, at }]（at は epoch 秒）、nowSec は今（epoch 秒）。
 * 新しい順に見て、各区分で最初に見たものを残す。
 */
export function pruneSnapshots(list, nowSec) {
  const sorted = [...list].sort((a, b) => (b.at - a.at) || (b.id - a.id));
  const seen = new Set();
  const keep = [];
  const drop = [];
  for (const s of sorted) {
    const age = Math.floor((nowSec - s.at) / DAY_S);
    const p = jstParts(s.at * 1000);
    let key;
    if (age <= 14) key = `all:${s.id}`;
    else if (age <= 90) key = `week:${isoWeek(p.y, p.mo, p.d)}`;
    else key = `month:${p.y}-${p.mo}`;
    if (seen.has(key)) {
      drop.push(s.id);
    } else {
      seen.add(key);
      keep.push(s.id);
    }
  }
  return { keep, drop };
}

/** 毎日の掃除を実行する。消した件数を返す */
export async function runMaintenance(env, nowSec) {
  const { results } = await env.DB.prepare('SELECT id, at FROM snapshots').all();
  const { drop } = pruneSnapshots(results, nowSec);
  for (let i = 0; i < drop.length; i += BATCH) {
    const ids = drop.slice(i, i + BATCH);
    await env.DB.prepare(`DELETE FROM snapshots WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  }
  const limits = await env.DB.prepare('DELETE FROM limits WHERE until < ?').bind(nowSec).run();
  return { snapshots: drop.length, kept: results.length - drop.length, limits: limits.meta.changes };
}
