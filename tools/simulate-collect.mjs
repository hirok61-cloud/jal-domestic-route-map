#!/usr/bin/env node
/* collect-in-browser.js を、偽のブラウザと偽のJAL/保存先の上で実際に走らせる。
 *
 * このプロジェクトは「JALの実ページでブックマークレットを押す最後の一手」を
 * こちら側で確かめられない。せめて収集ロジックの分岐（弾かれたとき・保存に
 * 失敗したとき・完走したとき）は手元で通しておきたい、というためのもの。
 * JALにも保存先にも一切つながないので、何度走らせても実害はない。
 *
 *   node tools/simulate-collect.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "tools", "collect-in-browser.js"), "utf8")
  // 待ち時間は検証に不要なので詰める（実物の間隔はそのまま残す）
  .replace(/const DELAY_MS = \d+;/, "const DELAY_MS = 0;")
  .replace(/attempt \* 5000/, "attempt * 5")
  .replace(/setTimeout\(r, 4000\)/, "setTimeout(r, 4)");

/* ---- 偽ブラウザ。収集スクリプトが触るところだけ用意する ---- */
function makeEnv({ host = "booking.jal.co.jp", jal, saver, pick = "両日" }) {
  const log = { shown: [], saved: [], downloads: [], searches: 0, seatmaps: 0 };

  const node = (tag) => {
    const el = {
      tagName: tag, style: { cssText: "" }, children: [], _text: "", id: "",
      set textContent(v) { el._text = String(v); },
      get textContent() { return el._text; },
      /* innerHTML で組み立てたあと querySelector('#id') で引かれるので、
         id つきのタグだけは子要素として作っておく（雑なHTMLパーサ代わり）。 */
      set innerHTML(v) {
        el._text = String(v).replace(/<[^>]*>/g, "");
        for (const m of String(v).matchAll(/id="([^"]+)"/g)) {
          if (!el.children.some((c) => c.id === m[1])) {
            const c = node("div");
            c.id = m[1];
            el.children.push(c);
          }
        }
      },
      get innerHTML() { return el._text; },
      appendChild(c) {
        el.children.push(c);
        // 「今日 / 明日 / 両日」の選択は押されるまで進まないので、指定どおり押す
        queueMicrotask(() => {
          const btn = (c.children || []).find(
            (b) => b.tagName === "button" && b.textContent.startsWith(pick.slice(0, 2)),
          );
          if (btn && btn.onclick) btn.onclick();
        });
        return c;
      },
      append(...cs) { el.children.push(...cs); },
      remove() {},
      click() {},
      select() {},
      querySelector(sel) { return find(el, sel.replace("#", "")); },
    };
    return el;
  };
  const find = (el, id) => {
    if (el.id === id) return el;
    for (const c of el.children) { const hit = find(c, id); if (hit) return hit; }
    return null;
  };

  const body = node("body");
  const document = {
    body, documentElement: body, head: body,
    createElement: node,
    getElementById: (id) => find(body, id),
    addEventListener() {}, removeEventListener() {},
    visibilityState: "visible",
  };

  const env = {
    document,
    __JAL_SEATS_KEY: "TESTKEY", // ブックマークレットが渡す合言葉のかわり
    location: { host, hostname: host },
    sessionStorage: { getItem: () => JSON.stringify({ authToken: "dummy-token" }) },
    crypto: { randomUUID: () => crypto.randomUUID() },
    performance: { now: () => 60000 },
    navigator: { userAgent: "test", wakeLock: null, clipboard: null },
    Blob: class { constructor(parts) { this.size = String(parts[0]).length; } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Date, JSON, Math, Object, Array, String, Number, Promise, Map, Set, Error, console,
    fetch: async (url, init) => {
      if (String(url).includes("api.dom.jal.co.jp")) {
        const seat = String(url).includes("seatmaps");
        if (seat) log.seatmaps++; else log.searches++;
        return jal(seat, init, log);
      }
      log.saved.push(JSON.parse(init.body));
      return saver(log.saved.length, log);
    },
  };
  env.window = env;
  env.globalThis = env;
  Object.defineProperty(env, "__log", { value: log });
  return env;
}

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/* JALの応答。1区間あたり2便、うち1便に空席があるものを返す */
const jalOk = (seat) => {
  if (seat) {
    return res(200, {
      data: {
        seatmaps: [{
          decks: [{
            seats: [
              { cabin: "eco", seatCharacteristicsCodes: ["W", "1A"], travelers: [{ seatAvailabilityStatus: "available", seatCharacteristicsCodes: ["W"] }] },
              { cabin: "eco", seatCharacteristicsCodes: ["A"], travelers: [{ seatAvailabilityStatus: "available", seatCharacteristicsCodes: ["A"] }] },
              { cabin: "eco", seatCharacteristicsCodes: ["E"], travelers: [{ seatAvailabilityStatus: "occupied" }] },
            ],
          }],
        }],
      },
    });
  }
  return res(200, {
    dictionaries: {
      flight: {
        f1: { marketingAirlineCode: "JL", marketingFlightNumber: "101", operatingAirlineCode: "JL", aircraftCode: "359", departure: { dateTime: "2026-08-09T07:00:00" }, arrival: { dateTime: "2026-08-09T08:10:00" } },
      },
    },
    data: {
      airBoundGroups: [{
        boundDetails: { segments: [{ flightId: "f1" }] },
        airBounds: [{
          prices: { unitPrices: [{ prices: [{ total: 20000 }] }] },
          availabilityDetails: [{ cabin: "eco", statusCode: "HK", quota: 9 }],
        }],
      }],
    },
  });
};

