// 画面のファイルを web/ にそろえる（Worker の静的配信用）。
// GitHub Pages がリポジトリのルートから配信している間は、ルートが元で web/ は写し。
// Pages をやめたら、ファイルを web/ に移してこのスクリプトを不要にする
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}web/`;
const files = ['index.html', 'privacy.html', 'privacy.css', 'app.js', 'styles.css', 'service-worker.js', 'manifest.webmanifest'];

/** 内容から決まる短い版番号（SHA-256 の先頭10文字）。同じ内容なら、いつビルドしても同じ値になる */
export function hash10(...texts) {
  const h = createHash('sha256');
  for (const t of texts) h.update(t).update('\0');
  return h.digest('hex').slice(0, 10);
}

const STAMP_SOURCES = ['index.html', 'app.js', 'styles.css', 'service-worker.js'];

/**
 * 画面に出す版の日時（JST の "YYYY-MM-DD HH:MM"）。画面のファイルを最後に変えたコミットの日時なので、ファイルを変えない
 * デプロイ（docs だけの変更など）では変わらない。git が使えないときは、ビルドした時刻。環境変数 BUILD_DATE で固定できる（テスト用）。
 * ※履歴が浅い clone（最新の1コミットだけ）では、そのコミットの日時になる
 */
export function versionDate(cwd, env = process.env) {
  if (env.BUILD_DATE) return env.BUILD_DATE;
  let when = new Date();
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...STAMP_SOURCES], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (iso && !Number.isNaN(Date.parse(iso))) when = new Date(iso);
  } catch { /* git が無い・git のリポジトリではない */ }
  return new Date(when.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** 置き換え対象が見つからなければ失敗する（黙って古い値のまま出さない） */
function replaceOnce(text, re, replacement, what) {
  if (!re.test(text)) throw new Error(`${what} が見つかりません（版番号を自動で書き換えられません）`);
  return text.replace(re, replacement);
}

/**
 * Worker から配信する index.html の版番号を、内容のハッシュに書き換える。
 *   app.js?v=…・styles.css?v=…  → それぞれのファイルの内容のハッシュ
 *   build-stamp                 → 「版の日時 [全体のハッシュ] 元の説明」。元の先頭の手書きの日時は外す。
 *                                 版の日時はビルドした時刻ではなく、画面のファイルを最後に変えたコミットの日時（versionDate）。
 *                                 ファイルを変えないデプロイで値が変わると、全端末が「新しい版が見つかりました」と読み直してしまうため
 */
export function versionIndexHtml(html, { app, css, all, date }) {
  // 実際のタグだけを対象にする（コメントの中の書き方の例は書き換えない）
  let out = replaceOnce(html, /(<script src="app\.js\?v=)[^"]*("><\/script>)/, `$1${app}$2`, 'index.html の app.js?v=');
  out = replaceOnce(out, /(<link rel="stylesheet" href="styles\.css\?v=)[^"]*(">)/, `$1${css}$2`, 'index.html の styles.css?v=');
  return replaceOnce(out, /(<meta name="build-stamp" content=")([^"]*)(")/, (_, a, stamp, c) => {
    const note = stamp.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*/, '').trim(); // 元の先頭の手書きの日時は外す
    return `${a}${[date, `[${all}]`, note].filter(Boolean).join(' ')}${c}`;
  }, 'index.html の build-stamp');
}

/** service-worker.js のキャッシュ名を、内容のハッシュに書き換える（版が変わると古いキャッシュが消える） */
export function versionServiceWorker(js, all) {
  return replaceOnce(js, /const CACHE_NAME = "[^"]*";/, `const CACHE_NAME = "deadline-tracker-${all}";`, 'service-worker.js の CACHE_NAME');
}

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
  const text = (f) => readFile(`${root}${f}`, 'utf8');
  const [index, app, css, sw] = await Promise.all([text('index.html'), text('app.js'), text('styles.css'), text('service-worker.js')]);
  // ルートのファイル（GitHub Pages 用の旧環境）は手で版番号を更新する。web/ には、内容のハッシュを自動で入れる
  const all = hash10(index, app, css, sw);
  await writeFile(`${out}index.html`, versionIndexHtml(index, { app: hash10(app), css: hash10(css), all, date: versionDate(root) }));
  await writeFile(`${out}service-worker.js`, versionServiceWorker(sw, all));
  await writeFile(`${out}_headers`, buildHeaders(index));
  console.log(`web/ に ${files.length} ファイルと assets/、_headers をそろえました（版 ${all}）`);
}
