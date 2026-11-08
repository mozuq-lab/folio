# Cloudflare専用化とAI提供元の切り替え

## 目的と背景

Folioは、OpenAI Sites（ChatGPTのホスティング）向けに作られ、後からご自身のCloudflareへ移行した。現在はSites版とCloudflare版の2系統が残り、ログイン情報の受け渡しにOpenAI固有のヘッダー（`oai-authenticated-user-*`）を使い、AIはOpenAI Responses APIだけに対応している。

利用者の要望は次の3つ。

1. ChatGPTに依存しない形にする。配置先はCloudflareだけでよい。
2. Node.jsは24以上にする。
3. AIはOpenAIだけでなくClaude・OpenRouter・Workers AIも使えるようにし、**画面で切り替えられる**ようにする。

3の理由は「モデルを変えるときにインフラ（Secret・wrangler設定・再デプロイ）を触りたくない」こと。頻繁に切り替える想定ではない。

## 目標

- Sites／ChatGPT関連のコード・設定・依存をすべて削除し、Cloudflare Workers＋D1＋Cloudflare Accessを唯一の構成にする。
- 利用者の識別を、外部から送れるHTTPヘッダーに頼らない形にする。
- Node.js 24以上を要件にする。
- AI提供元（OpenAI／Claude／OpenRouter／Workers AI）とモデルを画面で選べるようにする。初回のキー登録とバインディング追加以外に、インフラ作業なしでモデルを変えられる。

## やらないこと

- Cloudflare Access以外のログイン方式（Google／GitHub OIDCなど）の実装。ただし後から追加できる差し替え口は用意する。
- 同じ操作を複数の提供元で同時に実行して比較する機能。
- APIキーを画面から入力・保存する機能。キーは引き続きCloudflare Secretだけに置く。
- `app/page.tsx` の全面的な分割・Prettier導入による整形（別作業とする。下記「判断した点」参照）。

## 失敗とみなすこと

- 既存のD1データ（Cloudflare移行済み）が読めなくなる。
- 偽装したヘッダーやCookieで他人として振る舞える。
- APIキーがブラウザー・D1・ログ・Gitに出る。
- AIの出力が、提供元によってはアプリ側の検証（記事ID・引用の実在・読書時間）を通らずに表示される。

## 決まっていること（利用者の決定）

| 項目 | 決定 |
| --- | --- |
| 配置先 | Cloudflareのみ。Sites版は廃止 |
| ログイン | Cloudflare Accessのまま |
| AI切り替え | 画面で利用者が切り替える |
| 対応提供元 | OpenAI、Claude（Anthropic）、OpenRouter、Workers AI |
| Claudeの既定モデル | `claude-haiku-5-5` |
| OpenAIの既定モデル | `gpt-6-luna`（「GPT 6.1 Luna」は公式一覧に無いことを確認済み。`gpt-6.1-terra` は存在するが既定にはしない） |
| Node.js | 24以上 |

## 設計

### 1. Cloudflare専用化

削除するもの：

- `app/chatgpt-auth.ts`、`worker/index.ts`（Sites用Worker入口）
- `scripts/vite/sites-vite-plugin.ts`（と LICENSE）、`scripts/vite/connector-preview-plugin.mjs`、`scripts/connector-preview/`
- `lib/connectors.ts`、`lib/connector-context.ts`、`lib/connector-contract.mts`、`lib/connector-errors.mts`、`lib/connector-preview.d.ts`
- `.openai/`、`examples/`、`db/index.ts`（`getDb` は未使用）
- Sites／Codex実行環境向けスクリプト：`scripts/install-ci.*`、`npm-install.mjs`、`pnpm-install.mjs`、`install-pnpm.sh`、`build-verified.sh`、`sites-env.sh`、`execution-profile.mjs`
- `vite.config.ts` のSites分岐・`CODEX_SANDBOX` 分岐・`managedLinux` 分岐
- 未使用の `components/ui/`（アプリから一切importされていない）と、それだけが使う依存（`@base-ui/react`、`@hookform/resolvers`、`@shadcn/react`、`cmdk`、`date-fns`、`embla-carousel-react`、`input-otp`、`next-themes`、`radix-ui`、`react-day-picker`、`react-hook-form`、`react-resizable-panels`、`recharts`、`sonner`、`vaul`、`class-variance-authority`、`json-rpc-2.0`、`raw-body` など）。削除前に `grep` で未使用を再確認すること。`components.json`・`lib/utils.ts`・`vendor/shadcn-*` も参照が無ければ削除。

