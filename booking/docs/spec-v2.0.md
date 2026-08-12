# レンタルスペースALBE 予約システム 開発仕様書 v2.0

## 1. システム概要

### 1.1 プロジェクト概要
レンタルスペースALBEの予約業務を効率化するため、自社開発の予約管理システムを構築する。既存のWordPress + Booklyプラグインから、Cloudflare Workers + D1をバックエンドとしたヘッドレスアーキテクチャに移行する。

### 1.2 技術スタック
| レイヤー | 技術 | 備考 |
|---------|------|------|
| バックエンドAPI | TypeScript + Hono | Cloudflare Workers上で稼働 |
| データベース | Cloudflare D1 | SQLite互換、サーバーレス |
| フロントエンド（顧客） | HTML + JavaScript | WordPress（space-albe.com）に埋め込み |
| フロントエンド（管理） | TypeScript + React | Cloudflare Pagesでホスト |
| サイネージ | HTML + JavaScript | Cloudflare Pages |
| 自動化 | Google Apps Script | 既存の請求書/領収書生成を流用 |
| カレンダー同期 | Google Calendar API | Webhook + ポーリング |
| 通知（メール） | GAS / SendGrid等 | テンプレートベース |
| 通知（LINE） | LINE Messaging API | 公式アカウント + Notify |
| 決済 | Stripe | Phase 4で実装 |

### 1.3 開発フェーズ
| フェーズ | 内容 | 優先度 |
|---------|------|--------|
| Phase 1 | 予約API基盤（D1 + Google Calendar同期） | 最優先 |
| Phase 2 | フロントエンドUI（カレンダー + カート + 予約フロー） | 高 |
| Phase 3 | 管理画面 + 自動化連携（GAS） | 高 |
| Phase 4 | 決済統合（Stripe） | 中 |

---

## 2. データベース設計

### 2.1 spaces（スペースマスタ）
```sql
CREATE TABLE spaces (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  name_en                 TEXT,
  google_calendar_id      TEXT,
  billing_type            TEXT NOT NULL,          -- 'hourly' or 'block'
  slot_minutes            INTEGER DEFAULT 60,
  has_minimum             BOOLEAN DEFAULT false,
  min_hours               INTEGER DEFAULT 0,
  open_time               TEXT NOT NULL,          -- '08:00'
  close_time              TEXT NOT NULL,          -- '22:00'
  booking_horizon_days    INTEGER DEFAULT 180,    -- 何日先まで予約可能
  booking_deadline_days   INTEGER,                -- NULLなら共通設定を使用。利用日の何日前まで受付
  block_name              TEXT,                   -- ブロック名（'終日'等、block時のみ）
  sort_order              INTEGER DEFAULT 0,
  is_active               BOOLEAN DEFAULT true
);
```

### 2.2 time_zones（時間帯定義・共通デフォルト）
```sql
CREATE TABLE time_zones (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,       -- '午前' / '午後' / '夜間'
  start_time  TEXT NOT NULL,       -- '08:00'
  end_time    TEXT NOT NULL,       -- '12:00'
  sort_order  INTEGER DEFAULT 0
);
```

### 2.3 space_time_zone_pricing（スペース別時間帯料金）
```sql
CREATE TABLE space_time_zone_pricing (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL REFERENCES spaces(id),
  zone_name     TEXT NOT NULL,       -- '午前'
  zone_start    TEXT NOT NULL,       -- '08:00'
  zone_end      TEXT NOT NULL,       -- '12:00'
  weekday_rate  INTEGER NOT NULL,    -- 平日単価
  weekend_rate  INTEGER NOT NULL,    -- 土日祝単価
  sort_order    INTEGER DEFAULT 0
);
```
- スペースに個別設定がない場合は共通デフォルト（time_zones）+ 従来のspace_pricingの単価を使用
- 時間帯が1つだけのスペースは全時間同一料金として動作

### 2.4 seasonal_pricing（季節料金）
```sql
CREATE TABLE seasonal_pricing (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,        -- 'GW'
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  surcharge_pct  INTEGER NOT NULL,     -- 30 = +30%
  is_active      BOOLEAN DEFAULT true,
  created_at     TEXT DEFAULT (datetime('now'))
);
```
- 全スペース共通で適用
- 複数日予約の場合、日ごとに該当/非該当を判定

### 2.5 campaigns（キャンペーン割引）
```sql
CREATE TABLE campaigns (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  discount_type   TEXT NOT NULL,       -- 'percent' or 'fixed'
  discount_value  INTEGER NOT NULL,
  apply_weekday   BOOLEAN DEFAULT true,
  apply_weekend   BOOLEAN DEFAULT true,
  space_id        TEXT,                -- NULLなら全スペース対象
  is_active       BOOLEAN DEFAULT true
);
```
- 割引クーポンとの併用不可（クーポン優先）

### 2.6 calendar_holidays（祝日・全体休業日）
```sql
CREATE TABLE calendar_holidays (
  id    TEXT PRIMARY KEY,
  date  TEXT NOT NULL UNIQUE,
  name  TEXT,
  type  TEXT NOT NULL    -- 'holiday'(土日祝料金適用) / 'custom'(同) / 'closed'(予約不可)
);
```
- 国民の祝日一括登録機能あり（内閣府データ基準）
- お盆・年末年始は手動で'custom'/'closed'として追加

### 2.7 space_closures（スペース固有の休業日）
```sql
CREATE TABLE space_closures (
  id        TEXT PRIMARY KEY,
  space_id  TEXT NOT NULL REFERENCES spaces(id),
  date      TEXT NOT NULL,
  reason    TEXT,
  UNIQUE(space_id, date)
);
```
- calendar_holidaysと合わせて2層構造で判定

