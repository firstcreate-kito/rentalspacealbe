# レンタルスペースALBE 予約システム 実装設計書 v1.0

> 本書は **開発仕様書 v2.0（[`spec-v2.0.md`](./spec-v2.0.md)）を「どう作るか」に落とし込む実装設計書**です。
> 仕様書は「何を作るか（What）」を定義します。本書は「どう作るか（How）」— アーキテクチャ、
> ディレクトリ構成、Cloudflare Workers 固有の制約への対応、料金エンジンの厳密化、競合防止、
> 認証、外部連携の境界、Phase 1 の受け入れ条件、テスト戦略、未確定事項 — を確定します。
>
> **仕様書 v2.0 に曖昧さ・矛盾があった箇所は本書で「実装上の決定」として解消し、事業判断が要る
> 箇所は §13 の「要確認」に集約しています。着手前にそこを潰してください。**

- 対象読者：実装担当（Claude Code / 人間）、レビュアー、運用管理者
- 前提：仕様書 v2.0 を読了していること
- ステータス：ドラフト（Phase 1 実装の設計確定を目的とする）

---

## 1. 本書のスコープと非スコープ

| | 内容 |
|---|---|
| スコープ | 全体アーキテクチャ、リポジトリ構成、共通規約、料金エンジン設計、予約確定と競合防止、認証・セキュリティ、Google Calendar 同期の境界、Phase 1 の詳細設計と受け入れ条件、テスト戦略 |
| 非スコープ（後続の設計書で詳細化） | 管理画面 React の画面設計、サイネージUI、Stripe 決済フロー、LINE Messaging 実装、GAS 側スクリプト、Bookly 実データのマッピング詳細 |

本書で「**決定**」とあるものは、仕様書の曖昧点を実装のために確定させたものです。事業側の合意が必要なものは §13 に「要確認」として再掲します。

---

## 2. アーキテクチャ全体像

```
                         ┌──────────────────────────────┐
   顧客（WordPress埋込）    │  space-albe.com (WordPress)   │
   ┌───────────────┐     │   予約UI（<script>で埋込）      │
   │ 予約カレンダーUI │──┐  └──────────────────────────────┘
   └───────────────┘  │
                       │  fetch (JSON)
   管理者              ▼
   ┌───────────────┐  ┌──────────────────────────────────┐   ┌──────────────────┐
   │ 管理画面(React)│─▶│  Booking API                      │──▶│ Cloudflare D1     │
   │ Pages         │  │  Cloudflare Workers + Hono        │   │ (SQLite互換)      │
   └───────────────┘  │                                    │   └──────────────────┘
                      │  - 料金エンジン（純関数）           │
   サイネージ          │  - 予約確定（競合防止）             │──▶ Google Calendar API
   ┌───────────────┐  │  - 認証(Web Crypto)                │──▶ LINE Messaging API
   │ 当日予約表示   │─▶│  - 通知ディスパッチ                 │──▶ SendGrid / GAS(メール/PDF)
   │ Pages         │  │  - Cron(リマインダー/Webhook更新)   │──▶ Stripe (Phase 4)
   └───────────────┘  └──────────────────────────────────┘
```

**設計原則**
1. **API がすべての真実の源（single source of truth）**。UI・サイネージ・管理画面は API を叩くだけ。ビジネスロジックをフロントに置かない。
2. **料金計算・予約可否判定は純関数に隔離**。DB や日時（`Date.now()`）に依存する部分を薄い外殻に押し出し、中核はテスト可能な純関数にする。金額のバグは信用に直結するため、ここを最優先で固める。
3. **D1 を権威（authority）とし、Google Calendar はミラー**。二重予約の最終防止線は D1 の原子的な条件付き INSERT（§7）。GCal は同期先であり、GCal 直接追加分は `blocked` として D1 に取り込むことで競合判定に参加させる。
4. **段階リリース**。Phase 1（API基盤）→ 2（顧客UI）→ 3（管理画面+自動化）→ 4（決済）。各 Phase は縦に薄く動く状態で切る。

---

## 3. リポジトリ構成の提案（決定）

### 3.1 方針：この repo に `booking/` を新設するモノレポ

ブランチ名が `claude/rental-space-booking-system-*` であること、既存の静的LP（`/lp/` 配信）と予約システムは**デプロイ先も技術も別系統**であることから、**同一リポジトリ内でディレクトリを分離**します。LP のルート配置は一切変えないため、`/lp/` へのアップロード運用に影響しません。

