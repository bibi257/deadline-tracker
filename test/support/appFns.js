// app.js はブラウザ用の1枚のスクリプト（読み込むと画面を作ってしまう）なので、テストでは必要な関数だけをソースから取り出して、
// 偽の画面まわり（store・db・fetch・confirm など）を渡した vm の中で動かす。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');

/** app.js の先頭の行から始まる関数 `function name(...){ ... }` のソースを返す（閉じの } が行頭にある書き方に頼る） */
export function extractFunction(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`app.js に ${name} が見つかりません`);
  const end = SRC.indexOf('\n}', start + 1);
  return SRC.slice(start + 1, end + 2);
}

/** 指定した関数だけを、globals を渡した vm の中に読み込んで、その globals（コンテキスト）を返す */
export function loadAppFunctions(names, globals = {}) {
  const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Number, Promise, setTimeout, clearTimeout, ...globals });
  for (const n of names) vm.runInContext(extractFunction(n), ctx, { filename: `app.js:${n}` });
  return ctx;
}
