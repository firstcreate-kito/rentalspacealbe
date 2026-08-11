# レンタルスペースALBE 両館比較LP

Google検索広告のランディングページ。**アルベホール名古屋**と**アルベ イベントスペース栄（仮称）**の
2施設を並べて比較・選択できるLP。素のHTML/CSS/最小限のJSで構成し、表示速度を最優先する。

- 設置先：`https://space-albe.com/lp/`（WordPressの外に静的設置）
- 仕様の詳細：[`CLAUDE.md`](./CLAUDE.md)

## ファイル構成（フラット構成）

すべて同じ階層に置く。`index.html` は同じ場所の `style.css` / `tracking.js` / 画像を参照する。

```
CLAUDE.md      制作仕様書（正）
README.md      このファイル
index.html     LP本体
style.css      白基調・最小限のスタイル
tracking.js    計測イベント（GA4 / Google広告）
（画像）        sakae-image-01-*.webp など。要WebP化（下記）
```

> サーバーへは、上記ファイルを `space-albe.com/lp/` フォルダにそのままアップロードする。

## ローカル確認

このフォルダで簡易サーバーを起動して開く。

```sh
python3 -m http.server 8000
# → http://localhost:8000/
```

## 現在の状態：土台（スケルトン）

確定情報は反映済み。以下の**ブロッカーが確定してから本実装**へ進む。
本文中の `要確認` / `TODO` が該当箇所。

### 🔴 着手前に確定させる

- [ ] 栄のグランドオープン時期（記録「2027年11月」だが「2026年11月」の可能性）
- [ ] 栄の正式施設名（現状「（仮称）」）
- [ ] アルベホール名古屋の**面積数値**（比較表・詳細表で使用）
- [ ] アルベホール名古屋の実績写真（画像ファイル）
- [ ] 栄の画像 `sakae-image-01`（元PNG。WebP化して配置）
- [ ] 電話番号（仕様書に記載なし。ヘッダー・CTA・構造化データの `tel:` で使用）

### 🟡 実装と並行

- [ ] 計測タグの実ID差し替え（GA4 `G-XXXXXXX` / Google広告 `AW-XXXXXXXXX`）— `index.html` の `<head>` で有効化
- [ ] `/contact/` 側に hidden フィールド追加（`?venue=albe-hall` / `?venue=sakae` を受け取る／Contact Form 7想定）
- [ ] `/contact/` 送信完了ページのコンバージョンタグ設置確認
- [ ] LINEクリックのコンバージョン計測を既存アカウント設定に合わせる
- [ ] 栄のGoogleマップURL（オープン後）

## 画像について（重要）

- 元画像（大サイズ・PNG）のまま公開しないこと。LCP悪化 → Google広告の品質スコア低下に直結。
- 栄の画像はWebPへ複数解像度（768 / 1280 / 1920px 程度）で書き出し、`index.html` の該当箇所を差し替える。
- ファーストビューに置く画像はLCP要素のため `loading="lazy"` を付けず `fetchpriority="high"` を付与。
- 栄の画像はAI生成イメージ。近傍に「イメージ」である旨の明記を維持し、
  実物と差異が出る部分（柱・床材・天井・照明）はスペック文言を画像の印象に引きずらせない。

## 実装済みの要件

- 必須セクション（FV／館の選択／料金／各館詳細／実績／アクセス／CTA）
- サイトリンク用アンカー：`#albe-hall` / `#sakae`（`#venues` `#pricing` `#contact` ほか）
- 計測イベントの器：`select_venue` / `to_form_click` / `line_click` / `tel_click` /
  `matterport_open` / `floorplan_download` / `gallery_open` / `view_pricing`（`data-track` 属性駆動）
- 構造化データ：`LocalBusiness`（各館）＋ `BreadcrumbList`
- レスポンシブ、スマホ追従CTA、`prefers-reduced-motion` 尊重、フォーカス可視化、スキップリンク
- 問い合わせ導線に館の別を引き継ぐURLパラメータ（`?venue=`）

運営：株式会社ファーストクリエイト