### 2.8 booking_groups（予約グループ）
```sql
CREATE TABLE booking_groups (
  id                TEXT PRIMARY KEY,
  booking_number    TEXT UNIQUE NOT NULL,  -- '20260420-001'形式
  customer_id       TEXT REFERENCES customers(id),
  space_id          TEXT NOT NULL REFERENCES spaces(id),
  event_name        TEXT NOT NULL,         -- イベント名（必須、サイネージ表示用）
  total_amount      INTEGER NOT NULL,
  payment_method    TEXT,                  -- 'card' / 'invoice'
  status            TEXT NOT NULL DEFAULT 'confirmed',  -- 'confirmed'/'cancelled'/'completed'
  source            TEXT DEFAULT 'web',    -- 'web'/'admin'/'google_calendar'
  reschedule_count  INTEGER DEFAULT 0,     -- セルフ日時変更の実行回数（1回まで）
  created_at        TEXT DEFAULT (datetime('now'))
);
```

#### 予約番号の採番ルール
- 形式: `YYYYMMDD-NNN`（例: 20260426-001）
- 当日の連番を自動採番
- booking_numberカラムにUNIQUE制約で重複防止
- 同時予約時はDBのUNIQUE制約でリトライして次の番号を採番

### 2.9 bookings（個別予約・1日分=1レコード）
```sql
CREATE TABLE bookings (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES booking_groups(id),
  space_id          TEXT NOT NULL REFERENCES spaces(id),
  date              TEXT NOT NULL,
  start_time        TEXT NOT NULL,         -- '10:00'
  end_time          TEXT NOT NULL,         -- '18:00'
  billable_hours    INTEGER NOT NULL,      -- 課金時間（最低利用・切り上げ考慮）
  rate              INTEGER,               -- 適用単価（時間帯別の場合はNULL、price_breakdownで管理）
  price             INTEGER NOT NULL,      -- スペース利用料金
  has_storage       BOOLEAN DEFAULT false,
  storage_before_h  INTEGER DEFAULT 0,
  storage_after_h   INTEGER DEFAULT 0,
  storage_fee       INTEGER DEFAULT 0,
  google_event_id   TEXT,
  status            TEXT NOT NULL DEFAULT 'confirmed',  -- 'confirmed'/'cancelled'/'blocked'/'held'
  block_reason      TEXT,                  -- GCal直接追加時のタイトル
  source            TEXT DEFAULT 'web'
);
```

### 2.10 options（オプションマスタ）
```sql
CREATE TABLE options (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,       -- '家具'/'映像'/'音響'等
  type        TEXT NOT NULL,       -- 'toggle' or 'quantity'
  price_type  TEXT NOT NULL,       -- 'free' / 'fixed' / 'per_unit'
  unit_price  INTEGER DEFAULT 0,
  unit_label  TEXT,                -- '脚'/'台'等
  max_qty     INTEGER,             -- 1予約あたりの上限
  stock_total INTEGER,             -- 総在庫数（NULLなら無制限）。日単位で集計
  scope       TEXT NOT NULL,       -- 'per_booking' / 'per_group'
  sort_order  INTEGER DEFAULT 0,
  is_active   BOOLEAN DEFAULT true
);
```
- 管理者が管理画面からいつでも追加・編集・非公開化可能
- カテゴリも自由に追加可能
- 在庫は日単位で計算（同日の全予約における利用数合計がstock_totalを超えないよう制御）

### 2.11 space_options（スペース×オプション紐付け）
```sql
CREATE TABLE space_options (
  space_id   TEXT NOT NULL REFERENCES spaces(id),
  option_id  TEXT NOT NULL REFERENCES options(id),
  is_active  BOOLEAN DEFAULT true,
  PRIMARY KEY (space_id, option_id)
);
```

### 2.12 booking_option_selections（予約オプション選択）
```sql
CREATE TABLE booking_option_selections (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT,                  -- 日程別オプション時
  group_id    TEXT,                  -- 全体オプション時
  option_id   TEXT NOT NULL REFERENCES options(id),
  quantity    INTEGER DEFAULT 1,
  subtotal    INTEGER NOT NULL
);
```

### 2.13 customers（顧客）
```sql
CREATE TABLE customers (
  id                      TEXT PRIMARY KEY,
  email                   TEXT UNIQUE NOT NULL,
  password_hash           TEXT,                -- NULLならゲスト
  is_registered           BOOLEAN DEFAULT false,
  company_name            TEXT,
  contact_name            TEXT NOT NULL,
  phone                   TEXT NOT NULL,
  postal_code             TEXT,
  address                 TEXT,
  invoice_number          TEXT,                -- 適格請求書番号
  status_id               TEXT DEFAULT 'general' REFERENCES customer_status_config(id),
  line_user_id            TEXT,
  point_balance           INTEGER DEFAULT 0,
  is_blocked              BOOLEAN DEFAULT false,
  blocked_reason          TEXT,
  blocked_at              TEXT,
  blocked_by              TEXT,
  auto_upgrade_disabled   BOOLEAN DEFAULT false,
  staff_memo              TEXT,                -- 社内メモ（GCalイベント説明にも表示）
  created_at              TEXT DEFAULT (datetime('now')),
  last_login_at           TEXT
);
```

### 2.14 customer_status_config（顧客ステータス設定）
```sql
CREATE TABLE customer_status_config (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,       -- '一般'/'優良'/'VIP'
  sort_order                INTEGER DEFAULT 0,
  can_self_cancel           BOOLEAN DEFAULT false,
  cancel_deadline_days      INTEGER,
  can_self_reschedule       BOOLEAN DEFAULT false,
  reschedule_deadline_days  INTEGER,
  auto_upgrade_threshold    INTEGER,             -- 自動昇格に必要な利用回数（NULLなら自動昇格なし）
  is_default                BOOLEAN DEFAULT false
);
```