```
rentalspacealbe/
├── index.html, style.css, tracking.js, *.webp   ← 既存の静的LP（ルート。/lp/ へ配信。変更しない）
├── blog/                                          ← 既存
├── CLAUDE.md                                       ← 既存（LPの仕様）
│
└── booking/                                        ← 予約システム（新設・独立）
    ├── README.md                                   ← 構成と開発手順
    ├── docs/
    │   ├── spec-v2.0.md                            ← 開発仕様書（正）
    │   └── implementation-design.md                ← 本書
    │
    ├── api/                                         ← Cloudflare Workers + Hono（Phase 1の主戦場）
    │   ├── src/
    │   │   ├── index.ts                            ← Hono ルーター（エントリ）
    │   │   ├── routes/                             ← エンドポイント（spaces, bookings, auth, mypage, admin, signage, sync）
    │   │   ├── domain/                             ← ★純粋ドメイン（DB非依存・テスト対象の中核）
    │   │   │   ├── pricing.ts                      ← 料金エンジン（純関数）
    │   │   │   ├── availability.ts                 ← 空き判定・○△✕
    │   │   │   ├── billing-hours.ts                ← 課金時間の切り上げ・時間帯分割
    │   │   │   └── types.ts                        ← ドメイン型
    │   │   ├── repo/                               ← D1 アクセス層（SQL をここに閉じ込める）
    │   │   ├── services/                           ← ユースケース（確定・キャンセル・変更・通知）
    │   │   ├── integrations/                       ← GCal / LINE / SendGrid / Stripe のアダプタ（IF＋実装）
    │   │   ├── lib/                                ← 認証(crypto)、id採番、日付、エラー、バリデーション
    │   │   └── middleware/                         ← 認証・CORS・レート制限・エラーハンドラ
    │   ├── migrations/                             ← D1 マイグレーション（0001_init.sql …）
    │   ├── seed/                                   ← 初期データ（スペース・時間帯・祝日等）
    │   ├── test/                                   ← Vitest（ドメイン純関数のテストを厚く）
    │   ├── wrangler.toml                           ← Workers 設定（D1 バインディング・Cron・Secrets 参照）
    │   ├── package.json
    │   └── tsconfig.json
    │
    ├── admin/                                       ← 管理画面 React（Phase 3。Cloudflare Pages）
    ├── signage/                                     ← サイネージ（Phase 3。Pages）
    └── web/                                         ← 顧客向け埋め込みUI（Phase 2。WordPress へ配信）
```

### 3.2 なぜモノレポか（別 repo との比較）

| 観点 | モノレポ（採用） | 別 repo |
|---|---|---|
| 型・スキーマ共有 | `api/src/domain/types.ts` を web/admin から相対参照または共有パッケージ化しやすい | 共有はパッケージ公開が必要で重い |
| 仕様書との近接 | LP・予約が同じ履歴に乗り、経緯を追える | 分散する |
| CI/デプロイ | パスフィルタで `booking/api/**` 変更時のみ Workers をデプロイ、と分離できる | リポジトリ単位で単純 |
| ブランチ運用 | 指定ブランチ `claude/rental-space-booking-system-*` にそのまま乗る | 新規 repo の手配が必要 |

将来コードベースが肥大化して独立管理したくなった場合は、`booking/` を `git subtree split` で切り出せます。まずはモノレポで開始するのが低コストです。

---

## 4. 技術方針とランタイム制約（Cloudflare Workers 固有）

Workers は Node.js ではありません。以下は実装時に必ず効いてくる制約と対応方針です。

| 論点 | 制約 | 対応（決定） |
|---|---|---|
| パスワードハッシュ | `bcrypt`/`argon2` のネイティブ依存は使えない | **Web Crypto の PBKDF2-HMAC-SHA256**（十分な反復回数）でハッシュ。フォーマットは `pbkdf2$<iter>$<saltB64>$<hashB64>`。将来のアルゴリズム差し替えに備えプレフィックスでバージョニング |
| セッション/トークン | — | `crypto.getRandomValues` で 32byte 乱数 → Base64URL。`auth_sessions` に保存。Cookie は `HttpOnly; Secure; SameSite=Lax`（WordPress 同一ドメイン埋め込み前提。別オリジンなら Bearer 併用） |
| トランザクション | D1 は対話的トランザクション（await をまたぐ BEGIN…COMMIT）に非対応。`db.batch([...])` は**原子的**に実行される | 複数文の原子性が要る箇所（グループ予約の一括INSERT等）は `db.batch()` に集約。単文で完結できる競合防止は「条件付きINSERT」を使う（§7） |
| 乱数・日時の純粋性 | ドメイン純関数内で `Date.now()`/`Math.random()` を使うとテスト不能・非決定 | **時刻・ID・乱数は外殻（services/lib）で生成し、ドメイン関数へ引数で注入**。`pricing()` などは `now` を引数で受ける |
| 実行時間・CPU | リクエストあたりの CPU 時間制限、サブリクエスト数上限 | 重い集計（エクスポート等）は分割・非同期化。GCal 一括同期は Cron/Queue に寄せる |
| 定期実行 | `setInterval` 不可 | **Cron Triggers**（`wrangler.toml`）でリマインダー送信・Webhook 再登録・ポーリング補完 |
| 秘密情報 | ソースに直書き禁止 | `wrangler secret` で管理（GCal サービスアカウント鍵、SendGrid/LINE/Stripe キー等）。§12 |

**言語・ツール**：TypeScript（strict）、Hono、Vitest（`@cloudflare/vitest-pool-workers` で Workers ランタイム上テスト）、Wrangler、Zod（入力バリデーション）。

---

## 5. 共通実装規約

### 5.1 ID・採番
- 主キー（`spaces.id` 等マスタ）：意味のある短い slug（例 `albe-hall`, `sakae`）を許容。トランザクション系（`bookings.id` 等）は **UUID v4**（`crypto.randomUUID()`）。
- **予約番号 `booking_number`（`YYYYMMDD-NNN`）**：当日連番。採番は「当日の最大連番+1 で INSERT → `UNIQUE(booking_number)` 制約に当たったらリトライ（最大 N 回）」。日付は JST 基準（§5.3）。
- ドメイン純関数は ID を生成しない。ID は services 層で採番して渡す。