const cases = [
  {
    name: "正常に完走する",
    jal: (seat) => jalOk(seat),
    saver: () => res(200, { ok: true }),
    check: (log, out) => ({
      "空席照会は70区間×2日": log.searches === 140,
      "保存は1日2回＝計4回": log.saved.length === 4,
      "座席属性コードを持ち帰る": !!log.saved.at(-1).codes && log.saved.at(-1).codes.n > 0,
      "旅客側と座席側を別々に数える": log.saved.at(-1).codes.t.W === log.saved.at(-1).codes.s.W
        && log.saved.at(-1).codes.s["1A"] > 0 && !log.saved.at(-1).codes.t["1A"],
      "項目名と実物を1件持ち帰る": log.saved.at(-1).codes.keys.includes("seat.cabin")
        && /seatAvailabilityStatus/.test(log.saved.at(-1).codes.sample),
      "成功表示で終わる": /更新しました/.test(out),
    }),
  },
  {
    name: "JALに弾かれる（CORSで例外）",
    jal: () => { throw new TypeError("Failed to fetch"); },
    saver: () => res(200, { ok: true }),
    check: (log, out) => ({
      "70区間も叩かず3区間で止める": log.searches === 3,
      "1件も保存しない": log.saved.length === 0,
      "理由を出す": /接続を断られ/.test(out) && /Failed to fetch/.test(out),
      "やり直し方を出す": /国内線を1回検索/.test(out),
    }),
  },
  {
    name: "JALが403を返す（本文つき）",
    jal: () => res(403, {}),
    saver: () => res(200, { ok: true }),
    check: (log, out) => ({
      // 403は1回リトライしてから諦めるので、3区間ぶん＝6回で止まる
      "3区間ぶんで止める": log.searches === 6,
      "1件も保存しない": log.saved.length === 0,
      "理由にHTTPを出す": /HTTP 403/.test(out),
    }),
  },
  {
    name: "保存が1回こけても次で通る",
    jal: (seat) => jalOk(seat),
    saver: (n) => (n === 1 ? res(500, { error: "一時的な障害" }) : res(200, { ok: true })),
    check: (log, out) => ({
      "やり直して完走する": /更新しました/.test(out),
      "保存を試した回数が増える": log.saved.length === 5,
    }),
  },
  {
    name: "保存が3回とも駄目",
    jal: (seat) => jalOk(seat),
    saver: () => res(503, { error: "落ちています" }),
    check: (log, out) => ({
      "3回試す": log.saved.length === 3,
      "理由を出す": /保存できませんでした/.test(out) && /落ちています/.test(out),
      "JSONを落とす": /ダウンロード/.test(out),
    }),
  },
];

let ng = 0;
for (const c of cases) {
  const env = makeEnv({ jal: c.jal, saver: c.saver });
  vm.createContext(env);
  vm.runInContext(source, env);
  const readUi = () => {
    const ui = env.document.getElementById("jal-seat-collector");
    return [ui?.querySelector("#jsc-msg")?.textContent || "",
            ui?.querySelector("#jsc-sub")?.textContent || ""].join(" / ");
  };
  const DONE = /更新しました|できませんでした|止まりました|断られ|実行できません|見つかりません/;
  let out = "";
  for (let i = 0; i < 600; i++) {
    out = readUi();
    if (DONE.test(out)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const L = env.__log;
  console.log(`\n■ ${c.name}`);
  console.log(`   空席照会 ${L.searches} 回 / 座席表 ${L.seatmaps} 回 / 保存 ${L.saved.length} 回`);
  for (const [label, ok] of Object.entries(c.check(env.__log, out))) {
    if (!ok) ng++;
    console.log(`   ${ok ? "OK " : "NG "} ${label}`);
  }
  console.log(`   表示: ${out.slice(0, 150)}`);
}
console.log(ng ? `\n${ng} 件失敗` : "\nすべてOK");
process.exit(ng ? 1 : 0);
