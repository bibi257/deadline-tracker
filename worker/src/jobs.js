// 定時の処理（Cron Triggers）と、手動で試すための入口。
import { buildDigest, discordBodies, postDiscord } from './digest.js';
import { buildFeed } from './feed.js';
import { gmailConfig, sendGmail, subjectFor, targetDate, buildMailBody } from './mail.js';
import { runMaintenance } from './maintenance.js';

export const CRON_DIGEST = '47 21 * * *'; // 毎朝 6:47（JST）。Cron は UTC で書く
export const CRON_MAIL_EVENING = '23 11 * * *'; // 毎日 20:23（JST）→ 翌日分のメール
export const CRON_MAIL_MORNING = '23 20 * * *'; // 毎日 5:23（JST）→ 当日分のメール
export const CRON_MAINTENANCE = '10 18 * * *'; // 毎日 3:10（JST）

const WEBHOOK = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+$/;

/** 設定（シークレットと変数）を読む。前後の空白は除く */
export function readConfig(env) {
  const get = (k) => (typeof env[k] === 'string' ? env[k].trim() : '');
  const hook = get('DISCORD_WEBHOOK_URL');
  let appUrl = get('APP_URL');
  if (appUrl && !appUrl.endsWith('/')) appUrl += '/';
  const uid = get('DISCORD_USER_ID');
  return {
    webhook: WEBHOOK.test(hook) ? hook : '',
    webhookSet: !!hook,
    appUrl,
    mentionUserId: /^\d{5,25}$/.test(uid) ? uid : '',
    doneLinks: get('DONE_LINKS') !== '0',
  };
}

async function loadData(env) {
  const row = await env.DB.prepare('SELECT json FROM docs WHERE id = ?').bind('main').first();
  return row ? JSON.parse(row.json) : null;
}

/** 締切一覧を作る（送らない）。確認用の API と、送信の両方が使う */
export async function previewDigest(env, nowMs) {
  const cfg = readConfig(env);
  const data = await loadData(env);
  if (!data) {
    return { cfg, warnings: [], bodies: [{ content: '⚠️ 締切データがまだ保存されていません。アプリで同期してください。' }] };
  }
  const { content, warnings } = buildDigest(data, { now: nowMs, appUrl: cfg.appUrl, mentionUserId: cfg.mentionUserId, doneLinks: cfg.doneLinks });
  return { cfg, warnings, bodies: discordBodies(content, cfg.mentionUserId) };
}

const sendOpts = (env) => ({ fetchFn: env.FETCH ?? fetch, ...(env.SLEEP ? { sleep: env.SLEEP } : {}) });

/** 締切一覧を Discord に送る。送った通数を返す。Webhook が未設定なら何もしない（null） */
export async function sendDigest(env, nowMs) {
  const cfg = readConfig(env);
  if (!cfg.webhook) {
    console.log(cfg.webhookSet ? 'DISCORD_WEBHOOK_URL が Discord の URL の形ではないため送りません' : 'DISCORD_WEBHOOK_URL が未設定のため送りません');
    return null;
  }
  let bodies;
  try {
    ({ bodies } = await previewDigest(env, nowMs));
  } catch (e) {
    console.error('締切一覧を作れませんでした', e);
    // 何も届かないと「今日は締切が無い」と見分けがつかないため、失敗したことを知らせる（作る側の失敗のときだけ）
    await postDiscord(cfg.webhook, [{ content: '⚠️ 締切一覧を作れませんでした（Worker）。ログを確認してください。' }], sendOpts(env)).catch(() => {});
    throw e;
  }
  return postDiscord(cfg.webhook, bodies, sendOpts(env));
}


// ---- 締切のメール（Claude のルーティンが Gmail から読む） ----

/** メールの件名と本文を作る（送らない）。データが無ければ body は null */
export async function previewMail(env, nowMs, mode = 'auto') {
  const target = targetDate(nowMs, mode);
  const data = await loadData(env);
  const subject = subjectFor(target);
  if (!data) return { target, subject, body: null, warnings: [] };
  const { feed, warnings } = buildFeed(data, { now: nowMs });
  return { target, subject, body: buildMailBody(feed, target), warnings };
}

/** メールを1通送る。Google の認証情報が未設定、またはデータが無いときは何もしない（null） */
export async function sendMail(env, nowMs, mode = 'auto') {
  const cfg = gmailConfig(env);
  if (!cfg.ok) {
    console.log('Gmail の設定（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN / MAIL_TO）が未設定のため、メールは送りません');
    return null;
  }
  const { subject, body } = await previewMail(env, nowMs, mode);
  if (body === null) {
    console.log('締切データがまだ保存されていないため、メールは送りません');
    return null;
  }
  const id = await sendGmail(cfg, { subject, body, nowMs, messageId: crypto.randomUUID() }, sendOpts(env));
  return { id, subject };
}

/** Cron のメール。失敗したら、Discord が使えるときは知らせてから例外にする（届かない日に気づけるように） */
async function runMail(env, nowMs) {
  try {
    return await sendMail(env, nowMs, 'auto');
  } catch (e) {
    console.error('メールを送れませんでした', e.message);
    const hook = readConfig(env).webhook;
    if (hook) await postDiscord(hook, [{ content: `⚠️ 締切のメールを送れませんでした（Worker）: ${e.message}` }], sendOpts(env)).catch(() => {});
    throw e;
  }
}

/** Cron から呼ばれる。cron は発火した式 */
export async function runScheduled(cron, env, nowSec) {
  if (cron === CRON_DIGEST) return { digest: await sendDigest(env, nowSec * 1000) };
  if (cron === CRON_MAIL_EVENING || cron === CRON_MAIL_MORNING) return { mail: await runMail(env, nowSec * 1000) };
  if (cron === CRON_MAINTENANCE) return { maintenance: await runMaintenance(env, nowSec) };
  console.log(`知らない Cron の式です: ${cron}`);
  return {};
}
