# 画像アセット

このディレクトリに画像を配置します。**元画像（大サイズ・PNG）のまま公開しないこと。**
LCP悪化 → Google広告の品質スコア低下に直結します。

## 必要な画像

| ファイル | 内容 | 状態 |
|---|---|---|
| `sakae-image-01-{768,1280,1920}.webp` | 栄のAI生成イメージ（元 2674×1600 / 5.7MB PNG） | **未配置**（元PNG未受領） |
| アルベホール名古屋 実績写真 | 館選択カード・詳細セクション用 | **未提供** |
| `*-og.jpg`（1200×630） | OGP用 | 未作成 |

## 変換手順（sakae-image-01）

元PNGを受領したら、WebPへ複数解像度で書き出します（例：ImageMagick / cwebp）。

```sh
# ImageMagick + cwebp の例（元ファイルを sakae-image-01.png とする）
for w in 768 1280 1920; do
  convert sakae-image-01.png -resize ${w}x -quality 82 sakae-image-01-${w}.png
  cwebp -q 80 sakae-image-01-${w}.png -o sakae-image-01-${w}.webp
  rm sakae-image-01-${w}.png
done
```

## 配置後にやること（index.html）

1. `<head>` の `<link rel="preload" as="image" ...>` のコメントを解除
2. ファーストビュー `.hero-media-placeholder` を `<picture>` + `srcset` に置換
   - LCP要素のため `loading="lazy"` は**付けない**／`fetchpriority="high"` を付与
3. 館選択カード・栄詳細の `.media-ph` を実画像に置換
4. alt テキスト：`（仮称）アルベ イベントスペース栄のイメージ。白壁とコンクリート床の約200㎡のフラットな空間`
5. 画像の近傍に「イメージ」である旨の明記を維持する（`.image-note` を活用）

## 注意

AI生成画像は実物と差異が出る可能性があります（柱の位置・床材・天井・照明）。
仕様書 9章「要確認（重要）」の照合が済むまで、スペック文言を画像の印象に引きずらせないこと。
