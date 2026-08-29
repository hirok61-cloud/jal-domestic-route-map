// HND⇔GMP 空席モニター: スナップショットの受け口と公開読み出し
// GET               : 公開読み出し(直近40スナップショット)
// GET ?view=archive : 出発済み日の実績(各日付×方向の最終観測値)
// POST              : (A) JSON + x-update-keyヘッダー … Chrome拡張用
//                     (B) フォーム(key+payload)     … ブックマークレット用(隠しiframe form POST)
//                     保存成功時は hnd_gmp_finals(日付×方向の最終観測)も更新する
// 参考運賃(fares)   : 任意。「会社|方向」をキーにしたZED運賃の実測値(収集1回につき4件)。
//                     latest(=生データ)にそのまま載るので、サイトは latest.fares を読む。
//                     snapshots/finals には載せない(便ごとの時系列には不要なため)。
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-update-key",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function htmlResult(ok: boolean, extra: Record<string, unknown>): Response {
  const msg = JSON.stringify({ __hndgmp: true, ok, ...extra });
  const body = `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;padding:12px">` +
    (ok ? "OK" : "NG") +
    `<script>try{parent.postMessage(${msg},"*")}catch(e){}</script></body>`;
  return new Response(body, { status: 200, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
}

type Flight = { fn: string; al: string; dep: string; ac?: string; chance?: string; tf?: string | null; Y?: number | null; cls?: string; sb?: Record<string, number> };
type Days = Record<string, Record<string, Flight[]>>;
type Fares = Record<string, unknown>;

function countFlights(days: Days): number {
  let n = 0;
  for (const routes of Object.values(days ?? {})) for (const fls of Object.values(routes ?? {})) n += (fls ?? []).length;
  return n;
}

function slimFlights(fls: Flight[]): Flight[] {
  return (fls ?? []).map((f) => ({ fn: f.fn, al: f.al, dep: f.dep, Y: f.Y ?? null, chance: f.chance, sb: f.sb ?? {} }));
}

function slimDays(days: Days): Days {
  const out: Days = {};
  for (const [d, routes] of Object.entries(days ?? {})) {
    out[d] = {};
    for (const [r, fls] of Object.entries(routes ?? {})) out[d][r] = slimFlights(fls);
  }
  return out;
}

// 参考運賃は「会社|方向」の高々数件。壊れた/肥大した入力は黙って捨てる(空席データは保存する)
function cleanFares(fares: unknown): Fares | null {
  if (!fares || typeof fares !== "object" || Array.isArray(fares)) return null;
  const entries = Object.entries(fares as Record<string, unknown>).slice(0, 20);
  const out: Fares = {};
  for (const [k, v] of entries) {
    if (typeof k !== "string" || k.length > 32) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function expectedKey(): string | null {
  return Deno.env.get("HND_GMP_UPDATE_KEY") ?? Deno.env.get("JAL_SEATS_UPDATE_KEY") ?? null;
}

async function saveSnapshot(supabase: ReturnType<typeof createClient>, ts: string, days: Days, fares: Fares | null): Promise<string | null> {
  const data = fares ? { ts, days, fares } : { ts, days };
  const { error } = await supabase.from("hnd_gmp_snapshots").upsert({ ts, data }, { onConflict: "ts" });
  if (error) return error.message;
  // 実績(最終観測)を更新: 非空の日付×方向だけ
  const rows = [];
  for (const [date, routes] of Object.entries(days)) {
    for (const [route, fls] of Object.entries(routes ?? {})) {
      if ((fls ?? []).length === 0) continue;
      rows.push({ key: date + "|" + route, date, route, ts, flights: slimFlights(fls), updated_at: new Date().toISOString() });
    }
  }
  if (rows.length) {
    const { error: e2 } = await supabase.from("hnd_gmp_finals").upsert(rows, { onConflict: "key" });
    if (e2) console.error("finals upsert failed:", e2.message); // 実績更新失敗は致命的ではない
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);

  if (req.method === "POST") {
    const expected = expectedKey();
    if (!expected) return json({ ok: false, error: "update key not configured" }, 503);
    const ctype = req.headers.get("content-type") || "";

    if (ctype.includes("application/x-www-form-urlencoded") || ctype.includes("multipart/form-data")) {
      let form: FormData;
      try { form = await req.formData(); } catch { return htmlResult(false, { error: "bad form" }); }
      if (String(form.get("key") || "") !== expected) return htmlResult(false, { error: "unauthorized" });
      let parsed: { ts?: string; days?: Days; fares?: unknown };
      try { parsed = JSON.parse(String(form.get("payload") || "")); } catch { return htmlResult(false, { error: "bad payload" }); }
      if (!parsed.ts || !parsed.days) return htmlResult(false, { error: "ts/days required" });
      const nDays = Object.keys(parsed.days).length;
      if (nDays < 1 || nDays > 60) return htmlResult(false, { error: "unexpected days count" });
      const nFlights = countFlights(parsed.days);
      if (nFlights === 0) return htmlResult(false, { error: "no flights collected (session not primed)" });
      const fares = cleanFares(parsed.fares);
      const err = await saveSnapshot(supabase, parsed.ts, parsed.days, fares);
      if (err) return htmlResult(false, { error: err });
      return htmlResult(true, { ts: parsed.ts, days: nDays, flights: nFlights, fares: fares ? Object.keys(fares).length : 0 });
    }

    if (req.headers.get("x-update-key") !== expected) return json({ ok: false, error: "unauthorized" }, 401);
    let body: { ts?: string; days?: Days; fares?: unknown };
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
    if (!body.ts || !body.days || typeof body.days !== "object") return json({ ok: false, error: "ts and days required" }, 400);
    const nDays = Object.keys(body.days).length;
    if (nDays < 1 || nDays > 60) return json({ ok: false, error: "unexpected days count" }, 400);
    const nFlights = countFlights(body.days);
    if (nFlights === 0) return json({ ok: false, error: "no flights collected (session not primed)" }, 422);
    const fares = cleanFares(body.fares);
    const err = await saveSnapshot(supabase, body.ts, body.days, fares);
    if (err) return json({ ok: false, error: err }, 500);
    return json({ ok: true, ts: body.ts, days: nDays, flights: nFlights, fares: fares ? Object.keys(fares).length : 0 });
  }

  if (req.method === "GET") {
    if (url.searchParams.get("view") === "archive") {
      // 出発済み日(JSTで今日より前)の実績を返す
      const todayJst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const { data: rows, error } = await supabase
        .from("hnd_gmp_finals").select("date, route, ts, flights")
        .lt("date", todayJst).order("date", { ascending: true });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ generated: new Date().toISOString(), archive: rows ?? [] });
    }
    const { data: rows, error } = await supabase
      .from("hnd_gmp_snapshots").select("ts, data").order("ts", { ascending: false }).limit(40);
    if (error) return json({ ok: false, error: error.message }, 500);
    if (!rows || rows.length === 0) return json({ generated: null, latest: null, snapshots: [] });
    const latest = (rows[0].data as { ts: string; days: Days; fares?: Fares; faresTs?: string });
    // 参考運賃は毎回は取れない(セッション都合で欠けることがある)ので、直近で取れたものにフォールバック
    if (!latest.fares) {
      for (const r of rows) {
        const f = (r.data as { fares?: Fares }).fares;
        if (f && Object.keys(f).length) { latest.fares = f; latest.faresTs = (r.data as { ts: string }).ts; break; }
      }
    }
    const snapshots = [...rows].reverse().map((r) => {
      const d = r.data as { ts: string; days: Days };
      return { ts: d.ts, days: slimDays(d.days) };
    });
    return json({ generated: new Date().toISOString(), latest, snapshots });
  }

  return json({ ok: false, error: "method not allowed" }, 405);
});
