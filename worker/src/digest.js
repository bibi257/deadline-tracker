// Discord に送る締切一覧の文面を作る。deadline-data の send_digest.sh（bash + jq）と同じ規則・同じ文面。
//
//   - 期限切れ・今日が締切・N日以内・定期予定（次回）・それ以降の予定を、近い順に並べる
//   - 期限切れ・今日が締切の行に「✅完了」リンク（アプリURL?done=ID）を付ける
//   - 2000文字を超えるときは「## 」の見出し単位で分けて、何通かに送る
//   - 返信ではなく本文のメンションだけを許可する（allowed_mentions）
//
// jq の関数（ep・add_rep・next_occ）は、秒単位の整数で計算する。次回の計算は send_digest.sh の next_occ に合わせてある
// （feed の expand とは、取りやめた回・回数の数え方が少し違う）。
import { addRep } from './recurrence.js';
import { dateStr, diffDays, isObj, jstDow, jstParts } from './time.js';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const REP_LABEL = { weekly: '毎週', biweekly: '隔週', monthly: '毎月', yearly: '毎年' };
const LIMIT = 1850; // Discord の本文上限(2000)に、余裕を持たせた値
const LATER_MAX = 10;

/** jq の「a // b」（null・false のときだけ代わりの値） */
const alt = (v, d) => (v === null || v === undefined || v === false ? d : v);
/** 1行1件で扱うため、改行と区切り文字を空白にする */
const clean = (v) => String(v).replace(/[\n\r\u001f]/g, ' ');
const pad2 = (n) => String(n).padStart(2, '0');

/** 締切日時として読めるか（jq の fromdateiso8601 と同じく、末尾 Z の形だけ） */
const parsable = (s) => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s));
/** ISO8601 を epoch 秒に（ミリ秒は捨てる） */
const ep = (s) => Math.floor(Date.parse(s.replace(/\.\d+Z$/, 'Z')) / 1000);

/** 繰り返しを n 回分進める（epoch 秒）。weekly / biweekly / monthly / yearly 以外は動かさない（jq の add_rep と同じ） */
function addRepSec(sec, rep, n, anchor) {
  if (n === 0) return sec;
  if (!REP_LABEL[rep]) return sec;
  return addRep(sec * 1000, rep, n, anchor) / 1000;
}

/** 基準時刻 t 以降で最初の回。取りやめた回(skip)は飛ばす。無ければ null（send_digest.sh の next_occ） */
function nextOcc(it, t) {
  const base = ep(it.due);
  const rep = alt(it.rep, 'none');
  const skip = Array.isArray(it.skip) ? it.skip : [];
  const anchor = alt(it.repDay, null);
  const lim0 = Number(alt(it.repCount, 0));
  // repCount は「今の回を含めた残り回数」（アプリが回を進めるたびに減らす）。0 は無期限
  const lim = Number.isFinite(lim0) ? lim0 : 0;
  const max = lim > 0 ? lim : 1100;
  for (let n = 0; n < max; n++) {
    const o = addRepSec(base, rep, n, anchor);
    if (o >= t && !skip.includes(dateStr(o * 1000))) return o;
  }
  return null;
}

/** jq の @uri と同じ（英数字と -_.~ 以外をパーセント表記にする） */
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * 締切一覧の本文を作る。now はミリ秒。
 * 読めない締切は除き、その旨を warnings に入れて返す（send_digest.sh は標準エラーに出していたもの）。
 */
