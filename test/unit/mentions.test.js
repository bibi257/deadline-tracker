// Discord へ直接送る経路（app.js・deadline-data-template）でも、@everyone・@here を通知にしないことを確かめる。
// Worker の経路は digest.test.js・jobs.test.js で確かめている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('app.js: Discord へ直接送る本文は、すべて allowed_mentions で誰もメンションしない', () => {
  const src = read('app.js');
  const m = /function discordPayload\(text\)\{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'discordPayload が見つからない');
  const ctx = vm.createContext({ JSON });
  vm.runInContext(m[0], ctx);
  const body = JSON.parse(ctx.discordPayload('@everyone 締切です @here'));
  assert.equal(body.content, '@everyone 締切です @here');
  assert.deepEqual(body.allowed_mentions, { parse: [], users: [] });
  // Discord へ POST する本文は、必ず discordPayload を通す（content だけの JSON を直接作らない）
  assert.equal((src.match(/JSON\.stringify\(\{content:/g) || []).length, 1, 'content だけの JSON は discordPayload の中にしか無い');
  assert.equal((src.match(/body:discordPayload\(/g) || []).length, 2, '自動通知と手動送信の2か所');
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
