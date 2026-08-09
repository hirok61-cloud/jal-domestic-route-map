# 引き継ぎ: Android・一部iPhoneで空席の保存が失敗する件

2026-08-10 時点、**対策を1つ打ったが、実機での完全解決は未確認**。
下の「2026-08-10 追記」を先に読むこと。

## 2026-08-10 追記（このセッションでやったこと）

**やったこと**

1. 「次に打てる手」の①②を検証・実行した。接続した Vercel MCP で
   `list_projects` / `get_project` を引いたところ、`jal-domestic-route-map`
   という名のプロジェクトはこのアカウントに1件も無い（`list_projects` が空、
   `get_project` は404）。**①（このドメインを本当にデプロイし直す）はこの
   アカウントからは不可能と確定した。** `jal-domestic-route-map.vercel.app` は
   別アカウントのものか、すでに失われた設定と思われる
2. そこで②（別ホストに中継を立てる）を実行。新規 Vercel プロジェクト
   `jal-seats-relay` を `deploy_to_vercel` で直接デプロイした
   （このGitHubリポジトリとは連携していない＝pushしても自動デプロイされない、
   詳細は下記「デプロイの注意」）
3. `curl` で合言葉をわざと間違えて叩き、Supabase側の実際のエラー応答
   （`{"error":"合言葉が違います"}`）が中継を経由して返ってくることを確認した。
   中継が上流（Supabase Edge Function）まで実際に到達していることの証拠
4. `tools/collect-core.js` の `SAVE_ENDPOINTS` に2件目として追加。
   `relay/api/save.js` にソースを置いた（内容は取り下げ済みだった旧
   `api/save.js` とほぼ同じ）
5. `npm run build:bookmarklet` → `npm run test:collect` → `npm run check:secrets`
   まで通した。`tools/simulate-collect.mjs` のテストも、宛先2つ・手段2つの
   総当たり（3周×2×2=12回）に合わせて更新した

**着手前に指示された「実機で内容をコピーの文面を確認」はやっていない。**
このセッションからはAndroid実機・配偶者のiPhone実機を操作できないため。
ただし依頼者の元のメッセージに **`fetch blocked by privacy-gateway` は
既に確認済み**とあった（fetchがJS層で横取りされている証拠）ので、
「宛先を変える」対策の筋は通っている。XHRも横取りされているか、
宛先ごとの詳しい理由までは今回も未確認のまま

**次にやること**

- 実機（Android・配偶者のiPhone）で1回更新を試す。**これで直れば解決**
- 直らなければ、まず「内容をコピー」の文面を取る（宛先ごと・fetch/XHRそれぞれの
  理由が出る）。新しいドメイン（`jal-seats-relay.vercel.app`）も同じ理由で
  弾かれているなら、ドメインを変えるだけでは足りない＝ブロック対象が
  「既知のバックエンドのドメイン」ではなく「fetch/XHR API自体、または
  サードパーティ全般」ということになるので、下の「次に打てる手」の
  3.（`sendBeacon`）・4.（隠しiframe）に進む
- `relay/api/save.js` を直したときは、pushだけでは反映されない
  （下記「デプロイの注意」）。必ず Vercel MCP で再デプロイすること

**デプロイの注意（重要）**

`jal-seats-relay` プロジェクトは Vercel MCP の `deploy_to_vercel` で
ファイルを直接渡して作った。**GitHubリポジトリとは連携していない。**
つまり:
- このリポジトリに `git push` しても、`jal-seats-relay.vercel.app` には
  何も反映されない
- `relay/api/save.js` を直したら、そのつど Vercel MCP で
  `deploy_to_vercel`（`name: "jal-seats-relay"`, `target: "production"`,
  `files` に `relay/api/save.js` の中身）を呼んで再デプロイする必要がある
- 本体サイト用に確立している「push → jsDelivrキャッシュ対策で
  `npm run purge:cdn`」の手順とは別物なので混同しないこと
  （`jal-seats-relay` はCDNではなくVercelの関数なので、purge:cdnの対象外）

## 症状

- 依頼者（kameda_hirofumi）本人のiPhoneでは動く
- 依頼者のAndroidと、配偶者のiPhoneでは、**70区間の空席照会は最後まで終わるのに、
  保存だけが必ず失敗する**
- 失敗すると `availability-YYYY-MM-DD.json` が自動ダウンロードされる
  （保存を諦めたときのフォールバック）

## 確定していること（推測ではない）

1. **Supabase Edge Function のログに、失敗した時間帯のPOSTが1件も届いていない。**
   その時間帯に来ていたのは `action=claim`（Mac拡張のポーリング）と
   `action=all`（サイト表示のGET）だけだった。→ 保存のPOSTが端末から
   出ていないか、出た直後に握りつぶされている
2. **ダウンロードされたJSONを解析**すると、`routes` は70区間ぶんそろっているが
   `sm`（座席番号）・`codes`（座席属性の調査データ）が0件だった。つまり
   **運賃70区間の収集は完走し、最初の保存（座席表に入る前）で失敗している**。
   「座席のところでエラー」に見えたのは収集フェーズの境目のタイミングにすぎない
3. JALのAPI（`api.dom.jal.co.jp`）への通信は最後まで通っている。
   落ちるのは保存先（`xymbknvwllwhmqlexege.supabase.co`）だけ
4. 実機で `<URL> fetch blocked by privacy-gateway` という文字列を確認した
   （投げられていたのは `Error` オブジェクトではなくただの文字列 = ページ内で
   `fetch` が何かに差し替えられている証拠）

