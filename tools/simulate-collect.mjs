#!/usr/bin/env node
/* 収集スクリプトを、偽のブラウザと偽のJAL・保存先の上で実際に走らせる。
 *
 * このプロジェクトは「JALの実ページで押す最後の一手」をこちら側で確かめられない。
 * せめて分岐（完走／弾かれたとき／保存に失敗したとき）は手元で通しておきたい。
 * JALにも保存先にも一切つながないので、何度走らせても実害はない。
 *
 * ブックマークレット用と拡張用の**両方**を同じシナリオにかける。
 * 以前この2つは別実装で、片方だけ直して片方が置き去りになった。
 *
 *   node tools/simulate-collect.mjs
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import nodeCrypto from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 実際に配信するのと同じ組み方で束ねる。中身には手を入れない。 */
async function bundle(entry) {
  const out = await build({
    entryPoints: [join(root, "tools", entry)],
    bundle: true, minify: false, format: "iife",
    target: ["chrome100"], charset: "utf8", write: false,
  });
  return out.outputFiles[0].text;
}

const res = (status, body) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const text = (out) => (typeof out === "string" ? out : JSON.stringify(out));

/* ---- 偽ブラウザ。収集スクリプトが触るところだけ用意する ---- */
function makeEnv({ host = "booking.jal.co.jp", jal, saver, pick = "両日" }) {
  const log = { saved: [], searches: 0, seatmaps: 0, finished: null, progress: [] };

  const node = (tag) => {
    const el = {
      tagName: tag, style: { cssText: "" }, children: [], _text: "", id: "",
      set textContent(v) { el._text = String(v); },
      get textContent() { return el._text; },
      /* innerHTML で組み立てたあと querySelector('#id') で引かれるので、
         id つきのタグだけ子要素として作る（雑なHTMLパーサ代わり）。 */
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
      remove() {}, click() {}, select() {},
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
    crypto: { randomUUID: () => nodeCrypto.randomUUID() },
    performance: { now: () => 60000 },
    navigator: { userAgent: "test", wakeLock: null, clipboard: null },
    Blob: class { constructor(parts) { this.size = String(parts[0]).length; } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    /* JALを叩く間隔も再送の待ちも、検証では待つ意味がない。
       ソースを書き換えるとズレるので、時計のほうを縮める。 */
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 3)),
    clearTimeout, setInterval, clearInterval, queueMicrotask,
    Date, JSON, Math, Object, Array, String, Number, Promise, Map, Set, Error, console,
    AbortController,
    // 拡張との受け渡し
    chrome: {
      storage: { local: { get: async () => ({ updateKey: "TESTKEY", job: { id: 1, days: [0, 1] } }) } },
      runtime: {
        sendMessage: (m) => {
          if (m.type === "collect-finished") log.finished = m;
          else if (m.type === "collect-progress") log.progress.push(m.message);
        },
      },
    },
    fetch: async (url, init) => {
      // 打ち切り（AbortController）が効くことも試したいので、signal を尊重する
      if (init?.signal) {
        if (init.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        var aborted = new Promise((_, rej) => init.signal.addEventListener("abort",
          () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
      const race = (p) => (init?.signal ? Promise.race([p, aborted]) : p);
      if (String(url).includes("api.dom.jal.co.jp")) {
        const seat = String(url).includes("seatmaps");
        if (seat) log.seatmaps++; else log.searches++;
        return race(Promise.resolve().then(() => jal(seat, init, log)));
      }
      if (String(url).includes("action=finish")) return res(200, { ok: true });
      log.saved.push(JSON.parse(init.body));
      return saver(log.saved.length, log);
    },
  };
  env.window = env;
  env.globalThis = env;
  Object.defineProperty(env, "__log", { value: log });
  return env;
}

/* JALの応答。1区間1便・空席ありで返す。座席は窓側1・通路側1・使用済み1 */
let FLIGHTS_PER_ROUTE = 1;
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
      flight: Object.fromEntries(Array.from({ length: FLIGHTS_PER_ROUTE }, (_, k) => [`f${k}`, {
        marketingAirlineCode: "JL", marketingFlightNumber: String(101 + k),
        operatingAirlineCode: "JL", aircraftCode: "359",
        departure: { dateTime: `2026-08-09T0${k % 9}:00:00` },
        arrival: { dateTime: `2026-08-09T0${k % 9}:50:00` },
      }])),
    },
    data: {
      airBoundGroups: Array.from({ length: FLIGHTS_PER_ROUTE }, (_, k) => ({
        boundDetails: { segments: [{ flightId: `f${k}` }] },
        airBounds: [{
          prices: { unitPrices: [{ prices: [{ total: 20000 }] }] },
          availabilityDetails: [{ cabin: "eco", statusCode: "HK", quota: 9 }],
        }],
      })),
    },
  });
};

const ok = (out) => /更新しました/.test(text(out)) || out?.ok === true;

