# 引継ぎメモ（ConoHa WING デプロイ / LP運用）

> このリポジトリ（`firstcreate-kito/rentalspacealbe`）は、レンタルスペースALBEの
> Google広告用ランディングページ（LP）を管理し、**GitHubにpushすると自動で
> ConoHa WING に反映**される仕組みになっています。新しいスレッド／担当者は、
> **まずこのファイルを読めば運用に必要なことが分かります。**

---

## 0. 結論（最短の使い方）

**ConoHaに手でFTPする必要はありません。** `main` ブランチにpushすれば、
GitHub Actions が自動でConoHa WINGへFTPSアップロードします。

1. リポジトリを clone する
2. `popup/`（既存LP）や新規 `office/` などの中のファイルを編集する
3. `main` に commit & push する
4. GitHubの「Actions」が緑✅になったら、本番サイトに反映完了

Claudeはこのリポジトリに **Claude GitHub App 経由で push 権限** を持っています
（インストール済み・組織/リポジトリ単位で永続）。新スレッドでも同じApp権限で
pushできます。

---

## 1. サイトのURLとサーバー構成

| 項目 | 値 |
|---|---|
| 本番サイト（ブランド公式） | https://space-albe.com/ （WordPress） |
| LP設置ディレクトリ | `space-albe.com/lp/` 配下（WordPressの**外**の実ディレクトリ） |
| 現在のLP（popup） | https://space-albe.com/lp/popup/ |
| 今後のLP（予定） | https://space-albe.com/lp/office/ （名駅フリースペースの仮事務所提案／未着手） |

- LPは **静的HTML/CSS/最小限のJS**。ビルドツール不要。
- `/lp/` は実ディレクトリなので、WordPressの.htaccessリライトと競合しない。
- **複数LPを `/lp/<名前>/` フォルダで並列運用**する方針
  （popup=ポップアップ/展示会向け、office=短期オフィス向け、など）。

---

## 2. リポジトリ構成（重要）

このGitHubリポジトリの**ルート = サーバーの `space-albe.com/lp/` の中身**です。

```
（リポジトリのルート）
├─ .github/workflows/deploy.yml   … 自動デプロイ設定（FTP除外対象）
├─ CLAUDE.md                      … LP制作仕様書（FTP除外対象）
├─ README.md                      … （FTP除外対象）
├─ HANDOVER.md                    … このファイル（FTP除外対象）
└─ popup/                         … 現在のLP一式（= space-albe.com/lp/popup/）
   ├─ index.html
   ├─ style.css
   ├─ tracking.js                 … 計測イベント送信
   ├─ favicon-1.png / logo-s.png / logo-w.png
   ├─ albe-hall-01.webp / albe-sakae-01.webp … メインビジュアル
   ├─ albe-hall-02.webp / albe-hall-02.pdf    … アルベホール図面（画像＋DL用PDF）
   ├─ albe-hall-03.webp           … 360°内覧サムネイル
   ├─ .htaccess                   … /lp/popup/ 配下のHTMLをno-cache配信
   └─ blog/
      ├─ index.html               … ブログ一覧
      └─ 2026-08-12-hello.html    … 記事
```

新しいLPを作るときは **`office/` のようにフォルダを新規作成**し、その中に
`index.html`・`style.css`・画像などを置く（popupを雛形にコピーすると早い）。

> 注意：**相対パス**（`style.css`、`logo-s.png`、`./blog/` など）で書けば、
> フォルダごと移動・複製してもそのまま動く。ただし **canonical・og:url・
> 構造化データ(JSON-LD)・画像の絶対URL** は各LPの実URL（例 `…/lp/office/`）に
> 合わせて書き換えること。

---

## 3. デプロイの仕組み（GitHub Actions → ConoHa WING）

- 設定ファイル：`.github/workflows/deploy.yml`
- 使用アクション：`SamKirkland/FTP-Deploy-Action@v4.3.5`
- トリガー：`main` への push（および手動 workflow_dispatch）
- 方式：FTPS / port 21 / `server-dir: ./`（＝FTPアカウントのホーム＝`/lp/`）
- **同期方式**：ローカル（リポジトリ）に無いファイルはサーバーからも削除される。
  つまりリポジトリ＝サーバーの`/lp/`の状態がそのまま同期される。

### FTP接続情報（GitHub Secrets に保管）

リポジトリ Settings → Secrets and variables → Actions に登録済み：

| Secret名 | 値 |
|---|---|
| `FTP_SERVER` | `www257.conoha.ne.jp` |
| `FTP_USERNAME` | `github@space-albe.com` |
| `FTP_PASSWORD` | （ConoHaで作成したFTPアカウントのパスワード。**Secretに保管・非公開**） |

