/* JALグループ路線マップ サイト本体（Cloudflare Workers）。
 *
 * Vercel時代は4プロジェクトに割れていたものを1本にまとめてある:
 *   - 本体（GitHub Pagesへのrewritesプロキシ + api/ 5本）  → このWorker
 *   - jal-seats-relay / relay-v2 / relay2（/api/save だけ） → このWorkerの /api/save
 *
 * relayを別プロジェクトに切り出していたのは、本体ドメインがGitHub Pagesを
 * 中継しているだけでサーバ側コードを実行できなかったため（relay/api/save.js の
 * 冒頭コメント参照）。Workersは静的配信とコードが同一オリジンで両立するので、
 * その分離自体が不要になった。
 *
 * 静的ファイルは assets（wrangler.jsonc の assets.directory）から配る。
 * assets.run_worker_first に挙げたパスだけがこのスクリプトに届く。
 */

const REALM = 'Basic realm="restricted", charset="UTF-8"';

/* ---------- ZEDゲート（旧 api/_auth.js） ---------- */

// 合言葉は wrangler secret（ZED_GATE_USER / ZED_GATE_PASS）。
// 未設定なら fail closed = 全員拒否。うっかり全公開になるより落ちる方を選ぶ。
function isAuthed(request, env) {
  const user = env.ZED_GATE_USER;
  const pass = env.ZED_GATE_PASS;
  if (!user || !pass) return false;

  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;

  let decoded;
  try {
    // atob はバイト列を返すので、UTF-8として解釈し直す
    // （Node版の Buffer.from(..., "base64").toString("utf8") と等価にするため）
    const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch (e) {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  return eq(decoded.slice(0, sep), user) && eq(decoded.slice(sep + 1), pass);
}

// 長さで早期returnしないタイミング安全比較
function eq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": REALM, "content-type": "text/plain; charset=utf-8" },
  });
}

/* ---------- /api/save（旧 relay/api/save.js） ---------- */

const UPSTREAM_SEATS = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats";

const CORS_SAVE = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-update-key",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};

// フォーム経由の結果を親ページへ知らせる小さなHTML。
function htmlReply(ok, error, status) {
  const payload = JSON.stringify({ __jalSeatsRelay: true, ok: !!ok, error: error || null, status: status || 0 })
    .replace(/<\/(script)/gi, "<\\/$1"); // error文言に</script>相当が混じっても壊れないように
  return `<!doctype html><meta charset="utf-8"><script>
try { parent.postMessage(${payload}, "*"); } catch (e) {}
</script>`;
}

async function handleSave(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_SAVE });
  if (request.method !== "POST") {
    return json({ error: "POST のみ受け付けます" }, 405, CORS_SAVE);
  }

  /* 隠しフォームの <form> は application/x-www-form-urlencoded で届く。
     この場合はヘッダではなくフォーム項目 key/payload に合言葉と本文が入っている
     （フォームPOSTはカスタムヘッダを付けられないため）。 */
  const contentType = request.headers.get("content-type") || "";
  const isForm = contentType.includes("application/x-www-form-urlencoded")
    || contentType.includes("multipart/form-data");

  let key, body;
  if (isForm) {
    const form = await request.formData();
    key = form.get("key");
    body = form.get("payload");
  } else {
    key = request.headers.get("x-update-key");
    body = await request.text();
  }

  if (!key) {
    if (isForm) return html(htmlReply(false, "合言葉がありません", 401));
    return json({ error: "合言葉がありません" }, 401, CORS_SAVE);
  }

  try {
    const upstream = await fetch(UPSTREAM_SEATS, {
      method: "POST",
      headers: { "content-type": "application/json", "x-update-key": String(key) },
      body,
    });
    const text = await upstream.text();

    if (isForm) {
      // iframeのナビゲーション自体は常に200で終える。結果はpostMessageの中身で伝える
      let error = null;
      if (!upstream.ok) { try { error = JSON.parse(text).error; } catch (e) { /* noop */ } }
      return html(htmlReply(upstream.ok, error || (!upstream.ok ? "HTTP " + upstream.status : null), upstream.status));
    }

    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_SAVE, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (e) {
    if (isForm) return html(htmlReply(false, String(e.message || e), 0));
    return json({ error: "保存先に中継できませんでした（" + (e.message || e) + "）" }, 502, CORS_SAVE);
  }
}

