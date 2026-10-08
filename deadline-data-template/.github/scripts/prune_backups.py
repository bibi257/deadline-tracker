#!/usr/bin/env python3
"""backups/ の古いバックアップを間引く。使い方: python3 prune_backups.py <dir> [--dry-run]"""
import os, re, sys
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))
PAT = re.compile(r"^data-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.json$")


def main():
    d = sys.argv[1]
    dry = "--dry-run" in sys.argv
    now = datetime.now(JST)
    files = []
    for name in os.listdir(d):
        m = PAT.match(name)
        if m:
            y, mo, da, h, mi = map(int, m.groups())
            files.append((datetime(y, mo, da, h, mi, tzinfo=JST), name))
    files.sort(reverse=True)  # 新しい順。各区分で最初に見たものを残す

    keep, seen = set(), set()
    for t, name in files:
        age = (now - t).days
        if age <= 14:
            key = ("all", name)
        elif age <= 90:
            key = ("week",) + tuple(t.isocalendar()[:2])
        else:
            key = ("month", t.year, t.month)
        if key not in seen:
            seen.add(key)
            keep.add(name)

    drop = [n for _, n in files if n not in keep]
    for n in drop:
        print(("消す予定: " if dry else "消しました: ") + n)
        if not dry:
            os.remove(os.path.join(d, n))
    print("残す: %d / 消す: %d" % (len(keep), len(drop)))


if __name__ == "__main__":
    main()
