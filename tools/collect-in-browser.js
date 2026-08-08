/* ===========================================================================
   JAL国内線 本日の空席 コレクタ（ブラウザのコンソールに貼り付けて実行）

   使い方
   ------
   1. https://www.jal.co.jp/ja-jp/ から国内線をふつうに1回検索して、
      「予約（空席照会）」の画面（booking.jal.co.jp/jl/dom-bkg/upsell/…）を開く。
      ※ 路線・日付は何でもよい。セッションを作るためだけに使う。
   2. その画面で DevTools のコンソールを開き、このファイルの中身を全部貼り付けて Enter。
      （初回は「Allow pasting」と打つよう求められることがある）
   3. 進捗がコンソールに出て、終わると availability.json が自動でダウンロードされる。
   4. そのファイルを このリポジトリの data/availability.json に上書きして git push。

   なぜこの方式か
   --------------
   jal.co.jp / booking.jal.co.jp は Akamai Bot Manager 配下で、curl も
   Playwright/Selenium で起動したブラウザも弾かれる（アプリ自身のAPI呼び出しごと
   失敗する）。空席APIも booking.jal.co.jp オリジンからしか呼べない。
   人が普通に開いたブラウザのセッションを間借りするのが、いちばん確実で軽い。

   取れるもの
   ----------
   便ごとの 普通席 / クラスJ / ファーストクラス の残席数。
   残席は最大9で頭打ち（10席以上あっても 9 と返る = 画面上の「空席あり」）。
   =========================================================================== */

(async () => {
  "use strict";

  // ---- 収集対象: 羽田発着の主要路線（index.html の ROUTES と揃えている） ----
  const HUB = "HND";
  const SPOKES = [
    "AKJ", "AOJ", "ASJ", "AXT", "CTS", "FUK", "GAJ", "HIJ", "HKD", "ISG",
    "ITM", "IZO", "KCZ", "KIX", "KKJ", "KMI", "KMJ", "KMQ", "KOJ", "KUH",
    "MMB", "MMY", "MSJ", "MYJ", "NGO", "NGS", "OBO", "OIT", "OKA", "OKJ",
    "SHM", "TAK", "TKS", "UBJ", "UEO",
  ];

  const API = "https://api.dom.jal.co.jp/rmweb-api/search/air-bounds";
  const API_KEY = "JZWuY6OJ5M2IfvIgZVRMA7dhbjk7jTtga0lclevt";
  const DELAY_MS = 1200; // JALのサーバを叩く間隔。短くしないこと
  const CABIN = { eco: "eco", business: "clsj", first: "first" };

  if (!location.host.startsWith("booking.jal.co.jp")) {
    console.error("[JAL] booking.jal.co.jp の空席照会画面で実行してください。");
    return;
  }

  const creds = JSON.parse(sessionStorage.getItem("apiAuthCreds") || "{}");
  if (!creds.authToken) {
    console.error("[JAL] 認証トークンが見つかりません。先に国内線を1回検索してください。");
    return;
  }
  const AUTH = "Bearer " + creds.authToken;

  const now = new Date();
  const date = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

  const pairs = [];
  for (const spoke of SPOKES) {
    pairs.push([HUB, spoke], [spoke, HUB]);
  }

  /** 1区間ぶん空席照会する。 */
  async function search(origin, destination) {
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

  /* レスポンスを便単位に畳む。
     statusCode は HK=確保可 / HL=キャンセル待ち(満席)。ただし「対象者限定」の
     運賃ファミリーは満席の便でも HK・quota 0 を返してくるので、
     空席の有無は statusCode ではなく quota の最大値で判定する。 */
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
        const price = unit && unit.prices && unit.prices[0]
          ? unit.prices[0].total
          : null;
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
    if (text.includes("no flight") || text.includes("not found")) {
      return ["empty", "残りの便なし"];
    }
    return ["error", err.title || err.code || "取得失敗"];
  }

  const routes = [];
  console.log(`[JAL] ${date} / ${pairs.length}区間の空席を取得します…`);

  for (let i = 0; i < pairs.length; i++) {
    const [origin, destination] = pairs[i];
    let res;
    try {
      res = await search(origin, destination);
      if (res.status !== 200) {
        await new Promise((r) => setTimeout(r, 4000));
        res = await search(origin, destination);
      }
    } catch (e) {
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

    const mark = { ok: "✓", cancelled: "✕", empty: "-" }[entry.status] || "!";
    console.log(
      `[JAL] ${String(i + 1).padStart(2)}/${pairs.length} ${mark} ` +
      `${origin}→${destination} ${(entry.flights || []).length}便`
    );
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const out = {
    generatedAt: new Date().toISOString(),
    date,
    hub: HUB,
    source: "JAL公式 空席照会API (api.dom.jal.co.jp/rmweb-api/search/air-bounds)",
    note: "残席数は9が上限（10席以上でも9と返る）。普通席=eco / クラスJ=clsj / ファースト=first。",
    routes,
  };

  const withSeats = routes.reduce(
    (n, r) => n + (r.flights || []).filter((f) => f.eco > 0).length, 0
  );
  console.log(
    `[JAL] 完了: ${routes.filter((r) => r.status === "ok").length}/${routes.length}区間・` +
    `普通席に空席あり ${withSeats}便`
  );

  const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "availability.json";
  a.click();
  URL.revokeObjectURL(a.href);
  console.log("[JAL] availability.json をダウンロードしました。");
})();