### 5.2 金額・端数
- 金額は**すべて整数（円）**。浮動小数点を金額計算に使わない。
- 消費税・適格請求書：**税込単価を正**として扱う（仕様書の料金は税込表記）。請求書の内訳表示に必要な税抜/税額の分解方法は §13 要確認。
- 割合計算（季節加算 `+%`、割引 `%`、ポイント付与 `1%`）は**円に落とす時点で切り捨て**（`Math.floor`）を既定とし、丸め方向を関数の仕様として固定・テスト化。

### 5.3 日時・タイムゾーン
- 業務上の日付・曜日・祝日判定は**すべて JST（Asia/Tokyo）**。Workers は UTC で動くため、**JST 変換ユーティリティを lib に一本化**し、ドメイン関数へは「JST の日付文字列 `YYYY-MM-DD` と `HH:mm`」を渡す。
- 時刻は 30 分刻み（`00`/`30` のみ）。営業時間外へのはみ出し不可（最終開始 = 営業終了 − 30分）。

### 5.4 API 規約
- ベースパス `/api`。JSON in/out。文字コード UTF-8。
- 入力は **Zod スキーマで境界検証**。失敗は `400` + エラー配列。
- エラー形式（統一）：
  ```json
  { "error": { "code": "SLOT_CONFLICT", "message": "指定の時間は予約できません", "details": {} } }
  ```
- 代表コード：`VALIDATION_ERROR`(400) / `UNAUTHORIZED`(401) / `FORBIDDEN`(403) / `NOT_FOUND`(404) / `SLOT_CONFLICT`(409) / `BLACKLISTED`(403, 顧客には理由を出さない) / `RATE_LIMITED`(429) / `INTERNAL`(500)。
- CORS：許可オリジンを WordPress ドメイン・管理 Pages ドメインに限定（ワイルドカード禁止）。
- 冪等性：`POST /api/bookings` は任意の `Idempotency-Key` ヘッダを受け、二重送信で二重予約が起きないようにする（キー＋結果を短期キャッシュ）。

### 5.5 レイヤリング（依存の向き）
```
routes → services → { domain(純), repo(D1), integrations(外部) }
domain は他レイヤに依存しない（何もimportしない中核）
```

---

## 6. 料金計算エンジン（最重要・純関数化）

仕様書 §3 を実装可能な形に厳密化します。ここは**金額バグ＝信用毀損**のため、純関数＋網羅テストで固めます。

### 6.1 入出力の型（`domain/pricing.ts`）

```ts
// すべて DB非依存の値オブジェクト。呼び出し側(services)が repo から材料を集めて渡す。
interface PricingInput {
  now: string;                      // JST 'YYYY-MM-DDTHH:mm'（締切判定用。外から注入）
  space: SpaceRule;                 // 営業時間, billing_type, min_hours, horizon/deadline 等
  timeZones: ZoneRate[];            // 時間帯×平日/土日祝 単価（該当スペース分に解決済み）
  days: DayUsage[];                 // 予約対象日ごとの利用時間・曜日区分・季節該当・残置指定
  seasonal: SeasonalRule[];         // 期間×加算%
  campaign?: CampaignRule;          // 自動適用（日付該当・対象スペース・曜日条件）
  instrument?: DiscountInstrument;  // 顧客が選ぶ discount のうち1つ（coupon|ticket|point|none）
  options: OptionSelection[];       // オプション（割引対象外）
}

type PricingResult = {
  ok: true;
  perDay: DayBreakdown[];           // 日別・時間帯別の内訳
  spaceSubtotal: number;            // スペース料金（残置含む、割引前）
  storageSubtotal: number;
  campaignDiscount: number;         // マイナス値で保持
  instrumentDiscount: number;       // クーポン/チケット/ポイントによる減額
  optionsSubtotal: number;
  total: number;
  pointsToEarn: number;             // completed 時付与予定（最終支払額の1%切り捨て）
  breakdownText: string[];          // 確認画面表示用の明細行
} | { ok: false; reason: UnavailableReason };  // 休業/締切/期間外/最低時間割れ等
```

### 6.2 計算順序（仕様書 §3.1 を実装手順に落とす）

1. **可否判定（各日）**：休業日（`space_closures` ∪ `calendar_holidays.type='closed'`）、予約締切（`利用日 − now < deadline`）、予約可能期間（`利用日 − now > horizon`）。1日でも不可なら早期に `ok:false`。
2. **曜日区分**：`祝日 or 独自休日 or 土日 → weekend単価`、それ以外 → `weekday単価`。
3. **課金時間の算出（`billing-hours.ts`）**：利用時間を**時間帯ごとに分割**し、各時間帯を**1時間単位で切り上げ**て課金時間を出す（仕様 §3.3 シンプル方式）。
4. **時間帯別スペース料金**：各時間帯の課金時間 × 該当単価。
5. **季節加算**：日が `seasonal` に該当したら、その日の各時間帯金額に `+surcharge_pct%`（円落とし時 floor）。
6. **最低利用時間**：`総利用時間 < min_hours` なら `min_hours` で再計算（最低時間の課金は最も安い時間帯単価か通常単価か → §13 要確認。暫定：利用開始時間帯の単価で不足分を補う）。
7. **残置料金**（連日かつ残置指定時のみ、§6.4）：営業時間内の残置時間を**同一時間帯単価**で課金。`storageSubtotal` に集計。
8. **キャンペーン**（自動）：`instrument=coupon` の場合は**適用しない**（クーポン優先）。それ以外は `spaceSubtotal+storageSubtotal` に対して適用（詳細は 6.3）。
9. **instrument（顧客選択の1つ）**を適用（6.3）。
10. **オプション**加算（**割引対象外**）。
11. `total` 確定 → `pointsToEarn = floor(total × point_rate)`（ポイント/クーポン/チケット利用時の付与可否は §13 要確認。暫定：付与する）。

