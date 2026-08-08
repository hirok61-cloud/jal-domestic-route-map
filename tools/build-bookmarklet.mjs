#!/usr/bin/env node
/* collect-in-browser.js を圧縮して seats/collect.min.js を作る。
 *
 * ブックマークレットは収集ロジックを丸ごと埋め込む（外部読み込みなし）。
 * JALのページから外部スクリプトを読もうとすると iOS / Android の両方で
 * 失敗したため、読み込み自体をなくすしかない。
 *
 * ただし Chrome のアドレスバーは 32,768 字で URL を切り捨てる。
 * 日本語は %XX 表記で1文字9字に膨らむので、コメントを落として
 * 十分小さくしてから埋め込む必要がある。
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
const LIMIT = 32768; // Chromeのアドレスバーの上限

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
writeFileSync(out, code);

// 実際にブックマークレットにしたときの長さを確かめる（合言葉は最長側で見積もる）
const payload = `(function(){window.__JAL_SEATS_KEY=${JSON.stringify("x".repeat(40))};\n${code}\n})();`;
const url = "javascript:" + encodeURIComponent(payload);

const orig = readFileSync(src, "utf8");
console.log(`元ファイル       : ${orig.length} 字`);
console.log(`圧縮後           : ${code.length} 字`);
console.log(`ブックマークレット: ${url.length} 字 / 上限 ${LIMIT} 字`);

if (url.length > LIMIT) {
  console.error("上限を超えています。コメントや文言を削ってください。");
  process.exit(1);
}
console.log("OK");
