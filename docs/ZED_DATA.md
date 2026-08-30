# ZEDデータ（data.json）の置き場所

`international/zed/data.json` は **このリポジトリには置かない**。
Cloudflare KV に入れて、Worker が Basic 認証を通した後にだけ配る。

- KV名前空間: `jal-route-map-private`（id `f3957ad140ed4d39b59b0804c3971ea6`、binding `PRIVATE`）
- キー: `zed:data.json`
- 配信: `worker/index.js` の `/international/zed/data.json` ハンドラ

## なぜリポジトリに置かないのか

2026-08-29時点で、このデータは **3経路から無認証で読めていた**。

1. GitHub Pages（`hirok61-cloud.github.io/.../international/zed/data.json`）
2. 公開リポジトリそのもの（raw）
3. jsDelivr

Vercel側の `api/zed-data.js` は Basic 認証をかけていたが、その中継元が
**公開中の GitHub Pages** だったため、認証は事実上の飾りだった
（`vercel/README.md` 参照）。航空会社職員向けの情報なので、
本体データはリポジトリから外して認証の内側に移した。

**過去のコミットには2026-08-03版が残っている。** 完全に消すにはリポジトリを
非公開にする必要があるが、`seats/collect.min.js` の jsDelivr 配布と
GitHub Pages が道連れになるため、移行が終わるまでは保留している。

## 更新のしかた

再収録して新しい data.json を作ったら、リポジトリにコミットせず KV へ入れる:

```
npx wrangler@latest kv key put "zed:data.json" --path=<新しいdata.json> \
  --namespace-id=f3957ad140ed4d39b59b0804c3971ea6 --remote
```

いまの中身を取り出したいとき:

```
npx wrangler@latest kv key get "zed:data.json" \
  --namespace-id=f3957ad140ed4d39b59b0804c3971ea6 --remote --text > data.json
```

（`--text` は末尾に改行を足すので、バイト単位で比較するときは除くこと）

## 原文の更新検知

各社の `fp` は収録時の原文のフィンガープリント（sha256先頭16桁）。
`/api/flyzed?code=<コード>` が返すハッシュと比べて変化を検知する。
**正規化は `worker/index.js` の `stripHtml` と `scripts/fingerprint.py` で
完全に一致させること**（ズレると全263社が「更新あり」になる）。
`stripHtml` の U+FEFF（BOM）除去は画面上不可視なので消さないよう注意。

2026-08-29に20社を照合し17社が完全一致。残る3社は**原文側の実変更**だった:

| | 収録時(8/3) | 2026-08-29 |
|---|---|---|
| BA ブリティッシュ・エアウェイズ | 19,536字 | 18,571字 |
| AF エールフランス | 3,782字 | 3,234字（冒頭の「最新情報」項が消滅） |
| DL デルタ航空 | 1,451字 | 3,548字（大幅増補） |

→ 2026-08-30 に全263社を照合し、変更が見つかった11社
（XZ・AR・UX・AF・MX・BA・DL・HX・XE・LX・VN）を下の手順で再収録済み。

## 再収録の手順（原文が更新された社を最新版にする）

1. **検知＋ジョブ生成**: `python3 scripts/fingerprint.py --data <現行data.json> --workdir <作業dir>`
   （現行data.jsonはKVから取得: 上の `kv key get`）。変更社の `changed.json`・原文HTML(`raw/`)・
   翻訳ジョブ(`jobs/<CODE>.json`)が作業dirにできる。
2. **和訳**: 各 `jobs/<CODE>.json` をClaudeで和訳し `out/<CODE>.json`
   （`{"sections":[{"title","text","summary"},…]}`）を作る。ルール:
   **原文の見出し構成をそのまま保持・情報を落とさない全訳**、旧訳と同一内容の部分は
   `old_entry` の旧訳を再利用、Embargo系見出しは「エンバーゴ」を含める
   （UIがこの語で警告バッジを判定）、`**強調**` 記法は使ってよい。
3. **マージ**: `python3 scripts/zed_merge.py --data <現行> --workdir <作業dir> --date YYYY-MM-DD --out <新data.json>`
   （fp/fpChars更新・`updated`付与・note除去まで自動。検証NGなら書き出さない）
4. **KVへ反映**: 上の `kv key put`。**リポジトリへのコミットは不要**（データはKVのみ）。
   ページの「◯月◯日再収録」表示は `updated` フィールドから自動で出る。
5. **確認**: もう一度 `fingerprint.py --data <新data.json>` を回して changed=0 を確認。

翻訳を挟むため完全自動にはできない。Claudeに「ZEDの原文更新チェックして、
変わってたら再収録して」と頼めばこの手順を通しで実行できる。
