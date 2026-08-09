#!/usr/bin/env node
/* collect-in-browser.js を圧縮して seats/collect.min.js を作る。
 *
 * ブックマークレットはこの圧縮版を <script> タグで読み込むだけの小さなもので、
 * ロジックは埋め込まない（埋め込むと2万字を超え、Androidのブックマークで
 * 切り捨てられて何も起きなくなる。実測）。したがってここでの長さは
 * ブックマークレットの上限とは関係なく、単に配信するファイルの大きさになる。
 *
 * 収集ロジックを直したら必ず実行し、生成物もコミットすること。
 * 利用者はブックマークを登録し直す必要はない（読み込み先が同じため）。
 *
 *   node tools/build-bookmarklet.mjs
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "tools", "collect-in-browser.js");
const out = join(root, "seats", "collect.min.js");

const result = await build({
  entryPoints: [src],
  bundle: false,
  minify: true,
  format: "iife",
  target: ["safari15", "chrome100"],
  charset: "utf8",
  legalComments: "none",
  write: false,
});

const code = result.outputFiles[0].text.trim();

/* ブックマークレットは「読み込めて動き出したか」をこの目印で判定する。
   esbuild が畳んでしまうと、配信元を順に試す仕組みが常に空振りする。 */
if (!code.includes("__JAL_SEATS_BOOTED")) {
  console.error("__JAL_SEATS_BOOTED が消えています。collect-in-browser.js を確認してください。");
  process.exit(1);
}

writeFileSync(out, code);

const orig = readFileSync(src, "utf8");
console.log(`元ファイル: ${orig.length} 字`);
console.log(`圧縮後    : ${code.length} 字 → seats/collect.min.js`);
console.log("OK");
