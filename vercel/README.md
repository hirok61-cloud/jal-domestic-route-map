# Vercel から回収した本体（2026-08-29）

この `vercel/` ディレクトリは、Vercel プロジェクト `jal-domestic-route-map` に
**CLIから直接デプロイされていて、どのリポジトリにも入っていなかった**構成を
ダッシュボードの Deployment Source（dpl_BM797EKNsYhW9PujpiRhC4npDuTH、2026-08-04）
から回収したものである。ローカルの作業ディレクトリは失われていた。

## 構成

- `vercel.json` — `/international/zed`・`/international/zed/`・`/international/zed/data.json`
  を下の関数へ、それ以外すべてを GitHub Pages へ rewrite する。
  rewrites は filesystem/関数の後に評価されるので `/api/*` は関数が優先される。
- `api/_auth.js` — HTTP Basic 認証。合言葉は環境変数 `ZED_GATE_USER` / `ZED_GATE_PASS`
  （ソースには入っていない）。未設定なら fail closed。
- `api/zed-page.js` / `api/zed-data.js` — ZEDページとdata.jsonを認証の内側で中継する。
- `api/flyzed.js` — flyzed.info の原文を再取得して正規化＋sha256先頭16桁を返す。
  **`stripHtml` の正規化は `scripts/fingerprint.py` と完全一致させること**
  （ズレると全263社が「更新あり」になる）。28行目の BOM 除去（U+FEFF）は
  画面上は不可視なので、編集時に消さないよう注意。
- `api/alliances.js` — oneworld と SkyTeam の加盟社を実スクレイプ。Star Alliance は
  Liferay の `p_auth` トークンが要るため固定リスト（`live: false` で正直に返す）。

## 注意

**この認証は現状ほとんど機能していない。** `zed-page.js` / `zed-data.js` の
UPSTREAM は公開中の GitHub Pages であり、同じ内容が
`https://hirok61-cloud.github.io/jal-domestic-route-map/international/zed/data.json`
から無認証で読める（リポジトリ自体も public）。Cloudflare への移行に合わせて
閉じ方を設計しなおす予定。
