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
   - 3b: Discord の締切一覧と Cron（毎朝 6:47 の送信）。`send_digest.sh` の出力と1文字まで一致することをテストで確認。Webhook（`DISCORD_WEBHOOK_URL`）が未設定の間は何も送らないので、旧環境（ルーティンの投稿）と二重にならない
   - 3c: Gmail API で自分宛てにメール送信（20:23 に翌日分、5:23 に当日分）。本文は `send_feed_mail.py` の出力と一致することをテストで確認。Google の設定が未設定の間は何も送らない
   - 3d: 夜の再通知と週次レビュー（`worker/src/review.js`）。旧環境の `send_digest.sh`（`DIGEST_MODE=evening` / `weekly`）の出力と1文字まで一致することをテストで確認。Cron の本数を増やさず、時刻を3本にまとめる（下の表）。次の2点は旧環境から変えた
     - 時刻: 夜の再通知は 20:47 から 20:23 に、週次レビューは日曜 21:45 から 20:23 に早まる
     - 月曜の `data.json` の添付（`send_backup`）は移植しない。世代バックアップが D1 にあり、メモを含む全データを毎週 Discord に置かないため（持ち主に確認済み）
     - 自動完了の予定は、夜の見出しの件数と負荷予報に数えない（アプリのカレンダー・朝の一覧と同じ）。旧環境のスクリプトにも同じ規則を入れた
4. アプリの保存先を Worker に切り替え（本番化）。Cron を有効にして旧 Actions を止める
5. 後片付け（Pages 停止、GitHub 同期コードの削除、`deadline-data` のアーカイブ）
   - 5a: 済。アプリの保存先・通知を Cloudflare に切り替えた後の確認
   - 5b: アプリ側のコードを削除した（v4.0）。残りの手作業は下の「5b の手作業」
     - 消したもの: GitHub への同期（`ghConfig`・`syncToGitHub`・`pullFromGitHub` の GitHub 側、Public 確認、`backups/` への退避、`getStoredGitHubConfig`、設定の入力欄）、Discord を端末から直接送る処理（`buildDigestText`・`fitDiscord`・`discordPayload`・`isDiscordWebhookUrl`・`fetchWebhookFromRepo`・`autoNotifyIfConfigured`・Webhook URL の端末保存・設定の入力欄）、`utf8ToBase64`・`base64ToUtf8`
     - 名前を変えたもの: `syncToGitHub` → `syncToCloud`、`pullFromGitHub` → `pullFromCloud`、`getStoredGhConfig` → `getStoredSyncConfig`、`ghHint` → `syncHint`。`fetchRemoteState` は `cfFetchState` に一本化した
     - 残したもの: `.ics` の「Worker が使えないとき」の備え（`downloadIcsPreferWorker` の `local()` 側）は、オフラインで書き出すために残す。1件ずつの書き出し・定期予定・表示中の一部の書き出しも `buildICS` のまま残す（`test/unit/app-logic.test.js` で、Worker の `buildIcs` と1文字まで一致することを確かめている）。端末内の記録 `gh-known-updatedAt`・`gh-last-sync`・`gh-last-pulled` は、中身が Cloudflare 用に変わっただけなので名前を変えない（変えると、端末ごとの同期の記録が消える）
     - 端末に残った旧設定（`gh-token`・`dc-hook`・`gh-sync`・`gh-public-acked`、設定 `autoNotify`）は、起動時に `forgetLegacySettings` が消す
     - CSP の `connect-src` から `api.github.com`・`discord.com` を外した（このアプリは同じオリジンの Worker にだけ通信する）

### 5b の手作業（コードでは行えない。マージ後に持ち主が行う）

