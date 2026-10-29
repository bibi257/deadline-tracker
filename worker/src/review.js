// 夜の再通知と週次レビューの文面を作る。deadline-data-template の send_digest.sh（DIGEST_MODE=evening / weekly）と同じ規則・同じ文面。
//
//   - 夜の再通知: 期限切れと今日が締切（繰り返しの今日の回を含む）だけ。0 件なら作らない（null）
//   - 週次レビュー: 来週7日間の見通し・この1週間の達成・繰り返しの調子・負荷予報・月初めの支出まとめ。2通分の本文を返す
//
// 見出しの件数と負荷予報には、自動完了の予定（締切を過ぎると自動で完了になる）を数えない（アプリのカレンダーと同じ規則。一覧には出す）。
// 月曜の data.json の添付（send_backup）は移植しない。世代バックアップが D1 にあり、メモを含む全データを Discord に置かないため。
import { alt, clean, count, ep, nextOcc, parsable, uriEncode } from './digest.js';
import { cmpStr, dateStr, diffDays, fromJst, isObj, jstDow, jstParts } from './time.js';

// 負荷予報で ⚠️ を付ける件数（1週間の合計 / 1カテゴリ）。app.js の LOAD_WARN / CAT_WARN と同じ。変えるときは両方そろえる
export const LOAD_WARN = 6;
export const CAT_WARN = 3;
// 月初めに支出をまとめるカテゴリ。メモの「¥1,980」「1980円」を集計する
export const SUBSC_CAT = 'サブスクなど';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const DAY_S = 86400;
const pad2 = (n) => String(n).padStart(2, '0');

