# レンタルスペースALBE 予約システム（booking/）

既存の WordPress + Bookly を置き換える、自社開発の予約管理システム。
Cloudflare Workers + D1 をバックエンドとしたヘッドレス構成。

> このディレクトリは、リポジトリ・ルートの静的LP（`/lp/` 配信）とは**独立**しています。
> LP のファイル配置・デプロイには影響しません。

## ドキュメント

| ファイル | 役割 |
|---|---|
| [`docs/spec-v2.0.md`](./docs/spec-v2.0.md) | 開発仕様書 v2.0（正）— 何を作るか（What） |
| [`docs/implementation-design.md`](./docs/implementation-design.md) | 実装設計書 v1.0 — どう作るか（How）。着手前にまず読む |

**着手前**：実装設計書 §13「要確認事項」を確定させてください（特に料金ロジックとスペース実データ）。

## 構成（予定）

```
booking/
├── docs/        設計ドキュメント（現状ここまで作成済み）
├── api/         Cloudflare Workers + Hono + D1（Phase 1）
├── web/         顧客向け埋め込みUI（Phase 2）
├── admin/       管理画面 React / Pages（Phase 3）
└── signage/     デジタルサイネージ / Pages（Phase 3）
```

## 開発フェーズ

| Phase | 内容 | 状態 |
|---|---|---|
| 設計 | 実装設計書の確定 | ドラフト作成済み |
| Phase 1 | 予約API基盤（D1 + 料金エンジン + 競合防止） | 未着手 |
| Phase 2 | 顧客UI（カレンダー + カート + 予約フロー） | 未着手 |
| Phase 3 | 管理画面 + 自動化連携（GAS） | 未着手 |
| Phase 4 | 決済統合（Stripe） | 未着手 |

## 技術スタック

- API: TypeScript + Hono（Cloudflare Workers）
- DB: Cloudflare D1（SQLite互換）
- テスト: Vitest（`@cloudflare/vitest-pool-workers`）
- 外部連携: Google Calendar / LINE Messaging / SendGrid or GAS / Stripe（Phase 4）

運営：株式会社ファーストクリエイト