export function buildDigest(data, { now, windowDays = 7, appUrl = '', mentionUserId = '', doneLinks = true }) {
  const nowS = Math.floor(now / 1000);
  const winS = nowS + windowDays * 86400;
  const daysFromToday = (sec) => diffDays(dateStr(sec * 1000), dateStr(nowS * 1000));
  const warnings = [];

  const fmtWhen = (ms, allDay) => {
    const p = jstParts(ms);
    const md = `${p.mo}/${p.d}（${DOW[jstDow(ms)]}）`;
    return allDay ? md : `${md} ${pad2(p.h)}:${pad2(p.mi)}`;
  };
  const doneLink = (id) => (doneLinks && appUrl && id ? `　[✅完了](<${appUrl}?done=${uriEncode(id)}>)` : '');
  const remain = (refS, dueS, hasStart) => {
    const diff = daysFromToday(refS);
    if (dueS < nowS) {
      const od = -daysFromToday(dueS);
      return od === 0 ? '期限切れ' : `${od} 日 超過`;
    }
    if (diff < 0) return '進行中';
    if (diff === 0) return hasStart && daysFromToday(dueS) !== 0 ? '今日から開始' : '今日';
    return hasStart ? `${diff} 日後に開始` : `${diff} 日後`;
  };

  // 未完了で、締切の日時が読める項目。開始日時だけが壊れているものは、開始なしとして扱う
  const items = [];
  const broken = [];
  for (const it0 of Array.isArray(data.items) ? data.items : []) {
    if (!isObj(it0) || alt(it0.done, false)) continue;
    if (!parsable(it0.due)) {
      broken.push(clean(alt(alt(it0.title, it0.id), '?')));
      continue;
    }
    const it = { ...it0 };
    // start が文字列でない・読めないものは、開始なしとして扱う（壊れた値で ep() が落ちないように）
    if (it.start != null && !parsable(it.start)) delete it.start;
    items.push(it);
  }
  if (broken.length) warnings.push(`締切日時が読めない項目を除外しました: ${broken.join('、')}`);

  const rows = items.map((it) => ({
    it, rep: alt(it.rep, 'none'), epoch: ep(it.due), startS: it.start ? ep(it.start) : null,
  }));
  const base = (r) => ({
    epoch: r.epoch,
    title: clean(alt(r.it.title, '')),
    cat: clean(alt(r.it.cat, 'その他')),
    due: r.it.due,
    start: typeof r.it.start === 'string' ? r.it.start : '',
    allDay: alt(r.it.allDay, false) === true,
    id: clean(alt(r.it.id, '')),
  });

  // 未完了かつ「期限切れ」または「N日以内」。繰り返しは「定期予定」で扱うが、自動完了でなく締切が過ぎていれば「期限切れ」にも入れる
  const main = rows
    .filter((r) => r.rep === 'none' || (!alt(r.it.autoComplete, false) && r.epoch < nowS))
    .map((r) => ({ ...base(r), rep: r.rep, refep: r.rep === 'none' ? (r.startS ?? r.epoch) : r.epoch }))
    .filter((r) => r.refep <= winS)
    .sort((a, b) => a.refep - b.refep);

  // 定期予定。次回（今から先で最初の回）が近い順。期間の指定に関わらず全件出す
  const repRows = rows
    .filter((r) => r.rep !== 'none')
    .map((r) => ({ ...base(r), rep: r.rep, epoch: nextOcc(r.it, nowS) }))
    .filter((r) => r.epoch !== null) // 回数を使い切った繰り返しは出さない
    .sort((a, b) => a.epoch - b.epoch);

  // それ以降の予定。繰り返しでない未完了のうち、対象の日数より先のもの（期間つきは開始日が先のもの）。近い順
  const laterRows = rows
    .filter((r) => r.rep === 'none')
    .map((r) => ({ ...base(r), refep: r.startS ?? r.epoch }))
    .filter((r) => r.refep > winS)
    .sort((a, b) => a.refep - b.refep);

  // 定期予定
  let repLines = '';
  for (const r of repRows) {
    const rdiff = daysFromToday(r.epoch);
    repLines += `- **${r.title}**　\`${r.cat}\`　${REP_LABEL[r.rep] ?? r.rep}\n`
      + `  次は ${fmtWhen(r.epoch * 1000, r.allDay)}　── ${rdiff === 0 ? '今日' : `${rdiff} 日後`}\n`;
  }
  const repSection = repLines ? `\n## 🔁 定期予定\n${repLines}` : '';

  // 対象の日数より先の予定。多い日は近い順に LATER_MAX 件まで
  let laterLines = '';
  laterRows.slice(0, LATER_MAX).forEach((r) => {
    let jdate = fmtWhen(Date.parse(r.due), r.allDay);
    if (r.start) {
      const sdate = fmtWhen(Date.parse(r.start), r.allDay);
      if (sdate !== jdate) jdate = `${sdate} 〜 ${jdate}`;
    }
    laterLines += `- **${r.title}**　\`${r.cat}\`\n  ${jdate}　── ${remain(r.refep, r.epoch, r.start)}\n`;
  });
  let laterSection = '';
  if (laterLines) {
    laterSection = `\n## 🗓️ それ以降の予定（${laterRows.length}件）\n${laterLines}`;
    if (laterRows.length > LATER_MAX) laterSection += `-# ほか ${laterRows.length - LATER_MAX} 件\n`;
  }

  const todayJst = `${jstParts(nowS * 1000).mo}月${jstParts(nowS * 1000).d}日（${DOW[jstDow(nowS * 1000)]}）`;
  // リンクは <> で囲む（囲まないと Discord がリンク先のプレビューカードを表示する）
  const linkSection = appUrl
    ? `\n## 🔗 リンク\n- [アプリを開く](<${appUrl}>)\n- [カレンダーに入れる](<${appUrl}?export=all>)\n`
    : '';

  if (!main.length) {
    return {
      content: `# 📋 締切トラッカー\n### ${todayJst}の連絡\n\n## ⏳ ${windowDays}日以内の締切\n-# 予定はありません\n${repSection}${laterSection}${linkSection}`,
      warnings,
    };
  }

  let overLines = '';
  let staleLines = '';
  let todayLines = '';
  let soonLines = '';
  let overdue = 0;
  let stale = 0;
  let todayCount = 0;
  let soon = 0;
  for (const r of main) {
    let jdate = fmtWhen(Date.parse(r.due), r.allDay);
    if (r.start) {
      const sdate = fmtWhen(Date.parse(r.start), r.allDay);
      // 終日で開始日と締切日が同じなら1つだけ出す
      if (sdate !== jdate) jdate = `${sdate} 〜 ${jdate}`;
    }
    const rem = remain(r.refep, r.epoch, r.start);
    const mark = r.rep !== 'none' ? '🔁 ' : '';
    // 期限切れ・今日が締切の行だけ、完了リンクを付ける（文字数の上限があるため）
    const link = daysFromToday(r.epoch) <= 0 ? doneLink(r.id) : '';
    const entry = `- ${mark}**${r.title}**　\`${r.cat}\`${link}\n  ${jdate}　── ${rem}\n`;
    if (r.epoch < nowS) {
      overLines += entry;
      overdue++;
      // 7日以上放置されているものは別途警告する
      const elapsed = -daysFromToday(r.epoch);
      if (elapsed >= 7) {
        stale++;
        if (stale <= 3) staleLines += `- ${mark}**${r.title}**　\`${r.cat}\`\n  ${fmtWhen(Date.parse(r.due), r.allDay)} 締切 ── ${elapsed}日経過\n`;
      }
    } else if (daysFromToday(r.epoch) === 0) {
      // 「今日が締切」は締切日で判断する（期間つきで今日始まり・後日締切のものは入れない）
      todayLines += entry;
      todayCount++;
    } else {
      soonLines += entry;
      soon++;
    }
  }

  const mention = mentionUserId ? `<@${mentionUserId}> \n` : '';
  let content = `${mention}# 📋 締切トラッカー\n### ${todayJst}の連絡\n`;
  if (stale > 0) {
    content += `\n## ⚠️ 長く残っています（${stale}件）\n${staleLines}`;
    if (stale > 3) content += `-# ほか ${stale - 3} 件\n`;
    content += '-# 完了か削除をおすすめします\n';
  }
  if (overdue > 0) content += `\n## 🔴 期限切れ（${overdue}件）\n${overLines}`;
  if (todayCount > 0) content += `\n## ⚡ 今日が締切（${todayCount}件）\n${todayLines}`;
  content += `\n## ⏳ ${windowDays}日以内の締切`;
  content += soon > 0 ? `（${soon}件）\n${soonLines}` : '\n-# 予定はありません\n';
  content += `${repSection}${laterSection}${linkSection}`;
  return { content, warnings };
}

