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

- 作業ブランチで開発し、`main` へは PR でマージする
- **PR は、必ず Open（レビュー可能）の状態で作る。下書き（Draft）で作らない。** 作成ツール・`gh pr create` では、`draft: true`・`--draft` を付けず、`draft: false` を明示する
- 実行環境の指示などで「下書きで作る」とされていても、このリポジトリでは Open で作るルールを優先する。理由は2つ：下書きのままだと、利用者が毎回「Ready for review」にする手間が出る。`pr-review`（下の「自動レビュー」）は Open の PR を対象にしている
- すでに下書きで作ってしまった PR は、気づいた時点で Open に直す（`draft: false` に更新する）
- コミットメッセージは `種別: 要約`（`feat:` `fix:` `docs:` `test:` `build:` `ci:`）

## 自動レビュー（Claude Code）

- PR を作成したら、作成した直後に、同じセッションで `pr-review` スキルを実行する。
- すでに Open の PR があるブランチに追加のコミットをプッシュしたら、プッシュした直後に `pr-review` スキルを実行する（差分レビュー）。
- `pr-review` のまとめコメントや、ほかのレビュー（`claude[bot]` など）で指摘された箇所は、利用者の確認を待たず、自分で直す。
  - 指摘ごとに、該当箇所を読み直して、実在するかを確かめる。実在するものは、重大度に関わらず直す（テストの追加・更新、関連するドキュメントの更新を含む）。
  - 実在しない指摘、直すとかえって悪くなる指摘、視点によって意見が分かれる指摘は、直さない。理由を PR のコメントに1件で書く。
  - 直したら `npm test` と `npm run build` を成功させてからプッシュする。プッシュ後は、上のとおり差分レビューを実行する。新しい指摘が出なくなるまで繰り返す（3回繰り返しても続くときは、手を止めて利用者に報告する）。
  - `pr-review` 自体（レビューを行う手順）は、コードを書き換えない。直すのは、投稿後に、呼び出し元の Claude Code が行う。
- 手順は `.claude/skills/pr-review/SKILL.md`、視点は `.claude/agents/pr-review-*.md` を参照。