### 6.3 併用ルールの厳密化（仕様書 §3.1 step9-10 と §3.7 の“ねじれ”を解消）

仕様書は step9 で「クーポン/チケット/ポイントは**いずれか1つ**」、step10 と§3.7 で「クーポン+キャンペーン不可／チケット+キャンペーンは残時間超過分のみ可／ポイント+キャンペーン可」と述べています。これを **2軸モデル**として実装します（**決定**、§13 で最終確認）。

- **軸A：キャンペーン**（自動・日付/スペース/曜日で決まる）
- **軸B：顧客が選ぶ discount instrument を最大1つ**（`coupon` | `ticket` | `point` | `none`）

instrument 別のキャンペーン相互作用：

| instrument | キャンペーン | 適用ロジック |
|---|---|---|
| `none` | 通常適用 | `campaignDiscount` を base に適用しておわり |
| `coupon` | **無効化** | キャンペーンは適用しない。base に対しクーポンの `%`/`¥` を適用（対象：スペース+残置のみ） |
| `ticket` | **超過分のみ** | チケット残時間で賄える時間は ¥0。**賄えない超過時間分の金額にのみキャンペーンを適用**。オプション対象外 |
| `point` | 通常適用 | キャンペーン適用後の `spaceSubtotal+storageSubtotal` からポイントを 1pt=1円 で減算（残高・上限内） |

その他の禁止組み合わせ（§3.7）は「instrument は1つだけ」で自然に担保される（coupon+ticket、coupon+point、ticket+point はいずれも B 軸で排他）。

> **なぜこの解釈か**：§3.7 の 6 行すべてを満たす最小モデルが「B軸の排他 + キャンペーンは coupon の時だけ無効・ticket の時だけ超過分・それ以外は通常」だからです。step9 の「いずれか1つ」は B 軸内の排他を指し、キャンペーンは B 軸の外（A 軸）にある、と読みます。

### 6.4 残置料金（仕様書 §3.4）
- カート内日程から**連続する日付グループ**を検出（services 側で判定し `days[].storage` に落とす）。
- 課金対象（営業時間内・通常時間単価）：
  - 初日：利用終了 → 営業終了
  - 中間日：営業開始 → 利用開始 ＋ 利用終了 → 営業終了
  - 最終日：営業開始 → 利用開始
- 残置料金もチケット・クーポンの割引対象（オプションは対象外）。

### 6.5 ブロック課金スペース
- `billing_type='block'` のスペースは時間選択なし。日付選択＝1ブロック料金。空き判定は「その日に予約があるか否か」の二値（○/✕）。

### 6.6 テスト（`test/pricing.spec.ts`）
- **テーブル駆動**で以下を網羅：単一時間帯／複数時間帯またぎ／30分切り上げ／土日祝×平日／季節加算の重畳／最低時間割れ／連日残置（初日・中間・最終）／instrument 4系統×キャンペーン有無／ポイント上限／端数（floor）境界。
- 各ケースは「入力オブジェクト → 期待 `total` と主要内訳」を固定値で assert。**まずここを緑にしてから API に載せる**。

---

## 7. 予約確定とダブルブッキング防止（決定）

D1 は書き込みを直列化しますが、`SELECT で空き確認 → INSERT` は 2 リクエストが同時に「空き」を見て**両方 INSERT** し得ます。そこで **単一 SQL 文の原子性**を使います。

### 7.1 条件付き INSERT（時間重複を単文で排他）

```sql
INSERT INTO bookings (id, group_id, space_id, date, start_time, end_time, ...)
SELECT :id, :group_id, :space_id, :date, :start, :end, ...
WHERE NOT EXISTS (
  SELECT 1 FROM bookings b
  WHERE b.space_id = :space_id
    AND b.date     = :date
    AND b.status IN ('confirmed','held','blocked')     -- 生きている予約 + GCal外部ブロック
    AND NOT (b.end_time <= :start OR b.start_time >= :end)  -- 時間帯の重なり
);
```
- 実行後 `meta.changes === 1` を確認。`0` なら **`409 SLOT_CONFLICT`**。
- 単文 INSERT…SELECT は原子的に評価されるため、`SELECT`〜`INSERT` 間の割り込みが起きない。
- **グループ予約（複数日）は `db.batch()` で全日を一括**。1日でも `changes=0` の日があればバッチ全体を無効化（=すべて失敗）として扱い、部分予約を作らない。※ D1 の batch 半失敗時の挙動は §13 で要検証（ロールバック相当にできない場合は、成功分を補償削除する services 層フォールバックを実装）。