/**
 * Discord の本文上限(2000文字)を超えないよう、見出し("## ")の区切りで分ける。
 * 見出し1つだけで上限を超えるときは、その見出しの末尾を切り詰める。文字数はコードポイントで数える（jq と同じ）。
 */
export function splitForDiscord(text, limit = LIMIT) {
  const len = (s) => Array.from(s).length;
  const parts = text.split('\n## ');
  const pieces = [parts[0], ...parts.slice(1).map((p) => `## ${p}`)];
  const chunks = [];
  for (const s of pieces) {
    if (chunks.length > 0 && len(chunks[chunks.length - 1]) + 1 + len(s) <= limit) chunks[chunks.length - 1] += `\n${s}`;
    else chunks.push(s);
  }
  return chunks
    .map((c) => c.replace(/^\n+/, '').replace(/\n+$/, ''))
    .map((c) => (len(c) > limit
      ? `${Array.from(c).slice(0, limit).join('')}\n\n…（件数が多いため省略しました。詳しくはアプリでご確認ください）`
      : c));
}

/**
 * Discord の Webhook に送る本文。メンションは指定ユーザーだけ許可する。
 * ユーザーID が空でも allowed_mentions は必ず付ける（付けないと、タイトルの @everyone・@here が本当に全員へ通知される）
 */
export function discordBodies(content, mentionUserId = '') {
  return splitForDiscord(content).map((c) => ({
    content: c,
    allowed_mentions: { parse: [], users: mentionUserId ? [mentionUserId] : [] },
  }));
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Webhook に順番に送る。一時的なエラー（429・5xx・通信エラー）は数回やり直す。
 * エラー文に Webhook の URL を含めない。
 */
export async function postDiscord(url, bodies, { fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 3 } = {}) {
  for (const body of bodies) {
    let last = '通信エラー';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(2000);
      let res;
      try {
        res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } catch {
        last = '通信エラー';
        continue;
      }
      if (res.ok) {
        last = null;
        break;
      }
      last = `HTTP ${res.status}`;
      if (!RETRY_STATUS.has(res.status)) break;
    }
    if (last !== null) throw new Error(`Discord への送信に失敗しました（${last}）`);
  }
  return bodies.length;
}
