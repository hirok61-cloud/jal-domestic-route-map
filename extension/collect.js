/* 空席照会ページに注入され、羽田発着70区間の空席を集めて送信する。
 *
 * ページと同じオリジンで動くので、booking.jal.co.jp 限定の空席APIをそのまま呼べる。
 * 認証はページが持っているトークン（sessionStorage.apiAuthCreds）を借りる。
 */

(async () => {
  const ENDPOINT = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats";
  const API = "https://api.dom.jal.co.jp/rmweb-api/search/air-bounds";
  const SEATMAP_API = "https://api.dom.jal.co.jp/rmweb-api/shopping/seatmaps";
  const CONTENT_VERSION = "/jl/statics/dom-bkg/content/1.0.170/";
  const API_KEY = "JZWuY6OJ5M2IfvIgZVRMA7dhbjk7jTtga0lclevt";
  const DELAY_MS = 1200; // JALのサーバを叩く間隔。短くしないこと
  const CABIN = { eco: "eco", business: "clsj", first: "first" };

  const HUB = "HND";
  const SPOKES = [
    "AKJ", "AOJ", "ASJ", "AXT", "CTS", "FUK", "GAJ", "HIJ", "HKD", "ISG",
    "ITM", "IZO", "KCZ", "KIX", "KKJ", "KMI", "KMJ", "KMQ", "KOJ", "KUH",
    "MMB", "MMY", "MSJ", "MYJ", "NGO", "NGS", "OBO", "OIT", "OKA", "OKJ",
    "SHM", "TAK", "TKS", "UBJ", "UEO",
  ];

  const finish = (ok, extra) =>
    chrome.runtime.sendMessage({ type: "collect-finished", ok, ...extra });

  const { job, updateKey } = await chrome.storage.local.get(["job", "updateKey"]);
  if (!updateKey) return finish(false, { error: "合言葉が未設定です" });

  const creds = JSON.parse(sessionStorage.getItem("apiAuthCreds") || "{}");
  if (!creds.authToken) return finish(false, { error: "JALのセッションを取得できませんでした" });
  const AUTH = "Bearer " + creds.authToken;
  // 1回の収集を識別する。同じ収集の2度目の保存を見分けるために使う
  const RUN_ID = crypto.randomUUID();

  /* 収集する日。依頼が指定していればそれに従う（0=今日 / 1=翌日）。
     座席表まで見ると1日8〜10分かかるので、要る日だけ選べるようにしてある。 */
  const jstDate = (offsetDays) => {
    const t = new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000);
    return t.toISOString().slice(0, 10);
  };
  const OFFSETS = Array.isArray(job?.days) && job.days.length ? job.days : [0, 1];
  const DAYS = OFFSETS.map(jstDate);

  async function search(origin, destination, date) {
    const res = await fetch(API, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: AUTH,
        "x-api-key": API_KEY,
        "ama-client-ref": crypto.randomUUID() + "--" + crypto.randomUUID(),
      },
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
        contentVersionId: "/jl/statics/dom-bkg/content/1.0.170/",
      }),
    });
    return { status: res.status, payload: await res.json().catch(() => null) };
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


  /* 座席表を1便分取る。運賃の在庫（予約クラスの枠）と、座席表で実際に
     指定できる席は別管理で、JALは当日空港割り当て分を確保しているため、
     運賃が「空席あり」でも座席表は埋まっていることがある。 */
  async function seatmap(route, flight, date) {
    const res = await fetch(SEATMAP_API, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: AUTH,
        "x-api-key": API_KEY,
        "ama-client-ref": crypto.randomUUID() + "--" + crypto.randomUUID(),
      },
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
       追加のリクエストは発生しない。W=窓側, A=通路側（座席属性コード）。 */
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

  function describeError(payload) {
    const err = (payload.errors || [])[0];
    if (!err) return ["empty", "残りの便なし"];
    const text = (err.title || err.detail || err.code || "").toLowerCase();
    if (text.includes("cancel")) return ["cancelled", "全便欠航"];
    if (text.includes("no flight") || text.includes("not found")) return ["empty", "残りの便なし"];
    return ["error", err.title || err.code || "取得失敗"];
  }

  const pairs = [];
  for (const spoke of SPOKES) pairs.push([HUB, spoke], [spoke, HUB]);

  const send = (path, body) => fetch(ENDPOINT + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-update-key": updateKey },
    body: JSON.stringify(body),
  });

  /** 1日分集めて保存する。戻り値はその日の要約。 */
  async function collectDay(date, dayIndex) {
    const label = OFFSETS[dayIndex] === 0 ? "今日" : "翌日";
    const routes = [];

    for (let i = 0; i < pairs.length; i++) {
      const [origin, destination] = pairs[i];
      if (i % 10 === 0) {
        chrome.runtime.sendMessage({
          type: "collect-progress", job,
          message: `${label}分を取得中 ${i + 1}/${pairs.length}`,
        });
      }

      let res;
      try {
        res = await search(origin, destination, date);
        if (res.status !== 200) {
          await new Promise((r) => setTimeout(r, 4000));
          res = await search(origin, destination, date);
        }
      } catch {
        res = { status: 0, payload: null };
      }

      const entry = { o: origin, d: destination };
      const payload = res.payload || {};
      if (res.status !== 200) {
        entry.status = "error";
        entry.message = "HTTP " + res.status;
      } else if (payload.errors) {
        [entry.status, entry.message] = describeError(payload);
      } else {
        entry.flights = fold(payload);
        entry.status = entry.flights.length ? "ok" : "empty";
        if (!entry.flights.length) entry.message = "残りの便なし";
      }
      routes.push(entry);
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    /* 全区間が error のときだけセッションを弾かれたとみなす。
       夜間は最終便まで出発済みで全区間 cancelled になるが、それは正しい結果。 */
    if (routes.every((r) => r.status === "error")) return null;

    const snapshot = () => ({
      generatedAt: new Date().toISOString(),
      runId: RUN_ID,
      date,
      hub: HUB,
      source: "JAL公式 空席照会API (api.dom.jal.co.jp/rmweb-api/search/air-bounds)",
      note: "残席数は9が上限（9席以上でも9と返る）。普通席=eco / クラスJ=clsj / ファースト=first。"
        + " sa=座席表で選べる普通席数 / st=普通席の総座席数。",
      routes,
    });

    const save = async () => {
      const res = await send("", snapshot());
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error || "保存に失敗しました");
      }
    };

    // 運賃ベースの結果をまず保存しておく（座席表の途中で止まっても無駄にならない）
    await save();

    /* 運賃が「空席あり」の便だけ座席表を見る。満席の便は見ても意味がない。
       運賃の在庫と座席表は別管理なので、ここで実際に選べる席数が分かる。 */
    const targets = [];
    for (const r of routes) {
      for (const f of r.flights || []) if (f.eco > 0) targets.push([r, f]);
    }
    for (let i = 0; i < targets.length; i++) {
      const [r, f] = targets[i];
      if (i % 10 === 0) {
        chrome.runtime.sendMessage({
          type: "collect-progress", job,
          message: `${label}分の座席表 ${i + 1}/${targets.length}`,
        });
      }
      try {
        const counts = await seatmap(r, f, date);
        if (counts) Object.assign(f, counts);
      } catch { /* 1便取れなくても続ける */ }
      await new Promise((r2) => setTimeout(r2, DELAY_MS));
    }
    if (targets.length) await save();

    const flights = routes.reduce((n, r) => n + (r.flights || []).length, 0);
    const withSeats = routes.reduce(
      (n, r) => n + (r.flights || []).filter((f) => f.eco > 0).length, 0,
    );
    const seatChecked = routes.reduce(
      (n, r) => n + (r.flights || []).filter((f) => f.sa !== undefined).length, 0,
    );
    const seatZero = routes.reduce(
      (n, r) => n + (r.flights || []).filter((f) => f.sa === 0).length, 0,
    );
    return `${label} ${flights}便中${withSeats}便に空席`
      + (seatChecked ? `（座席表確認 ${seatChecked}便・うち座席表満席 ${seatZero}便）` : "");
  }

  try {
    const parts = [];
    for (let d = 0; d < DAYS.length; d++) {
      // 今日分が取れた時点で先に保存されるので、翌日分で失敗しても無駄にならない
      const summary = await collectDay(DAYS[d], d);
      if (summary) parts.push(summary);
      else if (d === 0) {
        return finish(false, { error: "JALから空席を取得できませんでした（セッション拒否の可能性）" });
      }
    }

    const summary = parts.join(" / ");
    if (job?.id) await send(`?action=finish&id=${job.id}`, { ok: true, message: summary });
    finish(true, { summary });
  } catch (err) {
    finish(false, { error: String(err?.message || err) });
  }
})();