1. `deadline-tracker` の Settings → Pages で、公開（Source）を止める。止める前に、Worker の URL でアプリが開くこと、設定の「同期」でキーを入れて読み込めることを確かめる
2. `deadline-data`: ワークフロー `try-cloudflare.yml` を削除し、Secrets `APP_URL`・`APP_KEY` を消す
3. `deadline-data`: 非公開リポジトリのままアーカイブする（Settings → General → Archive this repository）。`archive/pre-cloudflare-2026-10-23/`（移行前のバックアップ）は残る
4. （任意）Discord の Webhook を作り直す。履歴の扱いは `deadline-data` の TODO に従う

## Cron Triggers（UTC。無料プランはアカウント全体で5本まで。このWorkerは3本）

1つの仕事が失敗しても、同じ Cron の残りは実行し、最後にまとめて失敗として投げる（Cloudflare の Cron の履歴に残る）。

| Cron（UTC） | JST | する仕事 |
|---|---|---|
| `47 21 * * *` | 毎日 6:47 | 朝の締切一覧を Discord へ |
| `23 11 * * *` | 毎日 20:23 | 翌日分のメールを自分宛てに ＋ 月〜土は夜の再通知、日曜は週次レビューを Discord へ |
| `23 20 * * *` | 毎日 5:23 | 当日分のメールを自分宛てに ＋ 世代バックアップの間引きと掃除 |

## 動作確認用の API（アクセスキーが要る）

| 呼び方 | 内容 |
| --- | --- |
| `GET /api/mail` | 締切のメールの件名と本文を作って返す（送らない）。`?target=today|tomorrow|auto` |
| `POST /api/mail` | 締切のメールを今すぐ自分宛てに送る |
| `GET /api/digest` | Discord に送る文面を作って返す（送らない）。設定の有無（`config`）も返す。`?kind=morning`（朝の一覧。既定）`evening`（夜の再通知）`weekly`（週次レビュー） |
| `POST /api/digest` | 今すぐ Discord に送る。`?kind=` は同じ |
| `GET /api/feed`、`GET /api/ics` | feed と `.ics` |

## Cloudflare 側の設定（手作業）

- Worker `deadline-tracker` を GitHub 連携（Workers Builds）で作成し、このリポジトリの `main` につなぐ
- シークレット `APP_KEY`（24文字以上のランダムな値）を Worker の設定に登録する
- 設定はすべて **「シークレット」の種類**で登録する（Cloudflare の「変数」〔テキスト〕は、Wrangler の設定に書いていないと、次のデプロイで消えることがあるため）
- Gmail API でのメール送信（段階4で登録する。登録するまでメールは送らない）
  - シークレット `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google Cloud の OAuth クライアント（デスクトップアプリ）
  - シークレット `GOOGLE_REFRESH_TOKEN`: スコープ `https://www.googleapis.com/auth/gmail.send` で取得したリフレッシュトークン。OAuth 同意画面を「本番」にしておく（「テスト」のままだと7日で切れる）
  - シークレット `MAIL_TO`: 送り先のメールアドレス（自分）。`MAIL_FROM`（任意）は送信元で、省略すると `MAIL_TO` と同じ
- Discord の送信（段階4で登録する。登録するまで朝の Cron・夜の再通知・週次レビューは何も送らない）
  - シークレット `DISCORD_WEBHOOK_URL`: Discord の Webhook の URL
  - シークレット `DISCORD_USER_ID`: 毎朝メンションするユーザーの ID（任意。空ならメンションなし）
  - シークレット `APP_URL`: 締切一覧のリンクに入れるアプリの URL（例: `https://<Worker名>.<サブドメイン>.workers.dev/`）
  - シークレット `DONE_LINKS`（任意）: `0` にすると「✅完了」リンクを付けない（任意）
- シークレット `FEED_TOKEN`（購読用 `.ics` の URL に入れる、24文字以上のランダムな値。`APP_KEY` とは別の値）。未設定の間、`/ics/…` は 404 を返す
- D1：本番 `deadline-tracker`、プレビュー `deadline-tracker-preview`（ID は `wrangler.jsonc`）
