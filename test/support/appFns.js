// app.js はブラウザ用の1枚のスクリプト（読み込むと画面を作ってしまう）なので、テストでは必要な関数だけをソースから取り出して、
// 偽の画面まわり（store・db・fetch・confirm など）を渡した vm の中で動かす。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');

/**
 * app.js の行頭から始まる関数 `function name(...){ ... }` のソースを返す。
 * 終わりの位置は、`}` を1つずつ候補にして「そこまでを構文として読めるか」で決める（最初に読めた所が、その関数の終わり）。
 * 途中の `}` で切ると波かっこが閉じず必ず読めないので、書き方（1行で書く・閉じの } を行頭に置かない）が変わっても壊れない。
 * 取り出せなければ（見つからない・最後まで読めない）例外にする
 */
export function extractFunction(name) {
  const marker = `\nfunction ${name}(`;
  const at = SRC.indexOf(marker);
  if (at < 0) throw new Error(`app.js に ${name} が見つかりません`);
  if (SRC.indexOf(marker, at + 1) >= 0) throw new Error(`app.js に ${name} が2つ以上あります`);
  const start = at + 1;
  for (let end = SRC.indexOf('}', start); end >= 0; end = SRC.indexOf('}', end + 1)) {
    const code = SRC.slice(start, end + 1);
    try {
      new vm.Script(code); // 読めなければ SyntaxError
    } catch {
      continue;
    }
    return code;
  }
  throw new Error(`app.js の ${name} の終わりが見つかりません`);
}

/** app.js の行頭から始まる、1行の定数 `var NAME=...;` のソースを返す */
export function extractVar(name) {
  const m = new RegExp(`\\nvar ${name}=[^\\n]*;[ \\t]*(?=\\n)`).exec(SRC);
  if (!m) throw new Error(`app.js に 1行の var ${name}=...; が見つかりません`);
  const code = m[0].slice(1);
  new vm.Script(code); // 読めなければ SyntaxError
  return code;
}

/**
 * 指定した関数（と、vars に指定した1行の定数）だけを、globals を渡した vm の中に読み込んで、その globals（コンテキスト）を返す。
 * 読み込んだ名前が関数として定義されていることも確かめる（取り出し範囲を誤ると、ここで失敗する）
 */
export function loadAppFunctions(names, globals = {}, vars = []) {
  const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Number, Promise, setTimeout, clearTimeout, ...globals });
  for (const v of vars) vm.runInContext(extractVar(v), ctx, { filename: `app.js:var ${v}` });
  for (const n of names) {
    const code = extractFunction(n);
    vm.runInContext(code, ctx, { filename: `app.js:${n}` });
    if (typeof ctx[n] !== 'function') throw new Error(`app.js の ${n} を関数として読み込めませんでした`);
  }
  return ctx;
}
