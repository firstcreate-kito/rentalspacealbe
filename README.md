# レンタルスペースALBE 両館比較LP

Google検索広告のランディングページ。**アルベホール名古屋**と**アルベ イベントスペース栄（仮称）**の
2施設を並べて比較・選択できるLP。素のHTML/CSS/最小限のJSで構成し、表示速度を最優先する。

- 設置先：`https://space-albe.com/lp/`（WordPressの外に静的設置）
- 仕様の詳細：リポジトリルートの [`CLAUDE.md`](./CLAUDE.md)

## ディレクトリ構成

```
.
├── CLAUDE.md              制作仕様書（正）
├── README.md              このファイル
└── lp/                    ← space-albe.com/lp/ にそのまま設置
    ├── index.html         LP本体
    └── assets/
        ├── css/style.css  白基調・最小限のスタイル
        ├── js/tracking.js 計測イベント（GA4 / Google広告）
        └── img/           画像（README参照。要WebP化）
```

## ローカル確認

```sh
cd lp && python3 -m http.server 8000
# → http://localhost:8000/
```

## 現在の状態：土台（スケルトン）

確定情報は反映済み。以下の**ブロッカーが確定してから本実装（B）**へ進む。

### 🔴 着手前に確定させる（本文中 `要確認` / `TODO` で該当箇所を明示）

- [ ] 栄のグランドオープン時期（記録「2027年11月」だが「2026年11月」の可能性）
- [ ] 栄の正式施設名（現状「（仮称）」）
- [ ] アルベホール名古屋の**面積数値**（比較表・詳細表で使用）
- [ ] アルベホール名古屋の実績写真（画像ファイル）
- [ ] 栄の画像 `sakae-image-01.png`（元PNG。WebP化して配置）
- [ ] 電話番号（仕様書に記載なし。ヘッダー・CTA・構造化データの `tel:` で使用）

### 🟡 実装と並行

- [ ] 計測タグの実ID差し替え（GA4 `G-XXXXXXX` / Google広告 `AW-XXXXXXXXX`）— `index.html` の `<head>` で有効化
- [ ] `/contact/` 側に hidden フィールド追加（`?venue=albe-hall` / `?venue=sakae` を受け取る／Contact Form 7想定）
- [ ] `/contact/` 送信完了ページのコンバージョンタグ設置確認
- [ ] LINEクリックのコンバージョン計測を既存アカウント設定に合わせる
- [ ] 栄のGoogleマップURL（オープン後）

## 実装済みの要件

- 必須セクション（FV／館の選択／料金／各館詳細／実績／アクセス／CTA）
- サイトリンク用アンカー：`#albe-hall` / `#sakae`（`#venues` `#pricing` `#contact` ほか）
- 計測イベントの器：`select_venue` / `to_form_click` / `line_click` / `tel_click` /
  `matterport_open` / `floorplan_download` / `gallery_open` / `view_pricing`（`data-track` 属性駆動）
- 構造化データ：`LocalBusiness`（各館）＋ `BreadcrumbList`
- レスポンシブ、スマホ追従CTA、`prefers-reduced-motion` 尊重、フォーカス可視化、スキップリンク
- 問い合わせ導線に館の別を引き継ぐURLパラメータ（`?venue=`）

運営：株式会社ファーストクリエイト
