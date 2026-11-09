# ご自身のCloudflareでFolioを動かす

Cloudflare Workers、D1、Cloudflare Accessを使用します。移行元の環境がある場合、新しくWorkerとDBを作成します。移行先にログインできるまでは、バックアップを元に戻せる状態で保管してください。

Node.js 24以上が必要です。必要なパッケージと設定ファイルを準備します。

```sh
npm ci
npm run cloudflare:init
npm run cloudflare:login
npm run cloudflare:whoami
```

`login`はCloudflareの公式OAuth画面を開きます。パスワードやCloudflare API tokenをチャットに送る必要はありません。

## 1. 移行先の設定

生成された `.folio/cloudflare.json` を編集します。このファイルはGit管理対象外です。設定例は [cloudflare.example.json](../cloudflare.example.json) にあります。

| 項目 | 内容 |
| --- | --- |
| `workerName` | 作成するWorker名。初期値は `folio-personal` |
| `accountId` | ご自身のCloudflare account ID。`whoami`で確認 |
| `databaseName` | D1名。初期値は `folio` |
| `databaseId` | D1作成後に自動設定。既存DBを使う場合はそのID |
| `allowedEmails` | ログインを許可する本人のメールアドレスの配列 |
| `accessTeamDomain` | 後で設定する `https://チーム名.cloudflareaccess.com` |
| `accessAudience` | 後で設定するAccessアプリのAUDタグ |
| `customDomain` | 任意。`folio.example.com`など、ご自身の管理する専用ドメイン。空なら `workers.dev` |

AIのキーなどの秘密値は、このJSONに追加しないでください。本人限定の運用では `allowedEmails` にご自身のメールアドレスだけを指定します。

## 2. D1を作成し、初回配置する

```sh
npm run cloudflare:db:create
npm run cloudflare:bootstrap
```

D1作成コマンドは、作成したDBのIDを設定ファイルへ保存します。作成済みのD1を使う場合は、そのIDを設定して作成コマンドを省略します。作成成功後に設定保存だけが失敗した場合は、CloudflareのD1一覧からIDを確認し、作成を繰り返さないでください。

`bootstrap` はビルド、未適用のD1 migration、Workerへの配置を行います。Accessの設定不足中は、画面・API・静的ファイルをすべて拒否する状態になります。

## 3. Cloudflare Accessを設定する

CloudflareアカウントでZero Trustを有効にしてから、Workers & Pagesで作成したWorkerを選びます。**Accessタブ → Protect this Worker behind Access → All traffic → Apply Access** で、Worker全体を保護します。Previews onlyは選ばないでください。作成されたアプリの許可ポリシーを本人のメールアドレスに制限します。

Worker全体の保護は、そのWorkerのroutes・独自ドメイン・`workers.dev`・プレビューに適用されます。ホスト名単位で保護する方式を使う場合は、利用する独自ドメインと `workers.dev` を同じAccessアプリに登録してください。Folioは1つのAccessアプリのAUDを検証するため、ホストごとに異なるAccessアプリを作る構成にはしていません。

