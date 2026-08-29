# デプロイ手順

サイト本体は Cloudflare Workers（Worker名 `jal-route-map`）で配信している。
本番: https://jal-route-map.hiro-k61.workers.dev

## 通常（自動）

`main` に push すると Workers Builds が動き、自動でデプロイされる（2026-08-29 接続）。

- ビルドコマンド: なし（ビルド不要の静的アセット＋Worker）
- デプロイコマンド: `npx wrangler deploy`
- ルートディレクトリ: `/`
- プロダクションブランチ: `main`

接続先リポジトリは **hirok61-cloud/jal-domestic-route-map**。
Cloudflare側のWorker名と `wrangler.jsonc` の `name` が一致していないとビルドは失敗する。

## 手動（緊急時・確認時）

```
npx wrangler@latest deploy
```

自動・手動は併用できる。後から実行したほうが有効になる。

## 注意

- **push しても GitHub Pages と Cloudflare は別経路。** Pages は GitHub Actions が、
  Cloudflare は Workers Builds が担当する。片方だけ更新されている状態に注意すること
- 空コミットは監視パスに一致しないためビルドが走らない（疎通確認には実ファイルの変更が要る）
- 配信対象から外すものは `.assetsignore` に書く（`node_modules` や `worker/` などはここで除外済み）
