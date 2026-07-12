# JAL国際線ルートマップ 実装メモ（データ手法・品質記録）

`/international/index.html` の実装記録。2026-07-12 作成。国内線版（`/index.html`）と同じ思想・品質基準。

## 収録範囲（ユーザー合意）
- **JAL自社運航（JL便）国際線** … 赤
- **oneworldパートナー運航便**（AA/BA/CX/QF/QR/AY/MH/UL 等、日本発着でJALの路線と重なる区間）… 青
- **提携/JVのハワイアン航空(HA)** の日本発着国際線 … 紫（後追加）
- **提携外の大韓航空(KE)・アシアナ航空(OZ)・エバー航空(BR)** の日本発着国際線 … 緑（ユーザー明示要望）
- 世界地図・日本中心（全世界1枚）。別ページ＋相互リンク方式。
- 地図はドラッグ移動＋ホイール/ピンチ/＋−ボタンで拡大（マーカー/ラベルは逆スケールで一定サイズ、密集地の近接空港=金浦/松山等を選択可能に）。

## データソースと手法（記憶からの生成は一切なし）
すべて **FlightAware** の運航スケジュール実績から機械的に取得・照合。

1. **路線列挙**: `ja.flightaware.com/live/findflight?origin=<ICAO>&destination=<ICAO>` で各空港ペアの就航便名を列挙。findflightは乗継便も含むため、次の2で自己補正。
2. **便ごとの照合**: `ja.flightaware.com/live/flight/<ICAO便名>` の `trackpollBootstrap` JSONから、真の出発/到着空港・IATA/ICAO・**タイムゾーン**・定刻ゲート出発/到着（epoch）・**機材型式**・空港座標を取得。
   - 現地時刻と`+N日`は epoch × 空港TZ（zoneinfo）で算出。
   - 「日本側空港（ICAO `RJ`/`RO`）と海外側空港の直行1区間」だけを採用（乗継・国内・第三国便は除外）。
   - 空港の緯度経度・日本語名もFlightAware由来。
3. **地図**: Natural Earth 110m 陸地をPython側で太平洋中心（中心経度150°E）に投影・Douglas-Peucker簡略化してJSに埋込（外部fetchなし・自己完結）。経度は `shift=((lon-150+180)%360+360)%360-180` で連続化。

## 精度フィルタ（誤認・貨物・実在しない便の除外）
コードシェア番号の運航会社誤認や貨物便がFlightAwareに混ざるため、以下を除外：
- **アラスカ航空(ASA)** 全便 … 日本発着を自社運航しない（JAL等metalのコードシェア誤認。機材A330で判明）
- **キャセイ(CPA)の非香港路線** … キャセイの日本旅客路線は香港線のみ。KIX-ICN等は貨物(747-8)/誤認
- **他社の9xxx番台** … マーケティングコードシェア（運航会社不確定）
- **747-8(B748)** … 当該各社では貨物便
- **EVA683(KIX-ORD)** … ネットワーク上実在しない単発ノイズ

## 実績（2026-07-12時点）
- **90路線・56都市・365便**（往復両方向）。
- アライアンス別便数: 提携外(KE/OZ/BR) 153 ／ JAL自社 142 ／ oneworld 64 ／ 提携(HA) 6。
- 運航会社: JL142, KE66, OZ43, BR44, CX23, AA10, AY9, QF8, HA6, QR5, BA4, MH4, UL1。
- **照合状況**: 全便がFlightAwareの定刻スケジュール実績に基づく（便名・現地時刻・機材・運航会社を実照合）。
- **未完（既知の限界）**: 復路が別便名で当日別区間に解決され取得できなかった3路線（NRT-PVG / NRT-TSN / NRT-CMB）は片方向のみ表示。パネルで「この方向の定期便は確認できませんでした」と明示。
- FlightAwareの「次の運航便」スナップショットのため、季節・曜日運航や当日の機材差し替えで実際と異なる場合あり（参考データと明記）。

## 再生成手順（scratchpadのスクリプト）
`routes.py`→`s1_enum.py`（路線列挙）→`s2a_fetch.py`/`s2b_collect.py`/`s3_fetch.py`（便照合）→`reverse_fill.py`（復路補完）→`process_land.py`（地図）→`assemble.py`（`records_all.json`＋`land.js`＋`template_intl.html`→ `international/index.html` を生成）→`qa.py`（異常検査）。
`git push` のみでGH Pages・Vercel両方に反映。