### 7.2 held（仮確保）とカート
- カート投入〜確定の間に他者に取られないよう、必要なら `status='held'` + 期限（TTL）で先行 INSERT する方式を採る（Phase 2 で UI と合わせて確定）。Phase 1 では **確定時の条件付き INSERT のみで排他**し、held は未実装でよい（設計だけ用意）。
- 期限切れ `held` の掃除は Cron。

### 7.3 Google Calendar との整合
- D1 を権威とする。確定は「①D1 条件付き INSERT 成功 → ②GCal イベント作成」。②失敗時は**予約は成立**とし、`google_event_id=NULL` のまま同期リトライキューへ（Cron が後追いで作成）。
- GCal 直接追加イベントは同期で `source='google_calendar', status='blocked'` として D1 に取り込み、7.1 の `NOT EXISTS` に自然に参加させる（外部予定も二重予約防止の対象になる）。

---

## 8. 認証・セキュリティ（決定）

| 項目 | 方針 |
|---|---|
| 顧客パスワード | PBKDF2-HMAC-SHA256（Web Crypto）。`password_hash` に `pbkdf2$iter$salt$hash`。ゲストは `NULL` |
| 管理者 | 同方式 + 役割（owner/manager/staff）。管理APIは全て役割チェック（§6.1 権限表を middleware で強制） |
| セッション | `auth_sessions`（token, customer_id, expires_at）。ログインで発行、失効を厳守。ローテーション |
| 顧客/管理の分離 | 顧客セッションと管理者セッションは**別テーブル・別 Cookie 名**。混用不可 |
| 書類の公開URL | `/documents/:public_token` は認証不要のため、`public_token` は**推測不可能な長さ（32byte 乱数, Base64URL）**。列挙・総当り対策にレート制限。`voided` は 410 |
| ブラックリスト | 予約時・アカウント作成時に `blacklist(email/phone)` を照合。**顧客には理由・連絡先を出さない**定型文のみ（§13.x 文言固定） |
| サイネージ | `signage_tokens` の簡易トークン。読み取り専用・当日確定予約のみ返す |
| レート制限 | 認証・予約・書類・チケット検証にレート制限（IP/トークン単位） |
| 入力検証 | 全エンドポイントで Zod。SQL は必ずパラメータバインド（文字列連結禁止） |
| Secrets | すべて `wrangler secret`（§12）。リポジトリ・ログに出さない |
| PII | 顧客の連絡先・住所・請求情報は最小限のログ。`staff_memo` は顧客/管理者への通知メールに**出さない**（§6.3 転送リスク） |

---

## 9. Google Calendar 双方向同期の境界設計

- **アダプタ化**：`integrations/gcal.ts` にインターフェース（`createEvent`/`updateEvent`/`deleteEvent`/`watch`/`listChanges`）を定義。Phase 1 は**モック実装**で API 契約を満たし、実 API は Phase 1 後半〜2 で差し込む。ドメイン/サービスは GCal 実体に依存しない。
- **方向**：システム→GCal（確定/変更/キャンセルでイベント CUD）／GCal→システム（Push Webhook `POST /api/sync/webhook` → 差分取り込み、5分 Cron でポーリング補完）。
- **命名規則**（仕様 §8.4）：予約 `[ALBE] 会社名 / 担当者名 様`、残置 `[ALBE残置] …`。説明欄に予約番号・イベント名・時間・オプション・金額・（あれば）社内メモ。
- **Webhook 更新**：Cron で有効期限が近い channel を再登録（§8.5）。
- **認証**：GCal はサービスアカウント（ドメイン内カレンダー共有）を想定。鍵は Secret。JWT 署名は Web Crypto で実装。

---

## 10. Phase 1 詳細スコープと受け入れ条件

Phase 1 のゴール＝**「予約が API 経由で、正しい金額で、二重予約なく作成できる」**縦の最小動作。

### 10.1 作るもの
1. **D1 スキーマ**：仕様書 §2 の全 39 テーブルの `migrations/0001_init.sql`（Phase 1 で使うのは一部だが、スキーマは一括作成しておく）。外部キー・UNIQUE 制約・インデックス（`bookings(space_id, date, status)` 等）を付与。
2. **seed**：スペース（アルベホール名古屋 / 栄）、time_zones、代表的な `space_time_zone_pricing`、祝日（当年分）。実データは §13 確定後に差し替え。
3. **ドメイン純関数**：`pricing.ts` / `billing-hours.ts` / `availability.ts` ＋ **Vitest 網羅テスト（緑）**。
4. **API（顧客側の中核のみ）**：
   - `GET /api/spaces`（一覧）
   - `GET /api/spaces/:id/slots?month=YYYY-MM`（空き枠 + ○△✕、閾値 `availability_threshold`）
   - `GET /api/spaces/:id/options`（在庫込み）
   - `POST /api/bookings`（グループ一括作成・料金再計算・**競合防止**・冪等キー対応）
   - `POST /api/tickets/validate`（コード検証。適用は確定内で）
5. **認証の土台**：`POST /api/auth/register` / `login`、セッション middleware（ゲスト予約も可能に）。
6. **横断**：Zod 検証、統一エラー、CORS、レート制限、`wrangler.toml`（D1 バインディング・Cron 枠・Secrets 参照）、ローカル実行手順。