`npm run dev`／`npm run build`／`npm start` はCloudflare版（現 `FOLIO_DEPLOY_TARGET=cloudflare` の挙動）に統一する。`FOLIO_DEPLOY_TARGET` 環境変数と `vite.config.ts` の分岐は不要になる。`scripts/sites-env.mjs` と `scripts/tool-environment.mjs` は、Wranglerのログ・レジストリの置き場所を決めるだけなので、名前を中立にして残してよい（`.sites-runtime/` も `.folio/` 配下へ寄せる）。

### 2. 利用者の識別（認証の作り替え）

現状は、Cloudflare版のWorkerがAccess JWTを検証した後、結果を `oai-authenticated-user-*` ヘッダーに詰め直してアプリへ渡し、アプリはそのヘッダーを読んでいる。

新しい形：

- `lib/auth/` に中立な型 `AuthUser = { id: string; email: string; displayName: string }` と、`getCurrentUser(): AuthUser | null` を置く。
- Worker入口（`worker/cloudflare.ts` を `worker/index.ts` として唯一の入口にする）で認証を行い、結果を `AsyncLocalStorage` に入れてから `handler.fetch` を呼ぶ。既存の `lib/connector-context.ts` と同じ仕組み。ルートハンドラーは `getCurrentUser()` だけを使う。
- ヘッダーによる受け渡しは廃止する。受信リクエストに `oai-*` などのヘッダーがあっても一切参照しない。
- 認証方式は差し替え口（`authenticate(request, env): Promise<AuthUser>`）にする。実装は2つ：
  - `cloudflare-access`：現 `lib/cloudflare-access.ts` の検証ロジックをそのまま使い、戻り値を `AuthUser` にする。
  - `dev`：`import.meta.env.DEV` のときだけ有効なローカル用。loopback（127.0.0.1／::1）からのリクエストに固定の開発用利用者を割り当てる。本番ビルドには含めない（`import.meta.env.DEV` による除去を確認するテストを置く）。ログイン画面は不要。
- **利用者IDの形式は変えない**：`cloudflare-access:<sub>`。既存のD1行がそのまま読める。
- 画面・APIの文言から「ChatGPT」を外す（`lib/client-library.ts:152,199`、`app/api/library/route.ts:10,39` など）。
- `/api/feeds` にもログイン確認と same-origin 確認を追加し、他のAPIとそろえる。
- 3つのルートで重複している same-origin 確認と「上限付きボディ読み取り」を `lib/http.ts` に共通化する。

### 3. Node.js 24

- `package.json` の `engines.node` を `>=24`、`.nvmrc` を `24` で追加。
- `@types/node` を24系へ。
- `npm test` を `node --test tests/*.test.ts` にする（`--experimental-strip-types` を外す。Node 24で137件成功を確認済み）。
- README・`docs/self-host-cloudflare.md` の記述を更新。

本番のWorkersはNode.jsでは動かないので、影響は開発ツールだけ。

### 4. AI提供元の切り替え

#### 4.1 提供元の差し替え口

`lib/ai.ts` のうち、指示文（`instructions`）、出力スキーマ（`resultSchema`）、アプリ側検証（`conforms`／`validateResult`）は提供元に依存しないので、そのまま共通部分として残す。OpenAI固有なのは送信と応答の取り出しだけ（現 `lib/ai.ts:104-122`）。

`lib/ai/providers/` に、次の共通の形で4つの実装を置く。

```ts
type StructuredRequest = {
  model: string;
  instructions: string;
  input: string;          // JSON.stringify(data)
  schemaName: string;     // folio_<action>
  schema: Schema;         // 現 resultSchema の戻り値
  signal: AbortSignal;
};
type StructuredResult =
  | { kind: 'ok'; json: unknown }
  | { kind: 'refused' }
  | { kind: 'incomplete' };
```

