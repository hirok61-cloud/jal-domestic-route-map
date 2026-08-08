// JAL国内線ルートマップ「空席状況」の受け口。
//
// 読み取り（公開）
//   GET  ?hub=HND&date=2026-08-09  → 指定日のスナップショット（既定は今日）
//   GET  ?action=all&hub=HND       → 持っている日分まとめて { "YYYY-MM-DD": payload }
//   POST ?action=request           → 更新依頼を積む（スマホなど収集できない端末用）
//   GET  ?action=status&id=123     → 依頼の進捗
//
// 収集側（x-update-key 必須。MacのChrome拡張とブックマークレットが使う）
//   POST                           → スナップショットを上書き（payload.date の日付に入る）
//   GET  ?action=claim             → 未処理の依頼を1件取り出して running にする
//   POST ?action=progress&id=123   → 進捗メッセージを書き込む
//   POST ?action=finish&id=123     → 依頼を done / failed にする
//
// 収集は必ず人のブラウザの中で行う。JALはAkamai Bot Manager配下で、
// サーバからの取得は403、空席APIのCORSも booking.jal.co.jp オリジン固定。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const UPDATE_KEY = Deno.env.get("JAL_SEATS_UPDATE_KEY") ?? "YhainQDvJix0rT3rcyqfyKPvslt65ecU";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SNAPSHOTS = "jal_seat_snapshots";
const HISTORY = "jal_seat_history";
const REQUESTS = "jal_seat_requests";
const MAX_BODY = 2_000_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-update-key",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      authorization: `Bearer ${SERVICE_ROLE}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const rpc = (name: string) =>
  fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE, authorization: `Bearer ${SERVICE_ROLE}`, "content-type": "application/json" },
    body: "{}",
  }).catch(() => {});

/** JSTの今日を YYYY-MM-DD で返す。 */
const todayJST = () =>
  new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 送られてきたスナップショットが「それらしい」かを確かめる。 */
