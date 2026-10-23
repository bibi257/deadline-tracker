# Cloudflare への移行

GitHub Pages + 非公開リポジトリ（`deadline-data`）の構成から、Cloudflare Workers + D1 へ移す。構造は `bibi257/tournament` に合わせる。

## 決めたこと

| 項目 | 内容 |
| --- | --- |
| 置き場所 | コードと Worker は `deadline-tracker`。データは D1。`deadline-data` は移行後にアーカイブ |
| 保存 | D1 に締切データを JSON 丸ごと1行（`docs`）。`rev` で衝突を検知（`If-Match`）。保存のたびに30分間隔で世代バックアップ（`snapshots`） |
| 認証 | 長いランダムなアクセスキー（Worker のシークレット `APP_KEY`）を `Authorization: Bearer` で送る。失敗が続いたら IP ごとに10分止める。tournament のパスワード+トークン方式とは異なる（利用者が1人のため） |
| 通知 | Worker の Cron Triggers から Discord へ直接送る。メールは Gmail API（OAuth）で自分宛てに送る。ルーティン（Claude）はメールを読む役だけにする |
| 購読 `.ics` | `/ics/<トークン>.ics` で常に最新を返す。UID と通知は `build_ics.py` と同じにする（購読中の予定が重複しないように） |
| 無料枠 | Workers・D1・Cron Triggers（5本まで）で収める |

## 段階

0. バックアップ（`deadline-data` の `archive/pre-cloudflare-2026-10-23/`）— 済
1. Worker の土台（このリポジトリ）：`wrangler.jsonc`・D1・認証・`/api/data`・テスト・CI
2. 既存の `data.json` を D1 に取り込んで照合
3. ダイジェスト・メール・`.ics` を移植し、旧 Actions と出力を比べる
   - 3a: 繰り返しの計算・feed・`.ics`（購読 URL `/ics/<トークン>.ics` を含む）— Python 版の出力と1文字まで一致することをテストで確認
   - 3b: Discord の締切一覧と Cron
   - 3c: Gmail API で自分宛てにメール送信
4. アプリの保存先を Worker に切り替え（本番化）。Cron を有効にして旧 Actions を止める
5. 後片付け（Pages 停止、GitHub 同期コードの削除、`deadline-data` のアーカイブ）

## Cloudflare 側の設定（手作業）

- Worker `deadline-tracker` を GitHub 連携（Workers Builds）で作成し、このリポジトリの `main` につなぐ
- シークレット `APP_KEY`（24文字以上のランダムな値）を Worker の設定に登録する
- シークレット `FEED_TOKEN`（購読用 `.ics` の URL に入れる、24文字以上のランダムな値。`APP_KEY` とは別の値）。未設定の間、`/ics/…` は 404 を返す
- D1：本番 `deadline-tracker`、プレビュー `deadline-tracker-preview`（ID は `wrangler.jsonc`）