> パスワードはGitHub Secretsにのみ保存。コードやメモに平文で書かない。
> 再発行が必要な場合は ConoHa WING コントロールパネルのFTPアカウント設定から。

### ConoHa側のFTPアカウント設定（サーバー側の事実）

- FTPアカウントの**ホームディレクトリ**：
  `/home/c9066897/public_html/space-albe.com/lp`
  → だから `server-dir: ./` がそのまま `space-albe.com/lp/` を指す。
- FTP接続そのものはConoHaの「FTPアカウント」機能で作成済み。
  GitHub Actionsはこのアカウントで接続している。

---

## 4. Claudeが変更を反映する具体手順

新スレッドのClaudeは、環境に応じて次のどちらかでOK：

**(A) 直接編集して push（推奨・シンプル）**
1. `git clone https://github.com/firstcreate-kito/rentalspacealbe`
2. 該当LPフォルダ（`popup/` など）内を編集、新規LPは新フォルダ作成
3. `git add -A && git commit -m "..." && git push origin main`
4. Actions が緑になれば反映

**(B) このセッションで使っていた flat-clone 経由の手順**
（ローカル作業コピーが別構成の場合の橋渡し。詳細は過去ログ参照）

いずれも `git config user.email "reportfirstcreate@gmail.com"` /
`user.name "firstcreate-kito"` を設定してからコミット。

---

## 5. キャッシュ対策（反映が古く見えるとき）

ConoHa/ブラウザのキャッシュで更新が見えないことがある。対策：

- **CSS/JS**：リンクに `?v=N` を付け、変更のたびに番号を上げる
  （例：`style.css?v=11`、`tracking.js?v=12`）。現在の版はソース参照。
- **HTML**：各LPフォルダの `.htaccess` で `Cache-Control: no-cache` を付与済み。
- それでも古い場合：**ConoHa管理画面のコンテンツキャッシュをクリア**＋
  ブラウザはシークレットウィンドウ／`Ctrl+F5`。
- 画像・ファビコンはキャッシュが特に強い。別名で差し替えると確実。

---

## 6. 計測タグ（GA4 / Google広告）

全ページの `<head>` に設置。`tracking.js` が data-track 属性のクリックを
GA4イベント＆Google広告コンバージョンとして送信する。

| 種別 | ID / ラベル | 状態 |
|---|---|---|
| GA4 測定ID | `G-XYZM0LL6BB` | 全ページ設置済み |
| Google広告 コンバージョンID | `AW-17762210452` | 設置済み |
| LINEクリック コンバージョン | `AW-17762210452/m2YsCL_wm6IcEJSl15VC` | 実装済み（LINEボタンクリックで発火） |
| 電話クリック コンバージョン | （未作成。Google広告で作成→ラベル取得→tracking.jsに追加） | **未** |
| フォーム送信 コンバージョン | `space-albe.com/contact/` の**送信完了ページ**にタグ設置が必要 | **未** |

- `tracking.js` の主なGA4イベント：`select_venue`（館選択）／`to_form_click`／
  `tel_click`／`line_click`／`matterport_open`／`floorplan_download`／`view_pricing`。
- 新LPを作ったら、同じ `tracking.js` を置けば計測は共通で動く。

---

## 7. 問い合わせ導線（LP共通の方針）

- フォーム：`https://space-albe.com/contact/`（同一ドメイン遷移）
  - どの施設か引き継ぐため `?venue=xxx` を付与する運用
- LINE：`https://page.line.me/565eerld?openQrModal=true`（外部・クリックを計測）
- 電話：`tel:0524855975`（052-485-5975）
- BtoBはフォーム・電話を主導線、LINEは副導線。

---

## 8. 反映確認のチェックリスト

1. GitHub → Actions のワークフローが**緑✅**か
2. 対象URL（例 https://space-albe.com/lp/popup/ ）をシークレットで開く＋`Ctrl+F5`
3. 画像・リンク・地図・計測（GA4リアルタイム）が正常か
4. 古い場合は ConoHa コンテンツキャッシュをクリア

---

## 9. 未対応・要確認（CLAUDE.md参照）

- 栄のグランドオープン時期／正式名称／アルベホールの面積（数値未確定）
- 電話・フォームのコンバージョン計測（上記6）
- **office LP（名駅フリースペースの仮事務所提案）は未着手**。
  作成には名駅フリースペースの実データ（住所・広さ・料金・利用時間・設備・
  アクセス・画像）が必要。**未確認スペックの創作は禁止**（CLAUDE.md方針）。
- 名駅フリースペースは既に2系統URL（`meiekifree.space-albe.com` と
  `space-albe.com/meiekifreeheizitu/`）が存在。`/lp/office/` を足すと重複が
  増えるため、canonical集約 or noindex を検討すること。

---

_最終更新：2026-08-22 時点の運用状態。詳細な制作方針は `CLAUDE.md` を参照。_
