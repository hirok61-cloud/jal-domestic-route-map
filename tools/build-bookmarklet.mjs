#!/usr/bin/env node
/* 収集ロジックから、配信する2つの生成物を作る。
 *
 *   tools/collect-core.js（本体・共通）
 *     ├─ tools/collect-in-browser.js → seats/collect.min.js   ブックマークレットが読む
 *     └─ tools/collect-extension.js  → extension/collect.js   Chrome拡張が注入する
 *
 * 以前は2か所に同じ収集ロジックのコピーがあり、片方だけ直して片方が
 * 置き去りになった。本体は1つにして、外側だけを差し替える形にしてある。
 * **extension/collect.js は生成物なので直接編集しないこと。**
 *
 * ブックマークレット自体は collect.min.js を <script> タグで読み込むだけの
 * 小さなもの（約2,500字）で、ロジックは埋め込まない。埋め込むと2万字を超え、
 * Androidのブックマークで切り捨てられて何も起きなくなる（実測）。
 *
 *   node tools/build-bookmarklet.mjs
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* どの版が動いたのかを端末側で言えるようにする。CDNに古いコピーが残っていても
   気づけるようにするため（2026-08-09、jsDelivrの12時間キャッシュに嵌まった）。 */
const STAMP = new Date().toISOString().slice(0, 16).replace("T", " ") + "Z";

const targets = [
  {
    entry: join(root, "tools", "collect-in-browser.js"),
    out: join(root, "seats", "collect.min.js"),
    label: "ブックマークレット用",
    minify: true,
    // ブックマークレットが「読み込めて動き出したか」を判定する目印。
    // esbuild に畳まれると、配信元を順に試す仕組みが常に空振りする
    must: "__JAL_SEATS_BOOTED",
  },
  {
    entry: join(root, "tools", "collect-extension.js"),
    out: join(root, "extension", "collect.js"),
    label: "Chrome拡張用",
    minify: false, // 拡張は読めるほうが直しやすい。長さの制約もない
    must: "collect-finished",
  },
];

for (const t of targets) {
  const result = await build({
    entryPoints: [t.entry],
    bundle: true, // collect-core.js を取り込む
    minify: t.minify,
    format: "iife",
    target: ["safari15", "chrome100"],
    charset: "utf8",
    legalComments: "none",
    banner: { js: `/* 生成物。編集しないこと。もとは tools/collect-core.js と ${t.entry.split("/").pop()}。\n   直したら npm run build:bookmarklet && npm run test:collect && npm run purge:cdn */\nvar __JAL_SEATS_BUILD__ = ${JSON.stringify(STAMP)};` },
    write: false,
  });
  const code = result.outputFiles[0].text.trim();
  if (!code.includes(t.must)) {
    console.error(`${t.label}: ${t.must} が消えています。取り込み方を確認してください。`);
    process.exit(1);
  }
  // 座席属性の調査ぶんが両方に入っていること（これが片方だけ、が今回の事故）
  if (!code.includes("codes")) {
    console.error(`${t.label}: 座席属性の集計が入っていません。`);
    process.exit(1);
  }
  writeFileSync(t.out, code + "\n");
  console.log(`${t.label.padEnd(16)} ${String(code.length).padStart(6)} 字 → ${t.out.replace(root + "/", "")}`);
}

const core = readFileSync(join(root, "tools", "collect-core.js"), "utf8");
console.log(`本体 tools/collect-core.js ${core.length} 字（この1本だけが収集ロジック）`);
console.log(`版の目印: ${STAMP}`);
console.log("push したら npm run purge:cdn を忘れずに（jsDelivrは12時間キャッシュする）");
console.log("OK");
