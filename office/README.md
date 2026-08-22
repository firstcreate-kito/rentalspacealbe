# 仮事務所LP（`office/` = `https://space-albe.com/lp/office/`）

- 対象施設: 名駅フリースペース（名古屋市中村区名駅南1-3-14 石原ビル3F）
- 作成日: 2026-08-22
- 位置づけ: `HANDOVER.md` §1 の「今後のLP（予定）」として着手したもの

このファイルは `deploy.yml` の除外対象（`**/README.md`）なので、サーバーにはアップロードされません。

## 構成

`popup/` と同じ作りです。相対パスで書いてあるので、フォルダごと複製しても動きます。

| ファイル | 内容 |
|---|---|
| `index.html` | LP本体 |
| `style.css` | `popup/style.css` ＋ 本LP用のコンポーネント（末尾に追加分） |
| `tracking.js` | `popup/tracking.js` と同一 |
| `.htaccess` | `popup/.htaccess` と同一（HTMLをno-cache配信） |
| `office-01` / `office-02` / `office-kitchen` / `office-meeting` `.webp` | 施設写真 |
| `office-floorplan.webp` | 平面図 |
| `logo-s.png` / `logo-w.png` / `favicon-1.png` | `popup/` と同一 |

## 掲載データの出どころ

すべて現行の施設ページ `https://space-albe.com/introduce/meieki-free-space/` の記載に基づきます
（CLAUDE.md §7「確認できていないスペックの記載」の禁止に従い、**未確認の数値は書かず「要確認（仮）」の印を残して**あります）。
写真・平面図も同ページの画像を使用しました。

**料金・設備・利用時間を改定したときは、施設ページとこのLPの両方を直す必要があります。**

## noindex にしてある理由

`HANDOVER.md` §9 と `CLAUDE.md` §10 のとおり、名駅フリースペースは既に
`meiekifree.space-albe.com` と `space-albe.com/meiekifreeheizitu/` の2系統URLが併存しています。
`/lp/office/` を検索対象に足すと3つ目になるため、`<meta name="robots" content="noindex, follow">`
にしてあります。**Google広告の着地ページとしては影響しません。**
検索にも出す方針であれば、`index.html` のこの1行を `index, follow` に戻してください。

## 公開前に確定させること

本文に赤い `要確認（仮）` の印を入れてあります（`style.css` の `.tbd`）。確定したら文言ごと差し替えてください。

| # | 項目 | なぜ必要か |
|---|---|---|
| 1 | **法人登記・住所利用の可否** | 仮事務所を探す人がまず確認する項目。可否どちらでも明記が要る |
| 2 | **郵便物・宅配便の受け取り** | スタッフ常駐ではない（近隣の事務所に在席）ため運用の説明が要る |
| 3 | **連日・長期の料金** | 「日数に応じてお見積り」のままにするか、週単位・月単位の料金表を出すか |
| 4 | **複合機・大型什器の持ち込み条件** | エレベーター開口部 W85×H210cm、かご内 W125×D135×H230cm を超えるものが入らない |
| 5 | **長期利用時の土足の扱い** | 通常は土足不可（有料オプション5,500円）。数週間の事務所利用での運用を決める |
| 6 | **広告のコンバージョンラベル** | `HANDOVER.md` §6 のとおり `AW-17762210452` を流用。LP別に分けるかどうか |
| 7 | **地図の埋め込み** | `maps?q=...&output=embed` の簡易形式。表示が不安定なら `maps/embed?pb=` 形式に差し替える |
| 8 | **OGP画像** | いまは `office-01.webp`（860×550）。1200×630 を用意するかどうか |
| 9 | **フォーム側のhiddenフィールド** | CTAは `?venue=meieki-free&plan=office` を付与済み。`CLAUDE.md` 4-5 のとおりフォーム側の受け取りが要対応 |

## 反映のしかた

`main` に push すれば GitHub Actions が ConoHa WING へFTPSアップロードします（`HANDOVER.md` §3）。
反映後は `HANDOVER.md` §8 のチェックリストで確認してください。
