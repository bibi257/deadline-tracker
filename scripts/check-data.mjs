// 書き出した JSON（設定の「JSONで書き出す」）の締切が、Worker の保存の検査に通るかを、項目ごとに確かめる。
// 出すのは「id（先頭20文字）と理由」と件数だけ。題名・メモなど締切の内容は出さない。
//   node scripts/check-data.mjs <書き出したファイル>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkData } from '../worker/src/index.js';
import { itemValueProblems, startAfterDue } from '../worker/src/itemrules.js';

/** 検査の結果。{ total, bad: [{ id, reasons }], startAfterDue: 件数 } */
export function checkFile(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const bad = [];
  let after = 0;
  items.forEach((it, i) => {
    const id = typeof it?.id === 'string' ? it.id.slice(0, 20) : `(${i + 1} 番目・id なし)`;
    // 値の意味の検査は、理由をすべて挙げる（保存 API は最初の1つだけを返す）
    const reasons = it && typeof it === 'object' ? itemValueProblems(it) : [];
    if (it && typeof it === 'object' && startAfterDue(it)) {
      reasons.push('start が due より後');
      after += 1;
    }
    if (!reasons.length) {
      try {
        checkData({ items: [it] }); // Worker の保存 API と同じ検査（型と形）
      } catch (e) {
        reasons.push(e?.message ? String(e.message).replace(/（[^）]*）$/, '') : '形式が正しくない');
      }
    }
    if (reasons.length) bad.push({ id, reasons });
  });
  return { total: items.length, bad, startAfterDue: after };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('使い方: node scripts/check-data.mjs <書き出したJSONファイル>');
    process.exit(2);
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.error('ファイルを読めませんでした（JSON の形式を確かめてください）');
    process.exit(2);
  }
  // 設定の「JSONで書き出す」は { items, ... } の形。世代バックアップの API の返り値（{ data: {...} }）も受け付ける
  const r = checkFile(data?.items ? data : data?.data);
  console.log(`締切 ${r.total} 件のうち、合わない項目: ${r.bad.length} 件`);
  for (const b of r.bad) console.log(`- ${b.id}: ${b.reasons.join(' / ')}`);
  console.log(`うち、開始日が締切日より後の項目: ${r.startAfterDue} 件`);
  process.exit(r.bad.length ? 1 : 0);
}
