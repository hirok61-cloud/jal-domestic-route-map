# 国際線ダイヤの更新（2026-11-09〜）

`international/index.html` の便データは `data/international-timetable.js` に分けてある。
更新は `scripts/update_international.py`（標準ライブラリのみ）。

## 何がどこから来るか

| データ | 出どころ | 更新 |
|---|---|---|
| JAL便の便名・時刻・運航曜日 | `data/jal-intl-plan.tsv`（JAL公式の運航計画の書き写し） | **期間ごとに人が差し替え** |
| JAL便の機材 | FlightAware `findflight` | 週1回自動 |
| 他社便の便名・時刻・機材 | FlightAware `findflight`（読めない便は `live/flight`） | 週1回自動 |

自動更新は `.github/workflows/update-international.yml`（毎週月曜 04:30 JST、Actionsタブから手動実行も可）。
**便データに差分がある週だけ**コミットする。main への push で Workers Builds が本番へ反映する。

## なぜJAL便だけ手作業なのか

`jal.co.jp` は curl やサーバーからの取得を受け付けない（Akamaiで403）。Actionsから取得せず、
FlightAwareで代用もしない（便数や運航曜日の精度が落ちる。羽田-シンガポールの便数誤りなどの前例あり）。
そのかわり **期間切れはワークフローの失敗（GitHubのメール通知）で分かる**ようにしてある。

## 次の期間への差し替え手順（年2回）

1. ブラウザで `https://www.jal.co.jp/jp/ja/info/<年>/inter/<地域>/` を開く
   （地域は north-america / europe-russia / asia / oceania / east-asia / hawaii-guam。
   冬ダイヤは末尾に `second/` が付く）
2. 各路線の「開く」を展開し、表の行を `data/jal-intl-plan.tsv` に写す（列はファイル先頭のコメント参照）
3. 先頭コメントの `period:` と `更新日:` を書き換える
4. 新しい空港が出たら `scripts/update_international.py` の `PLAN_AIRPORT` と `international/index.html` の `AP` に足す
5. Actionsから手動実行するか、手元で `python3 -I scripts/update_international.py`

## 表示の日付

- `meta.asOf` … **便名・時刻が最後に変わった確認日**。機材だけの変化では動かない
- `meta.season` … asOf から計算するIATAシーズン（夏／冬）
- 所要時間の時差は `meta.asOf` の日付で評価する（`TZ_REF`）。夏時間のある路線が1時間ずれないように

## 消える便の扱い

- 他社便が findflight に出ないときは `live/flight` で確認し、**直近21日にその区間を飛んだ実績が無ければ削除**
- FlightAwareに情報が無い便は**前回値を保持**し、確認できないまま56日たつと落とす（`data/international-state.json`）
- `PROTECTED`（富山線 CI170/171/370/371）は発表記事を根拠に載せているので消さない

## 安全弁

便数が前回比±30%超・0件・JAL便の数が計画と不一致・findflight の取得率8割未満なら、書き込まずに失敗で終わる。
FlightAwareが 401/403/429 を返したら**迂回せず止まる**。UAは素性を名乗る（ブラウザに偽装しない）。

## 精度フィルタ

`docs/INTERNATIONAL_DESIGN.md` のものを `excluded()` に実装（CPAの非香港・747-8、CALの5xxx、他社の9xxx、
`EXCLUDE_ROUTE`、EVA683 KIX-ORD）。adhoc の便は載せない。前回に無い便は、実績が1本だけで今後の予定も無ければ採用しない。