戻ってきた `json` は、どの提供元でも現在と同じ `validateResult` を通す。通らなければ現在と同じ `invalid_output`（502）。

| 提供元 | 呼び出し方 | 形式の固定 | 注意 |
| --- | --- | --- | --- |
| OpenAI | 現行どおり Responses API を `fetch`（`store:false`、`redirect:'manual'`、2MiB上限） | `text.format` json_schema strict | `reasoning.effort` はモデルIDから自動判定して送る（下記4.4） |
| Claude | 公式SDK `@anthropic-ai/sdk` の `messages.create` | `output_config.format`（json_schema） | Claudeの構造化出力は `minLength`／`maxLength`／`minimum`／`maximum` 非対応。送信前にスキーマから除去し、アプリ側の `conforms` で検証する。`stop_reason` が `refusal` なら `refused`、`max_tokens` なら `incomplete` |
| OpenRouter | OpenAI互換の Chat Completions を `fetch`（`https://openrouter.ai/api/v1/chat/completions`） | `response_format: {type:'json_schema', json_schema:{name, strict:true, schema}}`、`provider.require_parameters: true` | モデルによっては形式指定が努力目標扱い。アプリ側検証で弾く |
| Workers AI | `env.AI.run(model, {messages, response_format})` | `response_format: {type:'json_schema', json_schema: schema}` | 形式どおりに返る保証が無い（"JSON Mode couldn't be met" エラー）。日本語の質も他より低い可能性が高い |

各提供元の失敗は、現在の `AIError` の分類（`provider_error`／`timeout`／`network_error`／`rate_limited`／`refused`／`incomplete_output`）に写像する。存在しないモデルIDや、JSON出力に対応していないモデルを選んだときは「選んだモデルを確認してください（提供元：〜、モデル：〜）」と分かる文言にする。

#### 4.2 既定モデル

| 提供元 | 既定モデル | 根拠 |
| --- | --- | --- |
| Claude | `claude-haiku-5-5` | 利用者の決定 |
| OpenAI | `gpt-6-luna` | 利用者の決定 |
| OpenRouter | `openai/gpt-6-luna` | 私の判断。OpenRouterの構造化出力が確実に効くOpenAI系で、既定のOpenAIと同じ品質・安価。実装時にOpenRouterのモデル一覧でslugを確認する |
| Workers AI | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 私の判断。2026-09-14時点のJSON mode対応一覧で最も大きい汎用モデル |

既定値はコード内の定数とし、画面の候補一覧にも同じ値を入れる。

#### 4.3 設定の保存と画面

- 選んだ提供元と、提供元ごとのモデルIDと推論の深さ（effort）を `IntelligenceState` に任意項目として追加する：
  `ai?: { provider: 'openai'|'anthropic'|'openrouter'|'workers-ai'; models: Partial<Record<Provider, string>>; efforts: Partial<Record<Provider, Effort>> }`
  （`Effort` は下記4.4.1。未設定の提供元は既定の `'medium'` とみなす。Workers AIは対象外）
  任意項目にすることで、既存のD1データ・JSONバックアップはそのまま有効。ライブラリと一緒にD1へ同期されるので、どの端末でも同じ設定になる。
- `lib/cloud-library.ts` の zod スキーマ、`lib/client-library.ts`、`lib/library-backup.ts` の検証を合わせて更新。モデルIDは `^[A-Za-z0-9@/._:-]{1,200}$` に限定する。
- `GET /api/ai` は、提供元ごとに「使える／キー未設定」と既定モデルを返す：
  `{ providers: [{ id, label, available, defaultModel, reason? }] }`
- 画面：既存の「あなたらしいおすすめに」（好み設定）モーダルに「AIの設定」欄を追加する。
  - 提供元の選択（4つすべて表示。キー未設定のものは選べるが「キー未設定」と表示し、AIボタンは無効）。
  - モデル：候補一覧から選ぶか、モデルIDを直接入力。直接入力を許すので、新モデルが出てもコード変更なしで使える。
  - 推論の深さ：選択中の提供元が受け付ける値だけを選択肢に出す（4.4.1）。Workers AIでは欄を表示しない。
  - 現在の提供元とモデル名を、AIの状態表示（`AIStatus`）に小さく出す。
