#!/usr/bin/env python3
"""data.json から、モーニングブリーフが読む feed.json を作る（非公開リポジトリ内で完結）。

ブリーフ側が「今日」を自分で判断できるよう、状態（今日/超過など）は書かず、
絶対日付だけを並べる。GitHub Actions の実行が遅れて前日の生成物を読んでも、
日付で絞れば正しく「今日の締切」を拾える。

  - 未完了の締切（繰り返しなし）: 期限切れも含めて、範囲の終わりまでのものすべて
  - 繰り返し: 範囲内の各回を展開する（取りやめた回は除き、月末は基準日で丸める）
    自動完了でない回が締切を過ぎたまま残っていれば、その回も1件として出す
使い方: python3 build_feed.py <data.json> <出力先 feed.json> [先の日数(既定14)]
"""
import calendar
import json
import sys
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))
REP_LABEL = {"weekly": "毎週", "biweekly": "隔週", "monthly": "毎月", "yearly": "毎年"}


def parse_dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(JST)


def add_rep(base, rep, n, anchor):
    """base を n 回分進める。月・年単位は基準日 anchor を保ち、無い日は月末に丸める（アプリと同じ）。"""
    if rep == "weekly":
        return base + timedelta(days=7 * n)
    if rep == "biweekly":
        return base + timedelta(days=14 * n)
    months = n if rep == "monthly" else 12 * n
    m0 = base.month - 1 + months
    y, m = base.year + m0 // 12, m0 % 12 + 1
    day = min(anchor or base.day, calendar.monthrange(y, m)[1])
    return base.replace(year=y, month=m, day=day)


def entry(it, due, start=None):
    all_day = bool(it.get("allDay"))
    e = {
        "title": it.get("title", ""),
        "due_date": due.strftime("%Y-%m-%d"),
        "due_time": None if all_day else due.strftime("%H:%M"),
        "category": it.get("cat") or "その他",
        "recurring": (it.get("rep") or "none") != "none",
    }
    if e["recurring"]:
        e["repeat"] = REP_LABEL.get(it["rep"], it["rep"])
    if start:
        e["start_date"] = start.strftime("%Y-%m-%d")
        e["start_time"] = None if all_day else start.strftime("%H:%M")
    if it.get("memo"):
        e["memo"] = it["memo"]
    return e


def expand(it, frm, to, now):
    """繰り返しの各回のうち、締切日が frm〜to に入るものを返す。"""
    rep = it.get("rep") or "none"
    base = parse_dt(it["due"])
    span = base - parse_dt(it["start"]) if it.get("start") else None
    skip = set(k for k in (it.get("skip") or []) if isinstance(k, str))
    anchor = it.get("repDay")
    limit = it.get("repCount") or 0
    out = []
    # 自動完了でない回が締切を過ぎて残っている＝完了にし忘れ。超過として1件出す
    if base < now and not it.get("autoComplete") and base.date() < frm:
        out.append(entry(it, base, base - span if span else None))
    for n in range(0, 2000):
        if limit and n >= limit:
            break
        d = add_rep(base, rep, n, anchor)
        if d.date() > to:
            break
        if d.date() < frm or d.strftime("%Y-%m-%d") in skip:
            continue
        if it.get("autoComplete") and d < now:
            continue  # 自動完了の回は締切を過ぎるとアプリが完了にする（期限切れとして出さない）
        out.append(entry(it, d, d - span if span else None))
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    days = int(sys.argv[3]) if len(sys.argv) > 3 else 14
    with open(src, encoding="utf-8") as f:
        data = json.load(f)

    now = datetime.now(JST)
    frm = now.date()
    to = frm + timedelta(days=days)
    items = []
    for it in data.get("items", []):
        if it.get("done") or not it.get("title"):
            continue
        try:
            due = parse_dt(it["due"])
        except (KeyError, TypeError, ValueError, AttributeError):
            print("締切日時が読めないため除外: %s" % it.get("title"), file=sys.stderr)
            continue
        try:
            start = parse_dt(it["start"]) if it.get("start") else None
        except (TypeError, ValueError, AttributeError):
            # 開始だけが壊れているときは、開始なし（締切だけの予定）として扱う
            print("開始日時が読めないため締切のみで出力: %s" % it.get("title"), file=sys.stderr)
            it = dict(it)
            del it["start"]
            start = None
        if (it.get("rep") or "none") != "none":
            items += expand(it, frm, to, now)
        elif due.date() <= to or (start and start.date() <= to):
            # 期間つきは、範囲内に始まる・進行中のものも出す
            items.append(entry(it, due, start))

    items.sort(key=lambda e: (e["due_date"], e["due_time"] or "99:99", e["title"]))
    feed = {
        "description": "締切トラッカーの未完了の締切一覧（日付はJST）。"
                       "due_date が今日のものが『今日が締切』、今日より前のものは期限切れ。"
                       "start_date がある項目は期間つきの予定（start_date〜due_date）。",
        "timezone": "Asia/Tokyo",
        "generated_on": frm.strftime("%Y-%m-%d"),
        "range_end": to.strftime("%Y-%m-%d"),
        "source_updated_at": data.get("updatedAt"),
        "items": items,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(feed, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(len(items))


if __name__ == "__main__":
    main()