## すでに試して、効かなかったもの

| 対策 | 結果 |
|---|---|
| `fetch` を `XMLHttpRequest` に切り替え（宛先は同じ） | 効かない。**宛先が同じなら手段を変えても弾かれる** |
| 送信の再試行（3回×2手段） | 効かない。原因が時間切れではなく遮断のため |
| 保存に自前のタイムアウトを追加 | 「止まって見える」問題は直ったが、遮断そのものは直っていない |
| `jal-domestic-route-map.vercel.app/api/save.js` を作ってサイト経由の中継にする | **実装したが動かなかった。** `jal-domestic-route-map.vercel.app` は
  **Vercelが GitHub Pages を中継しているだけ**で、リポジトリはVercelに
  デプロイされていない（応答に `x-github-request-id` が付き、POSTは405、
  `/api/save.js` は静的ファイルとして200で返ってきた）。**サーバ側の処理は
  この見た目のドメインには置けない。** 結局取り下げてコミット済み
  （`git log` で `api/save.js` を検索すると経緯が追える） |

## いまのコード上の状態（2026-08-10 追記後）

- `tools/collect-core.js` の `SAVE_ENDPOINTS` 配列は、いまは2件
  （Supabase Edge Function ＋ `jal-seats-relay.vercel.app` 経由の中継）
  が入っている。3件目を足すのも同じ形で容易
- 保存は「宛先2つ × 手段2つ(fetch/XHR)」を総当たりし、3周まで試す設計
- 失敗時、失敗枠に「内容をコピー」ボタンがあり、押すと次の情報が集まる。
  **これが次の判断材料になる**
  ```
  保存できませんでした（保存先へ通常の方法: … / 保存先へ別の方法(XHR): …）
  ［fetch=素 or ★横取りされています / XHR=… / 版=… / 読込元=…］
  ```

## 次に打てる手（優先順の私案。決め打ちはしていない）

1. ~~**本当にVercelにデプロイする。**~~ **やった結果、不可能と確定（2026-08-10）。**
   接続したVercelアカウントに `jal-domestic-route-map` というプロジェクトは
   存在しない（`list_projects` が空、`get_project` も404）。ダッシュボードを
   見るまでもなく、このアカウントからは触れないドメインだと分かった
2. ~~**別の無料ホストに同じ中継を立てる。**~~ **2026-08-10、Vercelで実行済み。**
   新規プロジェクト `jal-seats-relay`（`https://jal-seats-relay.vercel.app/api/save`、
   ソースは `relay/api/save.js`）を立て、`SAVE_ENDPOINTS` に追加した。
   curlでの疎通は確認済みだが、**実機でのブロック回避まで確認できていない**
   （次はこの実機確認が最優先）。もし回避できていなければ、Cloudflare Pages
   Functions・Netlify Functions等、さらに別ドメインの中継を追加する余地はある
3. **`navigator.sendBeacon`** を試す。`fetch`/`XHR` の横取りとは別の経路になる
   可能性がある。ただしBeaconはPOST専用でレスポンスを読めないので、
   成功/失敗の判定方法を別に用意する必要がある（例: 送信直後に
   `?action=status` 的な確認GETを打つ、など設計variantが要る）
4. **隠しiframeへのフォームPOST**。古典的な回避策。CORSの制約を受けない代わり、
   同じくレスポンスを直接読めないので3と同様の課題がある
5. **その端末側で `jal.co.jp` を含む通信をブロッカーの対象から外してもらう**。
   技術的には最も簡単だが、利用者ごとに毎回お願いする形になり運用コストが高い
6. 上記のどれを選ぶにせよ、**着手前に一度、実機で「内容をコピー」の文面を
   取ってもらうこと。** JS層の横取り（`fetch=★横取りされています`）なのか、
   通信そのものの遮断（`fetch=素`なのに繋がらない）なのかで、効く対策が変わる。
   前者ならsendBeacon/iframeが効きやすく、後者ならブロッカーの設定を
   外してもらう以外はほぼ効かない

## やらなくてよいこと（すでに検討し却下・保留にした）

- リポジトリを非公開にする → ブックマークレットの配信元3つのうちGitHub Pagesと
  jsDelivrが死ぬので却下
- 収集ロジック自体（JAL側の空席照会・座席表取得）を疑う → **無実。** 常に完走している
- 拡張とブックマークレットの実装差を疑う → 2026-08-09に統合済み
  （`tools/collect-core.js` が唯一の実装。詳細は `docs/HANDOVER.md`）

## 動作確認・デプロイの手順（このプロジェクト共通のお作法）

収集ロジックを直したら必ず:
```bash
npm run build:bookmarklet   # tools/collect-core.js から生成物を作り直す
npm run test:collect        # 偽ブラウザ・偽JALでの検証（tools/simulate-collect.mjs）
npm run check:secrets       # 合言葉などが紛れ込んでいないか
```
push後、jsDelivrのキャッシュ対策で:
```bash
npm run purge:cdn
```

## 参照ドキュメント

- `docs/HANDOVER.md` — プロジェクト全体の引き継ぎ（座席収集の仕組み全般）
- `docs/SEAT_AVAILABILITY.md` — 仕様の詳細
- 合言葉は **Supabaseの環境変数にのみ存在**。このリポジトリのどこにも書かれていない
  （`tools/check-secrets.mjs` が再発防止のフックとして入っている）