- `POST /api/ai` のリクエストに `provider`・`model`・`effort` を追加する（`validateRequest` の zod スキーマに追加）。サーバーは：
  - `effort` がその提供元の受け付ける値か確認する（4.4.1の表。違えば400）。
  - `provider` が4つのいずれかであることを確認。
  - そのキー（またはWorkers AIなら `env.AI` バインディング）が無ければ 503 `not_configured`。
  - `model` は形式だけ確認して提供元へ渡す（許可リストは持たない。本人限定運用のため）。
  - 未指定なら、キーがある提供元のうち先頭（Claude → OpenAI → OpenRouter の順）とその既定モデルを使う。**Workers AIは自動選択の対象にしない**（Cloudflare側の課金で利用者の知らないうちに動くのを避けるため）。利用者が明示的に選んだときだけ使う。

#### 4.3.1 入力が長すぎる場合

送信量（最大30記事、全体2MB）は変えない。モデルの扱える長さを超えた場合は、黙って切り詰めず、提供元の応答から「入力が長すぎる」ことを見分けて、新しいエラー `input_too_long`（413）で「対象の記事を減らすか、扱える長さの大きいモデルを選んでください（提供元：〜、モデル：〜）」と表示する。見分けられない場合は通常の `provider_error` とする。モデルIDは自由入力のため、モデルごとの上限はコードに持たない。

#### 4.4 環境変数とSecret

| 名前 | 種類 | 用途 |
| --- | --- | --- |
| `OPENAI_API_KEY` | Secret | 既存 |
| `ANTHROPIC_API_KEY` | Secret | 追加 |
| `OPENROUTER_API_KEY` | Secret | 追加 |
| `AI` | バインディング | Workers AI。`scripts/cloudflare-config.mjs` の `workerConfiguration` に `ai: { binding: 'AI' }` を**常に**追加する（後でインフラを触らずに済むように）。ただしローカル開発（`scripts/vite/cloudflare-config.ts` の serve）では外し、`npm run dev` がCloudflareへのログインなしで動く状態を保つ。開発中はWorkers AIを「この環境では使えません」と表示する |
| `OPENAI_MODEL` | 廃止 | 画面設定に置き換え。READMEで廃止を明記 |

- `cloudflare-env.d.ts` を更新。
- `npm run cloudflare:secret` と `secret-from-env` は、登録するキー名を引数で受け取る（許可リスト：上の3つ）。キーの値をコマンド引数や標準出力に出さない現在の扱いは維持。

#### 4.4.1 推論の深さ（effort）

利用者の要望により、画面で選べるようにする（利用者は「画面が難しければデプロイ時設定でもよい」としたが、画面で実現できるため画面にする）。値は提供元ごとに保存する。**既定は `medium`**（利用者の決定）。

`Effort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`

| 提供元 | 選べる値 | 送り方 | 既定（`medium`）のとき |
| --- | --- | --- | --- |
| OpenAI | auto・none・low・medium・high・xhigh・max | `reasoning: { effort }` | `reasoning: { effort: 'medium' }` を送る |
| Claude | auto・low・medium・high・xhigh・max | `output_config: { effort }` | `output_config: { effort: 'medium' }` を送る（`claude-haiku-5-5` のAPI既定と同じだが明示する） |
| OpenRouter | auto・none・low・medium・high | 統一パラメーター `reasoning: { effort }`（実装時にOpenRouterの資料で値の範囲を確認し、表と食い違えば表を直す） | `reasoning: { effort: 'medium' }` を送る |
| Workers AI | （なし） | 送らない | — |