### 10.2 やらないこと（Phase 1 では）
GCal 実 API（モックで代替）、管理画面 UI、サイネージ UI、Stripe、LINE 実送信、PDF 生成、Bookly 実移行、セルフ変更/キャンセルの UI。※ ただし該当データモデルとサービス関数の**IFは用意**して後続で実装を差す。

### 10.3 受け入れ条件（Definition of Done）
- [ ] `npm test` で料金エンジンのテーブル駆動テストが**全緑**（§6.6 の全ケース）。
- [ ] `wrangler dev` でローカル起動し、seed 済み D1 に対して以下が通る：
  - [ ] `GET /api/spaces` が seed のスペースを返す。
  - [ ] `GET /api/spaces/:id/slots` が当月の ○△✕ を返す（休業日・祝日反映）。
  - [ ] `POST /api/bookings` が正しい `total`・`booking_number` で予約を作る。
  - [ ] **同一枠に同時 2 リクエスト → 一方 `201`、他方 `409 SLOT_CONFLICT`**（競合テスト）。
  - [ ] 予約締切/期間外/休業日/最低時間割れが正しく弾かれる。
  - [ ] ブラックリスト該当メール/電話で予約が定型文で拒否される。
- [ ] 秘密情報がソース・ログに一切出ていない。
- [ ] README の手順どおりにゼロから起動・テストできる。

---

## 11. テスト戦略
- **ユニット（厚く）**：`domain/*` の純関数。テーブル駆動。料金・課金時間・空き判定・可否理由。
- **統合（中）**：`@cloudflare/vitest-pool-workers` で D1 を張り、`POST /api/bookings` の競合・冪等・締切を検証。
- **契約（薄く）**：各エンドポイントの入出力を Zod スキーマで型・形状検証。
- **回帰の要所**：金額に関わる変更は必ずテスト追加。バグ修正は再現テストを先に書く。

---

## 12. 設定・シークレット（`wrangler.toml` + secrets）
- バインディング：`DB`（D1）、（後続）`KV`/`Queue`。
- Cron：リマインダー（日次 `reminder_time`）、GCal ポーリング（5分）、Webhook 再登録（日次）、`held` 掃除。
- Secrets（`wrangler secret put`）：`GCAL_SA_KEY`、`SENDGRID_API_KEY`、`LINE_CHANNEL_TOKEN`、`STRIPE_SECRET`（Phase 4）、`SESSION_PEPPER`（ハッシュ用ペッパー）等。**値は本書・リポジトリに記載しない**。
- 環境分離：`dev` / `production`（D1 データベースも分離）。

### 12.1 メール配信（決定：SendGrid）

到達率・運用安定を最優先する事業要件のため、**トランザクションメールは SendGrid（Twilio Inc.）**を採用（決定）。過去のメール不達の主因は、WordPress同居サーバ／通常Gmailからの送信でドメイン認証・IPレピュテーションが未整備だったことにあるため、予約系メールを専用配信基盤に分離する。

必須セットアップ（到達率のため。ベンダー非依存で必須）：
- **送信ドメイン認証**：`space-albe.com` に SendGrid の DKIM/SPF 用 CNAME を設定。送信は**専用サブドメイン**（例 `mail.space-albe.com`）にしてルートドメインの評判を保護。
- **DMARC** レコードを発行（まず `p=none` で監視 → 整えば強化）。
- 差出人は **`rental@space-albe.com`** で固定（`info@first-create.com` は使わない）。適切な Reply-To。
- **Event Webhook** でバウンス/苦情を受信し `notification_log` に記録・自動抑制（抑制リスト反映）。
- `integrations/mailer.ts` にアダプタIFを切り、Phase 1 はモック／dev は SendGrid サンドボックス、production で本送信。

### 12.2 外部委託先一覧（プライバシーポリシー記載用）

個人情報（氏名・メール・電話等）を移転・委託する事業者。**すべて海外事業者は「外国にある第三者への提供」欄に記載**。契約時点の登記上の正式名称を最終確認すること。

| 用途 | 事業者名（記載名） | 国外移転 |
|---|---|---|
| インフラ・DB（Workers/D1） | Cloudflare, Inc. | 該当（米国） |
| メール配信 | Twilio Inc.（SendGrid）※国内代理店経由なら株式会社構造計画研究所も併記 | 該当（米国） |
| カレンダー同期・帳票生成 | Google LLC（Google Calendar / Apps Script） | 該当（米国） |
| LINE 通知 | LINEヤフー株式会社 | 国内 |
| 決済（Phase 4） | Stripe Payments Japan 株式会社 ／ Stripe, Inc. | 一部該当（米国） |

---

## 13. 要確認事項（着手前・実装中に確定）

事業・データの判断が要るもの。仕様書の未確定と本書で解消した“暫定決定”を集約します。

**A. 料金ロジック（最優先）**
- [ ] §6.3 の 2 軸モデル（キャンペーン×instrument の相互作用）で解釈が正しいか。特に「ticket+キャンペーンは超過分のみ」の“超過分”＝チケット残時間で賄えない時間分の金額、で合っているか。
- [ ] §6.2-6 最低利用時間割れ時、不足分をどの単価で埋めるか（利用開始時間帯単価／最安単価／通常単価）。
- [ ] §6.2-11 ポイント/チケット/クーポン利用時にポイント付与を行うか（暫定：行う）。付与基準は「最終支払額（=カード/請求で実際に払う額）」か「割引前」か。
- [ ] 消費税の内訳表示（税抜・税額の分解）と端数処理。適格請求書の記載要件。