/* ---------- /api/flyzed（旧 api/flyzed.js） ---------- */

// flyzed.info 以外は絶対に取りに行かない。パスは航空会社コードの形だけ許す。
const CODE_RE = /^[A-Za-z0-9]{2,3}\*?$/;

/* 収録時のハッシュと突き合わせるための正規化。
   **scripts/fingerprint.py と完全に一致させること。**
   ズレると全263社が「更新あり」と表示される。
   下の U+FEFF（BOM）除去は画面上は不可視なので、編集時に消さないよう注意。 */
function stripHtml(fragment) {
  return fragment
    .replace(/<p class="go-to-top">[\s\S]*?<\/p>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/﻿/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256Hex16(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

const CORS_GET = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

async function handleFlyzed(request, env, url) {
  if (request.method === "OPTIONS") {
    // プリフライトにAuthorizationは付かない。本番のGET（認証付き）を通すため素通しする
    return new Response(null, { status: 204, headers: CORS_GET });
  }
  if (!isAuthed(request, env)) return unauthorized();

  const code = String(url.searchParams.get("code") || "").trim();
  if (!CODE_RE.test(code)) return json({ error: "invalid code" }, 400, CORS_GET);

  const target = `https://www.flyzed.info/${encodeURIComponent(code)}`;

  try {
    const upstream = await fetch(target, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (+jal-route-map ZED checker)" },
    });
    if (!upstream.ok) return json({ error: `upstream ${upstream.status}` }, 502, CORS_GET);

    const page = await upstream.text();

    const bodyMatch = page.match(
      /<div class="switchboard-info"[^>]*>([\s\S]*?)(?=<div class="switchboard-detail"|$)/
    );
    const body = bodyMatch ? stripHtml(bodyMatch[1]) : "";

    const headings = [];
    const headingRe = /<h3 id="heading-\d+">([\s\S]*?)<\/h3>/g;
    let m;
    while ((m = headingRe.exec(page)) !== null) headings.push(stripHtml(m[1]));

    return json({
      code,
      url: target,
      hash: await sha256Hex16(body),
      chars: body.length,
      headings,
      text: body.slice(0, 60000),
      checkedAt: new Date().toISOString(),
    }, 200, { ...CORS_GET, "cache-control": "public, max-age=300, s-maxage=300" });
  } catch (err) {
    const reason = err && err.name === "TimeoutError" ? "timeout" : "fetch failed";
    return json({ error: reason }, 504, CORS_GET);
  }
}

/* ---------- /api/alliances（旧 api/alliances.js） ---------- */

const UA_PLAIN = "Mozilla/5.0 (+jal-route-map alliance checker)";
// skyteam.com は短いUAだと403を返す。実在のデスクトップChromeらしい文字列が要る。
const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const ONEWORLD_SLUG_TO_CODE = {
  "alaska-airlines": "AS", "american-airlines": "AA", "british-airways": "BA",
  "cathay-pacific": "CX", "fiji-airways": "FJ", "finnair": "AY", "iberia": "IB",
  "japan-airlines": "JL", "malaysia-airlines": "MH", "oman-air": "WY",
  "philippine-airlines": "PR", "qantas": "QF", "qatar-airways": "QR",
  "royal-air-maroc": "AT", "royal-jordanian": "RJ", "srilankan-airlines": "UL",
};

const SKYTEAM_SLUG_TO_CODE = {
  "aerolineas-argentinas": "AR", "aeromexico": "AM", "air-europa": "UX",
  "air-france": "AF", "china-airlines": "CI", "china-eastern-airlines": "MU",
  "delta-airlines": "DL", "garuda-indonesia": "GA", "kenya-airways": "KQ",
  "klm-royal-dutch-airlines": "KL", "korean-air": "KE", "middle-east-airlines": "ME",
  "sas": "SK", "saudia": "SV", "tarom": "RO", "vietnam-airlines": "VN",
  "virgin-atlantic": "VS", "xiamenair": "MF",
};

/* Star Alliance の加盟社ページは Liferay ポートレットで、セッション紐付きの
   p_auth トークンが要る＝実ブラウザ無しでは取れない。ここだけ手動確認の
   固定リストで、live:false を返して「実取得ではない」と正直に伝える。
   staralliance.com で目視確認した26社のうち、Air China (CA) はこのデータ
   セットに無いので下に居なくて正常。 */
const STARALLIANCE_CODES = [
  "A3", "AC", "AI", "NZ", "NH", "OZ", "OS", "AV", "SN", "CM", "OU", "MS",
  "ET", "BR", "AZ", "LO", "LH", "ZH", "SQ", "SA", "LX", "TP", "TG", "TK", "UA",
];

async function fetchText(url, ua) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": ua } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return await res.text();
}

async function fetchOneworld() {
  const page = await fetchText("https://www.oneworld.com/members", UA_PLAIN);
  const slugs = new Set();
  const re = /href="\/members\/([a-z0-9-]+)"/g;
  let m;
  while ((m = re.exec(page)) !== null) slugs.add(m[1]);
  return [...slugs].map((s) => ONEWORLD_SLUG_TO_CODE[s]).filter(Boolean);
}

async function fetchSkyteam() {
  const page = await fetchText("https://www.skyteam.com/en/about/", UA_CHROME);
  const slugs = new Set();
  const re = /href="en\/about\/([a-z0-9-]+)"/g;
  let m;
  while ((m = re.exec(page)) !== null) slugs.add(m[1]);
  return [...slugs].map((s) => SKYTEAM_SLUG_TO_CODE[s]).filter(Boolean);
}

async function handleAlliances(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_GET });
  if (!isAuthed(request, env)) return unauthorized();

  const [oneworldR, skyteamR] = await Promise.allSettled([fetchOneworld(), fetchSkyteam()]);

  const result = {
    fetchedAt: new Date().toISOString(),
    oneworld: { live: oneworldR.status === "fulfilled", codes: [] },
    skyteam: { live: skyteamR.status === "fulfilled", codes: [] },
    staralliance: {
      live: false,
      codes: STARALLIANCE_CODES,
      note: "Star Alliance公式サイトはJS認証必須のポータル形式のため自動取得できません。手動確認済みの固定リストです。",
    },
  };

  if (oneworldR.status === "fulfilled" && oneworldR.value.length) {
    result.oneworld.codes = oneworldR.value;
  } else {
    result.oneworld.live = false;
    result.oneworld.error = oneworldR.reason ? String(oneworldR.reason.message || oneworldR.reason) : "empty";
  }

  if (skyteamR.status === "fulfilled" && skyteamR.value.length) {
    result.skyteam.codes = skyteamR.value;
  } else {
    result.skyteam.live = false;
    result.skyteam.error = skyteamR.reason ? String(skyteamR.reason.message || skyteamR.reason) : "empty";
  }

  return json(result, 200, { ...CORS_GET, "cache-control": "no-store" });
}

