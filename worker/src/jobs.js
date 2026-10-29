// 定時の処理（Cron Triggers）と、手動で試すための入口。
import { buildDigest, discordBodies, postDiscord } from './digest.js';
import { buildEvening, buildWeekly } from './review.js';
import { jstDow } from './time.js';
import { buildFeed } from './feed.js';
import { gmailConfig, sendGmail, subjectFor, targetDate, buildMailBody } from './mail.js';
import { runMaintenance } from './maintenance.js';

export const CRON_DIGEST = '47 21 * * *'; // 毎朝 6:47（JST）。Cron は UTC で書く
// 無料プランの Cron Triggers はアカウント全体で5本まで。時刻を3本にまとめ、1本で複数の仕事をする
export const CRON_MAIL_EVENING = '23 11 * * *'; // 毎日 20:23（JST）→ 翌日分のメール ＋ 月〜土は夜の再通知、日曜は週次レビュー
export const CRON_MAIL_MORNING = '23 20 * * *'; // 毎日 5:23（JST）→ 当日分のメール ＋ 世代バックアップの間引き・掃除

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

export const DIGEST_KINDS = ['morning', 'evening', 'weekly'];
const KIND_LABEL = { morning: '締切一覧', evening: '夜の再通知', weekly: '週次レビュー' };

/** Discord に送る文面を作る（送らない）。kind は morning（朝の一覧）・evening（夜の再通知）・weekly（週次レビュー）。確認用の API と、送信の両方が使う */
export async function previewDigest(env, nowMs, kind = 'morning') {
  const cfg = readConfig(env);
  const data = await loadData(env);
  if (!data) {
    // 朝だけ、保存されていないことを知らせる（夜の再通知・週次レビューは、何も送らない）
    const bodies = kind === 'morning' ? [{ content: '⚠️ 締切データがまだ保存されていません。アプリで同期してください。' }] : [];
    return { cfg, warnings: [], bodies };
  }
  const opts = { now: nowMs, appUrl: cfg.appUrl, mentionUserId: cfg.mentionUserId, doneLinks: cfg.doneLinks };
  if (kind === 'evening') {
    const content = buildEvening(data, opts);
    return { cfg, warnings: [], bodies: content === null ? [] : discordBodies(content, cfg.mentionUserId) }; // 対象が0件なら送らない
  }
  if (kind === 'weekly') {
    return { cfg, warnings: [], bodies: buildWeekly(data, opts).flatMap((c) => discordBodies(c, cfg.mentionUserId)) };
  }
  const { content, warnings } = buildDigest(data, opts);
  return { cfg, warnings, bodies: discordBodies(content, cfg.mentionUserId) };
}

const sendOpts = (env) => ({ fetchFn: env.FETCH ?? fetch, ...(env.SLEEP ? { sleep: env.SLEEP } : {}) });

/** Discord に送る。送った通数を返す（夜の再通知で対象が0件なら 0）。Webhook が未設定なら何もしない（null） */
export async function sendDigest(env, nowMs, kind = 'morning') {
  const cfg = readConfig(env);
  if (!cfg.webhook) {
    console.log(cfg.webhookSet ? 'DISCORD_WEBHOOK_URL が Discord の URL の形ではないため送りません' : 'DISCORD_WEBHOOK_URL が未設定のため送りません');
    return null;
  }
  let bodies;
  try {
    ({ bodies } = await previewDigest(env, nowMs, kind));
  } catch (e) {
    console.error(`${KIND_LABEL[kind]}を作れませんでした`, e);
    // 何も届かないと「今日は締切が無い」と見分けがつかないため、失敗したことを知らせる（作る側の失敗のときだけ）
    await postDiscord(cfg.webhook, [{ content: `⚠️ ${KIND_LABEL[kind]}を作れませんでした（Worker）。ログを確認してください。` }], sendOpts(env)).catch(() => {});
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

/**
 * 仕事を順に実行する。どれかが失敗しても残りは実行し、最後にまとめて例外にする
 * （Cloudflare のダッシュボードの Cron の履歴に失敗として残るように）。
 */
async function runAll(jobs) {
  const out = {};
  const errors = [];
  for (const [name, job] of Object.entries(jobs)) {
    try {
      out[name] = await job();
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map((e) => e.message).join(' / '));
  return out;
}

/** Cron から呼ばれる。cron は発火した式 */
export async function runScheduled(cron, env, nowSec) {
  const nowMs = nowSec * 1000;
  if (cron === CRON_DIGEST) return { digest: await sendDigest(env, nowMs) };
  if (cron === CRON_MAIL_EVENING) {
    // 日曜(JST)は週次レビュー、それ以外は夜の再通知
    return runAll({ mail: () => runMail(env, nowMs), review: () => sendDigest(env, nowMs, jstDow(nowMs) === 0 ? 'weekly' : 'evening') });
  }
  if (cron === CRON_MAIL_MORNING) {
    return runAll({ mail: () => runMail(env, nowMs), maintenance: () => runMaintenance(env, nowSec) });
  }
  console.log(`知らない Cron の式です: ${cron}`);
  return {};
}
