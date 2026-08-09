/* ===========================================================================
   JAL国内線 空席コレクタ ── 収集ロジック本体（唯一の実装）

   同じ処理を2か所から使う。
     - ブックマークレット   … tools/collect-in-browser.js → seats/collect.min.js
     - Chrome拡張          … tools/collect-extension.js  → extension/collect.js

   以前はこの2つが別々のコピーで、片方だけ直して片方が置き去りになった
   （拡張が古いままだったため、直したはずの中断処理も座席属性の調査も
   拡張経由の収集には入っていなかった）。同じ轍を踏まないよう1本にする。

   画面まわりと「どの日を集めるか」の決め方だけが呼び出し側の仕事で、
   JALを叩く・畳む・保存する部分はすべてここにある。

   合言葉はここに持たない。呼び出し側が渡す。
   =========================================================================== */

export const ENDPOINT = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats";
export const SITE = "https://jal-domestic-route-map.vercel.app/seats/";

export const HUB = "HND";
export const SPOKES = [
  "AKJ", "AOJ", "ASJ", "AXT", "CTS", "FUK", "GAJ", "HIJ", "HKD", "ISG",
  "ITM", "IZO", "KCZ", "KIX", "KKJ", "KMI", "KMJ", "KMQ", "KOJ", "KUH",
  "MMB", "MMY", "MSJ", "MYJ", "NGO", "NGS", "OBO", "OIT", "OKA", "OKJ",
  "SHM", "TAK", "TKS", "UBJ", "UEO",
];

const API = "https://api.dom.jal.co.jp/rmweb-api/search/air-bounds";
const SEATMAP_API = "https://api.dom.jal.co.jp/rmweb-api/shopping/seatmaps";
const CONTENT_VERSION = "/jl/statics/dom-bkg/content/1.0.170/";
const API_KEY = "JZWuY6OJ5M2IfvIgZVRMA7dhbjk7jTtga0lclevt";
export const DELAY_MS = 1200; // JALのサーバを叩く間隔。短くしないこと
const CABIN = { eco: "eco", business: "clsj", first: "first" };

export const jstDate = (offsetDays) => {
  const t = new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000);
  return t.toISOString().slice(0, 10);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 返事が返ってこないリクエストで収集全体が止まらないようにする。
   タイムアウトを持たせていなかったため、1本ハングすると先へ進めず、
   「進捗が止まったため中断しました」で終わっていた（座席表 91/231 で実際に発生）。
   打ち切れば呼び出し側が例外として拾い、その1便を飛ばして続けられる。 */
const TIMEOUT_MS = 30000;
async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw ctrl.signal.aborted ? new Error(`応答がありません（${TIMEOUT_MS / 1000}秒）`) : e;
  } finally {
    clearTimeout(timer);
  }
}

/* statusCode は HK=確保可 / HL=キャンセル待ち(満席)。ただし「対象者限定」の運賃は
   満席の便でも HK・quota 0 を返すので、空席の判定は quota の最大値で行う。 */