**B. 予約・在庫**
- [ ] §7.1 グループ予約の `db.batch()` 半失敗時にロールバック相当が担保できるか（D1 実挙動の検証）。できない場合の補償削除方針の承認。
- [ ] `held`（仮確保）を Phase 2 で導入するか、確定時排他のみで運用するか。
- [ ] オプション在庫の「日単位集計」で、同日に時間帯が重ならない複数予約でも在庫を共有カウントするか（仕様は日単位＝共有と読む）。

**C. マスタ・実データ**
- [ ] スペース定義（アルベホール名古屋／栄）の営業時間・`billing_type`・時間帯区分・平日/土日祝単価の**確定値**。LP 側 CLAUDE.md は「日額・ダイナミックプライシング」だが本システムは「時間帯別固定単価＋即時確定」で**事業モデルが異なる**。この転換が意図通りか、LP の料金表示と整合させるか。
- [ ] Google カレンダー ID（各スペース）と連携方式（サービスアカウント可否）。
- [ ] 祝日データの取得元（内閣府 CSV の取り込み手順）と毎年の更新運用。

**D. 認証・文言・法務**
- [x] メール配信事業者 = **SendGrid（Twilio Inc.）** に決定（§12.1）。プライバシーポリシーの委託先一覧は §12.2。→ 残：国内代理店経由か直契約か、送信サブドメイン名の確定、DMARC 運用ポリシー。
- [ ] ブラックリスト拒否の定型文（仕様の「申し訳ございませんが、ご予約をお受けすることができません。」で確定か）。
- [ ] 書類公開URLの有効範囲（無期限公開か、失効を設けるか）。
- [ ] 顧客規約・キャンセルポリシーの初期値（`cancel_policies` の段階・料率）。

**E. 移行**
- [ ] Bookly の顧客/予約テーブルの実カラムマッピング。移行後の重複メール処理。

**F. 決済・返金（§15）**
- [x] 決済は **Stripe 一本**（PayPal 不採用）、自動化は **カードのみ**、**承認ゲート方式**（管理者承認で Stripe 実行）に決定。
- [x] 値上がり差額の **SCA（3Dセキュア）フォールバック＝メール認証リンク** を採用に決定（§15.3）。
- [x] 承認ゲートは **返金・追加課金の両方**に適用（追加課金でも管理者へ変更リクエストが飛ぶ）。**承認画面での金額上書き（調整）を標準**に決定（§15.1）。
- [x] 申請時に予約枠を **保持**し、承認時に解放、で決定。
- [x] **セルフ操作は全廃＝全件承認制**に決定（§15.5）。ランク別セルフ可否・回数制限は廃止。
- [ ] メール承認リンク（管理者用の即応承認）を用意するか、管理画面ボタンのみか。※暫定：管理画面ボタン中心＋任意でメールリンク。
- [ ] 返金期限（約180日）超過時に銀行振込へ自動切替する運用の承認。
- [ ] **変更・キャンセルの申請受付期限**（暫定：利用日当日まで受付可 / 案B：◯日前で締切）。§15.6。
- [ ] **キャンセル料率**（`cancel_policies` の段階・％の実値。例：7日前まで無料／3日前50％／当日100％）。§15.6・§13-D。

---

## 15. 決済・変更・キャンセル・返金フロー（Stripe / カード・承認ゲート方式）

### 15.1 決定事項
- **決済事業者は Stripe 一本**（PayPal 不採用）。**自動化の対象はカード決済のみ**。請求書払い（銀行振込）は従来どおり手動フロー。
- **完全自動化はしない。全ての変更・キャンセルは管理者承認を経る（承認ゲート方式）。** これは**返金（値下がり・キャンセル）だけでなく、追加課金（値上がり差額）も同じ**。顧客の申請 → 管理者へ変更リクエスト通知 → 承認して初めて課金/返金を実行し、無断の追加請求は行わない。返金・差額課金の**計算と実行（Stripe API）はシステム**が行い、**実行の引き金は管理者の承認**とする。管理者は Stripe 管理画面を操作しない。
- **承認画面で管理者が金額を上書き（調整）できるのを標準とする（決定）。** システムは「承認された金額」で Stripe 返金/追加課金を実行。上書き時は**理由メモ必須**、`booking_adjustments` にシステム計算額・承認額・承認者・理由を記録（監査証跡）。返金は元決済額が上限、複数回の一部返金も可。支払額を超える金銭（お詫び等）は返金ではないため別手段（銀行振込／ポイント）。手動 Stripe 画面での返金は最終手段とし、その場合も返金IDをシステムに記録して突合を切らさない。
- **値上がり差額の追加課金で本人認証（3Dセキュア／SCA）が要求された場合は、顧客へメールで認証・決済リンクを送るフォールバックを採用（確定）。** 返金側にはこの制約はない。
- カードは予約時に **off-session 課金可能な形で保存**（Stripe Customer + PaymentMethod トークン）。カード番号は自社保持しない。
- 決済の追跡のため **`payments` テーブルを新設**（現行スキーマの穴。§15.4）。

