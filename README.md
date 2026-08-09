# 締切トラッカー

課題・記事などの締切を登録して一覧／カレンダーで見え、`.ics` を書き出して iPhone のカレンダーに通知を任せる静的Webアプリ。サーバー不要・費用0円。

## ファイル構成

**`deadline-tracker`（Public / GitHub Pagesで公開）**

```
index.html            アプリ本体（HTML/CSS/JS すべて内包）
manifest.webmanifest  ホーム画面追加用の設定
icon-180.png          iOSホーム画面アイコン
icon-192.png          Android/PWA用
icon-512.png          PWA用
```

**`deadline-data`（Private / データと自動送信）**

```
data.json                           締切データ（アプリの「GitHubに同期する」で自動生成・更新）
.github/workflows/daily-digest.yml  毎朝の実行スケジュール
.github/scripts/send_digest.sh      Discordへ送る処理（Webhook URL等の設定はこの冒頭）
.github/scripts/build_ics.py        添付する.icsを作る処理
```

> `daily-digest.yml` 内の `run:` のパスと `send_digest.sh` の実際の置き場所は必ず一致させること。ズレていると `No such file or directory` で失敗する。

## 公開手順（ステップ1）

1. GitHub で新しいリポジトリを作る（例：`deadline-tracker`、Public）
2. このフォルダの5ファイルをそのままアップロードする（**Add file → Upload files**）
3. **Settings → Pages** を開く
4. Source を **Deploy from a branch**、Branch を **main / (root)** にして Save
5. 1〜2分待つと `https://<ユーザー名>.github.io/deadline-tracker/` で開く

更新するときは、同じ場所にファイルを上げ直すだけ。反映されないときはブラウザを再読み込み（iPhoneは一度タブを閉じる）。

## iPhoneでの使い方

- Safariで上のURLを開く → 共有ボタン → **ホーム画面に追加**（アプリのように起動する）
- 締切カードの **カレンダーへ** を押すと `.ics` がダウンロードされる
- ファイルを開く → 「カレンダーに追加」を選ぶ → 予定と通知が入る

## 通知のしくみ

このアプリ自体は通知を出さない（静的サイトなのでプッシュ通知サーバーがない）。代わりに `.ics` に **VALARM を3件** 埋め込み、通知は iOS 標準カレンダーに出させる。

| タイミング | 時刻 |
|---|---|
| 1週間前 | 締切と同じ時刻 |
| 前日 | 締切と同じ時刻 |
| 当日 | 設定タブで指定した時刻（初期値 9:00） |

締切当日の時刻が指定時刻より前の場合、当日通知は入らない（鳴らす前に締切が来るため）。

締切を編集したら、**もう一度書き出して取り込み直す**。UID が同じで SEQUENCE が上がるので、同じ予定が上書き更新される。

## データについて

- 保存先は **ブラウザの localStorage**。端末ごとに別データになる
- 端末をまたぐときは、設定タブの **GitHubに同期する / GitHubから読み込む** を使う
  - PCで登録 → 「同期する」→ iPhoneで「読み込む」、で両方の端末が揃う
  - 読み込むと、その端末のデータは GitHub 上の内容で置き換わる（実行前に確認が出る）
  - トークンは端末ごとに入力が必要。「この端末にトークンを保存」にチェックすれば次回から省ける
- ファイル経由で移したい場合は **JSONで書き出す / JSONを読み込む** も使える
- ブラウザのデータを消すと締切も消える

### バックアップは3重にある

| 手段 | 作られるタイミング | 復元方法 |
|---|---|---|
| GitHubのコミット履歴 | 「GitHubに同期する」を押すたび | リポジトリの `data.json` → **History** → 戻したい時点の内容をコピーして、JSONとして読み込む |
| Discordへの週次添付 | 毎週月曜の朝（設定で変更可） | 添付ファイルを保存 → 設定タブの **JSONを読み込む** |
| 手動のJSON書き出し | 自分で押したとき | 同上 |

