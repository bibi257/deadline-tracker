#!/usr/bin/env python3
"""メール送信が Gmail サーバーの証明書を検証しているか確かめる（送信はしない）。
smtplib は context を渡さないと証明書を検証しない（ssl._create_stdlib_context）ため、
送信する2つのスクリプトとも、検証つきの context を STARTTLS(587) と SSL(465) の両方に渡す必要がある。"""
import importlib.util
import os
import smtplib
import ssl
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", ".github", "scripts")


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeSMTP:
    contexts = []

    def __init__(self, *a, **kw):
        if "context" in kw:
            FakeSMTP.contexts.append(kw["context"])

    def starttls(self, *a, **kw):
        FakeSMTP.contexts.append(kw.get("context"))

    def close(self):
        pass


def main():
    bad = 0
    smtplib.SMTP = smtplib.SMTP_SSL = FakeSMTP
    for name in ("send_feed_mail", "send_merge_mail"):
        mod = load(name)
        for label, factory in (("587/STARTTLS", mod._starttls), ("465/SSL", mod._ssl)):
            FakeSMTP.contexts = []
            factory()
            ctx = FakeSMTP.contexts[0] if FakeSMTP.contexts else None
            ok = (isinstance(ctx, ssl.SSLContext)
                  and ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname)
            print("%s %s.py %s" % ("✓" if ok else "✗", name, label))
            bad += 0 if ok else 1
    print("TLS 検証: %s" % ("すべて有効" if not bad else "%d 件が未検証" % bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
