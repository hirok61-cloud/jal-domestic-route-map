/* 生成物。編集しないこと。もとは tools/collect-core.js と collect-extension.js。
   直したら npm run build:bookmarklet && npm run test:collect && npm run purge:cdn */
var __JAL_SEATS_BUILD__ = "2026-08-09 14:32Z";
(() => {
  // tools/collect-core.js
  var ENDPOINT = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats";
  var SAVE_ENDPOINTS = [
    { url: ENDPOINT, name: "保存先" }
  ];
  var HUB = "HND";
  var SPOKES = [
    "AKJ",
    "AOJ",
    "ASJ",
    "AXT",
    "CTS",
    "FUK",
    "GAJ",
    "HIJ",
    "HKD",
    "ISG",
    "ITM",
    "IZO",
    "KCZ",
    "KIX",
    "KKJ",
    "KMI",
    "KMJ",
    "KMQ",
    "KOJ",
    "KUH",
    "MMB",
    "MMY",
    "MSJ",
    "MYJ",
    "NGO",
    "NGS",
    "OBO",
    "OIT",
    "OKA",
    "OKJ",
    "SHM",
    "TAK",
    "TKS",
    "UBJ",
    "UEO"
  ];
  var API = "https://api.dom.jal.co.jp/rmweb-api/search/air-bounds";
  var SEATMAP_API = "https://api.dom.jal.co.jp/rmweb-api/shopping/seatmaps";
  var CONTENT_VERSION = "/jl/statics/dom-bkg/content/1.0.170/";
  var API_KEY = "JZWuY6OJ5M2IfvIgZVRMA7dhbjk7jTtga0lclevt";
  var DELAY_MS = 1200;
  var SEAT_SAVE_EVERY = 50;
  var CABIN = { eco: "eco", business: "clsj", first: "first" };
  var jstDate = (offsetDays) => {
    const t = new Date(Date.now() + 9 * 36e5 + offsetDays * 864e5);
    return t.toISOString().slice(0, 10);
  };
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var TIMEOUT_MS = 3e4;
  var SAVE_TIMEOUT_MS = 2e4;
  var SAVE_BUDGET_MS = 9e4;
  function withDeadline(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label}が${ms / 1e3}秒で返事をしませんでした`)), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }
  async function fetchWithTimeout(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      throw ctrl.signal.aborted ? new Error(`応答がありません（${TIMEOUT_MS / 1e3}秒）`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  function postByXhr(url, body, headers) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", url, true);
      x.timeout = SAVE_TIMEOUT_MS;
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.onload = () => resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, text: x.responseText });
      x.onerror = () => reject(new Error("XHRも通りませんでした（通信そのものが遮られています）"));
      x.ontimeout = () => reject(new Error(`XHRの応答がありません（${SAVE_TIMEOUT_MS / 1e3}秒）`));
      x.send(body);
    });
  }
  function describeEnv() {
    const native = (f) => String(f).includes("[native code]");
    const build = typeof __JAL_SEATS_BUILD__ !== "undefined" ? __JAL_SEATS_BUILD__ : "不明";
    return [
      "fetch=" + (native(fetch) ? "素" : "★横取りされています"),
      "XHR=" + (native(XMLHttpRequest.prototype.open) ? "素" : "★横取りされています"),
      "版=" + build,
      "読込元=" + (window.__JAL_SEATS_SRC || "不明")
    ].join(" / ");
  }
  function fold(payload) {
    const flights = (payload.dictionaries || {}).flight || {};
    const byFlight = /* @__PURE__ */ new Map();
    for (const group of (payload.data || {}).airBoundGroups || []) {
      const segments = (group.boundDetails || {}).segments || [];
      if (segments.length !== 1) continue;
      const info = flights[segments[0].flightId];
      if (!info) continue;
      let rec = byFlight.get(segments[0].flightId);
      if (!rec) {
        rec = {
          no: info.marketingAirlineCode + info.marketingFlightNumber,
          op: info.operatingAirlineCode || info.marketingAirlineCode,
          dep: info.departure.dateTime.slice(11, 16),
          arr: info.arrival.dateTime.slice(11, 16),
          ac: info.aircraftCode || "",
          eco: 0,
          clsj: null,
          first: null,
          fare: null
        };
        byFlight.set(segments[0].flightId, rec);
      }
      for (const bound of group.airBounds || []) {
        const unit = ((bound.prices || {}).unitPrices || [])[0];
        const price = unit && unit.prices && unit.prices[0] ? unit.prices[0].total : null;
        for (const avail of bound.availabilityDetails || []) {
          const key = CABIN[avail.cabin];
          if (!key) continue;
          const quota = avail.statusCode === "HK" ? avail.quota || 0 : 0;
          if (rec[key] === null || quota > rec[key]) rec[key] = quota;
          if (key === "eco" && quota > 0 && price != null) {
            if (rec.fare === null || price < rec.fare) rec.fare = price;
          }
        }
      }
    }
    return [...byFlight.values()].sort((a, b) => a.dep.localeCompare(b.dep));
  }
  function describeError(payload) {
    const err = (payload.errors || [])[0];
    if (!err) return ["empty", "残りの便なし"];
    const text = (err.title || err.detail || err.code || "").toLowerCase();
    if (text.includes("cancel")) return ["cancelled", "全便欠航"];
    if (text.includes("no flight") || text.includes("not found")) return ["empty", "残りの便なし"];
    return ["error", err.title || err.code || "取得失敗"];
  }
  function createRun({ auth, updateKey, runId, report = () => {
  }, onSaveFailed }) {
    const headers = () => ({
      accept: "application/json",
      "content-type": "application/json",
      authorization: auth,
      "x-api-key": API_KEY,
      "ama-client-ref": crypto.randomUUID() + "--" + crypto.randomUUID()
    });
    async function search(origin, destination, date) {
      const res = await fetchWithTimeout(API, {
        method: "POST",
        credentials: "include",
        headers: headers(),
        body: JSON.stringify({
          travelers: [{ passengerTypeCode: "ADT" }],
          itineraries: [{
            originLocationCode: origin,
            destinationLocationCode: destination,
            departureDateTime: date + "T00:00:00.000",
            isRequestedBound: true
          }],
          jalSearchPreferences: { discountCode: "JCF", isCorporate: false },
          searchPreferences: { showSoldOut: true, includeWaitlist: true },
          contentVersionId: CONTENT_VERSION
        })
      });
      return { status: res.status, payload: await res.json().catch(() => null) };
    }
    const codeStats = { n: 0, t: {}, s: {}, keys: [], sample: null };
    const noteCodes = (bucket, codes) => {
      if (!Array.isArray(codes)) return;
      for (const c of codes) {
        if (typeof c !== "string" || c.length > 4) continue;
        if (!(c in bucket) && Object.keys(bucket).length >= 40) continue;
        bucket[c] = (bucket[c] || 0) + 1;
      }
    };
    const noteShape = (seat, traveler) => {
      if (codeStats.sample) return;
      codeStats.keys = [
        ...Object.keys(seat || {}).map((k) => "seat." + k),
        ...Object.keys(traveler || {}).map((k) => "traveler." + k)
      ];
      codeStats.sample = JSON.stringify({ seat, traveler }).slice(0, 700);
    };
    async function seatmap(route, flight, date) {
      const res = await fetchWithTimeout(SEATMAP_API, {
        method: "POST",
        credentials: "include",
        headers: headers(),
        body: JSON.stringify({
          flights: [{
            marketingAirlineCode: flight.no.slice(0, 2),
            marketingFlightNumber: flight.no.slice(2),
            originLocationCode: route.o,
            destinationLocationCode: route.d,
            departureDate: date,
            bookingClass: "Y",
            // 運賃別のクラスを渡しても結果は同じだった
            isRequestedFlight: true
          }],
          travelers: [{ passengerTypeCode: "ADT", isRequestedTraveler: true }],
          contentApplicationId: "-",
          contentVersionId: CONTENT_VERSION
        })
      });
      if (res.status !== 200) return null;
      const json = await res.json().catch(() => null);
      const decks = ((((json || {}).data || {}).seatmaps || [])[0] || {}).decks || [];
      let sa = 0, st = 0, sw = 0, sl = 0, sc = 0, se = 0, sg = 0, sj = null, sf = null;
      const smRaw = [];
      for (const deck of decks) {
        for (const s of deck.seats || []) {
          const t = s.travelers && s.travelers[0];
          const open = t && t.seatAvailabilityStatus === "available";
          if (s.cabin === "eco") {
            st++;
            if (open) {
              sa++;
              const codes = t.seatCharacteristicsCodes || [];
              const isWindow = codes.includes("W") || codes.includes("1W");
              const isAisle = codes.includes("A");
              const isExit = codes.includes("E");
              const isLeg = codes.includes("L");
              if (isWindow) sw++;
              if (isAisle) sl++;
              if (codes.includes("9")) sc++;
              if (isExit) se++;
              if (isLeg) sg++;
              codeStats.n++;
              noteCodes(codeStats.t, t.seatCharacteristicsCodes);
              noteCodes(codeStats.s, s.seatCharacteristicsCodes);
              noteShape(s, t);
              let flags = "";
              if (isWindow) flags += "W";
              if (isAisle) flags += "A";
              if (isExit) flags += "E";
              if (isLeg) flags += "L";
              const no = String(s.seatNumber || "");
              const m = no.match(/^(\d+)([A-Za-z]+)$/);
              smRaw.push({
                str: flags ? `${no}:${flags}` : no,
                row: m ? Number(m[1]) : 999,
                col: m ? m[2] : no
              });
            }
          } else if (s.cabin === "business") {
            sj = (sj || 0) + (open ? 1 : 0);
          } else if (s.cabin === "first") {
            sf = (sf || 0) + (open ? 1 : 0);
          }
        }
      }
      const sm = smRaw.sort((a, b) => a.row - b.row || a.col.localeCompare(b.col)).map((x) => x.str);
      return st ? { sa, st, sw, sl, sc, se, sg, sj, sf, sm } : null;
    }
    const pairs = [];
    for (const spoke of SPOKES) pairs.push([HUB, spoke], [spoke, HUB]);
    let sendBy = null;
    async function save(snap) {
      const headers2 = { "content-type": "application/json", "x-update-key": updateKey };
      const body = JSON.stringify(snap);
      const trouble = [];
      const started = Date.now();
      const combos = [];
      for (const ep of SAVE_ENDPOINTS) for (const way of ["fetch", "xhr"]) combos.push({ ep, way });
      combos.sort((a, b) => (sendBy && b.ep.url === sendBy.url && b.way === sendBy.way ? 1 : 0) - (sendBy && a.ep.url === sendBy.url && a.way === sendBy.way ? 1 : 0));
      let hopeless = false;
      for (let attempt = 1; attempt <= 3 && !hopeless; attempt++) {
        for (const { ep, way } of combos) {
          if (Date.now() - started > SAVE_BUDGET_MS) {
            trouble.push("時間切れ");
            hopeless = true;
            break;
          }
          const label = `${ep.name}へ${way === "fetch" ? "通常の方法" : "別の方法(XHR)"}`;
          try {
            report("save-try", { way, host: ep.name, attempt, seconds: SAVE_TIMEOUT_MS / 1e3 });
            const res = await withDeadline(
              way === "fetch" ? fetchWithTimeout(ep.url, { method: "POST", headers: headers2, body }) : postByXhr(ep.url, body, headers2),
              SAVE_TIMEOUT_MS,
              label
            );
            if (res.ok) {
              sendBy = { url: ep.url, way };
              return;
            }
            const detail = way === "fetch" ? (await res.json().catch(() => ({}))).error : (() => {
              try {
                return JSON.parse(res.text).error;
              } catch {
                return null;
              }
            })();
            trouble.push(`${label}: ${detail || "HTTP " + res.status}`);
            if (res.status === 400 || res.status === 401) {
              hopeless = true;
              break;
            }
          } catch (e) {
            trouble.push(`${label}: ${String(e.message || e)}`);
          }
        }
        if (!hopeless && attempt < 3) {
          report("save-retry", { attempt, wait: attempt * 5, error: trouble[trouble.length - 1] });
          await sleep(attempt * 5e3);
        }
      }
      if (onSaveFailed) onSaveFailed(snap);
      throw new Error("保存できませんでした（" + [...new Set(trouble)].join(" / ") + "）［" + describeEnv() + "］" + (onSaveFailed ? "。JSONをダウンロードしました" : ""));
    }
    async function collectDay({ date, label, dayIndex = 0, dayCount = 1 }) {
      const routes = [];
      const total = pairs.length * dayCount;
      for (let i = 0; i < pairs.length; i++) {
        const [origin, destination] = pairs[i];
        const done = dayIndex * pairs.length + i;
        report("fares", {
          label,
          i,
          total: pairs.length,
          origin,
          destination,
          pct: Math.round(done / total * 100),
          leftSec: Math.ceil((total - done) * (DELAY_MS + 900) / 1e3)
        });
        let res;
        try {
          res = await search(origin, destination, date);
          if (res.status !== 200) {
            await sleep(4e3);
            res = await search(origin, destination, date);
          }
        } catch (e) {
          res = { status: 0, payload: null, thrown: String(e.message || e) };
        }
        const entry = { o: origin, d: destination };
        const payload = res.payload || {};
        if (res.status !== 200) {
          entry.status = "error";
          entry.message = res.thrown ? "通信できず（" + res.thrown + "）" : "HTTP " + res.status;
        } else if (payload.errors) {
          [entry.status, entry.message] = describeError(payload);
        } else {
          entry.flights = fold(payload);
          entry.status = entry.flights.length ? "ok" : "empty";
          if (!entry.flights.length) entry.message = "残りの便なし";
        }
        routes.push(entry);
        if (routes.length >= 3 && !routes.some((r) => r.status !== "error")) {
          throw new Error(
            "JALに接続を断られています（" + (entry.message || "理由不明") + "）。空席照会の画面を開き直し、国内線を1回検索してから、もう一度実行してください。"
          );
        }
        await sleep(DELAY_MS);
      }
      const snapshot = () => ({
        generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        runId,
        date,
        hub: HUB,
        source: "JAL公式 空席照会API (api.dom.jal.co.jp/rmweb-api/search/air-bounds)",
        note: "残席数は9が上限（9席以上でも9と返る）。普通席=eco / クラスJ=clsj / ファースト=first。 sa=座席表で選べる普通席数 / st=普通席の総座席数。",
        routes,
        // 座席属性コードの実地調査ぶん（窓側の数え方を直すための材料。表示には使わない）
        ...codeStats.n ? { codes: codeStats } : {}
      });
      if (routes.every((r) => r.status === "error")) {
        throw new Error("JALから空席を取得できませんでした（セッションが弾かれた可能性）");
      }
      const count = (fn) => routes.reduce((n, r) => n + (r.flights || []).filter(fn).length, 0);
      const stats = {
        flights: routes.reduce((n, r) => n + (r.flights || []).length, 0),
        withSeats: count((f) => f.eco > 0),
        failed: routes.filter((r) => r.status === "error").length,
        seatChecked: 0,
        seatZero: 0
      };
      report("saving", { label, stats, phase: "fares" });
      await save(snapshot());
      const targets = [];
      for (const r of routes) {
        for (const f of r.flights || []) if (f.eco > 0) targets.push([r, f]);
      }
      for (let i = 0; i < targets.length; i++) {
        const [r, f] = targets[i];
        report("seats", {
          label,
          i,
          total: targets.length,
          origin: r.o,
          destination: r.d,
          no: f.no,
          pct: Math.round((dayIndex + i / targets.length) / dayCount * 100),
          leftSec: Math.ceil((targets.length - i) * (DELAY_MS + 1100) / 1e3)
        });
        try {
          const counts = await seatmap(r, f, date);
          if (counts) Object.assign(f, counts);
        } catch {
        }
        if ((i + 1) % SEAT_SAVE_EVERY === 0 && i + 1 < targets.length) {
          stats.seatChecked = count((f2) => f2.sa !== void 0);
          stats.seatZero = count((f2) => f2.sa === 0);
          report("saving", { label, stats, phase: "seats" });
          await save(snapshot());
        }
        await sleep(DELAY_MS);
      }
      if (targets.length) {
        stats.seatChecked = count((f) => f.sa !== void 0);
        stats.seatZero = count((f) => f.sa === 0);
        report("saving", { label, stats, phase: "seats" });
        await save(snapshot());
      }
      return stats;
    }
    return { collectDay, codeStats, pairs };
  }

  // tools/collect-extension.js
  (async () => {
    const finish = (ok, extra) => chrome.runtime.sendMessage({ type: "collect-finished", ok, ...extra });
    const { job, updateKey } = await chrome.storage.local.get(["job", "updateKey"]);
    if (!updateKey) return finish(false, { error: "合言葉が未設定です" });
    const creds = JSON.parse(sessionStorage.getItem("apiAuthCreds") || "{}");
    if (!creds.authToken) return finish(false, { error: "JALのセッションを取得できませんでした" });
    const OFFSETS = Array.isArray(job?.days) && job.days.length ? job.days : [0, 1];
    const send = (path, body) => fetch(ENDPOINT + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-update-key": updateKey },
      body: JSON.stringify(body)
    });
    const post = (message) => chrome.runtime.sendMessage({ type: "collect-progress", job, message });
    const report = (kind, x) => {
      if (kind === "fares" && x.i % 10 === 0) post(`${x.label}分を取得中 ${x.i + 1}/${x.total}`);
      else if (kind === "seats" && x.i % 10 === 0) post(`${x.label}分の座席表 ${x.i + 1}/${x.total}`);
      else if (kind === "saving") post(`${x.label}分を保存しています`);
      else if (kind === "save-try") post(`保存を送信中（${x.host} / ${x.way} ${x.attempt}回目）`);
      else if (kind === "save-retry") post(`保存をやり直しています（${x.error}）`);
    };
    const run = createRun({
      auth: "Bearer " + creds.authToken,
      updateKey,
      runId: crypto.randomUUID(),
      report
    });
    const parts = [];
    try {
      for (let d = 0; d < OFFSETS.length; d++) {
        const label = OFFSETS[d] === 0 ? "今日" : "翌日";
        const s = await run.collectDay({
          date: jstDate(OFFSETS[d]),
          label,
          dayIndex: d,
          dayCount: OFFSETS.length
        });
        parts.push(`${label} ${s.flights}便中${s.withSeats}便に空席` + (s.seatChecked ? `（座席表確認 ${s.seatChecked}便・うち座席表満席 ${s.seatZero}便）` : ""));
      }
      const summary = parts.join(" / ");
      if (job?.id) await send(`?action=finish&id=${job.id}`, { ok: true, message: summary });
      finish(true, { summary });
    } catch (err) {
      finish(false, {
        error: String(err?.message || err) + (parts.length ? `（${parts.join(" / ")} まで保存済み）` : "")
      });
    }
  })();
})();