デフォルト値:
| 操作 | 一般 | 優良 | VIP |
|------|------|------|-----|
| セルフキャンセル | 不可 | 可能（7日前まで） | 可能（3日前まで） |
| セルフ日時変更 | 不可 | 不可 | 可能（3日前まで） |
| セルフオプション変更 | 可能（期限内） | 可能（期限内） | 可能（期限内） |
| 自動昇格 | 5回で優良へ | VIPへの自動昇格なし | - |

### 2.15 customer_status_log（ステータス変更履歴）
```sql
CREATE TABLE customer_status_log (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  old_status_id TEXT,
  new_status_id TEXT NOT NULL,
  change_type   TEXT NOT NULL,     -- 'auto' / 'manual'
  changed_by    TEXT,              -- manual時の管理者ID
  changed_at    TEXT DEFAULT (datetime('now'))
);
```

### 2.16 customer_favorites（お気に入りスペース）
```sql
CREATE TABLE customer_favorites (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  created_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (customer_id, space_id)
);
```

### 2.17 auth_sessions（認証セッション）
```sql
CREATE TABLE auth_sessions (
  token       TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  expires_at  TEXT NOT NULL
);
```

### 2.18 discount_coupons（割引クーポン）
```sql
CREATE TABLE discount_coupons (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),   -- 顧客紐付け必須
  name            TEXT NOT NULL,
  code            TEXT UNIQUE NOT NULL,
  discount_type   TEXT NOT NULL,       -- 'percent' or 'fixed'
  discount_value  INTEGER NOT NULL,
  total_hours     INTEGER NOT NULL,
  remaining_hours INTEGER NOT NULL,
  apply_to        TEXT DEFAULT 'space_only',
  valid_from      TEXT NOT NULL,
  valid_until     TEXT NOT NULL,
  staff_memo      TEXT,
  status          TEXT DEFAULT 'active',    -- 'active'/'exhausted'/'expired'
  created_by      TEXT,                     -- 発行管理者ID
  created_at      TEXT DEFAULT (datetime('now'))
);
```

### 2.19 coupon_spaces（割引クーポン対象スペース）
```sql
CREATE TABLE coupon_spaces (
  coupon_id TEXT NOT NULL REFERENCES discount_coupons(id),
  space_id  TEXT NOT NULL REFERENCES spaces(id),
  PRIMARY KEY (coupon_id, space_id)
);
```

### 2.20 ticket_products（チケット商品マスタ）
```sql
CREATE TABLE ticket_products (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  total_hours     INTEGER NOT NULL,
  price           INTEGER NOT NULL,
  validity_days   INTEGER NOT NULL,     -- 購入日から何日間有効
  is_active       BOOLEAN DEFAULT true,
  sort_order      INTEGER DEFAULT 0
);
```

### 2.21 ticket_product_spaces（チケット商品対象スペース）
```sql
CREATE TABLE ticket_product_spaces (
  product_id TEXT NOT NULL REFERENCES ticket_products(id),
  space_id   TEXT NOT NULL REFERENCES spaces(id),
  PRIMARY KEY (product_id, space_id)
);
```

### 2.22 tickets（顧客保有チケット）
```sql
CREATE TABLE tickets (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),  -- 顧客紐付け必須、本人限定
  product_id      TEXT REFERENCES ticket_products(id),
  name            TEXT NOT NULL,
  total_hours     INTEGER NOT NULL,
  remaining_hours INTEGER NOT NULL,
  valid_from      TEXT NOT NULL,
  valid_until     TEXT NOT NULL,
  status          TEXT DEFAULT 'active',     -- 'active'/'exhausted'/'expired'
  purchased_at    TEXT DEFAULT (datetime('now'))
);
```

### 2.23 ticket_spaces（チケット対象スペース）
```sql
CREATE TABLE ticket_spaces (
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  space_id  TEXT NOT NULL REFERENCES spaces(id),
  PRIMARY KEY (ticket_id, space_id)
);
```
- チケットは必ずスペース指定（全スペース共通は不可）

### 2.24 coupon_usage / ticket_usage（利用履歴）
```sql
CREATE TABLE coupon_usage (
  id               TEXT PRIMARY KEY,
  coupon_id        TEXT NOT NULL REFERENCES discount_coupons(id),
  booking_id       TEXT NOT NULL REFERENCES bookings(id),
  hours_consumed   INTEGER NOT NULL,
  original_price   INTEGER NOT NULL,
  discounted_price INTEGER NOT NULL,
  used_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE ticket_usage (
  id               TEXT PRIMARY KEY,
  ticket_id        TEXT NOT NULL REFERENCES tickets(id),
  booking_id       TEXT NOT NULL REFERENCES bookings(id),
  hours_consumed   INTEGER NOT NULL,
  original_price   INTEGER NOT NULL,
  discounted_price INTEGER NOT NULL,
  used_at          TEXT DEFAULT (datetime('now'))
);
```

### 2.25 point_log（ポイント履歴）
```sql
CREATE TABLE point_log (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  type          TEXT NOT NULL,       -- 'earn' / 'use' / 'manual_add' / 'manual_remove'
  amount        INTEGER NOT NULL,    -- ポイント数（正の値）
  balance_after INTEGER NOT NULL,
  group_id      TEXT,                -- 予約に紐づく場合
  description   TEXT,
  created_by    TEXT,                -- manual時の管理者ID
  created_at    TEXT DEFAULT (datetime('now'))
);
```

### 2.26 custom_fields（カスタムフィールド定義）
```sql
CREATE TABLE custom_fields (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  label       TEXT NOT NULL,
  field_type  TEXT NOT NULL,     -- 'text' / 'select' / 'checkbox'
  options     TEXT,              -- JSON配列（select/checkbox時）
  is_required BOOLEAN DEFAULT false,
  sort_order  INTEGER DEFAULT 0,
  is_active   BOOLEAN DEFAULT true
);
```

