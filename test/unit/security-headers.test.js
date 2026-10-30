// セキュリティヘッダー（静的ファイルの _headers と Worker の応答）と、GitHub Actions の SHA 固定を確かめる。
// 再発検出: CSP の frame-ancestors・nosniff などが外れる／アクションがタグ指定（付け替えられうる）に戻る
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../../worker/src/index.js';
import { createD1 } from '../support/d1Shim.js';
import { buildHeaders } from '../../scripts/build.mjs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const KEY = 'k'.repeat(32);

test('build: web/_headers に CSP（meta と同じ内容 + frame-ancestors）・nosniff・Referrer-Policy・X-Frame-Options が出る', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root.pathname, stdio: 'pipe' });
  const headers = read('web/_headers');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(read('index.html'))[1];
  assert.match(headers, /^\/\*\n/);
  assert.ok(headers.includes(`  Content-Security-Policy: ${csp}; frame-ancestors 'none'\n`), 'meta と同じ CSP に frame-ancestors');
  assert.ok(headers.includes('  X-Content-Type-Options: nosniff\n'));
  assert.ok(headers.includes('  Referrer-Policy: no-referrer\n'));
  assert.ok(headers.includes('  X-Frame-Options: DENY\n'));
  assert.equal(headers, buildHeaders(read('index.html')));
});

test('CSP: style 属性を許さない（unsafe-inline なし・style-src-attr none）。app.js と index.html に style="..." を書き戻さない', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(read('index.html'))[1];
  assert.ok(!csp.includes("'unsafe-inline'"), "'unsafe-inline' を付けない");
  assert.match(csp, /style-src-attr 'none'/);
  // 固定の見た目は styles.css のクラス、計算で決まる値は data-st（applyDyn が CSSOM で付ける）。style 属性は CSP で効かない
  const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/\sstyle=/.test(html), 'index.html に style 属性');
  assert.deepEqual(read('app.js').match(/\sstyle="/g), null, 'app.js の文字列に style="..." を書かない（data-st か、styles.css のクラスに）');
});

test('build: CSP の meta が無い index.html ではエラーにする（ヘッダーが黙って消えない）', () => {
  assert.throws(() => buildHeaders('<html></html>'), /Content-Security-Policy/);
});

test('Worker: JSON・テキスト・エラー・OPTIONS の応答に X-Content-Type-Options: nosniff が付く', async () => {
  const env = { DB: createD1(), APP_KEY: KEY, FEED_TOKEN: 't'.repeat(40), NOW: () => 1_000_000 };
  const call = (method, path, auth = true) => worker.fetch(new Request(`https://x.test${path}`, {
    method, headers: { 'CF-Connecting-IP': '1.1.1.1', ...(auth ? { Authorization: `Bearer ${KEY}` } : {}) },
  }), env);
  const cases = [
    ['GET', '/api/health', false, 200],        // json()
    ['GET', '/api/data', true, 200],           // json()
    ['GET', '/api/data', false, 401],          // json() のエラー
    ['GET', `/ics/${'t'.repeat(40)}.ics`, false, null], // text()（データの有無で 200 / 404）
    ['GET', '/api/ics', true, null],           // text()
    ['OPTIONS', '/api/data', false, 204],
  ];
  for (const [method, path, auth, status] of cases) {
    const res = await call(method, path, auth);
    if (status) assert.equal(res.status, status, `${method} ${path}`);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', `${method} ${path}（${res.status}）`);
  }
});

test('GitHub Actions: 第三者のアクションはすべてコミット SHA で固定し、コメントにタグ名を残す', () => {
  const dir = new URL('.github/workflows/', root);
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 3);
  let n = 0;
  for (const f of files) {
    for (const line of read(`.github/workflows/${f}`).split('\n')) {
      const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
      if (!m || m[1].startsWith('./')) continue;
      n += 1;
      assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${m[1]} は SHA で固定する`);
      assert.match(m[2], /^\s+#\s*v\d/, `${f}: ${m[1]} のコメントにタグ名（例: # v4.4.0）を残す`);
    }
  }
  assert.ok(n >= 5, '確認したアクションの数');
});

test('Dependabot: github-actions を週次で更新する', () => {
  const y = read('.github/dependabot.yml');
  assert.match(y, /package-ecosystem:\s*github-actions/);
  assert.match(y, /interval:\s*weekly/);
});
