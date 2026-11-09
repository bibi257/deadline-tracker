// 締切 1 件の「値の意味」の検査（日付として読めるか・範囲）。アプリの sanitizeIncomingItems（app.js）が隔離する条件と、
// 範囲を少し広めにそろえたもの。いまは scripts/check-data.mjs が、手元のデータで合わない項目を数えるためだけに使う。
// Worker の保存 API（PUT /api/data）には、持ち主の確認（合わない項目が 0 件）が済むまで組み込まない（docs/IMPROVEMENTS.md の 37）。
const unset = (v) => v === undefined || v === null;
const readable = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

/** 合わない理由の一覧（日本語の短い文。題名・メモなど締切の内容は含めない）。空なら問題なし */
export function itemValueProblems(it) {
  const out = [];
  if (typeof it.title !== 'string' || !it.title.trim()) out.push('title が空');
  if (!readable(it.due)) out.push('due が日付として読めない');
  if (!unset(it.start) && !readable(it.start)) out.push('start が日付として読めない');
  if (!unset(it.repCount) && !(Number.isInteger(it.repCount) && it.repCount >= 0)) out.push('repCount が 0 以上の整数でない');
  if (!unset(it.repDay) && !(Number.isInteger(it.repDay) && it.repDay >= 1 && it.repDay <= 31)) out.push('repDay が 1〜31 でない');
  if (!unset(it.seq) && !(Number.isInteger(it.seq) && it.seq >= 0)) out.push('seq が 0 以上の整数でない');
  return out;
}

/** 参考：開始日が締切日より後（拒否にするかは、データを見てから決める） */
export function startAfterDue(it) {
  return readable(it.start) && readable(it.due) && Date.parse(it.start) > Date.parse(it.due);
}