Discordに届くファイルはアプリの読み込み形式とそのまま互換なので、ダウンロードして選ぶだけで復元できる。

バックアップの曜日は `.github/scripts/send_digest.sh` の `BACKUP_DOW` で変更する（`1`=月曜 … `7`=日曜、`0`で添付しない）。毎日欲しければ、その日の曜日番号ではなく毎回送るよう `send_backup` の曜日判定行を削除する。

> 注意：`data.json` はPublicリポジトリに置かれるため、締切のタイトルやメモは誰でも閲覧できる。見られたくない内容は書かないこと。

## Discordへ毎朝の連絡（任意機能）

GitHub Pagesはサーバーが無いため、アプリ単体では「閉じている間の自動通知」ができない。そこで **GitHub Actions** を使って、毎朝リポジトリ内の `data.json` を読み、近日中の締切をDiscordのチャンネルへ送る。

### リポジトリは2つに分ける

締切のタイトルやメモが他人に見えないよう、**データは別のPrivateリポジトリに置く**。

| リポジトリ | 公開設定 | 中身 |
|---|---|---|
| `deadline-tracker` | **Public**（GitHub Pagesに必要） | index.html, アイコン, manifest |
| `deadline-data` | **Private** | data.json, `.github/` 一式 |

Publicリポジトリはファイル一覧もコミット履歴も全て公開されるため、ファイル名を変えたり深い階層に置いても隠したことにはならない。分離が唯一の確実な方法。

### 設定手順

1. **Privateリポジトリを作る**
   GitHubで新規リポジトリ `deadline-data` を作成し、**Private** を選ぶ。
2. **Actions用のファイルを置く**
   `deadline-data` に **Add file → Create new file** で以下2つを作る（ファイル名にスラッシュを含めるとフォルダになる）。
   - `.github/workflows/daily-digest.yml`
   - `.github/scripts/send_digest.sh`
3. **Discordのウェブフックはスクリプトに埋め込み済み**
   `.github/scripts/send_digest.sh` の冒頭に、Webhook URLと毎朝メンションするユーザーIDを直接書いてある。Privateリポジトリなので他人には見えない。
4. **トークンを作る**
   GitHubの **Settings（アカウント） → Developer settings → Fine-grained tokens → Generate new token**
   - Repository access: **`deadline-data` を選択**（`deadline-tracker` ではない）
   - Permissions: **Contents → Read and write**
5. **アプリで同期する**
   アプリの **設定タブ → Discordへ毎朝連絡** に、GitHubユーザー名・`deadline-data`・トークンを入力し「GitHubに同期する」を押す。
6. **動作確認**
   `deadline-data` の **Actions** タブ → 「締切ダイジェストをDiscordへ送る」→ **Run workflow**

### すでに公開リポジトリに同期してしまった場合

`data.json` を削除しても、**コミット履歴から中身を取り出せてしまう**。確実に消すには次のどちらか。

- 見られて困る内容が無ければ、`data.json` を削除するだけで済ませる
- 内容を消したい場合は、`deadline-tracker` リポジトリを一度削除して作り直し、`index.html`・アイコン・`manifest.webmanifest` だけを上げ直す

### 通知先・メンション・対象期間・バックアップ曜日を変える

`.github/scripts/send_digest.sh` の冒頭にまとまっている。

```bash
DEFAULT_WEBHOOK_URL="https://discord.com/api/webhooks/..."  # 通知先
MENTION_USER_ID="1212746144481017908"                       # 空にするとメンションしない
DEFAULT_WINDOW_DAYS="7"                                     # 何日以内を対象にするか
BACKUP_DOW="1"                                              # data.jsonを添付する曜日(1=月, 0=しない)
APP_URL="https://bibi257.github.io/deadline-tracker/"       # 通知に載せるアプリのリンク
ATTACH_ICS="0"                                              # .icsを添付するか(既定0。iOSでは照会になるためリンク推奨)
ICS_DAY_HOUR="9"                                            # .ics内の当日リマインド時刻
```

