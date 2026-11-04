// 端末から Discord・GitHub へ直接送る経路が無いこと（app.js）と、deadline-data-template の send_digest.sh で @everyone・@here を通知にしないことを確かめる。
// Worker の経路は digest.test.js・jobs.test.js で確かめている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('app.js: Discord へも GitHub へも直接送らない（通知の送信は Worker だけ。Webhook URL・GitHub のトークンを端末に持たない）', () => {
  const src = read('app.js');
  // 段階5b で、端末から Discord・GitHub へ直接送る経路を消した。戻さないための確認
  for (const word of ['allowed_mentions', 'discord.com', 'discordapp.com', 'api.github.com', 'dc-hook', 'gh-token']) {
    const hits = src.split('\n').filter((l) => l.includes(word) && !/forgetLegacySettings|^\s*\/\//.test(l) && !l.includes('["gh-token","dc-hook"'));
    assert.deepEqual(hits, [], `app.js に ${word} が残っている`);
  }
  assert.doesNotMatch(read('index.html'), /connect-src[^;]*(github|discord)/, 'CSP の connect-src に GitHub・Discord を許さない');
});

test('deadline-data-template の send_digest.sh: ユーザーID が空でも allowed_mentions: {parse: [], users: []} を付ける', () => {
  const src = read('deadline-data-template/.github/scripts/send_digest.sh');
  const m = /jq -n --argjson c "\$truncated" --arg uid "\$MENTION_USER_ID" '\s*([\s\S]*?)'\)/.exec(src);
  assert.ok(m, 'jq の式が見つからない');
  const run = (uid) => JSON.parse(execFileSync('jq', ['-n', '-c', '--argjson', 'c', '"@everyone"', '--arg', 'uid', uid, m[1]]).toString());
  assert.deepEqual(run('').allowed_mentions, { parse: [], users: [] });
  assert.deepEqual(run('123456789012345678').allowed_mentions, { parse: [], users: ['123456789012345678'] });
  assert.equal(run('').content, '@everyone');
});