function validate(payload: any): string | null {
  if (!payload || typeof payload !== "object") return "payload が不正です";
  if (typeof payload.hub !== "string" || !/^[A-Z]{3}$/.test(payload.hub)) return "hub が不正です";
  if (typeof payload.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) return "date が不正です";
  if (typeof payload.generatedAt !== "string" || Number.isNaN(Date.parse(payload.generatedAt))) {
    return "generatedAt が不正です";
  }
  if (!Array.isArray(payload.routes) || payload.routes.length === 0 || payload.routes.length > 400) {
    return "routes が不正です";
  }
  const diffDays = (Date.parse(payload.date + "T00:00:00+09:00") - Date.now()) / 86_400_000;
  if (diffDays < -1.5 || diffDays > 3) return "date が現在から離れすぎています";
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";
  const hub = url.searchParams.get("hub") ?? "HND";
  const authed = req.headers.get("x-update-key") === UPDATE_KEY;

  /* ---------------------------------------------------------- 依頼を積む */
  if (req.method === "POST" && action === "request") {
    await rpc("jal_expire_stale_requests");

    // 連打防止。処理中のものがあればそれを使い回す
    const live = await db(`${REQUESTS}?status=in.(pending,running)&order=requested_at.desc&limit=1&select=id,status`)
      .then((r) => r.json()).catch(() => []);
    if (Array.isArray(live) && live.length) {
      return json({ id: live[0].id, status: live[0].status, reused: true });
    }

    let label = "";
    let days: number[] = [0, 1];
    try {
      const body = (await req.json()) ?? {};
      label = String(body.from ?? "").slice(0, 40);
      // 0=今日 / 1=翌日。座席表まで見ると1日8〜10分かかるので、要る日だけ選べるようにする
      if (Array.isArray(body.days)) {
        const picked = body.days.map(Number).filter((n: number) => n === 0 || n === 1);
        if (picked.length) days = [...new Set(picked)].sort();
      }
    } catch { /* bodyなしでもよい */ }

    const res = await db(REQUESTS, {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ hub, origin_label: label || null, day_offsets: days }),
    });
    if (!res.ok) return json({ error: "依頼を積めませんでした" }, 502);
    const [row] = await res.json();
    return json({ id: row.id, status: row.status });
  }

  /* -------------------------------------------------------- 依頼の進捗 */
  if (req.method === "GET" && action === "status") {
    await rpc("jal_expire_stale_requests");
    const id = Number(url.searchParams.get("id"));
    if (!Number.isFinite(id)) return json({ error: "id が不正です" }, 400);
    const rows = await db(`${REQUESTS}?id=eq.${id}&select=id,status,message,requested_at,updated_at,day_offsets&limit=1`)
      .then((r) => r.json()).catch(() => []);
    if (!Array.isArray(rows) || !rows.length) return json({ error: "見つかりません" }, 404);
    return json(rows[0]);
  }

  /* ------------------------------------------------- 依頼を拾う（収集側） */
  if (req.method === "GET" && action === "claim") {
    if (!authed) return json({ error: "合言葉が違います" }, 401);
    await rpc("jal_expire_stale_requests");
    const rows = await db(`${REQUESTS}?status=eq.pending&order=requested_at.asc&limit=1&select=id,hub,day_offsets`)
      .then((r) => r.json()).catch(() => []);
    if (!Array.isArray(rows) || !rows.length) return json({ job: null });
    const job = rows[0];
    // 同じ依頼を二重で拾わないよう、pending のときだけ running にする
    const upd = await db(`${REQUESTS}?id=eq.${job.id}&status=eq.pending`, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ status: "running", message: "収集を開始しました", updated_at: new Date().toISOString() }),
    });
    const changed = await upd.json().catch(() => []);
    if (!Array.isArray(changed) || !changed.length) return json({ job: null });
    return json({ job: { id: job.id, hub: job.hub, days: job.day_offsets ?? [0, 1] } });
  }

  /* ------------------------------------------------------ 進捗を書き込む */
  if (req.method === "POST" && action === "progress") {
    if (!authed) return json({ error: "合言葉が違います" }, 401);
    const id = Number(url.searchParams.get("id"));
    const body = await req.json().catch(() => ({}));
    await db(`${REQUESTS}?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ message: String(body.message ?? "").slice(0, 200), updated_at: new Date().toISOString() }),
    });
    return json({ ok: true });
  }

  /* -------------------------------------------------------- 依頼を閉じる */
  if (req.method === "POST" && action === "finish") {
    if (!authed) return json({ error: "合言葉が違います" }, 401);
    const id = Number(url.searchParams.get("id"));
    const body = await req.json().catch(() => ({}));
    await db(`${REQUESTS}?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: body.ok ? "done" : "failed",
        message: String(body.message ?? "").slice(0, 200),
        updated_at: new Date().toISOString(),
      }),
    });
    return json({ ok: true });
  }

  /* ------------------------------- 持っている日分まとめて読む（サイト用） */
  if (req.method === "GET" && action === "all") {
    await rpc("jal_prune_old_snapshots");
    const rows = await db(
      `${SNAPSHOTS}?hub=eq.${encodeURIComponent(hub)}&flight_date=gte.${todayJST()}` +
      `&order=flight_date.asc&select=flight_date,payload`,
    ).then((r) => r.json()).catch(() => null);
    if (!Array.isArray(rows)) return json({ error: "読み取りに失敗しました" }, 502);
    if (!rows.length) return json({ error: "まだスナップショットがありません" }, 404);
    const days: Record<string, unknown> = {};
    for (const row of rows) days[row.flight_date] = row.payload;
    return json({ hub, today: todayJST(), days });
  }

  /* --------------------------------------------------- 推移を読む（公開） */
  if (req.method === "GET" && action === "history") {
    const date = url.searchParams.get("date") ?? todayJST();
    const rows = await db(
      `${HISTORY}?hub=eq.${encodeURIComponent(hub)}&flight_date=eq.${date}` +
      `&order=captured_at.asc&select=captured_at,flights`,
    ).then((r) => r.json()).catch(() => null);
    if (!Array.isArray(rows)) return json({ error: "読み取りに失敗しました" }, 502);
    return json({ hub, date, points: rows });
  }

  /* ------------------------------------------------ スナップショットを読む */
  if (req.method === "GET") {
    const date = url.searchParams.get("date") ?? todayJST();
    let rows = await db(
      `${SNAPSHOTS}?hub=eq.${encodeURIComponent(hub)}&flight_date=eq.${date}&select=payload&limit=1`,
    ).then((r) => r.json()).catch(() => null);
    // 指定日がまだ無ければ、持っている中でいちばん新しい日を返す（地図が空にならないように）
    if (Array.isArray(rows) && !rows.length) {
      rows = await db(
        `${SNAPSHOTS}?hub=eq.${encodeURIComponent(hub)}&order=flight_date.desc&limit=1&select=payload`,
      ).then((r) => r.json()).catch(() => null);
    }
    if (!Array.isArray(rows)) return json({ error: "読み取りに失敗しました" }, 502);
    if (!rows.length) return json({ error: "まだスナップショットがありません" }, 404);
    return json(rows[0].payload);
  }

  /* ------------------------------------------ スナップショットを上書き */
  if (req.method !== "POST") return json({ error: "許可されていないメソッドです" }, 405);
  if (!authed) return json({ error: "合言葉が違います" }, 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "データが大きすぎます" }, 413);

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "JSON として読めません" }, 400);
  }

  const problem = validate(payload);
  if (problem) return json({ error: problem }, 400);

  /* 前回の値を便ごとに添えておく。こうしておくと、サイトは追加の問い合わせなしで
     「満席→空席に変わった便」や「1時間前は何席だったか」を出せる。 */
  const before = await db(
    `${SNAPSHOTS}?hub=eq.${encodeURIComponent(payload.hub)}` +
    `&flight_date=eq.${payload.date}&select=payload&limit=1`,
  ).then((r) => r.json()).catch(() => []);

  const prevPayload = Array.isArray(before) && before.length ? before[0].payload : null;
  /* 1回の収集は「運賃だけ保存 → 座席表を足して再保存」の2回書き込む。
     2度目で「前回」を自分自身にしてしまわないよう、収集IDで見分けて引き継ぐ。 */
  const sameRun = !!(payload.runId && prevPayload?.runId && payload.runId === prevPayload.runId);

  const prev = new Map<string, { e: number; s?: number }>();
  if (prevPayload) {
    for (const r of prevPayload.routes ?? []) {
      for (const f of r.flights ?? []) {
        prev.set(f.no, sameRun ? { e: f.pe, s: f.ps } : { e: f.eco, s: f.sa });
      }
    }
  }
  payload.prevAt = sameRun ? prevPayload.prevAt : prevPayload?.generatedAt;
  for (const r of payload.routes ?? []) {
    for (const f of r.flights ?? []) {
      const old = prev.get(f.no);
      if (!old || old.e === undefined) continue;
      f.pe = old.e;                          // 前回の運賃上の残席
      if (old.s !== undefined) f.ps = old.s; // 前回の座席表の空席
    }
  }

  // 推移用に軽い形で1行残す
  const slim: { n: string; e: number; s?: number }[] = [];
  for (const r of payload.routes ?? []) {
    for (const f of r.flights ?? []) slim.push({ n: f.no, e: f.eco, ...(f.sa !== undefined ? { s: f.sa } : {}) });
  }
  if (slim.length) {
    await db(`${HISTORY}?on_conflict=hub,flight_date,run_id`, {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        hub: payload.hub,
        flight_date: payload.date,
        captured_at: payload.generatedAt,
        run_id: payload.runId ?? null,
        flights: slim,
      }),
    }).catch(() => {});
    rpc("jal_prune_old_history");
  }

  const res = await db(`${SNAPSHOTS}?on_conflict=hub,flight_date`, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      hub: payload.hub,
      flight_date: payload.date,
      generated_at: payload.generatedAt,
      payload,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) return json({ error: "保存に失敗しました", detail: await res.text() }, 502);

  const flights = payload.routes.reduce(
    (n: number, r: any) => n + (Array.isArray(r.flights) ? r.flights.length : 0),
    0,
  );
  return json({ ok: true, hub: payload.hub, date: payload.date, routes: payload.routes.length, flights });
});
