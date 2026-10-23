// 定時の処理（Cron Triggers）と、手動で試すための入口。
import { buildDigest, discordBodies, postDiscord } from './digest.js';
import { runMaintenance } from './maintenance.js';

export const CRON_DIGEST = '47 21 * * *'; // 毎朝 6:47（JST）。Cron は UTC で書く
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

/** Cron から呼ばれる。cron は発火した式 */
export async function runScheduled(cron, env, nowSec) {
  if (cron === CRON_DIGEST) return { digest: await sendDigest(env, nowSec * 1000) };
  if (cron === CRON_MAINTENANCE) return { maintenance: await runMaintenance(env, nowSec) };
  console.log(`知らない Cron の式です: ${cron}`);
  return {};
}
