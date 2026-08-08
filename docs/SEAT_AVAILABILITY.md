# 本日の空席（`/seats/`）の作り方

羽田発着の主要35路線（往復70区間）について、JAL公式の空席照会と同じデータを
まとめて取得して表示する。表示先は2か所:

- `/seats/` — 区間ごとの便一覧（便名・時刻・機材・残席・最安運賃）
- `/`（ルートマップ）— サブタブ横の「空席で塗り分け」ボタンで、地図の路線を
  空席あり=緑／残りわずか=橙／満席=灰／全便欠航=赤破線 に塗り替える。
  対象外（羽田発着以外）の路線は薄く表示する。

## 更新のしかた

初回だけ **<https://jal-domestic-route-map.vercel.app/seats/update.html>** で
合言葉を入れ、「✈ JAL空席を更新」をブックマークバーにドラッグしておく。

以降の更新は**2アクション**:

1. [JAL公式サイト](https://www.jal.co.jp/ja-jp/)で国内線をふつうに1回検索し、
   「予約（空席照会）」の画面（`booking.jal.co.jp/jl/dom-bkg/upsell/…`）まで進む
   — 路線・日付は何でもよい。JALのセッションを作るためだけに使う
2. ブックマークバーの **「✈ JAL空席を更新」** をクリック

画面右下に進捗が出て、約90秒でサイトに反映される。git 操作もファイル移動も不要。

送信に失敗した場合は `availability.json` が自動でダウンロードされるので、
`data/availability.json` に置いて push すれば従来どおり反映できる。

## 構成

```
JALの予約画面（人が開いたブラウザ）
  └─ ブックマークレット
       └─ tools/collect-in-browser.js         ← 収集ロジック（サイトから配信）
            ├─ api.dom.jal.co.jp …… 70区間ぶん空席照会
            └─ POST supabase/functions/v1/jal-seats （x-update-key 付き）
                 └─ public.jal_seat_snapshots（hubごとに1行を上書き）

サイト（/seats/ と /）
  └─ GET supabase/functions/v1/jal-seats   ← ふだんはこちら
       └─ 失敗したら data/availability.json（コミット済みの静止データ）
```

- Supabase プロジェクト: `xymbknvwllwhmqlexege`
- Edge Function: `jal-seats`（`verify_jwt=false`。GETは公開、POSTは合言葉必須）
- テーブル: `public.jal_seat_snapshots`（RLS有効・匿名SELECTのみ許可。書き込みは
  Edge Function が service role で行う）
- **合言葉はこのリポジトリに置かない。** ブックマークレット（＝利用者のブラウザ）
  だけが持ち、`window.__JAL_SEATS_KEY` として収集スクリプトに渡す。
  変える場合は Edge Function の環境変数 `JAL_SEATS_UPDATE_KEY` を設定する。

## なぜブラウザ上で収集するのか

- `jal.co.jp` / `booking.jal.co.jp` は **Akamai Bot Manager** 配下で、
  `curl` は 403、Vercel のサーバ関数からも 403。
- 空席API `api.dom.jal.co.jp/rmweb-api/search/air-bounds` は
  `Access-Control-Allow-Origin: https://booking.jal.co.jp` 固定なので、
  ブラウザからは予約サイトのページ上でしか呼べない。
- Playwright / Selenium で起動した Chrome は Akamai に検知され、
  **JALのアプリ自身のAPI呼び出しごと失敗する**（実測）。CDP接続でも同じ。
- さらに、トップページにフォームPOSTしただけのセッションは 429（`cpr_chlge`）で
  弾かれる。**検索ウィジェットを実際に操作して作ったセッション**でないとAPIが通らない。
- 結局、人が普通に開いたブラウザのセッションを間借りするのが、いちばん確実で
  JAL側への負荷も小さい（1巡70リクエスト・1.2秒間隔）。

## データ仕様

Edge Function が返す JSON（`data/availability.json` と同じ形）

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
サイトでは `9` を「空席あり」、`1〜8` を「残りN席」、`0` を「満席」と表示する。

出発済みの便はAPI側で除外されるため、`flights[]` は常に「これから出発する便」だけ。

## 取得ロジックの要点

- リクエストは1区間1回。`itineraries` に片道1本だけ入れる。
- `searchPreferences.showSoldOut: true` を付けて満席便も返させ、こちらで判定する。
- レスポンスの `availabilityDetails[].statusCode` は `HK`=確保可 / `HL`=キャンセル待ち。
  ただし**「対象者限定」の運賃ファミリーは満席の便でも `HK` かつ `quota: 0` を返す**ので、
  空席の有無は `statusCode` ではなく **`quota` の最大値**で判定すること。
- `boundDetails.segments` が2本以上の旅程（乗り継ぎ）は対象外。
- セッションは `booking.jal.co.jp` の `sessionStorage.apiAuthCreds.authToken`
  （有効約2時間）＋ 予約サイトのバンドルに埋まっている `x-api-key`。

## 対象路線を変えるとき

`tools/collect-in-browser.js` の `SPOKES` 配列を編集して push するだけ。
ブックマークレットは毎回このファイルを読みに行くので、登録し直す必要はない。
区間を増やすとその分JALへのリクエストが増えるので、`DELAY_MS` は短くしないこと。
