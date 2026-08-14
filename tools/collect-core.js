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

/* 保存先。宛先を増やせる形にしてある。

   端末によっては supabase.co への通信だけが弾かれる（広告ブロッカーや
   プライバシー系のアプリが既知のバックエンドを遮断していると起こる）。
   2026-08-09、2台の端末で「70区間は取れるのに保存だけが必ず失敗する」状態を確認し、
   Supabase のログでも**その時間帯にPOSTが1件も届いていない**ことを裏付けた。
   fetch を XHR に変えても宛先が同じなら同じように弾かれる。

   このサイト自身（jal-domestic-route-map.vercel.app）を中継にしようとしたが、
   **このサイトは Vercel が GitHub Pages を中継しているだけ**で（応答に
   x-github-request-id が付く）、サーバ側の処理を置けない＝POSTを受けられない。
   2026-08-10、接続した Vercel アカウントで確認しても該当プロジェクトは無く
   （list_projects が空、get_project も404）、このアカウントからは触れない
   ドメインだと確定した。そこで**別プロジェクトとして中継を新規に立てた**
   （ソースは relay/api/save.js）。

   2026-08-10、その中継（jal-seats-relay.vercel.app）に変えても同じ
   「fetch blocked by privacy-gateway」で弾かれる実機を確認した
   （fetch=/XHR=ともに「横取りされています」）。宛先ではなく fetch/XHR という
   API自体が差し替えられているとみられるため、中継だけは `ways` に "iframe"
   （隠しフォームのPOST。fetch/XHRを経由しない）も持たせてある。
   Supabase本体はJSONしか返さないので対象外（"fetch","xhr"のみ）。

   ドメインが jal-seats-relay2 なのは、jal-seats-relay への**2回目以降の
   デプロイがVercel側の権限で拒否された**ため（このAPIキーは新規プロジェクトの
   初回デプロイはできるが、既存プロジェクトへの再デプロイは403で弾かれた。
   何度か別名で試して再現したので、個別プロジェクトの不調ではなく仕様とみられる）。
   直すときは新しいプロジェクト名で作り直すしかない。詳細は
   docs/HANDOVER_ANDROID_SAVE_ISSUE.md。 */
const SAVE_ENDPOINTS = [
  { url: ENDPOINT, name: "保存先", ways: ["fetch", "xhr"] },
  { url: "https://jal-seats-relay2.vercel.app/api/save", name: "中継経由", ways: ["fetch", "xhr", "iframe"] },
];

export const HUB = "HND";

/* 法人（JALオンライン）ぶんの置き場所。
   Edge Function は (hub, 搭乗日) で1行なので、**ハブ名を分けるだけで
   既存の空席データと混ざらない**。テーブルもEdge Functionも変更が要らない
   （本番のEdge Functionはリポジトリ版と細部が違い、再デプロイすると
   巻き戻る危険があるため、サーバを触らずに済むこの形にした）。
   取り出すときは `?action=all&hub=JOH`。hub は英大文字3文字である必要がある。 */
export const CORP_HUB = "JOH";

/* 法人モードも**公式と同じ35路線・70区間**を見る（2026-08-15、本人の希望で
   7路線の抜粋から変更）。区間が一致していると、公式の日次スナップショット
   （hub=HND・同じ日付）と便名で突き合わせるときに欠けが出ない。
   法人モードは1区間につき法人＋公式の2回叩くので、1回の掃引は
   140リクエスト・約3分（座席表は取らないので、公式収集の8〜10分よりは短い）。 */
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
const SEAT_SAVE_EVERY = 50;   // 座席表を何便ぶん取るごとに保存するか
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
const SAVE_TIMEOUT_MS = 20000; // 保存は120KB程度。回線が生きていれば数秒で終わる
const SAVE_BUDGET_MS = 90000;  // 保存1回にかける上限。宛先も手段も総当たりするので頭を打つ

