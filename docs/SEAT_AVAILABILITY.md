# 本日の空席（`/seats/`）の作り方

羽田発着の主要35路線（往復70区間）について、JAL公式の空席照会と同じデータを
まとめて取得し、`data/availability.json` に落として表示する。表示先は2か所:

- `/seats/` — 区間ごとの便一覧（便名・時刻・機材・残席・最安運賃）
- `/`（ルートマップ）— サブタブ横の「空席で塗り分け」ボタンで、地図の路線を
  空席あり=緑／残りわずか=橙／満席=灰／全便欠航=赤破線 に塗り替える。
  対象外（羽田発着以外）の路線は薄く表示する。

## 更新手順（所要 約3分）

1. Chrome で <https://www.jal.co.jp/ja-jp/> を開き、**国内線をふつうに1回検索する**。
   路線・日付は何でもよい（セッションを作るためだけ）。
   「予約（空席照会）」の画面 `booking.jal.co.jp/jl/dom-bkg/upsell/outbound` まで進む。
2. その画面で DevTools（⌥⌘I）のコンソールを開き、
   [`tools/collect-in-browser.js`](../tools/collect-in-browser.js) の中身を全部貼り付けて Enter。
   - 初回は Chrome に `Allow pasting` と打つよう求められる。
3. 進捗がコンソールに流れ、終わると `availability.json` が自動ダウンロードされる。
4. そのファイルを `data/availability.json` に上書きして commit → push。
   Vercel は GitHub Pages を rewrite しているだけなので、push すれば両URLに反映される。

```bash
mv ~/Downloads/availability.json data/availability.json
git add data/availability.json && git commit -m "本日の空席を更新" && git push
```

## なぜブラウザのコンソールなのか

- `jal.co.jp` / `booking.jal.co.jp` は **Akamai Bot Manager** 配下で、
  `curl` は 403、Vercel のサーバ関数からも 403。
- 空席API `api.dom.jal.co.jp/rmweb-api/search/air-bounds` は
  `Access-Control-Allow-Origin: https://booking.jal.co.jp` 固定なので、
  ブラウザからは予約サイトのページ上でしか呼べない。
- Playwright / Selenium で起動した Chrome は Akamai に検知され、
  **JALのアプリ自身のAPI呼び出しごと失敗する**（実測）。CDP接続でも同じ。
- 人が普通に開いたブラウザのセッションを間借りするのが、いちばん確実で
  JAL側への負荷も小さい（1巡70リクエスト・1.2秒間隔）。

## データ仕様

`data/availability.json`

| フィールド | 内容 |
|---|---|
| `generatedAt` | 取得時刻（ISO8601） |
| `date` | 搭乗日 `YYYY-MM-DD` |
| `hub` | ハブ空港コード（`HND`） |
| `routes[]` | 区間ごとの結果。`o`=出発, `d`=到着, `status` |
| `routes[].status` | `ok` / `cancelled`（全便欠航） / `empty`（残り便なし） / `error` |
| `routes[].flights[]` | 便ごとの空席 |

便レコード:

| キー | 内容 |
|---|---|
| `no` | 便名（`JL117`） |
| `op` | 運航会社コード（`JL` / `NU` など） |
| `dep` / `arr` | 出発・到着時刻 `HH:MM` |
| `ac` | IATA機材コード（`359` / `788` / `73H` など） |
| `eco` | **普通席の残席数** |
| `clsj` | クラスJの残席数（`null`=設定なし） |
| `first` | ファーストクラスの残席数（`null`=設定なし） |
| `fare` | 普通席で購入可能な最安運賃（円・大人1名） |

**残席数は 9 が上限**。JALは10席以上あっても `quota: 9` としか返さないので、
`/seats/` では `9` を「空席あり」、`1〜8` を「残りN席」、`0` を「満席」と表示する。

出発済みの便はAPI側で除外されるため、`flights[]` は常に「これから出発する便」だけ。

## 取得ロジックの要点

- リクエストは1区間1回。`itineraries` に片道1本だけ入れる。
- `searchPreferences.showSoldOut: true` を付けて満席便も返させ、こちらで判定する。
- レスポンスの `availabilityDetails[].statusCode` は `HK`=確保可 / `HL`=キャンセル待ち。
  ただし**「対象者限定」の運賃ファミリーは満席の便でも `HK` かつ `quota: 0` を返す**ので、
  空席の有無は `statusCode` ではなく **`quota` の最大値**で判定すること。
- `boundDetails.segments` が2本以上の旅程（乗り継ぎ）は対象外。

## 対象路線を変えるとき

`tools/collect-in-browser.js` の `SPOKES` 配列を編集する。
`index.html` の `ROUTES` に含まれる空港コードならそのまま使える。
区間を増やすとその分JALへのリクエストが増えるので、`DELAY_MS` は短くしないこと。
