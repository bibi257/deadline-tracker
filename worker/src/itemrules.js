// 締切 1 件の「値の意味」の監査（実在する日付・範囲）。アプリの取り込み形式を保ちつつ、Date.parse が丸める不正日も見つける。
// 数値の範囲を少し広めに確認する。いまは scripts/check-data.mjs が、手元のデータを調べるためだけに使う。
// Worker の保存 API（PUT /api/data）には、持ち主の確認（合わない項目が 0 件）が済むまで組み込まない（docs/IMPROVEMENTS.md の 37）。
const unset = (v) => v === undefined || v === null;

function readable(s) {
  if (typeof s !== 'string' || Number.isNaN(Date.parse(s))) return false;
  // Date.parse は 2026-02-30 のような日付を翌月へ丸める実装があるため、ISO 形式の日付部分を別に確かめる。
  const m = /^(\d{4})-(\d{2})-(\d{2})(?=$|[Tt ])/.exec(s);
  if (!m) return true; // 既存データの ISO 以外の Date.parse 対応形式は、従来どおり許容する。
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

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