/* 送信手段そのものが黙り込んでも必ず抜けられるようにする。
   fetch も XHR も横取りされている端末では、こちらの期限だけが頼りになる。 */
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}が${ms / 1000}秒で返事をしませんでした`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
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

/* 端末によっては、ページの中の fetch が横取りされていて、
   第三者ドメインへの通信だけが弾かれる。実機で
   「<URL> fetch blocked by privacy-gateway」という例外を確認した。
   JALのAPIは同じ jal.co.jp なので通り、保存先(supabase.co)だけが落ちるため、
   70区間を集めきったところで必ず失敗する、という症状になっていた。

   横取りされているのは fetch だけのことが多いので、XMLHttpRequest でも送れるようにする。
   どちらで通ったかは呼び出し側に返して、失敗時の切り分けに使う。 */
function postByXhr(url, body, headers) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url, true);
    x.timeout = SAVE_TIMEOUT_MS;
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.onload = () => resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, text: x.responseText });
    x.onerror = () => reject(new Error("XHRも通りませんでした（通信そのものが遮られています）"));
    x.ontimeout = () => reject(new Error(`XHRの応答がありません（${SAVE_TIMEOUT_MS / 1000}秒）`));
    x.send(body);
  });
}

/* 2026-08-10、実機で fetch も XHR も「横取りされています」（describeEnv() の
   native チェックに引っかかる＝JS層で差し替えられている）ことを確認した。
   宛先を変えても同じ理由（fetch blocked by privacy-gateway）で弾かれたため、
   差し替えは宛先ではなく fetch/XHR というAPIそのものに対して行われている。

   その手の差し替えは、対象のAPI（fetch・XMLHttpRequest）を個別に上書きする形が
   ほとんどで、**通常のHTML <form> をiframeへPOSTするナビゲーションまでは
   及ばない**見込みが高い。そこで隠しiframeにフォームをPOSTする経路を足す。
   レスポンス本文は読めないので、中継（relay/api/save.js）が返すHTMLに
   仕込んだ <script> から postMessage で結果を伝えてもらう。

   この経路が使えるのは、フォームPOSTを受けてHTML+postMessageで返す作りに
   してある中継（SAVE_ENDPOINTS の ways に "iframe" を持つ宛先）だけ。
   Supabase Edge Function 本体はJSONしか返さないので対象外。 */
function postByIframe(url, updateKey, body) {
  return new Promise((resolve, reject) => {
    const box = document.createElement("iframe");
    const frameName = "jsc-relay-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    box.name = frameName;
    box.style.display = "none";

    const form = document.createElement("form");
    form.method = "POST";
    form.action = url;
    form.target = frameName;
    form.style.display = "none";
    const field = (name, value) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    };
    field("key", updateKey);
    field("payload", body);

    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      form.remove();
      setTimeout(() => box.remove(), 500); // postMessage送出直後に消すと届かないブラウザがある
      fn(arg);
    };
    const onMessage = (ev) => {
      const d = ev && ev.data;
      if (!d || d.__jalSeatsRelay !== true) return;
      finish(resolve, { ok: !!d.ok, status: d.status || 0, text: JSON.stringify({ error: d.error }) });
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(
      () => finish(reject, new Error(`iframe経由の応答がありません（${SAVE_TIMEOUT_MS / 1000}秒）`)),
      SAVE_TIMEOUT_MS,
    );

    document.body.appendChild(box);
    document.body.appendChild(form);
    form.submit();
  });
}

/** いまの環境で何が使えるかを短くまとめる。失敗したときだけ画面に出す。
    版と読み込み元も入れる。CDNに古いコピーが残っていても気づけるように。 */
export function describeEnv() {
  const native = (f) => String(f).includes("[native code]");
  const build = typeof __JAL_SEATS_BUILD__ !== "undefined" ? __JAL_SEATS_BUILD__ : "不明";
  return [
    "fetch=" + (native(fetch) ? "素" : "★横取りされています"),
    "XHR=" + (native(XMLHttpRequest.prototype.open) ? "素" : "★横取りされています"),
    "版=" + build,
    "読込元=" + (window.__JAL_SEATS_SRC || "不明"),
  ].join(" / ");
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
  /* 法人（JALオンライン）の検索では、その区間・日付にこの契約で買える運賃が
     無いときに JSL001E009 が返る。**これは異常ではなく通常の応答**で、
     70区間のうち大半がこれになることもある。"error" に分類すると
     「3区間続けて error ならセッション拒否」の安全弁に引っかかって
     毎回中断してしまうので、必ず empty 扱いにすること。 */
  if (err.code === "JSL001E009" || text.includes("fare and route")) {
    return ["empty", "この契約では取り扱いなし"];
  }
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
 * @param corporate   JALオンライン（法人・制度利用）として集めるか。
 *                    true のとき、検索条件が法人向けに変わり、座席表は取らず、
 *                    保存先のハブが CORP_HUB になる。詳細は docs/JAL_ONLINE_CORP.md
 */
export function createRun({ auth, updateKey, runId, report = () => {}, onSaveFailed, corporate = false }) {
  const headers = () => ({
    accept: "application/json",
    "content-type": "application/json",
    authorization: auth,
    "x-api-key": API_KEY,
    "ama-client-ref": crypto.randomUUID() + "--" + crypto.randomUUID(),
  });

  /** 1区間分空席照会する。asCorp で法人／一般を切り替える（既定はこの収集のモード）。 */
  async function search(origin, destination, date, asCorp = corporate) {
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
        /* 一般＝JCF・非法人。法人（JALオンライン）＝NONE・法人。
           実機のJOHNが送っている本文をそのまま採ったもので、
           **叩くAPIもヘッダも認証もまったく同じ。違いはここだけ**。 */
        jalSearchPreferences: asCorp
          ? { discountCode: "NONE", isCorporate: true }
          : { discountCode: "JCF", isCorporate: false },
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
    let sa = 0, st = 0, sw = 0, sl = 0, sc = 0, se = 0, sg = 0, sj = null, sf = null;
    const smRaw = []; // 空いている普通席の一覧（クリックで座席表を見せる用）
    for (const deck of decks) {
      for (const s of deck.seats || []) {
        const t = s.travelers && s.travelers[0];
        const open = t && t.seatAvailabilityStatus === "available";
        if (s.cabin === "eco") {
          st++;
          if (open) {
            sa++;
            const codes = (t.seatCharacteristicsCodes || []);
            /* 席の位置は A(通路) / 9(中央) / W(窓) / 1W(窓の一種) の4つで、
               実測 2,900 席がこの4つにちょうど分かれた（重複も取りこぼしもなし）。
               1W を窓に数えていなかったぶん、窓側を約1割少なく出していた。
               1W が窓である裏付け: LS(左側)+RS(右側)=314 が W+1W=314 と一致する。 */
            const isWindow = codes.includes("W") || codes.includes("1W");
            const isAisle = codes.includes("A");
            const isExit = codes.includes("E");
            const isLeg = codes.includes("L");
            if (isWindow) sw++;
            if (isAisle) sl++;
            if (codes.includes("9")) sc++;  // 中央席
            /* E=非常口席 / L=足元が広い席。実データ2,900席で、E の255席には
               1A（乳幼児不可）がちょうど同数付いていた＝非常口列である裏付け。 */
            if (isExit) se++;
            if (isLeg) sg++;
            codeStats.n++;
            noteCodes(codeStats.t, t.seatCharacteristicsCodes);
            noteCodes(codeStats.s, s.seatCharacteristicsCodes);
            noteShape(s, t);

            /* 空いている席番号を持ち帰る。追加のリクエストはない（同じ応答から拾うだけ）。
               満席の席は持たない＝どの席が埋まっているかは分からない前提で、
               「空いている席だけを軽く見せる」用途に絞っている。
               形式は "15H:WE" のように 席番号:属性1文字ずつ（窓W/通路A/非常口E/足元L）。
               どれも付かない中央席は "15D" とだけ書く。 */
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
              col: m ? m[2] : no,
            });
          }
        } else if (s.cabin === "business") {
          sj = (sj || 0) + (open ? 1 : 0);
        } else if (s.cabin === "first") {
          sf = (sf || 0) + (open ? 1 : 0);
        }
      }
    }
    const sm = smRaw
      .sort((a, b) => a.row - b.row || a.col.localeCompare(b.col))
      .map((x) => x.str);
    return st ? { sa, st, sw, sl, sc, se, sg, sj, sf, sm } : null;
  }

  const pairs = [];
  for (const spoke of SPOKES) pairs.push([HUB, spoke], [spoke, HUB]);

  /* 8〜10分かけて集めたものを、送信1回の失敗で捨てないようにする。
     宛先（保存先そのもの / 中継経由）× その宛先が対応する手段（fetch / XHR /
     中継のみ iframe）を総当たりし、それを3周まで繰り返す。宛先ごと弾かれる
     端末があるので、手段を変えるだけでは足りず、**宛先を変えられる**ことが効く。
     さらに fetch/XHR そのものがJS層で差し替えられている端末には、
     どの宛先に変えても効かないので、**iframeという別のAPI経路**も用意してある。 */
  let sendBy = null; // 一度通った組み合わせは覚えて、次回はそれを先に試す
  async function save(snap) {
    const headers = { "content-type": "application/json", "x-update-key": updateKey };
    const body = JSON.stringify(snap);
    const trouble = [];
    const started = Date.now();

    const wayLabel = { fetch: "通常の方法", xhr: "別の方法(XHR)", iframe: "隠しフォーム(iframe)" };

    // 通った実績のある組み合わせを先頭に持ってくる
    const combos = [];
    for (const ep of SAVE_ENDPOINTS) for (const way of ep.ways || ["fetch", "xhr"]) combos.push({ ep, way });
    combos.sort((a, b) => (sendBy && b.ep.url === sendBy.url && b.way === sendBy.way ? 1 : 0)
      - (sendBy && a.ep.url === sendBy.url && a.way === sendBy.way ? 1 : 0));

    let hopeless = false; // 合言葉違い・中身不正。宛先も手段も変えても直らない
    for (let attempt = 1; attempt <= 3 && !hopeless; attempt++) {
      for (const { ep, way } of combos) {
        // 全体の持ち時間を超えたら打ち切る。黙って何分も粘らない
        if (Date.now() - started > SAVE_BUDGET_MS) { trouble.push("時間切れ"); hopeless = true; break; }
        const label = `${ep.name}へ${wayLabel[way]}`;
        try {
          report("save-try", { way, host: ep.name, attempt, seconds: SAVE_TIMEOUT_MS / 1000 });
          const res = await withDeadline(
            way === "fetch" ? fetchWithTimeout(ep.url, { method: "POST", headers, body })
              : way === "xhr" ? postByXhr(ep.url, body, headers)
                : postByIframe(ep.url, updateKey, body),
            SAVE_TIMEOUT_MS, label,
          );
          if (res.ok) { sendBy = { url: ep.url, way }; return; }
          const detail = way === "fetch"
            ? (await res.json().catch(() => ({}))).error
            : (() => { try { return JSON.parse(res.text).error; } catch { return null; } })();
          trouble.push(`${label}: ${detail || "HTTP " + res.status}`);
          if (res.status === 400 || res.status === 401) { hopeless = true; break; }
        } catch (e) {
          trouble.push(`${label}: ${String(e.message || e)}`);
        }
      }
      if (!hopeless && attempt < 3) {
        report("save-retry", { attempt, wait: attempt * 5, error: trouble[trouble.length - 1] });
        await sleep(attempt * 5000);
      }
    }
    if (onSaveFailed) onSaveFailed(snap);
    // 同じ理由の繰り返しは畳んで、切り分けに要る情報だけ残す
    throw new Error("保存できませんでした（" + [...new Set(trouble)].join(" / ") + "）"
      + "［" + describeEnv() + "］"
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
      } else if (payload.message && !payload.data && !payload.errors) {
        /* セッション切れ。**`errors` ではなく `message` で返る**ので、
           拾わないと「便が0件」に見えてしまう（2026-08-15に実際に踏んだ）。
           画面はログイン済みのまま見えるので、なお気づきにくい。
           回復しないので、その場で止める。 */
        throw new Error(
          "JALのセッションが切れています（" + String(payload.message).slice(0, 60) + "）。"
          + (corporate
            ? "JALオンラインにログインし直し、企業（ＬＴ００）を選び、"
              + "一度検索してから実行してください。"
            : "空席照会の画面を開き直してから、もう一度実行してください。"),
        );
      } else if (payload.errors) {
        [entry.status, entry.message] = describeError(payload);
      } else {
        entry.flights = fold(payload);
        entry.status = entry.flights.length ? "ok" : "empty";
        if (!entry.flights.length) entry.message = "残りの便なし";
      }
      /* 法人モードでは、**同じ瞬間の公式の空席もあわせて取る**。
         「制度枠が出る便と出ない便の違い」を後から分析するための材料。
         公式ぶんを別途取ると数時間ずれてしまう（実搭乗率は刻々と変わる）ので、
         ここで並べて取る。1区間あたり2リクエストになるが、14区間なので約35秒。

         保存する flights は**公式の全便**にして、各便が制度枠で取れるかを
         `zl` に持たせる。こうすると「出た便」と「出なかった便」が同じ表に並び、
         そのまま分析に使える。座席表の実数（sa）は公式の日次収集
         （hub=HND・同じ日付）に入っているので、便名で後から突き合わせる。 */
      if (corporate && entry.status !== "error") {
        const bookable = new Set((entry.flights || []).map((f) => f.no));
        entry.zlCount = bookable.size;
        await sleep(DELAY_MS);
        try {
          const pub = await search(origin, destination, date, false);
          const pl = pub.payload || {};
          const pubFlights = pub.status === 200 && !pl.errors && !pl.message ? fold(pl) : [];
          if (pubFlights.length) {
            entry.flights = pubFlights.map((f) => ({ ...f, zl: bookable.has(f.no) }));
            entry.status = "ok";
            delete entry.message;
          }
        } catch { /* 公式が取れなくても、制度枠の記録は残す */ }
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
      hub: corporate ? CORP_HUB : HUB,
      source: corporate
        ? "JALオンライン（法人・制度利用）の空席照会 (api.dom.jal.co.jp/rmweb-api/search/air-bounds)"
        : "JAL公式 空席照会API (api.dom.jal.co.jp/rmweb-api/search/air-bounds)",
      note: corporate
        ? "flights は公式の全便。zl=true がその時点で制度で予約できた便。"
          + " eco は公式の運賃残席（9が上限）。座席表(sa)は取っていないので、"
          + " 必要なら同じ日付の hub=HND のスナップショットと便名で突き合わせる。"
        : "残席数は9が上限（9席以上でも9と返る）。普通席=eco / クラスJ=clsj / ファースト=first。"
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

    /* 法人モードで1便も見つからないときは保存しない。
       この状態は次の3つの区別がつかないため:
         (a) JALオンラインにログインしていない
         (b) ログインはしたが企業（ＬＴ００）を選んでいない
         (c) 本当にその日の制度枠がゼロ
       (a)(b)でも全区間が JSL001E009「取り扱いなし」になるとみられ、
       そのまま保存すると「予約できる便は無い」と表示され続けてしまう。
       既存の「全区間 error なら保存しない」と同じ考え方で、止めて理由を出す。
       ※(c) が実際に起きうるなら、この判定は見直すこと（実データ待ち）。 */
    if (corporate && !routes.some((r) => r.zlCount > 0)) {
      throw new Error(
        "制度で予約できる便が1件も見つかりませんでした。"
        + "JALオンラインにログインし、企業（ＬＴ００）を選んだ状態で実行してください。"
        + "（本当にその日の枠がゼロのときも同じ表示になります）",
      );
    }

    const count = (fn) => routes.reduce((n, r) => n + (r.flights || []).filter(fn).length, 0);
    const stats = {
      flights: routes.reduce((n, r) => n + (r.flights || []).length, 0),
      // 法人では「制度で取れた便数」を数える（eco は公式の残席なので意味が違う）
      withSeats: corporate
        ? routes.reduce((n, r) => n + (r.zlCount || 0), 0)
        : count((f) => f.eco > 0),
      failed: routes.filter((r) => r.status === "error").length,
      seatChecked: 0,
      seatZero: 0,
    };

    // 運賃ベースの結果をまず保存する（座席表の途中で止まっても無駄にならない）
    report("saving", { label, stats, phase: "fares" });
    await save(snapshot());

    /* 法人（JALオンライン）は「その便を制度で予約できるか」だけが要るので、
       ここで終わり。座席表は1便2.3秒かかるうえ、制度枠の判断には使わない。 */
    if (corporate) return stats;

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

      /* 座席表は1便2.3秒かかるので、最後にまとめて保存すると途中で落ちたときに
         その回ぶんが丸ごと消える（実際に 91/231 で止まって91便ぶんを失った）。
         50便ごとに区切って保存しておく。座席属性の調査ぶんも最初の保存で残る。 */
      if ((i + 1) % SEAT_SAVE_EVERY === 0 && i + 1 < targets.length) {
        stats.seatChecked = count((f2) => f2.sa !== undefined);
        stats.seatZero = count((f2) => f2.sa === 0);
        report("saving", { label, stats, phase: "seats" });
        await save(snapshot());
      }

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
