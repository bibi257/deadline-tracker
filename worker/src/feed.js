// 未完了の締切の一覧（feed）を作る。deadline-data の build_feed.py と同じ規則。
//
// 状態（今日/超過など）は書かず、絶対日付だけを並べる。
//   - 未完了の締切（繰り返しなし）: 期限切れも含めて、範囲の終わりまでのものすべて
//   - 繰り返し: 範囲内の各回を展開する（取りやめた回は除き、月末は基準日で丸める）
//     自動完了でない回が締切を過ぎたまま残っていれば、その回も1件として出す
import { addRep } from './recurrence.js';
import { addDaysStr, cmpStr, dateStr, isObj, parseDt, timeStr } from './time.js';

const REP_LABEL = { weekly: '毎週', biweekly: '隔週', monthly: '毎月', yearly: '毎年' };

function entry(it, due, start) {
  const allDay = !!it.allDay;
  const rep = it.rep || 'none';
  const e = {
    title: it.title ?? '',
    due_date: dateStr(due),
    due_time: allDay ? null : timeStr(due),
    category: it.cat || 'その他',
    recurring: rep !== 'none',
  };
  if (e.recurring) e.repeat = REP_LABEL[it.rep] ?? it.rep;
  if (start !== null) {
    e.start_date = dateStr(start);
    e.start_time = allDay ? null : timeStr(start);
  }
  if (it.autoComplete === true) e.auto_complete = true; // 自動完了の予定（メールの件数に数えない）
  if (typeof it.memo === 'string' && it.memo) e.memo = it.memo; // 文字列でないメモは出さない（メール本文の replaceAll が落ちるため）
  return e;
}

/** 繰り返しの各回のうち、締切日が frm〜to（"YYYY-MM-DD"）に入るものを返す */
export function expand(it, frm, to, now) {
  const rep = it.rep || 'none';
  const base = parseDt(it.due);
  const span = it.start ? base - parseDt(it.start) : null;
  const skip = new Set((Array.isArray(it.skip) ? it.skip : []).filter((k) => typeof k === 'string'));
  const anchor = it.repDay;
  const limit = it.repCount || 0;
  const out = [];
  // 自動完了でない回が締切を過ぎて残っている＝完了にし忘れ。超過として1件出す
  if (base < now && !it.autoComplete && dateStr(base) < frm) {
    out.push(entry(it, base, span !== null ? base - span : null));
  }
  for (let n = 0; n < 2000; n++) {
    if (limit && n >= limit) break;
    const d = addRep(base, rep, n, anchor);
    const ds = dateStr(d);
    if (ds > to) break;
    if (ds < frm || skip.has(ds)) continue;
    if (it.autoComplete && d < now) continue; // 自動完了の回は締切を過ぎるとアプリが完了にする（期限切れとして出さない）
    out.push(entry(it, d, span !== null ? d - span : null));
  }
  return out;
}

/**
 * data（締切データ）から feed を作る。now はミリ秒、days は先の日数。
 * 読めない締切は除き、その旨を warnings に入れて返す（Python 版は標準エラーに出していたもの）。
 */
export function buildFeed(data, { now, days = 14 }) {
  const frm = dateStr(now);
  const to = addDaysStr(frm, days);
  const items = [];
  const warnings = [];
  for (let it of Array.isArray(data.items) ? data.items : []) {
    if (!isObj(it) || it.done || !it.title) continue;
    const due = parseDt(it.due);
    if (Number.isNaN(due)) {
      warnings.push(`締切日時が読めないため除外: ${it.title}`);
      continue;
    }
    let start = null;
    if (it.start) {
      start = parseDt(it.start);
      if (Number.isNaN(start)) {
        // 開始だけが壊れているときは、開始なし（締切だけの予定）として扱う
        warnings.push(`開始日時が読めないため締切のみで出力: ${it.title}`);
        it = { ...it };
        delete it.start;
        start = null;
      }
    }
    if ((it.rep || 'none') !== 'none') {
      items.push(...expand(it, frm, to, now));
    } else if (dateStr(due) <= to || (start !== null && dateStr(start) <= to)) {
      // 期間つきは、範囲内に始まる・進行中のものも出す
      items.push(entry(it, due, start));
    }
  }
  items.sort((a, b) =>
    cmpStr(a.due_date, b.due_date) || cmpStr(a.due_time ?? '99:99', b.due_time ?? '99:99') || cmpStr(a.title, b.title));
  return {
    feed: {
      description: '締切トラッカーの未完了の締切一覧（日付はJST）。'
        + 'due_date が今日のものが『今日が締切』、今日より前のものは期限切れ。'
        + 'start_date がある項目は期間つきの予定（start_date〜due_date）。',
      timezone: 'Asia/Tokyo',
      generated_on: frm,
      range_end: to,
      source_updated_at: data.updatedAt ?? null,
      items,
    },
    warnings,
  };
}

/** feed.json と同じ文字列（インデント2・末尾に改行） */
export const feedJson = (feed) => `${JSON.stringify(feed, null, 2)}\n`;
