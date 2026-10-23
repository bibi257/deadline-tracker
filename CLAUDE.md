# CLAUDE.md

締切トラッカー（個人用の締切管理 Web アプリ）の開発ルール。作業前に必ず読むこと。

## 1. 構成

- 画面: HTML 1枚 + `app.js` + `styles.css`。フレームワークなし・ビルドなし（ES5 風の素の JavaScript）。ルートに置く
- 保管 API: Cloudflare Worker + D1（`worker/src/index.js`）。設定はルートの `wrangler.jsonc`。利用者は自分1人
- 配信: Cloudflare の Workers Builds が `main` から自動デプロイする（PR では「Workers Builds」のチェックが走る）。`web/` は `scripts/build.mjs` が作る生成物でコミットしない
- 旧環境: GitHub Pages（ルートから配信）と、非公開リポジトリ `deadline-data` への GitHub 同期。移行が終わるまで壊さない
- 移行の計画と進捗: `docs/cloudflare-migration.md`

```
worker/src/   API（認証・データの保存・世代バックアップ）
scripts/      build.mjs（画面のファイルを web/ にそろえる）
test/unit/    単体テスト（node --test）
test/support/ テスト用の D1 互換シム（node:sqlite）
```

## 2. ルール

- 秘密（アクセスキー `APP_KEY`、Webhook URL、API トークン）をリポジトリに書かない。Cloudflare のシークレットに置く。`wrangler.jsonc` の D1 の ID は秘密ではない
- 認証のない API を増やさない（`/api/health` を除く）。トークン・キーをログや画面に出さない
- 締切データは個人情報を含む。公開リポジトリ・公開 URL・ログに出さない（購読用 `.ics` は専用の長いトークンで守り、メモを含めない）
- 外部ランタイム依存を増やさない（Worker は依存 0 を維持）
- ユーザーに見える文言は日本語。識別子は英語。2スペースインデント・セミコロンあり・シングルクォート（`app.js` は既存の書き方に合わせる）
- 無料プランで動かす。D1 の読み書きは少なく、Worker の CPU 時間は 10ms 以内に収める。有料機能が必要になったら先に相談する

## 3. テストと完了条件

- `npm test`（単体テスト）と `npm run build` が成功すること
- ロジックを変えたら対応するテストを追加・更新する。不具合を直したら再発を検出するテストを足す

## 4. Git・PR

- 作業ブランチで開発し、`main` へは PR でマージする。PR は下書き（Draft）ではなく、通常の PR として作る
- コミットメッセージは `種別: 要約`（`feat:` `fix:` `docs:` `test:` `build:` `ci:`）
