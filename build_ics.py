#!/usr/bin/env python3
"""data.json から未完了の締切をまとめた .ics を作る。

アプリ(index.html)の書き出しと同じ仕様に合わせてある:
  - 期間つきの予定は DTSTART〜DTEND、それ以外は締切の30分間
  - 繰り返しは RRULE。通知は毎回鳴るよう相対トリガーにする
  - 繰り返しでない予定の通知は絶対時刻(UTC)
  - 通知は「1週間前 / 前日 / 当日の指定時刻」の3件
使い方: python3 build_ics.py <data.json> <出力先.ics> [当日リマインドの時]
"""
import json
import sys
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))


def parse_dt(s):
    """ISO8601(末尾Z / ミリ秒つきも可)を datetime に変換する。"""
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def esc(s):
    """RFC5545 のテキスト用エスケープ。"""
    return (str(s).replace("\\", "\\\\").replace(";", "\\;")
            .replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n"))


def utc(dt):
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def fold(line):
    """1行75オクテット以内に折る。日本語があるのでバイト数で判定する。"""
    out, cur, n = [], "", 0
    for ch in line:
        b = len(ch.encode("utf-8"))
        if n + b > 72:
            out.append(cur)
            cur, n = "", 0
        cur += ch
        n += b
    out.append(cur)
    return "\r\n ".join(out)


def alarm_abs(trigger, label):
    return ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(label),
            "TRIGGER;VALUE=DATE-TIME:" + utc(trigger), "END:VALARM"]


def alarm_rel(minutes_before, label, related_end):
    rel = ";RELATED=END" if related_end else ""
    return ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(label),
            "TRIGGER%s:-PT%dM" % (rel, minutes_before), "END:VALARM"]


def vevent(it, day_hour):
    due = parse_dt(it["due"])
    start = parse_dt(it["start"]) if it.get("start") else None
    begin = start or due
    end = due if start else due + timedelta(minutes=30)

    lines = ["BEGIN:VEVENT",
             "UID:%s@deadline-tracker" % it.get("id", "x"),
             "DTSTAMP:" + utc(datetime.now(timezone.utc)),
             "SEQUENCE:%d" % it.get("seq", 0),
             "DTSTART:" + utc(begin),
             "DTEND:" + utc(end),
             "SUMMARY:" + esc(("" if start else "【締切】") + it.get("title", "")),
             "CATEGORIES:" + esc(it.get("cat") or "その他")]
    if it.get("memo"):
        lines.append("DESCRIPTION:" + esc(it["memo"]))

    rep = it.get("rep") or "none"
    repeating = rep != "none"
    if repeating:
        freq = {"weekly": "FREQ=WEEKLY",
                "biweekly": "FREQ=WEEKLY;INTERVAL=2",
                "monthly": "FREQ=MONTHLY"}.get(rep)
        if freq:
            count = it.get("repCount") or 0
            lines.append("RRULE:" + freq + (";COUNT=%d" % count if count > 0 else ""))

    title = it.get("title", "")
    if repeating:
        rel_end = start is not None
        lines += alarm_rel(7 * 24 * 60, title + "：あと1週間", rel_end)
        lines += alarm_rel(24 * 60, title + "：明日が締切", rel_end)
        due_jst = due.astimezone(JST)
        mins = (due_jst.hour - day_hour) * 60 + due_jst.minute
        if mins > 0:
            lines += alarm_rel(mins, title + "：今日が締切", rel_end)
    else:
        lines += alarm_abs(due - timedelta(days=7), title + "：あと1週間")
        lines += alarm_abs(due - timedelta(days=1), title + "：明日が締切")
        due_jst = due.astimezone(JST)
        day_of = due_jst.replace(hour=day_hour, minute=0, second=0, microsecond=0)
        if day_of < due_jst:
            lines += alarm_abs(day_of, title + "：今日が締切")

    lines.append("END:VEVENT")
    return lines


def main():
    data_path, out_path = sys.argv[1], sys.argv[2]
    day_hour = int(sys.argv[3]) if len(sys.argv) > 3 else 9

    with open(data_path, encoding="utf-8") as f:
        data = json.load(f)

    items = [i for i in data.get("items", []) if not i.get("done")]
    if not items:
        return 1  # 書き出すものが無い

    items.sort(key=lambda i: parse_dt(i["due"]))

    lines = ["BEGIN:VCALENDAR", "VERSION:2.0",
             "PRODID:-//deadline-tracker//JP", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH"]
    for it in items:
        lines += vevent(it, day_hour)
    lines.append("END:VCALENDAR")

    with open(out_path, "w", encoding="utf-8", newline="") as f:
        f.write("\r\n".join(fold(l) for l in lines) + "\r\n")
    print(len(items))
    return 0


if __name__ == "__main__":
    sys.exit(main())
