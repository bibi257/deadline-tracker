// 画面のファイルを web/ にそろえる処理と、プライバシーポリシーのページ（Google の OAuth の公開に必要）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('build: 画面のファイルと privacy.html を web/ にそろえる', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root.pathname, stdio: 'pipe' });
  for (const f of ['index.html', 'privacy.html', 'app.js', 'styles.css', 'service-worker.js', 'manifest.webmanifest', 'assets/icon-192.png']) {
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

test('サービスワーカー: /api/ と /ics/ は横取りしない（データをキャッシュに残さない）', () => {
  const sw = read('service-worker.js');
  assert.match(sw, /startsWith\(["']\/api\/["']\)/);
  assert.match(sw, /startsWith\(["']\/ics\/["']\)/);
});
