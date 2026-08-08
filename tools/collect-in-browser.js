/* ===========================================================================
   JAL国内線 本日の空席 コレクタ

   JALの「予約（空席照会）」画面でブックマークレットから読み込まれ、
   羽田発着35路線(往復70区間)の当日・普通席の残席をまとめて取得して、
   サイトの保存先(Supabase Edge Function)へ送る。送信できない場合は
   availability.json としてダウンロードするので、手動で差し替えもできる。

   使い方は /seats/update.html を参照。

   なぜブラウザ上で動かすのか
   --------------------------
   jal.co.jp / booking.jal.co.jp は Akamai Bot Manager 配下で、curl も
   Playwright/Selenium で起動したブラウザも弾かれる(JALのアプリ自身のAPI
   呼び出しごと失敗する)。空席APIも booking.jal.co.jp オリジンからしか
   呼べない。人が普通に開いたブラウザのセッションを間借りするのが、
   いちばん確実で JAL 側への負荷も小さい。

   合言葉について
   --------------
   このファイルは公開サイトから配信されるので、書き込み用の合言葉は
   持たせない。ブックマークレットが window.__JAL_SEATS_KEY に入れて渡す。
   =========================================================================== */

(async () => {
  "use strict";

  const ENDPOINT = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats";
  const SITE = "https://jal-domestic-route-map.vercel.app/seats/";

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

  /* ---------------------------------------------------------------- 進捗表示 */

  document.getElementById("jal-seat-collector")?.remove();
  const ui = document.createElement("div");
  ui.id = "jal-seat-collector";
  ui.style.cssText = [
    "position:fixed", "right:18px", "bottom:18px", "z-index:2147483647",
    "width:320px", "max-width:calc(100vw - 36px)", "padding:16px 18px", "border-radius:14px",
    "background:#fff", "color:#1b1e24", "border:1px solid #e2e0da",
    "box-shadow:0 12px 34px rgba(30,20,20,.28)",
    'font:13px/1.6 "Hiragino Sans","Yu Gothic UI",-apple-system,sans-serif',
  ].join(";");
  ui.innerHTML = `
    <div style="font-size:10px;letter-spacing:.22em;color:#b7001e;font-weight:700">JAL SEAT COLLECTOR</div>
    <div id="jsc-msg" style="margin-top:6px;font-weight:700">準備しています…</div>
    <div style="margin-top:10px;height:6px;border-radius:99px;background:#eceae5;overflow:hidden">
      <div id="jsc-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#b7001e,#8c0017);transition:width .2s"></div>
    </div>
    <div id="jsc-sub" style="margin-top:7px;font-size:11.5px;color:#6b7480">&nbsp;</div>`;
  document.body.appendChild(ui);

  const $msg = ui.querySelector("#jsc-msg");
  const $sub = ui.querySelector("#jsc-sub");
  const $bar = ui.querySelector("#jsc-bar");
  const show = (msg, sub, pct) => {
    if (msg != null) $msg.textContent = msg;
    if (sub != null) $sub.innerHTML = sub;
    if (pct != null) $bar.style.width = pct + "%";
  };
  const fail = (msg, sub) => {
    show(msg, sub, 100);
    $bar.style.background = "#b7001e";
    setTimeout(() => ui.remove(), 20000);
  };

  /* -------------------------------------------------------------- 事前チェック */

  /* JALのトップページなど www 側で押された場合は、空席照会画面まで自分で進む。
     （空席APIは booking.jal.co.jp オリジンからしか呼べないため）
     ページ遷移でこのスクリプトは消えるので、着いたらもう一度押してもらう。 */
  if (/(^|\.)jal\.co\.jp$/.test(location.host) && !location.host.startsWith("booking.")) {
    try {
      // Akamaiは開いた直後のセッションを信用しない。読み込みから30秒経つまで待つ
      const openedFor = performance.now();
      const waitMs = Math.max(0, 30000 - openedFor);
      if (waitMs > 0) {
        for (let left = Math.ceil(waitMs / 1000); left > 0; left--) {
          show("JALの空席照会を開きます", `あと${left}秒お待ちください`,
            Math.round((1 - left / (waitMs / 1000)) * 100));
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      show("空席照会の画面へ移動します…", "移動したら、もう一度このブックマークを押してください", 100);

      const seed = await fetch(
        "https://www.jal.co.jp/cgi-bin/jal/common_rn/domEnc/getDomEnc.cgi?_=" + Date.now(),
        { headers: { Accept: "application/json" }, credentials: "include" },
      ).then((r) => r.json());

      const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
        .toISOString().slice(0, 10);
      const fields = {
        linkId: "02", langCd: "ja", hv_sid: seed.hv_sid, dt_sid: seed.dt_sid,
        tripType: "OW", depDate: today, depAirportCode1: "HND", arrAirportCode1: "ITM",
        adult: "1", child: "0", infant: "0", class: "ecoBusiness", discountType: "JCF",
      };
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "https://booking.jal.co.jp/jl/dom-bkg/upsell";
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      fail("空席照会の画面へ進めませんでした", String(e.message || e));
    }
    return;
  }

  if (!location.host.startsWith("booking.jal.co.jp")) {
    fail("この画面では実行できません",
      "<b>JALのサイト</b>を開いた状態で押してください。"
      + "トップページで押せば、空席照会の画面まで自動で進みます。");
    return;
  }
  const creds = JSON.parse(sessionStorage.getItem("apiAuthCreds") || "{}");
  if (!creds.authToken) {
    fail("ログイン情報が見つかりません",
      "先に国内線を1回検索して、便が並んだ画面で実行してください。");
    return;
  }
  const AUTH = "Bearer " + creds.authToken;
  const UPDATE_KEY = window.__JAL_SEATS_KEY || "";

  /* ------------------------------------------------------------------ 収集 */

  const now = new Date();
  const date = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

  const pairs = [];
  for (const spoke of SPOKES) pairs.push([HUB, spoke], [spoke, HUB]);

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

  /* スマホだと収集中に画面が消えるとタイマーが絞られて途中で止まるので、
     可能なら画面スリープを抑止する（iOS 16.4+ / Android Chrome）。 */
  let wakeLock = null;
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
  } catch { /* 非対応。そのまま続行する */ }
  const releaseWakeLock = () => { try { wakeLock?.release(); } catch {} wakeLock = null; };

  // 画面を消されたことに気づけるようにしておく（止まった理由がわからないと困るため）
  let wentHidden = false;
  const onHide = () => { if (document.visibilityState === "hidden") wentHidden = true; };
  document.addEventListener("visibilitychange", onHide);

  const routes = [];
  const started = Date.now();

  for (let i = 0; i < pairs.length; i++) {
    const [origin, destination] = pairs[i];
    const left = Math.ceil((pairs.length - i) * (DELAY_MS + 900) / 1000);
    show(`空席を取得中… ${i + 1} / ${pairs.length}`,
      `${origin} → ${destination}　残り約${left}秒`
      + "<br><span style='color:#b7001e'>この画面を開いたままにしてください</span>",
      Math.round((i / pairs.length) * 100));

    let res;
    try {
      res = await search(origin, destination);
      if (res.status !== 200) {
        await new Promise((r) => setTimeout(r, 4000));
        res = await search(origin, destination);
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

  document.removeEventListener("visibilitychange", onHide);
  releaseWakeLock();

  const out = {
    generatedAt: new Date().toISOString(),
    date,
    hub: HUB,
    source: "JAL公式 空席照会API (api.dom.jal.co.jp/rmweb-api/search/air-bounds)",
    note: "残席数は9が上限（9席以上でも9と返る）。普通席=eco / クラスJ=clsj / ファースト=first。",
    routes,
  };

  const flightCount = routes.reduce((n, r) => n + (r.flights || []).length, 0);
  const withSeats = routes.reduce(
    (n, r) => n + (r.flights || []).filter((f) => f.eco > 0).length, 0,
  );
  const failed = routes.filter((r) => r.status === "error").length;
  const took = Math.round((Date.now() - started) / 1000);
  const stats = `${routes.length}区間・${flightCount}便／普通席に空席 <b>${withSeats}便</b>`
    + (failed ? `／取得失敗 ${failed}区間` : "") + `（${took}秒）`
    // 画面を消すとタイマーが絞られて取りこぼすので、失敗が多いときは理由を添える
    + (wentHidden && failed ? "<br>途中で画面が消えたため取りこぼしたようです。もう一度お試しください。" : "");

  /* ------------------------------------------------------------- 保存・送信 */

  function download() {
    const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "availability.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  show("サイトに反映しています…", stats, 96);

  if (!UPDATE_KEY) {
    download();
    fail("合言葉がないため保存できませんでした",
      `${stats}<br>availability.json をダウンロードしました。`);
    return;
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-update-key": UPDATE_KEY },
      body: JSON.stringify(out),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
  } catch (e) {
    download();
    fail("送信に失敗しました",
      `${String(e.message || e)}<br>availability.json をダウンロードしたので、`
      + `data/ に置いて push すれば反映されます。`);
    return;
  }

  show("更新しました ✈", `${stats}<br><a href="${SITE}" target="_blank" style="color:#b7001e;font-weight:700">本日の空席を開く</a>`, 100);
  $bar.style.background = "#1a7f4b";
  setTimeout(() => ui.remove(), 30000);
})();
