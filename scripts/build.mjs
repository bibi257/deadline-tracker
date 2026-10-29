// 画面のファイルを web/ にそろえる（Worker の静的配信用）。
// GitHub Pages がリポジトリのルートから配信している間は、ルートが元で web/ は写し。
// Pages をやめたら、ファイルを web/ に移してこのスクリプトを不要にする
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}web/`;
const files = ['index.html', 'privacy.html', 'privacy.css', 'app.js', 'styles.css', 'service-worker.js', 'manifest.webmanifest'];

/**
 * 静的ファイルに付けるセキュリティヘッダー（Workers の静的アセットの _headers）。
 * CSP は index.html の meta と同じ内容（meta だけでは効かない frame-ancestors を足す）。meta を変えたら、ここも自動で変わる
 */
export function buildHeaders(indexHtml) {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(indexHtml);
  if (!m) throw new Error('index.html に Content-Security-Policy の meta が見つかりません');
  return `/*
  Content-Security-Policy: ${m[1]}; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
`;
}

// テストから import したときは、何もしない（ファイルを作るのは、直接実行したときだけ）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const f of files) await cp(`${root}${f}`, `${out}${f}`);
  await cp(`${root}assets`, `${out}assets`, { recursive: true });
  await writeFile(`${out}_headers`, buildHeaders(await readFile(`${root}index.html`, 'utf8')));
  console.log(`web/ に ${files.length} ファイルと assets/、_headers をそろえました`);
}
