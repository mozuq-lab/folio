# Folio — エージェント向けメモ

日本語のRSSリーダーです。Cloudflare Workers・D1・Cloudflare Access上で動き、Next.js互換のvinext（Vite）でビルドします。機能と起動手順は `README.md`、本番への配置は `docs/self-host-cloudflare.md`にあります。`docs/superpowers/`（設計書と実装計画）はGitで管理しないので、手元にあるときだけ参照できます。

## 完了の条件

変更を終えたと言う前に、次の4つがすべて通ること。

```sh
npm test
npx tsc --noEmit
npm run lint
npm run cloudflare:dry-run
```

## 書き方の決まり

- 画面の文言・エラーメッセージ・ドキュメントは日本語の「です・ます」調で書く。
- コミットメッセージは日本語で書く。先頭に `feat:` / `fix:` / `refactor:` / `chore:` / `docs:` などの種別を付け、件名は「〜する」で終える。
- `app/page.tsx` は1行に詰めた書き方になっている。変更する行だけを直し、周囲を整形し直さない。

## 利用者の識別

- 利用者は `getCurrentUser()`（`lib/auth/context.ts`）だけから取得する。値を設定するのはWorkerの入口（`worker/handler.ts`）だけで、HTTPヘッダーやCookieから利用者を読み取る処理は作らない。
- 利用者IDの形式 `cloudflare-access:<sub>` を保つ。D1の既存データはこのIDで保存されている。
- 開発用の自動ログイン（`lib/auth/dev.ts`、ID `dev:local`）は開発サーバーでだけ有効。本番ビルドに含まれると `scripts/build-guard.mjs` がビルドを止める。

## AI

- 提供元は `lib/ai/providers/` に1つずつある。指示文・出力スキーマ・出力の検証（`validateResult`）は `lib/ai.ts` に共通で置き、どの提供元の出力もこの検証を通す。
- 提供元のエラーは `providerFailure`（`lib/ai/provider-error.ts`）の固定文言で返す。提供元の応答本文やエラーメッセージは分類に使うだけで、利用者向けの文言にもログにも出さない。
- ブラウザーで動くコード（`components/`、`app/page.tsx`、`lib/ai-settings.ts`、`lib/ai-analyze.ts`）からAI関連で読み込んでよいのは `lib/ai/types.ts` と `lib/ai/selection.ts` だけ。`lib/ai/registry.ts`・`lib/ai/providers/`・`@anthropic-ai/sdk` を読み込むと、SDKがブラウザー用のバンドルに入る。
- 提供元の選び方（自動選択の順番、既定のモデル、推論の深さ）は `lib/ai/selection.ts` と `lib/ai/types.ts` の `PROVIDERS` にまとめてある。サーバーと画面の両方がここを使うので、規則を変えるときはここだけを直す。
- APIキーはCloudflare Secretにだけ置く（`npm run cloudflare:secret -- <KEY>`）。`.folio/cloudflare.json` やコードには書かない。

## 同期データ

- 同期する文書の検証（`lib/cloud-library.ts`）は未知の項目を拒否する。項目を足すときは任意項目にし、その項目が無い既存の文書・JSONバックアップ・ブラウザーのキャッシュが読み込めることをテストで確かめる。

## 記事のバックログ

- 記事本体は2か所に分かれる。定期取得した90日分はバックログ（`lib/backlog/`、D1の `folio_articles` と端末のIndexedDB）に置く。同期データには保持対象の記事（保存・メモ・AI参照）とその既読IDだけを置く。
- バックログの記事や大量の既読IDを同期データに書かない。4MiBを超える。
- 定期取得（`scheduled`）と更新（refresh）の経路で同期データを読み込まない。無料プランのCPU時間（10ミリ秒）を超える。購読の写しは `folio_feeds` を使う。
- ブラウザーで動くコードから読み込んでよいのは `lib/backlog/types.ts`・`client-state.ts`・`view.ts`・`priority.ts`・`refresh.ts`・`migration-runner.ts` だけ。`store.ts`・`schedule.ts`・`scheduled.ts`・`api.ts` は読み込まない。

## テストと開発環境の注意

- テストはNode 24の型除去でTypeScriptをそのまま実行する。テストから読み込むモジュールでは import に `.ts` 拡張子を付け、`enum` やコンストラクター引数のプロパティ宣言を使わない。
- `cloudflare:workers` を読み込むファイル（`app/api/*/route.ts` など）はテストから読み込めない。判断のロジックは `lib/` に切り出してテストし、ルートは薄く保つ。
- vinextの開発サーバーは1つのフォルダにつき1つしか起動できない（ポート5173）。起動済みのサーバーがあれば、自分で起動したもの以外は止めずに利用者に確認する。
- 新しいローカル環境では、D1のmigrationを適用するまで同期が動かない。手順は `README.md` の「ローカルDB」にある。