const cases = [
  {
    name: "正常に完走する",
    jal: (seat) => jalOk(seat),
    saver: () => res(200, { ok: true }),
    check: (log, out) => ({
      "空席照会は70区間×2日": log.searches === 140,
      "保存は1日3回（運賃・50便目・最後）＝計6回": log.saved.length === 6,
      "座席属性コードを持ち帰る": log.saved.at(-1).codes?.n > 0,
      "旅客側と座席側を別々に数える":
        log.saved.at(-1).codes.s["1A"] > 0 && !log.saved.at(-1).codes.t["1A"],
      "項目名と実物を1件持ち帰る": log.saved.at(-1).codes.keys.includes("seat.cabin")
        && /seatAvailabilityStatus/.test(log.saved.at(-1).codes.sample),
      "成功で終わる": ok(out),
    }),
  },
  {
    name: "JALに弾かれる（CORSで例外）",
    jal: () => { throw new TypeError("Failed to fetch"); },
    saver: () => res(200, { ok: true }),
    check: (log, out) => ({
      "70区間も叩かず3区間で止める": log.searches === 3,
      "1件も保存しない": log.saved.length === 0,
      "理由を出す": /接続を断られ/.test(text(out)) && /Failed to fetch/.test(text(out)),
      "やり直し方を出す": /国内線を1回検索/.test(text(out)),
    }),
  },
  {
    name: "JALが403を返す",
    jal: () => res(403, {}),
    saver: () => res(200, { ok: true }),
    check: (log, out) => ({
      "3区間ぶん＝6回で止める": log.searches === 6,
      "1件も保存しない": log.saved.length === 0,
      "理由にHTTPを出す": /HTTP 403/.test(text(out)),
    }),
  },
  {
    name: "保存が1回こけても次で通る",
    jal: (seat) => jalOk(seat),
    saver: (n) => (n === 1 ? res(500, { error: "一時的な障害" }) : res(200, { ok: true })),
    check: (log, out) => ({
      "やり直して完走する": ok(out),
      "保存を試した回数が1回ぶん増える": log.saved.length === 7,
    }),
  },
  {
    name: "座席表は50便ごとに区切って保存する",
    flightsPerRoute: 2, // 1日140便 → 50/100 で2回、最後に1回
    jal: (seat) => jalOk(seat),
    saver: () => res(200, { ok: true }),
    check: (log, out) => ({
      "完走する": ok(out),
      "1日あたり運賃1回＋座席表3回＝計8回": log.saved.length === 8,
      "途中の保存にも調査ぶんが入る": log.saved[1].codes?.n > 0,
    }),
  },
  {
    name: "座席表の返事が返ってこなくても止まらない",
    jal: (seat) => (seat ? new Promise(() => {}) : jalOk(false)), // 座席表だけ永久に待たせる
    saver: () => res(200, { ok: true }),
    check: (log, out) => ({
      "打ち切って最後まで進む": ok(out),
      "座席表は全便ぶん試している": log.seatmaps === 140,
      "区切りの保存も行われる": log.saved.length === 6,
    }),
  },
  {
    name: "保存が3回とも駄目",
    jal: (seat) => jalOk(seat),
    saver: () => res(503, { error: "落ちています" }),
    check: (log, out) => ({
      "3回試す": log.saved.length === 3,
      "理由を出す": /保存できませんでした/.test(text(out)) && /落ちています/.test(text(out)),
    }),
  },
];

const shells = [
  { name: "ブックマークレット", entry: "collect-in-browser.js" },
  { name: "Chrome拡張", entry: "collect-extension.js" },
];

let ng = 0;
for (const shell of shells) {
  const source = await bundle(shell.entry);
  console.log(`\n=============== ${shell.name} ===============`);
  for (const c of cases) {
    FLIGHTS_PER_ROUTE = c.flightsPerRoute || 1;
    const env = makeEnv({ jal: c.jal, saver: c.saver });
    vm.createContext(env);
    vm.runInContext(source, env);

    const readOut = () => {
      if (env.__log.finished) return env.__log.finished; // 拡張は結果を返して終わる
      const ui = env.document.getElementById("jal-seat-collector");
      return [ui?.querySelector("#jsc-msg")?.textContent || "",
        ui?.querySelector("#jsc-sub")?.textContent || ""].join(" / ");
    };
    const DONE = /更新しました|できませんでした|止まりました|断られ|実行できません|見つかりません/;
    let out = "";
    for (let i = 0; i < 800; i++) {
      out = readOut();
      if (typeof out !== "string" || DONE.test(out)) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const L = env.__log;
    console.log(`\n■ ${c.name}`);
    console.log(`   空席照会 ${L.searches} 回 / 座席表 ${L.seatmaps} 回 / 保存 ${L.saved.length} 回`);
    for (const [label, pass] of Object.entries(c.check(L, out))) {
      if (!pass) ng++;
      console.log(`   ${pass ? "OK " : "NG "} ${label}`);
    }
    console.log(`   結果: ${text(out).slice(0, 130)}`);
  }
}
console.log(ng ? `\n${ng} 件失敗` : "\nすべてOK");
process.exit(ng ? 1 : 0);