- `auto`（画面表示は「モデルに任せる」）は推論設定を**送らない**。推論設定を受け付けないモデル（OpenAIの非推論モデルなど）を使うときの逃げ道として選択肢に残す。
- `auto` 以外を選んだのに、モデルが推論設定を受け付けない場合（400）は、「このモデルは推論の深さの指定に対応していません。『モデルに任せる』を選んでください（提供元：〜、モデル：〜）」と表示する。自動リトライはしない。
- 深い設定ほど時間がかかるため、タイムアウトを effort に合わせて伸ばす：`auto`・`none`・`low` はサーバー45秒（現行）、`medium` は90秒、`high` 以上は120秒。ブラウザー側のタイムアウトはサーバーより10秒長くする。
- 深い設定では推論にトークンを使い切って出力が途中で切れやすいため、最大出力トークンを `high` 以上で 32,000（それ以外は現行の16,000）にする。切れた場合は既存の `incomplete_output` で「推論の深さを下げるか対象記事を減らしてください」と表示する。
- 画面の選択肢の横に「深いほど時間と費用がかかります」と添える。

#### 4.5 レート制限

現在のメモリー上の制限（1分6回）は維持する。提供元に関係なく利用者単位で数える。READMEに「各提供元の管理画面で利用額の上限を設定すること」を追記する。

### 5. その他の修正

- lintエラー3件（`app/page.tsx:95` 描画中のref代入、`:103` effect内のsetState、`:159` `<a href="/">`）を解消する。
- README と `docs/self-host-cloudflare.md` を、Cloudflare専用・4提供元・Node 24の内容に書き直す。Sitesに関する記述は削除。

## テスト

- 既存137件を維持。
- 認証：`getCurrentUser` が Worker入口で設定した値だけを返すこと、`oai-*` ヘッダーを送っても無視されること、`dev` 認証が本番ビルドに含まれないこと。
- AI：提供元ごとに、`fetch`（またはSDK・`env.AI`）を差し替えて、正常・拒否・打ち切り・HTTPエラー・形式違反・タイムアウトを確認。Claude向けにスキーマから非対応キーワードが除去されること。
- 同期：`ai` 項目ありの文書・なしの文書がどちらも検証を通ること。不正な `provider`／`model`／`effort` を拒否すること。
- effort：提供元ごとに表の値だけを受け付けること、既定が `medium` であること、`auto` で推論設定を送らないこと、`high` 以上でタイムアウトと最大出力トークンが変わること。
- `npm test`、`npx tsc --noEmit`、`npm run lint`、`npm run cloudflare:dry-run` がすべて通ること。

## 判断した点（利用者の確認待ちではなく、私が決めたもの）

- OpenRouterとWorkers AIの既定モデル（4.2）。
- 設定はD1へ同期する（端末ごとではない）。
- キー未設定の提供元も選択肢に表示する。
- モデルIDの直接入力を許し、サーバー側で許可リストを持たない。
- Claudeは公式SDK、OpenAI・OpenRouterは `fetch`、Workers AIはバインディングで呼ぶ。
- `app/page.tsx` の全面分割とPrettier導入は今回の対象外。差分が巨大になり、機能変更のレビューが難しくなるため。lintエラーの修正と、AI設定欄の追加に必要な最小限の切り出しだけ行う。
- `OPENAI_MODEL` は廃止する。
- Workers AIのバインディングは常に入れるが、自動選択の対象から外す。ローカル開発では外す（4.4）。
- 推論の深さは提供元ごとに保存し、既定は `medium`（利用者の決定）。`auto` は「送らない」の意味で残す。タイムアウトを `medium` で90秒、`high` 以上で120秒、最大出力トークンを `high` 以上で32,000に伸ばす（数値は私の判断）。
- 入力が長すぎる場合は切り詰めず、分かりやすいエラーにする（4.3.1）。

## 実装者に任せる点

- `lib/ai/` 内のファイル分割の細部、型名。
- 画面のAI設定欄の見た目（既存の好み設定モーダルの作法に合わせる）。
- 未使用依存の最終的な削除範囲（`grep` で確認したうえで）。
- 旧バージョンの画面を開いたままの別端末が、`ai` 項目付きの文書を受け取ると検証エラーになる。再読み込みで解消するため対処は不要だが、READMEの更新手順に一文添える。
