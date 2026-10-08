#!/usr/bin/env python3
"""data.json の中身を確かめる。エラーがあれば終了コード1。
GitHub Actions ではエラー/警告を注釈（::error:: / ::warning::）として出す。
使い方: python3 validate_data.py <data.json>"""
import json
import os
import re
import sys
from datetime import datetime, timezone

REPS = {"none", "weekly", "biweekly", "monthly", "yearly"}
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
GHA = os.environ.get("GITHUB_ACTIONS") == "true"


def parse_dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def main():
    path = sys.argv[1]
    errors, warns = [], []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        errors.append("読み込めません: %s" % e)
        data = {}

    if not isinstance(data, dict):
        errors.append("最上位がオブジェクトではありません")
        data = {}
    items = data.get("items")
    if not isinstance(items, list):
        errors.append("items が配列ではありません")
        items = []
    cats = {x for x in data["categories"] if isinstance(x, str)} if isinstance(data.get("categories"), list) else None

    seen = {}
    for n, it in enumerate(items):
        if not isinstance(it, dict):
            errors.append("items[%d] がオブジェクトではありません" % n)
            continue
        name = "「%s」(items[%d])" % (it.get("title") or it.get("id") or "?", n)
        iid = it.get("id")
        if not isinstance(iid, str) or not iid:
            errors.append(name + " id がありません")
        elif iid in seen:
            errors.append(name + " id が items[%d] と重複しています" % seen[iid])
        else:
            seen[iid] = n

        due = start = None
        try:
            due = parse_dt(it["due"])
        except (KeyError, TypeError, ValueError, AttributeError):
            errors.append(name + " due が日時として読めません: %r" % it.get("due"))
        if it.get("start"):
            try:
                start = parse_dt(it["start"])
            except (TypeError, ValueError, AttributeError):
                errors.append(name + " start が日時として読めません: %r" % it.get("start"))
        if due and start and start > due:
            errors.append(name + " start が due より後です")

        rep = it.get("rep", "none")
        if not isinstance(rep, str) or rep not in REPS:
            errors.append(name + " rep が不明な値です: %r" % rep)
        if it.get("done"):
            try:
                parse_dt(it["doneAt"])
            except (KeyError, TypeError, ValueError, AttributeError):
                errors.append(name + " 完了済みなのに doneAt が読めません")

        if not str(it.get("title") or "").strip():
            warns.append(name + " タイトルが空です")
        if cats is not None and isinstance(it.get("cat"), str) and it["cat"] and it["cat"] not in cats:
            warns.append(name + " カテゴリ「%s」が categories にありません" % it["cat"])
        for k in ("repCount", "seq"):
            if k in it and not is_int(it[k]):
                warns.append(name + " %s が整数ではありません: %r" % (k, it[k]))
        skip = it.get("skip")
        if skip is not None and (not isinstance(skip, list)
                                 or any(not (isinstance(s, str) and DAY.match(s)) for s in skip)):
            warns.append(name + " skip の形式が不正です: %r" % (skip,))

    cr = data.get("catReminders") if isinstance(data, dict) else None
    if cr is not None:
        if not isinstance(cr, dict):
            warns.append("catReminders がオブジェクトではありません")
        else:
            for k, v in cr.items():
                if not (isinstance(v, list) and all(is_int(x) and 0 <= x <= 60 for x in v)):
                    warns.append("catReminders「%s」が0〜60の整数の配列ではありません: %r" % (k, v))

    up = data.get("updatedAt") if isinstance(data, dict) else None
    if up:
        try:
            if (parse_dt(up) - datetime.now(timezone.utc)).total_seconds() > 600:
                warns.append("updatedAt が未来の日時です: %s（端末の時計がずれている可能性）" % up)
        except (TypeError, ValueError, AttributeError):
            warns.append("updatedAt が日時として読めません: %r" % up)

    for m in warns:
        print(("::warning file=%s::" % path if GHA else "警告: ") + m)
    for m in errors:
        print(("::error file=%s::" % path if GHA else "エラー: ") + m)
    print("項目 %d件 / エラー %d / 警告 %d" % (len(items), len(errors), len(warns)))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