/** jq の真偽（null と false だけが偽） */
const truthy = (v) => v !== null && v !== undefined && v !== false;
/** jq の「(.x // 0) | tonumber? // 0」。数にできなければ 0 */
function num(v) {
  const x = alt(v, 0);
  if (typeof x === 'number') return x;
  if (typeof x === 'string' && /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(x)) return Number(x);
  return 0;
}
/** jq の round（0.5 は 0 から遠いほうへ） */
const cround = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
/** 小数第1位まで（jq の「. * 10 | round / 10」） */
const r1 = (x) => cround(x * 10) / 10;
/** jq の max_by と同じく、同じ値が並んだら最後のものを返す */
function maxBy(list, f) {
  let best;
  let bestV;
  for (const x of list) {
    const v = f(x);
    if (best === undefined || v >= bestV) { best = x; bestV = v; }
  }
  return best;
}
/** jq の group_by と同じく、キーの昇順に並べたグループの配列にする */
function groupBy(list, f, cmp = cmpStr) {
  const map = new Map();
  for (const x of list) {
    const k = f(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return [...map.keys()].sort(cmp).map((k) => map.get(k));
}

/** 今日(JST)の0時、日数の数え方など、2つの文面で共通のもの */
function dayTools(now) {
  const nowS = Math.floor(now / 1000);
  const p = jstParts(now);
  const todayStart = fromJst(p.y, p.mo, p.d) / 1000;
  const daysFromToday = (sec) => diffDays(dateStr(sec * 1000), dateStr(nowS * 1000));
  return { nowS, todayStart, daysFromToday };
}

const items = (data) => (Array.isArray(data.items) ? data.items.filter(isObj) : []);

// ---- 夜の再通知 ----

/**
 * 夜の再通知の本文。now はミリ秒。期限切れと今日が締切が1件も無ければ null（送らない）。
 */
export function buildEvening(data, { now, appUrl = '', mentionUserId = '', doneLinks = true, windowDays = 7 }) {
  const { nowS, daysFromToday } = dayTools(now);
  const winS = nowS + windowDays * DAY_S;
  const doneLink = (id) => (doneLinks && appUrl && id ? `　[✅完了](<${appUrl}?done=${uriEncode(id)}>)` : '');
  const hhmm = (sec) => { const p = jstParts(sec * 1000); return `${pad2(p.h)}:${pad2(p.mi)}`; };

  // 朝の一覧と同じ対象（未完了で、締切が読める項目。開始日時だけ壊れているものは開始なしとして扱う）
  const rows = [];
  for (const it0 of items(data)) {
    if (truthy(it0.done) || !parsable(it0.due)) continue;
    const it = { ...it0 };
    if (it.start != null && !parsable(it.start)) delete it.start;
    const rep = alt(it.rep, 'none');
    const epoch = ep(it.due);
    // 繰り返しは「定期予定」で扱う。自動完了でなく締切が過ぎているものだけ、期限切れとして加える
    if (rep !== 'none' && (truthy(it.autoComplete) || epoch >= nowS)) continue;
    const refep = rep === 'none' ? ep(it.start ?? it.due) : epoch;
    if (refep > winS) continue;
    rows.push({ it, rep, epoch, refep });
  }
  rows.sort((a, b) => a.refep - b.refep);

  let lines = '';
  let total = 0;
  let autos = 0;
  const seen = new Set();
  const add = (line, it) => { lines += line; total++; if (truthy(it.autoComplete)) autos++; };
  for (const r of rows) {
    if (daysFromToday(r.epoch) > 0) continue;
    const id = clean(alt(r.it.id, ''));
    seen.add(id);
    const d = daysFromToday(r.epoch);
    let state;
    if (r.epoch < nowS) state = d === 0 ? '🔴 締切を過ぎました' : `🔴 ${-d} 日超過`;
    else if (alt(r.it.allDay, false) === true) state = '⚡ 今日中';
    else state = `⚡ 今日 ${hhmm(r.epoch)} まで`;
    add(`- ${r.rep !== 'none' ? '🔁 ' : ''}**${clean(alt(r.it.title, ''))}**　\`${clean(alt(r.it.cat, 'その他'))}\`　${state}${doneLink(id)}\n`, r.it);
  }

  // 繰り返しの予定は、次の回（今から先で最初の回）が今日のものを加える
  const repRows = [];
  for (const it of items(data)) {
    if (truthy(it.done) || !parsable(it.due) || alt(it.rep, 'none') === 'none') continue;
    const epoch = nextOcc(it, nowS);
    if (epoch !== null) repRows.push({ it, epoch });
  }
  repRows.sort((a, b) => a.epoch - b.epoch);
  for (const r of repRows) {
    if (daysFromToday(r.epoch) !== 0) continue;
    const id = clean(alt(r.it.id, ''));
    if (id && seen.has(id)) continue;
    const state = alt(r.it.allDay, false) === true ? '⚡ 今日中' : `⚡ 今日 ${hhmm(r.epoch)} まで`;
    add(`- 🔁 **${clean(alt(r.it.title, ''))}**　\`${clean(alt(r.it.cat, 'その他'))}\`　${state}${doneLink(id)}\n`, r.it);
  }
  if (total === 0) return null;

  const mention = mentionUserId ? `<@${mentionUserId}> \n` : '';
  let content = `${mention}# 🌙 まだ終わっていません（${count(total, autos)}）\n${lines}`;
  if (appUrl) content += `\n[アプリで完了にする](<${appUrl}>)`;
  return content;
}

// ---- 週次レビュー ----

/** 完了のタイミングの言い方 */
function leadText(c) {
  if (c.kind === 'auto') return '自動完了';
  if (c.lead < 0) {
    const x = -c.lead;
    return `締切を${x < 24 ? `${Math.floor(x)}時間` : `${Math.floor(x / 24)}日`}過ぎて`;
  }
  if (c.lead < 24) return `締切の${Math.floor(c.lead)}時間前`;
  return `締切の${Math.floor(c.lead / 24)}日前`;
}
function band(sec) {
  const h = jstParts(sec * 1000).h;
  if (h < 5) return '深夜（0〜5時）';
  if (h < 12) return '朝（5〜12時）';
  if (h < 18) return '昼（12〜18時）';
  return '夜（18〜24時）';
}
const mdhm = (sec) => { const p = jstParts(sec * 1000); return `${p.mo}/${p.d}（${DOW[jstDow(sec * 1000)]}） ${pad2(p.h)}:${pad2(p.mi)}`; };

/** 「この1週間の達成」の行。完了の記録（completions）が無い古いデータでは null */
function weekDone(data, nowS, stale) {
  if (!Array.isArray(data.completions)) return null;
  const all = data.completions
    .filter((c) => isObj(c) && typeof c.doneAt === 'string')
    .map((c) => ({ ...c, t: parsable(c.doneAt) ? ep(c.doneAt) : 0, lead: num(c.lead), kind: alt(c.kind, 'ontime'), exp: num(c.exp) }));
  const wall = all.filter((c) => c.t > nowS - 7 * DAY_S && c.t <= nowS).sort((a, b) => a.t - b.t);
  const w = wall.filter((c) => c.kind !== 'bonus');
  const clears = wall.length - w.length;
  const man = w.filter((c) => c.kind !== 'auto');
  const total = num(data.expCarry) + all.filter((c) => c.t <= nowS).reduce((s, c) => s + c.exp, 0);
  const gain = wall.reduce((s, c) => s + c.exp, 0);
  const lv = Math.floor(total / 100) + 1;
  const lv0 = Math.floor((total - gain) / 100) + 1;
  const kinds = (k) => w.filter((c) => c.kind === k).length;
  const out = [`- 完了：${w.length}件（前倒し ${kinds('early')}・期限内 ${kinds('ontime')}・遅れ ${kinds('late')}・自動 ${kinds('auto')}）`];
  if (man.length > 0) {
    const avg = man.reduce((s, c) => s + c.lead, 0) / man.length;
    out.push(`- 平均：${avg >= 0 ? `締切の${r1(avg / 24)}日前に完了` : `締切を${r1(-avg / 24)}日過ぎて完了`}`);
    const g = maxBy(groupBy(man, (c) => band(c.t)), (x) => x.length);
    out.push(`- 完了が多い時間帯：${band(g[0].t)}に${g.length}件`);
    const best = maxBy(man, (c) => c.lead);
    if (best.lead >= 24) out.push(`- 一番早く片付けた：「${clean(alt(best.title, ''))}」（${leadText(best)}）`);
  }
  const late = w.filter((c) => c.kind === 'late');
  if (late.length > 0) out.push(`- 遅れたもの：${late.slice(0, 3).map((c) => `「${clean(alt(c.title, ''))}」`).join('・')}`);
  if (clears > 0) out.push(`- 🌟 本日のクエスト全クリア：${clears}日`);
  out.push(`- 獲得EXP：+${gain}（Lv.${lv}・累計 ${total} EXP）${lv > lv0 ? `　🎉 Lv.${lv0} → Lv.${lv} にレベルアップ！` : ''}`);
  if (stale > 0) out.push(`- ⚠️ 7日以上の滞留：${stale}件`);
  if (w.length > 0) {
    out.push('\n### ✅ 完了したもの');
    for (const c of [...w].reverse().slice(0, 10)) out.push(`- ${mdhm(c.t)}　${clean(alt(c.title, ''))}　\`${clean(alt(c.cat, 'その他'))}\`　${leadText(c)}`);
    if (w.length > 10) out.push(`- ほか ${w.length - 10}件`);
  }
  return out.join('\n');
}

/** 「繰り返しの調子（直近4週）」の行。無ければ空の配列 */
function repStats(data, nowS) {
  if (!Array.isArray(data.completions)) return [];
  const titles = new Map();
  for (const it of items(data)) if (alt(it.rep, 'none') !== 'none' && it.id != null) titles.set(String(it.id), it.title);
  const rows = data.completions.filter((c) => isObj(c) && c.rep === true && typeof c.doneAt === 'string'
    && (parsable(c.doneAt) ? ep(c.doneAt) : 0) > nowS - 28 * DAY_S && c.kind !== 'bonus');
  const keyCmp = (a, b) => (typeof a === 'string' && typeof b === 'string' ? cmpStr(a, b) : (a === b ? 0 : a == null ? -1 : b == null ? 1 : String(a) < String(b) ? -1 : 1));
  return groupBy(rows, (c) => (c.itemId === undefined ? null : c.itemId), keyCmp).map((g) => {
    const n = g.length;
    const ok = g.filter((c) => c.kind === 'early' || c.kind === 'ontime').length;
    const late = g.filter((c) => c.kind === 'late').length;
    const auto = g.filter((c) => c.kind === 'auto').length;
    const leads = g.filter((c) => c.kind !== 'auto').map((c) => num(c.lead));
    const title = clean(alt(alt(g[0].itemId == null ? undefined : titles.get(String(g[0].itemId)), g[0].title), '?'));
    let text;
    if (auto === n) text = `自動 ${auto}`;
    else {
      text = `期限内 ${ok}/${n - auto}`;
      if (leads.length > 0) {
        const a = leads.reduce((s, x) => s + x, 0) / leads.length;
        text += `　平均 ${a >= 0 ? `締切の${r1(a / 24)}日前` : `締切を${r1(-a / 24)}日過ぎて`}`;
      }
      if (late > 0) text += `　⚠️ 遅れ${late}`;
    }
    return `- ${title}　${text}`;
  });
}

/** 負荷予報（来週・再来週）。自動完了の予定は数えない */
function loadForecast(data, s) {
  const to = s + 14 * DAY_S;
  const all = [];
  for (const it of items(data)) {
    if (truthy(it.done) || !parsable(it.due) || truthy(it.autoComplete)) continue;
    const c = alt(it.cat, 'その他');
    const occs = [];
    if (alt(it.rep, 'none') === 'none') occs.push(ep(it.due));
    else {
      const f = nextOcc(it, s);
      const p = { weekly: 7, biweekly: 14 }[it.rep] ?? null;
      if (f !== null) for (let k = 0; k < (p === null ? 1 : 3); k++) occs.push(f + (p === null ? 0 : k * p * DAY_S));
    }
    for (const o of occs) if (o >= s && o < to) all.push({ c, w: Math.floor((o - s) / (7 * DAY_S)) });
  }
  const md = (sec) => { const p = jstParts(sec * 1000); return `${p.mo}/${p.d}`; };
  return [0, 1].map((w) => {
    const x = all.filter((a) => a.w === w);
    const ws = s + w * 7 * DAY_S;
    const cats = groupBy(x, (a) => a.c).map((g) => ({ c: g[0].c, n: g.length })).sort((a, b) => b.n - a.n);
    return `- ${w === 0 ? '来週' : '再来週'} ${md(ws)}〜${md(ws + 6 * DAY_S)}：${x.length}件${x.length >= LOAD_WARN ? ' ⚠️' : ''}`
      + (cats.length > 0 ? `　${cats.map((c) => `${clean(c.c)} ${c.n}${c.n >= CAT_WARN ? ' ⚠️' : ''}`).join('・')}` : '');
  });
}

/** 月の最初の日曜（1〜7日）だけ出す、サブスクなどの月あたりの支出 */
function subscriptions(data) {
  const yen = (it) => {
    const m = /(?:¥|￥)\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円/.exec(typeof it.memo === 'string' ? it.memo : '');
    return m ? Number((m[1] ?? m[2]).replace(/,/g, '')) : null;
  };
  const factor = { monthly: 1, yearly: 1 / 12, weekly: 52 / 12, biweekly: 26 / 12 };
  const xs = items(data).filter((it) => !truthy(it.done) && alt(it.cat, '') === SUBSC_CAT)
    .map((it) => ({ t: clean(alt(it.title, '')), v: yen(it), rep: alt(it.rep, 'none') }));
  const ok = xs.filter((x) => x.v !== null && factor[x.rep] !== undefined).map((x) => ({ ...x, m: cround(x.v * factor[x.rep]) }));
  const no = xs.filter((x) => x.v === null).map((x) => x.t);
  const out = [];
  if (ok.length > 0) {
    const sum = ok.reduce((s, x) => s + x.m, 0);
    out.push(`- 月あたり 約${sum}円（年 約${sum * 12}円）`);
    for (const x of [...ok].sort((a, b) => b.m - a.m)) out.push(`  - ${x.t}：${x.m}円/月`);
  }
  if (no.length > 0) out.push(`-# 金額が未記入：${no.join('・')}（メモに ¥1,980 のように書くと集計されます）`);
  return out;
}

/**
 * 週次レビューの本文（2通分の配列）。now はミリ秒。
 * 1通目は来週の見通しとこの1週間の達成、2通目は繰り返しの調子・負荷予報・支出まとめ・リンク。
 */
export function buildWeekly(data, { now, appUrl = '' }) {
  const { nowS, todayStart } = dayTools(now);
  const all = items(data);
  const live = all.filter((it) => !truthy(it.done) && parsable(it.due));

  // 来週7日間（明日0時〜8日後0時）。繰り返しは次回の日付で拾う
  const ws = todayStart + DAY_S;
  const we = todayStart + 8 * DAY_S;
  const next7 = live
    .map((it) => ({ it, epoch: alt(it.rep, 'none') === 'none' ? ep(it.due) : nextOcc(it, ws) }))
    .filter((x) => x.epoch !== null && x.epoch >= ws && x.epoch < we)
    .sort((a, b) => a.epoch - b.epoch);
  let byDay = '';
  for (let off = 1; off <= 7; off++) {
    const sec = todayStart + off * DAY_S;
    const key = dateStr(sec * 1000);
    const p = jstParts(sec * 1000);
    let dayLines = '';
    for (const x of next7) {
      if (dateStr(x.epoch * 1000) !== key) continue;
      dayLines += `${alt(x.it.rep, 'none') !== 'none' ? '- 🔁' : '-'} ${clean(alt(x.it.title, ''))}　\`${clean(alt(x.it.cat, 'その他'))}\`\n`;
    }
    if (dayLines) byDay += `**${p.mo}/${p.d}（${DOW[jstDow(sec * 1000)]}）**\n${dayLines}\n`;
  }
  if (!byDay) byDay = '来週の締切はまだ登録されていません。\n';

  const doneCount = all.filter((it) => truthy(it.done) && truthy(it.doneAt)
    && (typeof it.doneAt === 'string' && parsable(it.doneAt) ? ep(it.doneAt) : 0) > nowS - 7 * DAY_S).length;
  // 7日以上の滞留（自動完了の繰り返しは、締切が過ぎても次回へ進むだけなので数えない）
  const stale = live.filter((it) => !(alt(it.rep, 'none') !== 'none' && truthy(it.autoComplete)) && ep(it.due) < nowS - 7 * DAY_S).length;

  const p = jstParts(now);
  let first = `# 📅 来週の見通し\n### ${p.mo}月${p.d}日（${DOW[jstDow(now)]}）の週次レビュー\n\n## 🗓️ 来週7日間\n${byDay}`;
  const done = weekDone(data, nowS, stale);
  if (done) first += `\n## 🏆 この1週間の達成\n${done}`;
  else {
    first += `\n## 📊 この1週間\n- 完了：${doneCount}件`;
    if (stale > 0) first += `\n- ⚠️ 7日以上の滞留：${stale}件`;
  }

  let extra = '';
  const reps = repStats(data, nowS);
  if (reps.length > 0) extra += `\n## 🔁 繰り返しの調子（直近4週）\n${reps.join('\n')}`;
  extra += `\n\n## 📈 負荷予報\n${loadForecast(data, ws).join('\n')}`;
  if (SUBSC_CAT && p.d <= 7) {
    const sub = subscriptions(data);
    if (sub.length > 0) extra += `\n\n## 💳 ${SUBSC_CAT}\n${sub.join('\n')}`;
  }
  if (appUrl) extra += `\n\n## 🔗 リンク\n- [アプリを開く](<${appUrl}>)`;
  return [first, `# 📈 先々の見通し\n\n${extra.replace(/^\n+/, '')}`];
}