### 15.2 承認ゲート・フロー
```
顧客が変更/キャンセルを申請（マイページ or 変更リクエストフォーム）
   │  予約枠は解放せず保持（暫定・§13-F 要確認）
   ▼
システムが返金額（キャンセル料控除後）/差額を自動計算
   → booking_adjustments を status='pending' で作成
   ├─ 管理者へ通知（メール＋LINE：予約番号・内容・金額・承認依頼）
   └─ 顧客へ受付確認メール
   ▼
管理者が管理画面で確認 → 承認 / 却下
   ├ 承認・カード・返金/値下がり差額 → Stripe refund を自動実行 → completed → 予約更新or取消・GCal反映・顧客へ完了通知
   ├ 承認・カード・値上がり差額     → 保存カードへ off-session 課金
   │     └ 本人認証要求(requires_action) → 顧客へメール認証リンク送信 → 完了で確定（§15.3）
   ├ 承認・請求書払い               → 返金は銀行振込指示／差額は請求書（手動）
   └ 却下                          → status='rejected' → 予約は元のまま・顧客へ通知
```
- **二重実行防止**：`status` 遷移を厳格化（`pending→completed/rejected` のみ）＋ Stripe 呼び出しに冪等キー。承認 API は同一 adjustment に対し 1 回だけ実行を許可。
- **返金上限**：元決済額を超えない。キャンセル料は `cancellation_log.cancel_fee` を控除した純額を返金。返金期限（元決済からおおむね180日）超過分は銀行振込へ自動切替（管理者に明示）。

### 15.3 SCA（3Dセキュア）フォールバックの挙動
1. 承認時に off-session PaymentIntent を作成・確定。
2. Stripe が `requires_action`（本人認証要求）を返したら、**その場では課金を保留**し、adjustment を `status='awaiting_customer_auth'` にする。
3. 顧客へ**認証・決済リンク（安全トークン付き・有効期限あり）**をメール送信。顧客がリンクで on-session 認証を完了 → Webhook（`payment_intent.succeeded`）で `completed` に遷移し変更を確定。
4. 期限内に未完了なら管理者に通知（督促 or 却下判断）。返金・値下がり・差額ゼロはこの経路を通らない（即実行）。

### 15.4 スキーマ追加・変更
- **新設 `payments`**：`id`, `group_id`, `provider('stripe')`, `stripe_customer_id`, `stripe_payment_method_id`, `payment_intent_id`, `charge_id`, `amount`, `status`, `created_at`。返金/追加課金はこの行を辿る。
- **`booking_adjustments` に追加**：`approved_by`（承認管理者ID）, `approved_at`, `stripe_refund_id` / `stripe_payment_intent_id`, `auth_link_token`（SCA用）, `auth_link_expires_at`。既存 `status` に `awaiting_customer_auth` を追加。
- **`booking_groups.payment_method`** で経路分岐（`card`=Stripe自動実行／`invoice`=手動）。

### 15.5 仕様書 v2.0 との差分（要同時改訂）
- §4.4 の「値下がり差額＝返金先口座入力→管理者が銀行振込」は、**カード払いでは廃止**（Stripe 自動返金。口座収集不要）。請求書払いのみ従来フロー。
- §4.4 の「値上がり差額・カード＝即時確定」は、**承認ゲート＋（必要時）SCAメール認証**に変更。
- **セルフ操作は全廃（決定）＝全件承認制**。§2.14 のランク別セルフ可否（優良7日前/VIP3日前 等）、§5.3 の「日時変更1回まで」、§5.6 の「月2回まで」は**役目を終える**。`customer_status_config.can_self_cancel/can_self_reschedule` は実質すべて false 運用。マイページからの変更・キャンセルは**すべて「変更リクエスト（承認待ち）」として起票**される（従来の変更リクエストフォームと統合）。
- 会員ランクは**ポイント・チケット・割引クーポンの権利**としては引き続き機能（セルフ操作の権利としては使わない）。

### 15.6 申請受付期限とキャンセル料（要確認）
- **申請受付期限**（顧客が変更・キャンセルを申請できる下限日）＝ §13-F 要確認。暫定：**利用日当日まで受付可**（承認制のため無人確定がなく、遅い申請はキャンセル料で調整）。
- **キャンセル料**は `cancel_policies`（利用日の何日前で何％）に従い、申請可否とは独立に適用。料率の実値は §13-D 要確認。

---

## 14. 次のアクション（本書承認後）
1. §13-A（料金ロジック）と §13-C（スペース実データ）を確定 —— 料金エンジンの実装に直結。
2. `booking/api` の雛形作成（Hono + wrangler + tsconfig + Vitest）。
3. `migrations/0001_init.sql`（全テーブル）＋ seed。
4. `domain/pricing.ts` ほか純関数 ＋ テーブル駆動テスト（緑）。
5. `GET /api/spaces`・`/slots`・`POST /api/bookings`（競合防止・冪等）＋ 認証土台。
6. 受け入れ条件（§10.3）を満たしたら Phase 2（顧客UI）設計へ。

---

*本書は実装の確定に伴い更新する。仕様書 v2.0 と矛盾が生じた場合は、事業合意のうえ両者を同時に改訂する。*