function fold(payload) {
  const flights = (payload.dictionaries || {}).flight || {};
  const byFlight = new Map();

  for (const group of (payload.data || {}).airBoundGroups || []) {
    const segments = (group.boundDetails || {}).segments || [];
    if (segments.length !== 1) continue; // 乗り継ぎ旅程は対象外
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
        eco: 0, clsj: null, first: null, fare: null,
      };
      byFlight.set(segments[0].flightId, rec);
    }

    for (const bound of group.airBounds || []) {
      const unit = ((bound.prices || {}).unitPrices || [])[0];
      const price = unit && unit.prices && unit.prices[0] ? unit.prices[0].total : null;
      for (const avail of bound.availabilityDetails || []) {
        const key = CABIN[avail.cabin];
        if (!key) continue;
        const quota = avail.statusCode === "HK" ? (avail.quota || 0) : 0;
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

/**
 * 1回の収集を作る。
 *
 * @param auth        "Bearer …"（ページの sessionStorage から借りたもの）
 * @param updateKey   保存先の合言葉
 * @param runId       この収集の識別子。同じ収集の2度目の保存を見分けるのに使う
 * @param report      進捗を外に伝える。呼び出し側が画面に出す
 * @param onSaveFailed 保存を諦めたときに呼ぶ（ブックマークレットはJSONを落とす）
 */
export function createRun({ auth, updateKey, runId, report = () => {}, onSaveFailed }) {
  const headers = () => ({
    accept: "application/json",
    "content-type": "application/json",
    authorization: auth,
    "x-api-key": API_KEY,
    "ama-client-ref": crypto.randomUUID() + "--" + crypto.randomUUID(),
  });

  /** 1区間分空席照会する。 */
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
          isRequestedBound: true,
        }],
        jalSearchPreferences: { discountCode: "JCF", isCorporate: false },
        searchPreferences: { showSoldOut: true, includeWaitlist: true },
        contentVersionId: CONTENT_VERSION,
      }),
    });
    return { status: res.status, payload: await res.json().catch(() => null) };
  }

  /* 座席属性コードの実地調査。窓側(W)の数が座席配置から見て少なすぎる
     （737-800の3-3で「窓でも通路でもない」が43%。中央席は33%が上限）ので、
     JALが実際にどのコードをどこに付けているかを数えて持ち帰る。
     追加のリクエストはない（同じ応答を数えるだけ）。
       t = 旅客ごとの属性（いま窓側/通路側を数えているのはこちら）
       s = 座席そのものの属性（こちらに多く付いていれば、読む場所が違う）
     非常口席・足元の広い席が判別できるかどうかも、ここに出るコードで分かる。 */
  const codeStats = { n: 0, t: {}, s: {}, keys: [], sample: null };
  const noteCodes = (bucket, codes) => {
    if (!Array.isArray(codes)) return;
    for (const c of codes) {
      if (typeof c !== "string" || c.length > 4) continue;
      if (!(c in bucket) && Object.keys(bucket).length >= 40) continue; // 際限なく増やさない
      bucket[c] = (bucket[c] || 0) + 1;
    }
  };
  const noteShape = (seat, traveler) => {
    if (codeStats.sample) return;
    codeStats.keys = [
      ...Object.keys(seat || {}).map((k) => "seat." + k),
      ...Object.keys(traveler || {}).map((k) => "traveler." + k),
    ];
    codeStats.sample = JSON.stringify({ seat, traveler }).slice(0, 700);
  };

  /* 座席表を1便分取る。運賃の在庫（予約クラスの枠）と、座席表で実際に
     指定できる席は別管理で、JALは当日空港割り当て分を確保しているため、
     運賃が「空席あり」でも座席表は埋まっていることがある。 */
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
          bookingClass: "Y", // 運賃別のクラスを渡しても結果は同じだった
          isRequestedFlight: true,
        }],
        travelers: [{ passengerTypeCode: "ADT", isRequestedTraveler: true }],
        contentApplicationId: "-",
        contentVersionId: CONTENT_VERSION,
      }),
    });
    if (res.status !== 200) return null;
    const json = await res.json().catch(() => null);
    const decks = ((((json || {}).data || {}).seatmaps || [])[0] || {}).decks || [];
    /* 同じレスポンスからクラスJ・ファーストと、窓側/通路側も数える。
       W=窓側, A=通路側（座席属性コード）。 */
    let sa = 0, st = 0, sw = 0, sl = 0, sj = null, sf = null;
    for (const deck of decks) {
      for (const s of deck.seats || []) {
        const t = s.travelers && s.travelers[0];
        const open = t && t.seatAvailabilityStatus === "available";
        if (s.cabin === "eco") {
          st++;
          if (open) {
            sa++;
            const codes = (t.seatCharacteristicsCodes || []);
            if (codes.includes("W")) sw++;
            if (codes.includes("A")) sl++;
            codeStats.n++;
            noteCodes(codeStats.t, t.seatCharacteristicsCodes);
            noteCodes(codeStats.s, s.seatCharacteristicsCodes);
            noteShape(s, t);
          }
        } else if (s.cabin === "business") {
          sj = (sj || 0) + (open ? 1 : 0);
        } else if (s.cabin === "first") {
          sf = (sf || 0) + (open ? 1 : 0);
        }
      }
    }
    return st ? { sa, st, sw, sl, sj, sf } : null;
  }

  const pairs = [];
  for (const spoke of SPOKES) pairs.push([HUB, spoke], [spoke, HUB]);

  /* 8〜10分かけて集めたものを、送信1回の失敗で捨てないようにする。
     スマホの回線は一瞬切れることがあるので、間を空けて3回まで試す。 */
  async function save(snap) {
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchWithTimeout(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", "x-update-key": updateKey },
          body: JSON.stringify(snap),
        });
        if (res.ok) return;
        last = (await res.json().catch(() => ({}))).error || "HTTP " + res.status;
        if (res.status === 400 || res.status === 401) break; // 合言葉違い・中身不正は待っても直らない
      } catch (e) {
        last = String(e.message || e);
      }
      if (attempt < 3) {
        report("save-retry", { attempt, wait: attempt * 5, error: last });
        await sleep(attempt * 5000);
      }
    }
    if (onSaveFailed) onSaveFailed(snap);
    throw new Error("保存できませんでした（" + last + "）"
      + (onSaveFailed ? "。JSONをダウンロードしました" : ""));
  }

  /**
   * 1日分集めて保存する。
   * @returns {{flights:number, withSeats:number, seatChecked:number, seatZero:number, failed:number}}
   */
  async function collectDay({ date, label, dayIndex = 0, dayCount = 1 }) {
    const routes = [];
    const total = pairs.length * dayCount;

    for (let i = 0; i < pairs.length; i++) {
      const [origin, destination] = pairs[i];
      const done = dayIndex * pairs.length + i;
      report("fares", {
        label, i, total: pairs.length, origin, destination,
        pct: Math.round((done / total) * 100),
        leftSec: Math.ceil((total - done) * (DELAY_MS + 900) / 1000),
      });

      let res;
      try {
        res = await search(origin, destination, date);
        if (res.status !== 200) {
          await sleep(4000);
          res = await search(origin, destination, date);
        }
      } catch (e) {
        /* fetch が例外を投げるのは、CORSヘッダの付かない応答（＝Akamaiの遮断ページ）か
           通信そのものの失敗。HTTPエラーとは原因が別なので、区別して覚えておく。 */
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

      /* 出だしから1区間も取れないのは、JALにセッションを弾かれているとき。
         以前はこれに気づかず70区間ぶん叩ききってから失敗していた（約90秒、
         JALにも70回の無駄打ち）。3区間続けて駄目なら、その場で理由を出して止める。 */
      if (routes.length >= 3 && !routes.some((r) => r.status !== "error")) {
        throw new Error(
          "JALに接続を断られています（" + (entry.message || "理由不明") + "）。"
          + "空席照会の画面を開き直し、国内線を1回検索してから、もう一度実行してください。",
        );
      }

      await sleep(DELAY_MS);
    }

    const snapshot = () => ({
      generatedAt: new Date().toISOString(),
      runId,
      date,
      hub: HUB,
      source: "JAL公式 空席照会API (api.dom.jal.co.jp/rmweb-api/search/air-bounds)",
      note: "残席数は9が上限（9席以上でも9と返る）。普通席=eco / クラスJ=clsj / ファースト=first。"
        + " sa=座席表で選べる普通席数 / st=普通席の総座席数。",
      routes,
      // 座席属性コードの実地調査ぶん（窓側の数え方を直すための材料。表示には使わない）
      ...(codeStats.n ? { codes: codeStats } : {}),
    });

    /* 全区間が error なら、JALにセッションを弾かれている。
       いまあるデータを壊さないよう保存しない（夜間の全便出発済みは cancelled なのでOK）。 */
    if (routes.every((r) => r.status === "error")) {
      throw new Error("JALから空席を取得できませんでした（セッションが弾かれた可能性）");
    }

    const count = (fn) => routes.reduce((n, r) => n + (r.flights || []).filter(fn).length, 0);
    const stats = {
      flights: routes.reduce((n, r) => n + (r.flights || []).length, 0),
      withSeats: count((f) => f.eco > 0),
      failed: routes.filter((r) => r.status === "error").length,
      seatChecked: 0,
      seatZero: 0,
    };

    // 運賃ベースの結果をまず保存する（座席表の途中で止まっても無駄にならない）
    report("saving", { label, stats, phase: "fares" });
    await save(snapshot());

    /* 運賃が「空席あり」の便だけ座席表を見る。満席の便は見ても意味がない。
       運賃の在庫と座席表は別管理なので、ここで実際に選べる席数が分かる。 */
    const targets = [];
    for (const r of routes) {
      for (const f of r.flights || []) if (f.eco > 0) targets.push([r, f]);
    }
    for (let i = 0; i < targets.length; i++) {
      const [r, f] = targets[i];
      report("seats", {
        label, i, total: targets.length, origin: r.o, destination: r.d, no: f.no,
        pct: Math.round(((dayIndex + (i / targets.length)) / dayCount) * 100),
        leftSec: Math.ceil((targets.length - i) * (DELAY_MS + 1100) / 1000),
      });
      try {
        const counts = await seatmap(r, f, date);
        if (counts) Object.assign(f, counts);
      } catch { /* 1便取れなくても続ける */ }
      await sleep(DELAY_MS);
    }
    if (targets.length) {
      stats.seatChecked = count((f) => f.sa !== undefined);
      stats.seatZero = count((f) => f.sa === 0);
      report("saving", { label, stats, phase: "seats" });
      await save(snapshot());
    }
    return stats;
  }

  return { collectDay, codeStats, pairs };
}
