#!/usr/bin/env python3
"""feed.json の内容を、モーニングブリーフが Gmail から読めるよう自分宛てにメールで送る。

件名は「【締切トラッカー】M/D（曜）の締切」で固定し、ブリーフはこの件名で検索する。
対象日は実行時刻(JST)で決める：15時以降なら翌日分、それより前なら当日分。
（GitHub Actions の定期実行は数時間遅れることがあるため、前日の夜にも送っておく）

環境変数:
  GMAIL_ADDRESS       送信元＝宛先の Gmail アドレス（Secret）
  GMAIL_APP_PASSWORD  Google アカウントのアプリパスワード（Secret）
  TARGET              today / tomorrow / auto（既定 auto）
  DRY_RUN=1           送らずに本文を表示する
使い方: python3 send_feed_mail.py <feed.json>
"""
import json
import os
import smtplib
import sys
from datetime import date, datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid

JST = timezone(timedelta(hours=9))
DOW = "月火水木金土日"
SUBJECT_PREFIX = "【締切トラッカー】"


def jp(d):
    return "%d/%d（%s）" % (d.month, d.day, DOW[d.weekday()])


def line(e, today=None):
    due = date.fromisoformat(e["due_date"])
    when = jp(due) + (" " + e["due_time"] if e.get("due_time") else " 終日")
    if e.get("start_date"):
        st = date.fromisoformat(e["start_date"])
        when = jp(st) + (" " + e["start_time"] if e.get("start_time") else "") + " 〜 " + when
    mark = "🔁 " if e.get("recurring") else ""
    extra = ""
    if today and due < today:
        extra = "（%d日超過）" % (today - due).days
    elif today and due > today:
        extra = "（あと%d日）" % (due - today).days
    s = "- %s%s ［%s］ %s%s" % (mark, e["title"], e.get("category", ""), when, extra)
    if e.get("repeat"):
        s += " ／" + e["repeat"]
    if e.get("memo"):
        s += "\n    メモ: " + e["memo"].replace("\n", " ")
    return s


def build_body(feed, target):
    items = feed.get("items", [])
    over = [e for e in items if date.fromisoformat(e["due_date"]) < target]
    today = [e for e in items if date.fromisoformat(e["due_date"]) == target]
    during = [e for e in items if e.get("start_date")
              and date.fromisoformat(e["start_date"]) <= target < date.fromisoformat(e["due_date"])]
    soon = [e for e in items if target < date.fromisoformat(e["due_date"]) <= target + timedelta(days=7)
            and e not in during]

    out = ["%sの締切（締切トラッカーより自動送信）" % jp(target), ""]

    def section(title, rows, empty):
        out.append("■ %s（%d件）" % (title, len(rows)))
        out.extend(line(e, target) for e in rows) if rows else out.append("- " + empty)
        out.append("")

    section("今日が締切", today, "なし")
    section("期限切れ", over, "なし")
    section("期間中", during, "なし")
    section("今後7日間の締切", soon, "なし")
    out.append("-- ")
    out.append("この日付: %s ／ データ更新: %s" % (target.isoformat(), feed.get("source_updated_at") or "不明"))
    out.append("このメールは deadline-data の GitHub Actions が自動で送っています。返信不要です。")
    return "\n".join(out)


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        feed = json.load(f)

    now = datetime.now(JST)
    mode = os.environ.get("TARGET", "auto")
    if mode == "tomorrow" or (mode == "auto" and now.hour >= 15):
        target = now.date() + timedelta(days=1)
    else:
        target = now.date()

    subject = "%s%sの締切" % (SUBJECT_PREFIX, jp(target))
    body = build_body(feed, target)

    if os.environ.get("DRY_RUN") == "1":
        print("件名:", subject)
        print(body)
        return 0

    addr = os.environ.get("GMAIL_ADDRESS", "").strip()
    pw = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not addr or not pw:
        print("GMAIL_ADDRESS / GMAIL_APP_PASSWORD の Secret が未設定のため、メールは送りません。", file=sys.stderr)
        return 0  # 未設定でもワークフロー全体は失敗扱いにしない

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = addr
    msg["To"] = addr
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain="deadline-tracker")
    with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as s:
        s.starttls()
        s.login(addr, pw)
        s.send_message(msg)
    print("送信しました:", subject)
    return 0


if __name__ == "__main__":
    sys.exit(main())
