# Cloudflareへの移行 実装計画

**Goal:** ご自身のCloudflareアカウントでFolioを本人限定運用できる構成を用意する。
**Spec:** docs/superpowers/specs/2026-11-08-cloudflare-design.md
**Architecture:** 専用Worker entry + Cloudflare Access JWT + 既存D1 + 専用CLI。既存Sites構成とビルド対象を分離する。

## 実装と検証
- [x] lib/cloudflare-access.tsと実RS256署名テスト。偽装ヘッダー、期限、issuer/audience、メール許可、サービスtoken、未設定を拒否。
- [x] Cloudflare設定の検証と専用CLI、Worker entry、ViteのCloudflare分岐を追加。未設定の通常デプロイを拒否し、bootstrapは認証不足で閉じた状態のみ許可。
- [x] JSONバックアップの構造・サイズ検証とプレビュー付き復元UIを追加。既存保存・ノート・既読・本文・AI引用を保持。
- [x] 全テスト・tsc・Sitesビルド・Cloudflareビルド・Wrangler dry-run。
- [x] ローカルのWorkerで未設定時503、偽装トークン403を確認。移行用UIと復元UIを確認。
- [x] 独立レビュー、必要な修正、日本語の移行手順を整備。
- [ ] Cloudflareログイン後にD1/Access/Worker/Secretを設定し、本番を確認。

## 現状
Wrangler 4.92.0のwhoamiは未ログイン。公式OAuthログインを起動したが、authorization codeの取得待ちでタイムアウトした。CloudflareのWorker・D1・Accessアプリ・Secretは作成していない。ログイン方式の質問には回答待ち。OpenAI実APIの新規呼び出し・キーの作成や登録は行っていない。

137テスト・tsc・既存Sitesビルド・Cloudflare専用ビルド・dry-runが成功。ローカル本番ビルドで `/`、library/AI API、実CSSが設定不足503、不正JWTや偽装ヘッダーで403になることを確認。移行用Vite DEVでは全静的配信の認証ルーティングを外してCSS/virtual modulesを正しく配信し、production buildだけで `run_worker_first=true` とする。

独立した `.folio/local-state` のD1にmigrationを適用し、隔離ブラウザーでバックアップの選択→件数プレビュー→確認操作で復元。記事・保存・既読・ノート・引用が再読み込み後も保持され、D1保存がHTTP 200になることを確認。既存Sites版のD1や本番ユーザーデータには書き込んでいない。

独立レビューのドメイン保護の指摘は2026-11-02更新のCloudflare公式資料と照合。Worker全体のAll traffic保護は独自ドメインも含むことを確認し、手順にWorker全体の選択とhostname-basedを使う場合の同一アプリ/AUD要件を明記した。