### 2.27 custom_field_values（カスタムフィールド回答）
```sql
CREATE TABLE custom_field_values (
  id       TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES booking_groups(id),
  field_id TEXT NOT NULL REFERENCES custom_fields(id),
  value    TEXT
);
```

### 2.28 documents（書類管理）
```sql
CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES booking_groups(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  type          TEXT NOT NULL,          -- 'invoice' / 'receipt'
  booking_number TEXT NOT NULL,
  pdf_url       TEXT,
  public_token  TEXT UNIQUE NOT NULL,   -- 個別URL用トークン（推測不可能なランダム文字列）
  total_amount  INTEGER NOT NULL,
  issued_at     TEXT DEFAULT (datetime('now')),
  status        TEXT DEFAULT 'issued'   -- 'issued' / 'voided'
);
```
- 請求書: 予約確定時に自動発行（1予約グループ=1通にまとめる）
- 領収書: カード決済時は自動発行、請求書払い時は管理者が入金確認後に手動発行
- 個別URL: `https://space-albe.com/documents/[public_token]`（認証不要）
- マイページからPDFダウンロード・URLコピー可能

### 2.29 booking_adjustments（差額履歴）
```sql
CREATE TABLE booking_adjustments (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES booking_groups(id),
  type             TEXT NOT NULL,        -- 'surcharge' / 'refund'
  amount           INTEGER NOT NULL,
  payment_method   TEXT NOT NULL,        -- 'stripe' / 'invoice' / 'bank_transfer'
  requested_date   TEXT,
  requested_start  TEXT,
  requested_end    TEXT,
  bank_name        TEXT,
  branch_name      TEXT,
  account_type     TEXT,                 -- 'normal' / 'checking'
  account_number   TEXT,
  account_holder   TEXT,
  status           TEXT DEFAULT 'pending',  -- 'pending' / 'completed' / 'rejected'
  created_at       TEXT DEFAULT (datetime('now')),
  completed_at     TEXT
);
```

### 2.30 cancel_policies（キャンセルポリシー）
```sql
CREATE TABLE cancel_policies (
  id          TEXT PRIMARY KEY,
  space_id    TEXT,                -- NULLなら共通ポリシー
  days_before INTEGER NOT NULL,   -- 利用日の何日前（0=当日）
  charge_pct  INTEGER NOT NULL,   -- キャンセル料率（%）
  sort_order  INTEGER DEFAULT 0
);
```
- 共通ポリシー + スペース個別上書き

### 2.31 cancellation_log（キャンセル履歴）
```sql
CREATE TABLE cancellation_log (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES booking_groups(id),
  booking_id        TEXT NOT NULL REFERENCES bookings(id),
  customer_id       TEXT NOT NULL,
  cancelled_at      TEXT DEFAULT (datetime('now')),
  days_before       INTEGER NOT NULL,
  charge_pct        INTEGER NOT NULL,
  original_price    INTEGER NOT NULL,
  cancel_fee        INTEGER NOT NULL,
  collection_status TEXT DEFAULT 'pending'   -- 'pending' / 'collected'
);
```

### 2.32 blacklist（ブラックリスト）
```sql
CREATE TABLE blacklist (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,       -- 'email' / 'phone'
  value       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  source      TEXT NOT NULL,       -- 'auto' / 'manual'
  customer_id TEXT,                -- 自動登録時の元顧客ID
  created_by  TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(type, value)
);
```
- 顧客をブラックリストに追加すると、メール+電話が自動でblacklistテーブルにも登録
- 別アカウント作成での再予約も防止

### 2.33 admin_users（管理者）
```sql
CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',  -- 'owner' / 'manager' / 'staff'
  is_active     BOOLEAN DEFAULT true
);
```

### 2.34 space_notifications（スペース別通知先）
```sql
CREATE TABLE space_notifications (
  id              TEXT PRIMARY KEY,
  space_id        TEXT NOT NULL REFERENCES spaces(id),
  email           TEXT NOT NULL,
  on_booking      BOOLEAN DEFAULT true,
  on_cancel       BOOLEAN DEFAULT true,
  on_reschedule   BOOLEAN DEFAULT true,
  UNIQUE(space_id, email)
);
```

### 2.35 notification_log（通知ログ）
```sql
CREATE TABLE notification_log (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,     -- 'booking_confirmed'/'reminder'/'cancelled'/'rescheduled'/'invoice_issued'
  recipient   TEXT NOT NULL,     -- 'customer' / 'admin'
  channel     TEXT NOT NULL,     -- 'email' / 'line'
  customer_id TEXT,
  group_id    TEXT,
  status      TEXT NOT NULL,     -- 'sent' / 'failed' / 'skipped'
  skip_reason TEXT,
  sent_at     TEXT DEFAULT (datetime('now'))
);
```

### 2.36 email_templates（メールテンプレート）
```sql
CREATE TABLE email_templates (
  id            TEXT PRIMARY KEY,
  type          TEXT UNIQUE NOT NULL,
  subject       TEXT NOT NULL,
  body_template TEXT NOT NULL,       -- {{customer_name}}等のプレースホルダ
  is_active     BOOLEAN DEFAULT true,
  updated_at    TEXT
);
```

### 2.37 sync_state（Google Calendar同期状態）
```sql
CREATE TABLE sync_state (
  space_id        TEXT PRIMARY KEY REFERENCES spaces(id),
  calendar_id     TEXT NOT NULL,
  channel_id      TEXT,
  channel_expiry  TEXT,
  last_sync_token TEXT,
  last_synced_at  TEXT
);
```

