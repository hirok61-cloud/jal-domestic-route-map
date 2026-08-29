#!/usr/bin/env node
/* jsDelivr のキャッシュを消す。**push したら必ず実行すること。**
 *
 * ブックマークレットは収集スクリプトを Cloudflare → Vercel → GitHub Pages →
 * jsDelivr の順に読み込む。GitHub Pages は push で、Cloudflare は
 * `npx wrangler deploy` で新しくなるが、
 * **jsDelivr は @main を最大12時間キャッシュする**。
 *
 * そのため、Vercel に届かない端末（プライバシー系の拡張やブロッカーが
 * 入っていると起こる）では jsDelivr の古いコピーが動き続ける。
 * 2026-08-09、直したはずの不具合が特定の端末だけ再現し続けたのがこれだった。
 *
 *   node tools/purge-cdn.mjs
 */
const PATHS = ["seats/collect.min.js"];
const REPO = "hirok61-cloud/jal-domestic-route-map";

let ng = 0;
for (const path of PATHS) {
  const url = `https://purge.jsdelivr.net/gh/${REPO}@main/${path}`;
  try {
    const res = await fetch(url);
    const body = await res.json();
    const ok = res.ok && body.status === "finished";
    console.log(`${ok ? "OK " : "NG "} ${path}  (${body.status ?? res.status})`);
    if (!ok) ng++;
  } catch (e) {
    console.log(`NG  ${path}  ${e.message}`);
    ng++;
  }
}

// 本当に新しくなったかを確かめる。消したつもりで残っているのがいちばん困る
for (const path of PATHS) {
  const cdn = await fetch(`https://cdn.jsdelivr.net/gh/${REPO}@main/${path}`).then((r) => r.text());
  const site = await fetch(`https://jal-route-map.hiro-k61.workers.dev/${path}`).then((r) => r.text());
  const same = cdn.trim() === site.trim();
  console.log(`${same ? "OK " : "NG "} ${path} がサイトと一致（${cdn.length} 字 / ${site.length} 字）`);
  if (!same) ng++;
}

process.exit(ng ? 1 : 0);