/* ---------- 小物 ---------- */

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(headers || {}) },
  });
}

function html(body) {
  return new Response(body, {
    status: 200,
    headers: { ...CORS_SAVE, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ---------- 入口 ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/api/save") return handleSave(request);
    if (p === "/api/flyzed") return handleFlyzed(request, env, url);
    if (p === "/api/alliances") return handleAlliances(request, env);

    /* ZEDは配下まるごと認証の内側。個別のパスを列挙して守るのではなく
       プレフィックスで一括して弾く（/international/zed/index.html のような
       直接指定で素通りするのを防ぐため）。 */
    if (p === "/international/zed" || p.startsWith("/international/zed/")) {
      if (!isAuthed(request, env)) return unauthorized();

      // 本体データは公開リポジトリに置かずKVに入れてある（GitHub Pages・
      // jsDelivr・リポジトリの3経路から無認証で読めていたのを塞ぐため）
      if (p === "/international/zed/data.json") {
        const body = await env.PRIVATE.get("zed:data.json");
        if (body === null) return json({ error: "data not loaded" }, 503);
        return new Response(body, {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (p === "/international/zed" || p === "/international/zed/") {
        return env.ASSETS.fetch(new Request(new URL("/international/zed/index.html", url), request));
      }
      return env.ASSETS.fetch(request); // assets/ 配下のアライアンス章など
    }

    return new Response("Not found", { status: 404 });
  },
};