### 2.38 signage_tokens（サイネージ認証）
```sql
CREATE TABLE signage_tokens (
  space_id   TEXT PRIMARY KEY REFERENCES spaces(id),
  token      TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 2.39 system_settings（システム設定）
```sql
CREATE TABLE system_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```
主な設定キー:
- `default_booking_deadline_days`: 予約受付締切のデフォルト（0=当日まで）
- `monthly_cancel_limit`: 月間セルフキャンセル上限（デフォルト: 2）
- `availability_threshold`: カレンダー稼働状況の○/△閾値（デフォルト: 50%）
- `reminder_time`: 前日リマインダー送信時刻（デフォルト: 18:00）
- `point_rate`: ポイント付与率（デフォルト: 1%）
- `default_cancel_policy`: 共通キャンセルポリシー使用フラグ

---

## 3. 料金計算ロジック

### 3.1 計算フロー（優先順位）
1. **休業日チェック**: space_closures + calendar_holidays(type='closed') → 予約不可
2. **予約受付締切チェック**: 利用日 - 今日 < booking_deadline_days → 予約不可
3. **予約可能期間チェック**: 利用日 - 今日 > booking_horizon_days → 予約不可
4. **曜日区分判定**: 祝日/独自休日→weekend料金、土日→weekend料金、平日→weekday料金
5. **時間帯別料金計算**: 利用時間を時間帯ごとに分割し、各時間帯ごとに1時間単位で切り上げて課金
6. **季節料金加算**: seasonal_pricingに該当 → 各時間帯の金額にsurcharge_pct%を加算
7. **最低利用時間チェック**: 利用時間 < min_hours → min_hoursで計算
8. **残置料金算出**: 連日予約で残置ありの場合、営業時間内の残置時間を同一単価で加算
9. **割引クーポン or チケット or ポイント適用**（いずれか1つのみ）: スペース料金+残置料金に対してのみ
10. **キャンペーン割引**: 割引クーポンとは併用不可（クーポン優先）。チケットとは残時間超過分のみ可
11. **オプション料金加算**: 割引対象外
12. **合計金額確定**

### 3.2 予約開始・終了時刻のルール
- 開始/終了は毎時00分または30分のみ
- 課金は1時間単位（30分でも切り上げ）
- 営業時間外にはみ出す予約は不可（最終開始=営業終了-30分）

### 3.3 時間帯をまたぐ場合の課金
各時間帯ごとに利用時間を計算し、それぞれ1時間単位で切り上げて課金（シンプル方式）。

### 3.4 残置料金の計算
- 連日予約で残置ありの場合のみ発生
- 営業時間内を通常の時間単価で課金
  - 初日: 利用終了 → 営業終了
  - 中間日: 営業開始 → 利用開始 + 利用終了 → 営業終了
  - 最終日: 営業開始 → 利用開始
- 残置料金もチケット・割引クーポンの適用対象

### 3.5 割引クーポンとチケットの比較
| 項目 | 割引クーポン | チケット |
|------|-------------|---------|
| 概要 | 管理者が発行する特別割引 | 顧客が購入する時間プリペイド |
| 発行/購入 | 管理者のみ | 顧客がマイページから購入 |
| 顧客登録 | 必須 | 必須 |
| ログイン | 必須 | 必須 |
| 本人限定 | はい（譲渡不可） | はい（譲渡不可） |
| 対象スペース | 管理者が指定 | スペースごとに販売（全スペース共通は不可） |
| 割引/料金 | ○%OFF or ¥引き | 時間内は¥0 |
| 消費単位 | 1時間=1h消費 | 1時間=1h消費 |
| 適用範囲 | スペース料金+残置料金のみ | スペース料金+残置料金のみ |
| オプション | 対象外 | 対象外 |
| ゲスト利用 | 不可 | 不可 |

### 3.6 ポイント
- 付与: 最終支払い金額の1%（1円単位切り捨て）
- 価値: 1ポイント = 1円
- 有効期限: 無期限
- 用途: 次回予約のスペース料金値引きのみ
- チケット購入時の使用: 不可
- チケット・割引クーポンとの併用: 不可
- 付与タイミング: 予約ステータスがcompletedになった時点で自動付与
- 管理者による手動付与・取消も可能

### 3.7 併用ルール
| 組み合わせ | 可否 |
|-----------|------|
| 割引クーポン + キャンペーン | 不可（クーポン優先） |
| チケット + キャンペーン | 条件付き可（残時間超過分のみ） |
| 割引クーポン + チケット | 不可（クーポン優先） |
| 割引クーポン + ポイント | 不可 |
| チケット + ポイント | 不可 |
| ポイント + キャンペーン | 併用可 |

---

## 4. 予約フロー（カレンダーファーストUI）

### 4.1 全体ステップ
1. **STEP 0**: スペース選択（カード形式、お気に入りマーク対応）
2. **STEP 1**: 月カレンダー表示
3. **STEP 2**: 日付クリック → 時間選択モーダル
4. **STEP 3**: カートに追加 → カレンダーに戻り複数日選択可能
5. **STEP 4**: 残置確認（連日予約がある場合のみ）
6. **STEP 5**: オプション選択
7. **STEP 6**: 確認画面（料金内訳、チケットコード入力、ポイント使用、キャンセルポリシー表示）
8. **STEP 7**: 顧客情報入力（ログイン or ゲスト + カスタムフィールド）
9. **STEP 8**: 予約完了 + アカウント作成促進

### 4.2 カレンダー表示仕様
- 月表示がメイン
- 各日に稼働状況を自動表示: ○（空き50%以上）、△（空き1-49%）、✕（満枠）
- 閾値は管理画面で変更可能
- 色分け: 平日（白）、土日祝（黄）、休業日（グレー）、選択中（青）、季節料金（オレンジ枠）
- ブロック単位スペースは予約ありで✕、なしで○

### 4.3 時間選択モーダル
- 開始/終了ドロップダウン（30分刻み、営業時間内のみ）
- 空き状況バー: 時間帯ごとに空き/予約済/選択中を色分け
- **空き枠タップで時間入力**: 1回目タップ→開始時刻、2回目タップ→終了時刻
- リセットボタン（×マーク）で選択をクリア
- ドロップダウンでの手動選択も引き続き可能
- 最低利用時間の警告メッセージ
- 時間帯別料金のプレビュー（内訳表示）
- ブロック単位スペースはモーダルなし（日付クリックで直接カート追加）

### 4.4 残置確認
- カート内の日程から連日グループを自動検出
- 連日グループごとに残置する/しないを選択
- 連日でない日程には残置オプション非表示
- 残置料金の内訳をリアルタイム表示

### 4.5 オプション選択
- カテゴリタブで絞り込み
- 全日程共通（per_group）と日程別（per_booking）を分離表示
- 在庫数を「残○」として表示（在庫0は選択不可）
- 「前の日からコピー」ボタン

### 4.6 確認画面
- 全料金内訳表示（時間帯別の内訳含む）
- チケット/割引クーポンコード入力欄
- ポイント利用入力欄（チケット/クーポン適用時はグレーアウト）
- キャンセルポリシーの段階表示
- 獲得予定ポイント表示

### 4.7 顧客情報入力
- ログイン or ゲスト選択
- 必須項目: お名前、メールアドレス、電話番号、イベント名
- 任意項目: 会社名
- スペースにカスタムフィールドがある場合は追加表示
- ブラックリストチェック（メール・電話一致で予約拒否）
- 拒否メッセージ:「申し訳ございませんが、ご予約をお受けすることができません。」（理由・連絡先は表示しない）

### 4.8 ゲスト予約とアカウント昇格
- ゲストは名前・メール・電話のみで予約可能
- 予約完了後にパスワード設定を促す
- 同じメールで再度ゲスト予約 → 既存レコードに紐付け
- ブラックリストチェックはアカウント作成時にも実行

### 4.9 ゲスト vs 会員の機能差
| 機能 | ゲスト | 会員 |
|------|--------|------|
| 予約する | 可 | 可 |
| チケット利用/購入 | 不可 | 可 |
| 割引クーポン利用 | 不可 | 可 |
| ポイント付与/利用 | 不可 | 可 |
| セルフキャンセル/変更 | 不可 | ステータスに依存 |
| オプション変更 | 不可 | 可 |
| 再予約 | 不可 | 可 |
| 予約履歴閲覧 | 不可 | 可 |
| PDF DL | メール添付のみ | マイページ |
| お気に入り登録 | 不可 | 可 |

---

## 5. 顧客管理

### 5.1 マイページ機能
- **ダッシュボード**: 次回の予約、お気に入りスペース、保有ポイント、チケット/クーポン残高
- **予約履歴**: 一覧（ステータス別フィルタ）、詳細、セルフキャンセル、セルフ日時変更、セルフオプション変更、再予約
- **マイチケット/割引クーポン**: 残時間プログレスバー、利用履歴、チケット購入ボタン
- **書類**: 請求書/領収書のPDFダウンロード、URLコピー
- **アカウント設定**: 基本情報編集、パスワード変更、会員ランク表示、ログアウト

### 5.2 再予約機能
過去の予約内容（スペース・時間帯・オプションと数量）をプリセットした状態で予約画面に遷移し、日程だけ新たに選ぶ。オプションの変更も可能。

### 5.3 セルフ日時変更ルール
- VIPのみ可能
- 1予約につき1回まで
- ステータスの期限設定に従う
- 変更時に注意書き表示:「予約変更はお一人様1回までです。変更確定後、再度の日時変更は変更リクエストフォームからのお申し込みとなります。」
- 2回目以降はグレーアウトし、変更リクエストフォームへ誘導

### 5.4 セルフ日時変更の差額処理
- **差額プラス（値上がり）**:
  - カード決済: 差額決済完了で即時確定
  - 請求書希望: 即時確定しない。管理者にメール→請求書手動発行→入金確認→管理者が手動変更
- **差額マイナス（値下がり）**: 常に即時確定。返金先口座入力→管理者に返金依頼メール→管理者が銀行振込
- **差額ゼロ**: 即時確定

### 5.5 セルフオプション変更ルール
- 全会員が可能（ステータス不問）
- 回数制限なし
- 期限は顧客ステータスの期限設定に従う
- 差額処理は日時変更と同じ

### 5.6 セルフキャンセルルール
- 優良/VIPのみ可能
- 月2回まで（system_settings.monthly_cancel_limit）
- 3回目以降は変更リクエストフォームへ誘導
- キャンセル実行時にキャンセル料を自動計算して表示
- キャンセル料は管理者が手動徴収
- キャンセル実行時に残回数を表示

### 5.7 変更リクエストフォーム
日時変更・オプション変更・キャンセルの全てで、セルフ操作不可の場合はこのフォームに誘導:
- 変更内容の種別選択（日時変更/オプション変更/キャンセル/その他）
- 希望内容の自由記述
- 送信→管理者にメール通知→顧客に受付確認メール→管理者が手動対応
- 電話での対応は一切行わない（トラブル防止）

### 5.8 会員ランク自動昇格
- 一般→優良: 利用回数5回以上で自動昇格（回数は管理画面で変更可能）
- 優良→VIP: 管理者が手動で設定（自動昇格なし）
- 管理者はいつでも任意にランク変更可能
- 「自動昇格を無効にする」チェックボックスで個別に除外可能
- 昇格時に顧客にメール通知

---

## 6. 管理画面

### 6.1 権限設計
| 操作 | owner | manager | staff |
|------|-------|---------|-------|
| 料金・オプション変更 | 可 | 可 | 不可 |
| スペース設定変更 | 可 | 可 | 不可 |
| 予約の確定・キャンセル | 可 | 可 | 可 |
| 代理予約の追加 | 可 | 可 | 可 |
| 顧客情報閲覧 | 可 | 可 | 可 |
| 割引クーポン発行 | 可 | 可 | 不可 |
| スタッフ管理 | 可 | 不可 | 不可 |
| キャンセルポリシー変更 | 可 | 不可 | 不可 |
| システム設定変更 | 可 | 不可 | 不可 |
| ブラックリスト管理 | 可 | 可 | 不可 |

### 6.2 管理画面メニュー
- **ダッシュボード**: 今日の予約一覧、今月の売上サマリー、直近のキャンセル、変更リクエスト一覧
- **予約管理**: カレンダー表示（全スペース横断）、手動追加・編集、ステータス変更、代理予約
- **スペース設定**: 追加・編集・非公開化、営業時間、時間帯別料金、Google Calendar紐付け、予約可能期間、予約受付締切、カスタムフィールド、サイネージ設定、通知先メール
- **料金設定**: 課金方式、時間帯別料金、最低利用時間、季節料金
- **オプション設定**: 追加・編集・非公開化、カテゴリ管理、スペース紐付け、在庫管理
- **顧客管理**: 一覧・検索、詳細（予約履歴・書類）、ステータス変更、社内メモ、ブラックリスト追加
- **割引クーポン管理**: 発行・一覧・停止
- **チケット管理**: 商品設定・販売状況
- **書類管理**: 請求書・領収書一覧、発行状況、再発行
- **カレンダー管理**: 祝日・休業日（共通+個別）、祝日一括登録
- **ブラックリスト**: 一覧・手動追加・削除
- **データエクスポート**: 予約・顧客・売上をExcel出力
- **システム設定**: スタッフアカウント、通知設定、メールテンプレート、キャンセルポリシー、セルフキャンセル回数制限、カレンダー表示設定、ポイント設定、予約受付締切デフォルト、会員ランク自動昇格設定

### 6.3 顧客メモ（社内メモ）の表示箇所
- 管理画面の顧客詳細: 編集可能
- 管理画面の予約詳細: 表示のみ
- Googleカレンダーのイベント説明欄: 表示
- 顧客への通知メール: 表示しない（転送リスク防止）
- 管理者への通知メール: 表示しない（転送リスク防止）

---

## 7. 通知設計

### 7.1 通知一覧
| トリガー | 顧客メール | 顧客LINE | 管理者メール | 管理者LINE |
|---------|-----------|---------|------------|-----------|
| 予約確定 | ○ | ○ | ○（スペース別通知先） | ○ |
| 前日リマインダー | ○ | ○ | - | - |
| キャンセル完了 | ○ | ○ | ○（スペース別通知先+キャンセル料情報） | ○ |
| 日時変更完了 | ○ | ○ | ○（スペース別通知先） | ○ |
| オプション変更完了 | ○ | ○ | ○（スペース別通知先） | ○ |
| 請求書発行 | ○ | - | - | - |
| 変更リクエスト受付 | ○（受付確認） | - | ○（対応依頼） | ○ |
| 差額請求書発行依頼 | - | - | ○（対応手順付き） | ○ |
| 返金依頼 | - | - | ○（口座情報付き） | ○ |
| 会員ランクアップ | ○ | ○ | - | - |

### 7.2 前日リマインダー
- 毎日指定時刻（デフォルト18:00）に翌日の予約を送信
- 予約作成日が当日の場合はスキップ（当日予約への前日リマインダー防止）
- 複数日一括予約の場合も日ごとに判定

### 7.3 スペース別通知先
- スペースごとに通知先メールアドレスを複数設定可能
- 通知する内容もスペース別に制御

---

## 8. Google Calendar 双方向同期

### 8.1 構成
- 各スペースに専用のGoogleカレンダーを割り当て
- システム→GCal: 予約確定/変更/キャンセル時にイベント作成/更新/削除
- GCal→システム: Push通知（Webhook）で変更検知→D1に反映
- 5分間隔のポーリングでWebhookの取りこぼしを補完

### 8.2 外部追加の処理
- GCal直接追加イベントはsource='google_calendar'、status='blocked'としてD1に取り込み
- イベントタイトルがblock_reasonに格納

### 8.3 競合防止
- 予約確定直前にD1 + Google Calendar APIの両方で空き確認
- どちらかに予約があればエラー

### 8.4 イベント命名規則
- 予約: `[ALBE] 会社名 / 担当者名 様`
- 残置: `[ALBE残置] 会社名 / 担当者名 様`
- 説明欄: 予約番号、イベント名、利用時間、オプション、金額、社内メモ（メモがある場合）

### 8.5 Webhook自動更新
- Cloudflare Workers Cron Triggerで毎日1回、有効期限が近いWebhookを自動再登録

---

## 9. デジタルサイネージ

### 9.1 仕様
| 項目 | 仕様 |
|------|------|
| 設置場所 | 各スペース入口に1台ずつ |
| 画面 | 横型（TVモニター） |
| 表示内容 | 当日の予約一覧（確定済みのみ） |
| 表示名 | イベント名を優先表示 |
| 終了予約 | 表示しない（自動非表示） |
| 更新間隔 | 5分ごとに自動リロード |
| 予約なし | 「本日の予約はありません」 |
| 全予約終了 | 「本日の予約は全て終了しました」 |
| ステータス | 利用中（緑）/ これから（無印）を自動判定 |
| 実装 | ブラウザでURLアクセス（簡易トークン認証） |
| APIエンドポイント | GET /api/signage/[space_id]?token=xxxx |

---

## 10. データエクスポート

### 10.1 エクスポート対象
| 種別 | 主な項目 | 形式 |
|------|---------|------|
| 予約データ | 予約番号、日付、スペース、顧客、利用時間、料金内訳、ステータス | Excel |
| 顧客データ | 顧客ID、会社名、担当者名、連絡先、利用回数、累計金額、最終利用日 | Excel |
| 売上データ | 日別/月別売上、スペース別、オプション売上、割引額、キャンセル数 | Excel |

フィルタ: 期間（今月/先月/今期/前期/年間）、スペース、ステータス

---

## 11. API一覧

### 11.1 顧客向けAPI
| メソッド | パス | 説明 |
|---------|------|------|
| GET | /api/spaces | スペース一覧取得 |
| GET | /api/spaces/:id/slots | 空き枠取得（月単位、稼働状況○△✕含む） |
| GET | /api/spaces/:id/options | オプション一覧（在庫情報含む） |
| POST | /api/bookings | 予約作成（一括） |
| POST | /api/bookings/:id/cancel | 予約キャンセル |
| POST | /api/bookings/:id/reschedule | 予約日時変更 |
| POST | /api/bookings/:id/options | オプション変更 |
| POST | /api/bookings/:id/change-request | 変更リクエスト送信 |
| POST | /api/auth/register | 会員登録 |
| POST | /api/auth/login | ログイン |
| GET | /api/mypage/bookings | 予約履歴取得 |
| GET | /api/mypage/tickets | チケット一覧 |
| GET | /api/mypage/coupons | 割引クーポン一覧 |
| GET | /api/mypage/points | ポイント残高・履歴 |
| GET | /api/mypage/documents | 書類一覧 |
| GET | /api/mypage/favorites | お気に入りスペース一覧 |
| POST | /api/mypage/favorites | お気に入り追加/削除 |
| PUT | /api/mypage/profile | プロフィール更新 |
| PUT | /api/mypage/password | パスワード変更 |
| POST | /api/tickets/purchase | チケット購入 |
| POST | /api/tickets/validate | チケット/クーポンコード検証 |
| GET | /api/documents/:token | 書類PDF取得（認証不要） |
| GET | /api/ticket-products | 販売中チケット商品一覧 |

### 11.2 管理者向けAPI
| メソッド | パス | 説明 |
|---------|------|------|
| CRUD | /api/admin/spaces | スペース管理 |
| CRUD | /api/admin/options | オプション管理 |
| CRUD | /api/admin/pricing | 料金設定管理 |
| CRUD | /api/admin/time-zones | 時間帯設定管理 |
| CRUD | /api/admin/seasonal | 季節料金管理 |
| CRUD | /api/admin/holidays | 祝日/休業日管理 |
| CRUD | /api/admin/campaigns | キャンペーン管理 |
| CRUD | /api/admin/cancel-policies | キャンセルポリシー管理 |
| CRUD | /api/admin/coupons | 割引クーポン管理 |
| CRUD | /api/admin/ticket-products | チケット商品管理 |
| CRUD | /api/admin/custom-fields | カスタムフィールド管理 |
| GET | /api/admin/customers | 顧客一覧/検索 |
| PUT | /api/admin/customers/:id/status | ステータス変更 |
| PUT | /api/admin/customers/:id/block | ブラックリスト追加 |
| POST | /api/admin/customers/:id/points | ポイント手動操作 |
| CRUD | /api/admin/bookings | 予約管理（代理予約含む） |
| POST | /api/admin/bookings/:id/approve-change | 変更リクエスト承認 |
| POST | /api/admin/documents/:id/issue-receipt | 領収書手動発行 |
| GET | /api/admin/export/:type | データエクスポート |
| CRUD | /api/admin/staff | スタッフ管理 |
| CRUD | /api/admin/blacklist | ブラックリスト管理 |
| CRUD | /api/admin/notifications | 通知先管理 |
| CRUD | /api/admin/email-templates | メールテンプレート管理 |
| GET/PUT | /api/admin/settings | システム設定 |
| GET | /api/admin/sync-status | Google Calendar同期状況 |
| POST | /api/admin/sync/manual | 手動同期実行 |
| GET | /api/admin/change-requests | 変更リクエスト一覧 |

### 11.3 その他API
| メソッド | パス | 説明 |
|---------|------|------|
| GET | /api/signage/:space_id | サイネージ用当日予約取得 |
| POST | /api/sync/webhook | Google Calendar Webhook受信 |

---

## 12. Booklyからのデータ移行
- wp_bookly_customersテーブルからエクスポート→D1のcustomersテーブルにインポート
- 全移行顧客はis_registered=false（ゲスト）として登録
- 初回ログイン時にパスワード設定を促す（メールでリセットリンク送信）
- Booklyの予約データは参照用として残し、段階的に役割を縮小

---

## 13. ブラックリスト管理
- 顧客詳細で「ブラックリストに追加する」チェック→is_blocked=true + blacklistテーブルにメール・電話を自動登録
- 管理画面から未登録ユーザのメール・電話を手動登録も可能
- 予約時・アカウント作成時にブラックリストチェック
- 拒否メッセージ:「申し訳ございませんが、ご予約をお受けすることができません。」（理由・連絡先は表示しない）

---

## 14. 用語集
| 用語 | 説明 |
|------|------|
| スペース | レンタル可能な施設 |
| 予約グループ | 1回の予約操作で作成される予約のまとまり（複数日含む） |
| 残置 | 連日予約時に利用時間外で荷物を残すことによるスペース占有 |
| チケット | 顧客が購入する時間プリペイド |
| 割引クーポン | 管理者が発行する特別割引 |
| ブロック課金 | 終日等のブロック単位で課金する方式 |
| カスタムフィールド | スペース固有の追加入力項目 |
| 稼働状況 | カレンダー上の○△✕表示 |
| 変更リクエスト | セルフ操作不可の場合にフォームから送信する変更依頼 |
| ブラックリスト | 予約を拒否する顧客のメール/電話のリスト |
