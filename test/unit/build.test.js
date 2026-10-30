// 画面のファイルを web/ にそろえる処理と、プライバシーポリシーのページ（Google の OAuth の公開に必要）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hash10, versionDate, versionIndexHtml, versionServiceWorker } from '../../scripts/build.mjs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('build: 画面のファイルと privacy.html を web/ にそろえる', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root.pathname, stdio: 'pipe' });
  for (const f of ['index.html', 'privacy.html', 'privacy.css', 'app.js', 'styles.css', 'service-worker.js', 'manifest.webmanifest', 'assets/icon-192.png']) {
    assert.ok(existsSync(new URL(`web/${f}`, root)), f);
  }
});

test('プライバシーポリシー: 使う権限・目的・第三者に渡さないこと・Google の限定的な使用・連絡先を書いている。個人情報は書かない', () => {
  const html = read('privacy.html');
  assert.match(html, /<title>プライバシーポリシー/);
  assert.match(html, /gmail\.send/);
  assert.match(html, /閲覧・読み取り・削除/);
  assert.match(html, /第三者に提供・販売・共有することはありません/);
  assert.match(html, /Limited Use/);
  assert.match(html, /api-services-user-data-policy/);
  assert.match(html, /github\.com\/bibi257\/deadline-tracker\/issues/);
  assert.doesNotMatch(html, /[\w.+-]+@[\w-]+\.[\w.]+/, 'メールアドレスは書かない');
});

test('プライバシーポリシー: スタイルは外部ファイル（CSP がインラインの <style> を止めるため）', () => {
  assert.doesNotMatch(read('privacy.html'), /<style|\sstyle=/);
  assert.match(read('privacy.html'), /<link rel="stylesheet" href="privacy\.css">/);
  assert.match(read('web/privacy.css'), /max-width:42rem/);
});

test('サービスワーカー: /api/ と /ics/ は横取りしない（データをキャッシュに残さない）', () => {
  const sw = read('service-worker.js');
  assert.match(sw, /startsWith\(["']\/api\/["']\)/);
  assert.match(sw, /startsWith\(["']\/ics\/["']\)/);
});

test('版番号の自動化: app.js・styles.css の内容のハッシュで ?v= を、全体のハッシュで build-stamp とキャッシュ名を書き換える', () => {
  const html = '<!-- 例: <script src="app.js?v=..."> / <link href="styles.css?v=..."> -->\n<meta name="build-stamp" content="2026-10-29 13:00 説明">\n<link rel="stylesheet" href="styles.css?v=20261027-0300">\n<script src="app.js?v=20261029-1300"></script>';
  const out = versionIndexHtml(html, { app: 'aaaaaaaaaa', css: 'cccccccccc', all: 'ffffffffff', date: '2026-10-30 09:15' });
  assert.equal(out, '<!-- 例: <script src="app.js?v=..."> / <link href="styles.css?v=..."> -->\n<meta name="build-stamp" content="2026-10-30 09:15 [ffffffffff] 説明">\n<link rel="stylesheet" href="styles.css?v=cccccccccc">\n<script src="app.js?v=aaaaaaaaaa"></script>');
  assert.equal(versionServiceWorker('const CACHE_NAME = "deadline-tracker-v17";\nx', 'ffffffffff'), 'const CACHE_NAME = "deadline-tracker-ffffffffff";\nx');
});

test('版番号の自動化: 置き換え対象が見つからなければ失敗する（古い値のまま出さない）', () => {
  const all = { app: 'a', css: 'c', all: 'f', date: '2026-10-30 09:15' };
  const ok = '<meta name="build-stamp" content="x">\n<link rel="stylesheet" href="styles.css?v=1">\n<script src="app.js?v=1"></script>';
  assert.doesNotThrow(() => versionIndexHtml(ok, all));
  assert.throws(() => versionIndexHtml(ok.replace('app.js?v=1', 'app.js'), all), /app\.js\?v=/);
  assert.throws(() => versionIndexHtml(ok.replace('styles.css?v=1', 'styles.css'), all), /styles\.css\?v=/);
  assert.throws(() => versionIndexHtml(ok.replace('build-stamp', 'other'), all), /build-stamp/);
  assert.throws(() => versionServiceWorker('const NAME = "x";', 'f'), /CACHE_NAME/);
});

test('版番号の自動化: ハッシュは内容だけで決まる（同じ内容なら同じ。1文字違えば変わる。区切りが違えば変わる）', () => {
  assert.equal(hash10('a', 'b'), hash10('a', 'b'));
  assert.match(hash10('a'), /^[0-9a-f]{10}$/);
  assert.notEqual(hash10('a'), hash10('b'));
  assert.notEqual(hash10('ab', 'c'), hash10('a', 'bc'));
});

test('build: web/ の index.html と service-worker.js に、ファイルの内容のハッシュが入る。ルートのファイルは変えない', () => {
  const rootIndex = read('index.html');
  const rootSw = read('service-worker.js');
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root.pathname, stdio: 'pipe' });
  const web = read('web/index.html');
  assert.ok(web.includes(`<script src="app.js?v=${hash10(read('app.js'))}"></script>`), '実際の script タグ');
  assert.ok(web.includes(`<link rel="stylesheet" href="styles.css?v=${hash10(read('styles.css'))}">`), '実際の link タグ');
  assert.doesNotMatch(web, /(?:app\.js|styles\.css)\?v=\d{8}-\d{4}/, '手書きの日時の版番号が残っていない');
  const all = hash10(rootIndex, read('app.js'), read('styles.css'), rootSw);
  assert.match(web, new RegExp(`<meta name="build-stamp" content="\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} \\[${all}\\] [^"]+">`), '日時・ハッシュ・説明');
  assert.match(read('web/service-worker.js'), new RegExp(`const CACHE_NAME = "deadline-tracker-${all}";`));
  assert.equal(read('index.html'), rootIndex, 'ルートの index.html は書き換えない');
  assert.equal(read('service-worker.js'), rootSw, 'ルートの service-worker.js は書き換えない');
  // 同じコミットなら、何度ビルドしても同じ（見た目に関係のないデプロイで読み直しが起きない）
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root.pathname, stdio: 'pipe' });
  assert.equal(read('web/index.html'), web);
});

test('版の日時: BUILD_DATE で固定できる。無ければ、画面のファイルを最後に変えたコミットの日時（JST）か、ビルドした時刻', () => {
  assert.equal(versionDate(root.pathname, { BUILD_DATE: '2026-01-02 03:04' }), '2026-01-02 03:04');
  assert.match(versionDate(root.pathname, {}), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(versionDate('/', {}), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'git のリポジトリではない場所でも、ビルドした時刻で動く');
});

test('版番号: index.html の app-version（v3.1 の 3.1）と package.json の version の major.minor がそろっている。Worker 用の web/ にもそのまま出る', () => {
  const v = /<meta name="app-version" content="([^"]+)">/.exec(read('index.html'));
  assert.ok(v, 'index.html に app-version の meta がある');
  assert.match(v[1], /^\d+\.\d+$/, '「3.1」の形');
  const pkg = JSON.parse(read('package.json')).version;
  assert.equal(pkg.split('.').slice(0, 2).join('.'), v[1], 'package.json の version と major.minor が同じ');
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root.pathname, stdio: 'pipe' });
  assert.ok(read('web/index.html').includes(`<meta name="app-version" content="${v[1]}">`), 'ビルドしても版番号は消えない');
  assert.ok(read('docs/VERSIONS.md').includes(`| v${v[1]} |`), 'docs/VERSIONS.md の履歴に、この版の行がある');
});
