// 締切トラッカー：AI の使用量ウィジェット（Scriptable 用）
const DAY = 86400000;
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const COLORS = {
  bg: Color.dynamic(new Color('#fbf7ee'), new Color('#1c1c1e')),
  text: Color.dynamic(new Color('#3a3a3a'), new Color('#e5e5e7')),
  sub: Color.dynamic(new Color('#8a8a8a'), new Color('#98989f')),
  track: Color.dynamic(new Color('#e6e0d2'), new Color('#3a3a3c')),
  fill: Color.dynamic(new Color('#2f7d5b'), new Color('#4fb38a')),
  warning: Color.dynamic(new Color('#d83a3a'), new Color('#ff6b6b')),
};
const pad = (n) => String(n).padStart(2, '0');
// 端末のタイムゾーン設定に左右されないよう、表示用の日付は JST にそろえる
const jst = (value) => new Date(new Date(value).getTime() + 9 * 3600000);
function fmtDate(value) {
  const d = jst(value);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]}) ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function dayDiff(value, now) {
  const target = jst(value); const today = jst(now);
  return Math.round((Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / DAY);
}
function ageHours(value, now) { return (now.getTime() - Date.parse(value)) / 3600000; }
function message(text) {
  const w = new ListWidget(); w.backgroundColor = COLORS.bg;
  const t = w.addText(text); t.font = Font.systemFont(13); t.textColor = COLORS.sub;
  return w;
}
function rowText(row, text, color, size = 10) {
  const t = row.addText(text); t.font = Font.systemFont(size); t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.7; return t;
}
function render(usage, family, now, base, offline = false, warning = '', limited = false) {
  const w = new ListWidget(); w.backgroundColor = COLORS.bg; w.setPadding(8, 12, 8, 12);
  const small = family === 'small';
  if (!small) { const h = w.addText('AI の使用量'); h.font = Font.boldSystemFont(13); h.textColor = COLORS.text; w.addSpacer(5); }
  const services = [
    ['Codex', usage.codex, 'quota'], ['Muse', usage.muse, 'quota'], ['Claude Code', usage.claudeCode, 'claude'],
  ];
  for (const [name, item, type] of services) {
    if (!item) {
      if (small) { rowText(w.addStack(), `${name === 'Claude Code' ? 'Claude' : name} 未取得`, COLORS.sub, 10); }
      else { const top = w.addStack(); top.centerAlignContent(); const label = top.addStack(); label.size = new Size(84, 0); rowText(label, name, COLORS.sub, 11); top.addSpacer(); rowText(top, '未取得', COLORS.sub, 11); w.addSpacer(1); rowText(w.addStack(), 'まだ届いていません', COLORS.sub, 10); w.addSpacer(4); }
      continue;
    }
    const stale = ageHours(item.measuredAt, now) > 36;
    let value, warn = false, expired = false, resetPast = false;
    if (type === 'claude') {
      const days = dayDiff(item.loginExpiresAt, now);
      expired = Date.parse(item.loginExpiresAt) <= now.getTime(); warn = !expired && days <= 7;
      value = expired ? '期限切れ' : days === 0 ? '今日まで' : `あと${days}日`;
    } else {
      resetPast = Date.parse(item.resetsAt) < now.getTime();
      warn = !resetPast && item.usedPercent >= 85; value = `${item.usedPercent}%`;
    }
    const valueColor = expired || warn ? COLORS.warning : resetPast ? COLORS.sub : COLORS.text;
    if (small) {
      const r = w.addStack(); r.centerAlignContent();
      const t = r.addText(`${warn || expired ? '⚠ ' : ''}${name === 'Claude Code' ? 'Claude' : name} ${value}${stale ? ' 古' : ''}`); t.font = Font.boldSystemFont(12); t.textColor = valueColor; t.lineLimit = 1;
      continue;
    }
    const top = w.addStack(); top.centerAlignContent();
    const label = top.addStack(); label.size = new Size(84, 0);
    const nt = label.addText(name); nt.font = Font.systemFont(11); nt.textColor = COLORS.text; nt.lineLimit = 1;
    if (type !== 'claude' && !resetPast) {
      const barW = 150;
      const outer = top.addStack(); outer.size = new Size(barW, 6); outer.cornerRadius = 3; outer.backgroundColor = COLORS.track;
      if (item.usedPercent > 0) { const fill = outer.addStack(); fill.size = new Size(Math.max(2, Math.round(barW * item.usedPercent / 100)), 6); fill.cornerRadius = 3; fill.backgroundColor = warn ? COLORS.warning : COLORS.fill; outer.addSpacer(); }
      top.addSpacer(6);
    } else top.addSpacer();
    const num = top.addText(value); num.font = Font.boldSystemFont(15); num.textColor = valueColor; num.rightAlignText(); num.lineLimit = 1; num.minimumScaleFactor = 0.7;
    w.addSpacer(1);
    let detail;
    if (expired) detail = 'claude で再ログイン';
    else if (resetPast) detail = 'リセット済み（次の更新待ち）';
    else if (type === 'claude') detail = `${warn ? '⚠ 期限間近 · ' : ''}ログイン期限 ${fmtDate(item.loginExpiresAt)}`;
    else {
      detail = `${warn ? '⚠ 残りわずか · ' : ''}${fmtDate(item.resetsAt)} リセット`;
      if (family === 'large') {
        const days = dayDiff(item.resetsAt, now); if (days > 0) detail += `（あと${days}日）`;
        if (name === 'Codex' && item.windowDays !== undefined) detail += ` · ${item.windowDays}日枠`;
        if (name === 'Muse' && item.extraInUse !== undefined) detail += item.extraInUse ? ' · 追加分 使用中' : ' · 追加分 未使用';
      }
    }
    if (stale) detail += '（古い）';
    rowText(w.addStack(), detail, COLORS.sub, 10);
    w.addSpacer(4);
  }
  if (warning) { const t = w.addText(warning); t.font = Font.systemFont(9); t.textColor = COLORS.warning; }
  const updated = jst(usage.updatedAt);
  const old = ageHours(usage.updatedAt, now) > 36;
  const dateText = `${updated.getUTCMonth() + 1}/${updated.getUTCDate()} ${pad(updated.getUTCHours())}:${pad(updated.getUTCMinutes())}`;
  const footerText = small ? `${old ? '⚠ ' : ''}${dateText}` : `${old ? '⚠ 古い · ' : '更新 '}${dateText}${limited ? '・制限中' : offline ? '・オフライン' : ''}`;
  const f = w.addText(footerText);
  f.font = Font.systemFont(9); f.textColor = old ? COLORS.warning : COLORS.sub;
  w.refreshAfterDate = new Date(now.getTime() + 60 * 60000);
  if (base) w.url = base;
  return w;
}
async function build() {
  const family = config.widgetFamily || 'medium';
  const base = (args.widgetParameter || '').trim().replace(/\/+$/, '');
  let token = Keychain.contains('deadline-usage-token') ? Keychain.get('deadline-usage-token') : '';
  if (!config.runsInWidget) {
    if (!token) {
      const alert = new Alert(); alert.title = '使用量ウィジェット'; alert.addSecureTextField('使用量のトークン', '');
      alert.addAction('保存'); alert.addCancelAction('キャンセル');
      if (await alert.present() === 0) { const entered = alert.textFieldValue(0).trim(); if (entered) { token = entered; Keychain.set('deadline-usage-token', token); } }
      if (!token) return message('使用量のトークンを入れてください');
    } else {
      const alert = new Alert(); alert.title = '使用量ウィジェット'; alert.addAction('表示する'); alert.addAction('トークンを入れ直す'); alert.addCancelAction('キャンセル');
      if (await alert.present() === 1) {
        const change = new Alert(); change.title = '使用量のトークン'; change.addSecureTextField('使用量のトークン', ''); change.addAction('保存'); change.addCancelAction('キャンセル');
        if (await change.present() === 0) { const entered = change.textFieldValue(0).trim(); if (entered) { token = entered; Keychain.set('deadline-usage-token', token); } }
      }
    }
  }
  if (!token) return message('Scriptable アプリでこのスクリプトを一度開いて、トークンを入れてください');
  if (!base) return message('ウィジェットのパラメータにアプリの URL を入れてください');
  const fm = FileManager.local(); const cachePath = fm.joinPath(fm.documentsDirectory(), 'deadline-usage-cache.json');
  const now = new Date(); let cached = null;
  if (fm.fileExists(cachePath)) { try { cached = JSON.parse(fm.readString(cachePath)); } catch (_) {} }
  try {
    const req = new Request(`${base}/api/usage`); req.method = 'GET'; req.headers = { Authorization: `Bearer ${token}` }; req.timeoutInterval = 10;
    const raw = await req.loadString(); const status = req.response.statusCode;
    if (status === 401) return cached && cached.usage ? render(cached.usage, family, now, base, false, 'トークンが違います。Scriptable で開いて入れ直してください') : message('トークンが違います。Scriptable で開いて入れ直してください');
    if (status === 503) { let body; try { body = JSON.parse(raw); } catch (_) {} return message(body && body.error ? body.error : '取得できませんでした'); }
    if (status === 429) return cached && cached.usage ? render(cached.usage, family, now, base, false, '', true) : message('取得できませんでした');
    if (status >= 500) return cached && cached.usage ? render(cached.usage, family, now, base, true) : message('取得できませんでした');
    if (status !== 200) return message(`取得できませんでした（HTTP ${status}）`);
    const body = JSON.parse(raw);
    if (!body.usage) return message('まだデータがありません（毎朝 8:46 ごろ更新）');
    if (body.usage.v !== 1) return message('ウィジェットを更新してください');
    fm.writeString(cachePath, raw || JSON.stringify(body));
    return render(body.usage, family, now, base);
  } catch (_) {
    return cached && cached.usage ? render(cached.usage, family, now, base, true) : message('取得できませんでした');
  }
}
const widget = await build();
if (config.runsInWidget) Script.setWidget(widget); else await widget.presentMedium();
Script.complete();
