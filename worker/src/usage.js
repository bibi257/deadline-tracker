import { HttpError } from './http.js';
import { parsable } from './digest.js';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message, status = 400) => { throw new HttpError(status, message); };
const iso = (v) => typeof v === 'string' && parsable(v);

function validate(body, now) {
  if (!object(body)) fail('使用量データはオブジェクトにしてください');
  for (const key of Object.keys(body)) if (!['v', 'codex', 'muse', 'claudeCode'].includes(key)) fail(`${key} は指定できません`);
  if (body.v !== undefined && body.v !== 1) fail('v は 1 にしてください');
  for (const [name, fields, required] of [
    ['codex', ['usedPercent', 'resetsAt', 'measuredAt', 'windowDays'], ['usedPercent', 'resetsAt', 'measuredAt']],
    ['muse', ['usedPercent', 'resetsAt', 'measuredAt', 'extraInUse'], ['usedPercent', 'resetsAt', 'measuredAt']],
    ['claudeCode', ['loginExpiresAt', 'measuredAt'], ['loginExpiresAt', 'measuredAt']],
  ]) {
    if (!(name in body)) continue;
    const value = body[name];
    if (!object(value)) fail(`${name} はオブジェクトにしてください`);
    for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${name}.${key} は指定できません`);
    for (const key of required) if (!(key in value)) fail(`${name}.${key} は必須です`);
    if (name !== 'claudeCode') {
      if (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) fail(`${name}.usedPercent は 0〜100 の数値にしてください`);
      if (!iso(value.resetsAt) || !iso(value.measuredAt)) fail(`${name} の日時の形式が正しくありません`);
      if (name === 'codex' && value.windowDays !== undefined && (typeof value.windowDays !== 'number' || !Number.isFinite(value.windowDays) || value.windowDays <= 0)) fail('codex.windowDays は 0 より大きい数値にしてください');
      if (name === 'muse' && value.extraInUse !== undefined && typeof value.extraInUse !== 'boolean') fail('muse.extraInUse は真偽値にしてください');
    } else if (!iso(value.loginExpiresAt) || !iso(value.measuredAt)) fail('claudeCode の日時の形式が正しくありません');
    if (Date.parse(value.measuredAt) > now * 1000 + 5 * 60 * 1000) fail(`${name}.measuredAt は未来すぎます`);
  }
}

export async function getUsage(env, json) {
  const row = await env.DB.prepare('SELECT json FROM docs WHERE id = ?').bind('usage').first();
  return json({ ok: true, usage: row ? JSON.parse(row.json) : null });
}

export async function putUsage(env, request, json, now) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 4096) fail('使用量データが大きすぎます', 413);
  let body;
  try { body = JSON.parse(text || '{}'); } catch { fail('送られたデータの形式が正しくありません'); }
  validate(body, now(env));
  if (!['codex', 'muse', 'claudeCode'].some((k) => k in body)) fail('codex / muse / claudeCode のいずれかを送ってください');
  const row = await env.DB.prepare('SELECT json FROM docs WHERE id = ?').bind('usage').first();
  let current = {};
  if (row) { try { current = JSON.parse(row.json); } catch { current = {}; } }
  const updatedAt = new Date(now(env) * 1000).toISOString();
  const usage = { ...current, ...Object.fromEntries(['codex', 'muse', 'claudeCode'].filter((k) => k in body).map((k) => [k, body[k]])), v: 1, updatedAt };
  // id='usage' では rev を使わない。
  await env.DB.prepare('INSERT OR REPLACE INTO docs (id, json, rev, updated_at, saved_at) VALUES (?, ?, ?, ?, ?)').bind('usage', JSON.stringify(usage), 1, updatedAt, now(env)).run();
  return json({ ok: true, updatedAt });
}