### 通知時刻を変える

`.github/workflows/daily-digest.yml` 内の

```yaml
- cron: "0 22 * * *"   # UTC 22:00 = JST 7:00
```

を編集する（cronはUTC基準。`UTC時刻 = JST時刻 - 9時間`）。

### iPhoneでカレンダーに入れるとき

Discordの添付ファイルを直接タップすると、iOSは「照会カレンダー」として登録してしまい、更新がすぐ反映されない。通知内の **「カレンダーに入れる」リンク**（`?export=all`）を開くと、アプリが.icsをファイルとして保存するので、それを開いて「カレンダーに追加」を選ぶ。

添付ファイルから入れたい場合は、長押し→「ファイルに保存」してから開くこと。

### 注意

- PrivateリポジトリでもGitHub Actionsは無料枠（月2000分）で動く。このジョブは1回1分未満なので十分収まる
- Privateリポジトリでは `raw.githubusercontent.com` からファイルを取得できないが、Actionsはリポジトリ内のファイルを直接読むので問題ない



## 実装済みの機能

- 締切の登録・編集・削除・完了（完了タブにアーカイブ）
- 期限までの残り日数、経過メーター、期限切れ・当日・3日以内・7日以内の色分け
- 期限切れ／今日・明日／今週／これから のグループ分け表示
- 月表示カレンダー（前月・翌月・今月へ移動、日付タップでその日の締切）
- カテゴリの追加・削除・並び替え（↑↓ボタン。フィルタの並び順にも反映）
- 設定タブから Discord へ手動送信（毎朝の連絡を待たずに送れる。通知先はPrivateリポジトリの send_digest.sh から自動取得）
- GitHub経由の端末間同期（送信・受信の両方向）
- 毎朝の通知にアプリのURLと、ワンタップで.icsを書き出すリンクを掲載
- `?export=all` を付けて開くと.icsの書き出しが自動で始まる（`rep`で定期予定のみ、`once`で締切のみ）
- 「定期予定」タブ — 繰り返しの予定は一覧タブから分離し、カレンダーでは緑で表示。Discordにも別セクションで届く
- 繰り返し締切（毎週・隔週・毎月・回数指定）— 先の回までカレンダーに自動表示、.icsはRRULEで出力
- 終日の予定（時刻を決めない。.icsも終日形式で出力）
- 繰り返しのうち特定の回だけ取りやめ（.icsにはEXDATEで反映、定期予定タブから元に戻せる）
- 複数日にまたがる予定（試験期間・合宿など）— 残り日数は「開始日まで」を数える— 開始日と終了日を持ち、カレンダーに期間の帯を表示
- `.ics` 書き出し（1件ずつ／表示中まとめて／全件）
- JSONバックアップと復元
- Discordへの毎朝ダイジェスト送信（GitHub Actions、任意設定）
- ダークモード（自動・ライト・ダーク）
- レスポンシブ表示、ホーム画面追加時のアイコン

## 動作確認のチェックリスト

- [ ] GitHub Pages のURLがPCとiPhoneの両方で開く
- [ ] 締切を登録 → 再読み込みしても残っている
- [ ] 期限切れの締切が赤く出る
- [ ] カレンダーの日付をタップするとその日の締切が出る
- [ ] **iPhone実機で `.ics` を開き、カレンダーに予定と通知3件が入る**
- [ ] 締切を編集して再取り込みすると、予定が増えずに上書きされる
- [ ] JSONを書き出して別端末で読み込むと同じ内容になる
- [ ]（Discordを使う場合）Privateリポジトリ `deadline-data` を作成した
- [ ] トークンのRepository accessが `deadline-data` になっている
- [ ] 設定タブで同期 → `deadline-data` に `data.json` ができる
- [ ] Actionsタブから手動実行 → Discordに届く
- [ ] Publicリポジトリ側に `data.json` が残っていない