作成されたAccessアプリの設定から、チームのドメインとApplication Audience（AUD）Tagを確認します。Zero TrustのAccess controls → ApplicationsにあるアプリのAdditional settingsからAUDを確認できます。[Cloudflareの保護設定](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)、[AUDとJWT検証の公式手順](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

`.folio/cloudflare.json` の `accessTeamDomain`・`accessAudience`・`allowedEmails` を設定し、再デプロイします。

```sh
npm run cloudflare:deploy
```

このコマンドは設定が不足した状態の通常デプロイを拒否します。すべてのURLをWorker経由にし、JWTの署名・issuer・audience・期限とメール許可を検証します。Accessのヘッダーが無い、または不正なリクエストは403で拒否します。

`customDomain` を指定する場合は、既存サービスで使っていない専用のホスト名を選んでください。

## 定期取得（Cron Trigger）

デプロイすると、`*/5 * * * *` のCron Triggerが設定に自動で入ります。追加の操作は不要です。5分ごとに、優先フィード1件と通常フィード1件を取得してD1にためます。外部から起動するHTTPの入口はありません。対象は、直近90日以内にFolioを開いた `allowedEmails` の利用者です。記事は90日保持し、削除はUTC 03:00〜03:04の実行時に1日1回です。D1のmigration（`0002`・`0003` を含む）は `cloudflare:bootstrap`／`cloudflare:db:migrate` で適用します。

### 無料プランの制限

- 無料プランは、1回の実行あたりCPU時間10ミリ秒・外部へのリクエスト50件までです。通信待ちは数えませんが、XMLの解析は数えます。そのため1回の実行で取得するフィードは2件までです。解析だけで10ミリ秒を超える大きなフィードは取り込めないことがあり、その場合はフィード管理に「取得に失敗しました」と表示します。
- D1の書き込みは1日10万行までです。通常の取得と既読では収まりますが、数万件を「すべて既読にする」と1回で枠の多くを使います。枠に達すると一部だけ既読になり、再試行の表示が出ます。翌日に続けてください。
- 古い画面を開いたままの端末は、更新後に再読み込みしてください。

### 無料プランに切り替えたあとに確認すること

CPU時間10ミリ秒の制限は通常の画面やAPIにもかかります。次の操作が上限を超えて失敗しないか、切り替え後に確認してください。今回の改修では作り替えていません。

- 記事本文の取得（最大2MBのHTMLを解析）
- 大きなRSSのフィードの即時取得（フィードの追加、「フィードを更新」）
- トップページの表示
- OPMLの読み込み（最大500フィード）

## 4. AIを使う場合

使う提供元のAPIキーを、Cloudflare Secretへ対話入力で設定します。`<KEY>` は `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENROUTER_API_KEY` のいずれかです。

```sh
npm run cloudflare:secret -- <KEY>
```

確認済みのローカル環境ファイルにキーがある場合は、ファイルからメモリー内で読み、Wranglerの標準入力へ渡す方法もあります。値はコマンド引数や標準出力へ出しません。

```sh
npm run cloudflare:secret-from-env -- .dev.vars <KEY>
```

Workers AIはキーが不要です。バインディング `AI` が配置のたびに自動で設定に入ります。利用料はCloudflare側で請求されます。自動では選ばれないため、使う場合は画面の「あなたらしいおすすめに」で提供元に選びます。

期限切れのキーは使用できません。キー未設定でもRSS閲覧・ローカル推薦・ノート・同期は利用できます。AIの既定モデルは提供元ごとに決まっています（OpenAI `gpt-6-luna`、Claude `claude-haiku-5-5`、OpenRouter `openai/gpt-6-luna`、Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`）。提供元・モデル・推論の深さは画面で変更できます。`OPENAI_MODEL` は廃止しました。各提供元の管理画面で、利用額の上限を設定してください。

## 5. 既存データを移す

1. 現在のFolioで、左下のダウンロードボタン（ライブラリをエクスポート）からJSONバックアップを保存します。
2. 新しいFolioへCloudflare Accessでログインします。
3. 左下の「データの移行・バックアップ」を開き、バックアップを選びます。
4. 件数と置き換え内容を確認して「このバックアップを読み込む」を押します。

購読・好み・ノート・AI結果と、保存・メモ・AI回答で参照している記事（その既読・取得済み本文を含む）をまとめて復元します。90日分の記事のバックログと、それ以外の記事の既読はバックアップに含まれません。古い形式のバックアップを読み込んだ場合は、中の記事と既読をバックログに取り込みます。ドメインやログイン方式が変わるため、ブラウザーのキャッシュやユーザーIDは自動では引き継ぎません。復元した内容は、移行先でログイン中の本人のライブラリとして保存します。

読み込みは現在のライブラリを置き換えます。ファイルは16MiBまで、読み込む文書の内容はクラウド同期と同じ4MiBまでです。形式や容量が不正な場合は、データを切り捨てずに中止します。

## 更新・ローカル確認

```sh
npm test
npx tsc --noEmit
npm run cloudflare:dry-run
npm run cloudflare:deploy
```

`dry-run` は外部へWorkerを配置せず、専用ビルドとアップロード内容を確認します。`deploy --dry-run` のような追加引数は誤操作防止のため受け付けません。

ローカル開発では定期取得は動きません。「フィードを更新」ボタン（表示中のフィード、またはすべてのフィード）とフィードの追加で取得します。ローカル開発は `npm run dev`（`npm run cloudflare:dev` でも同じ）で起動します。ログイン画面はありません。開発サーバー上のloopbackからのアクセスには、固定の開発用利用者を割り当てます。この仕組みは本番のビルドに含まれません。ローカルD1は `.folio/local-state` に保存します。初回と、`drizzle/` にmigrationが増えたときは、ビルド後に以下で未適用のmigrationをすべて適用します。

```sh
npm run cloudflare:build
node --import ./scripts/tool-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --config .folio/deploy/wrangler.json --persist-to .folio/local-state
```

`npm run build` も同じCloudflare向けのビルドです。配置するときは、専用ビルドと対象確認を毎回行う `cloudflare:deploy` を使用してください。
