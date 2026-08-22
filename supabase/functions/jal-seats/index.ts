// JAL国内線ルートマップ「空席状況」の受け口。
//
// 読み取り（公開）
//   GET  ?hub=HND&date=2026-08-09  → 指定日のスナップショット（既定は今日）
//   GET  ?action=all&hub=HND       → 持っている日分まとめて { "YYYY-MM-DD": payload }
//   POST ?action=request           → 更新依頼を積む（スマホなど収集できない端末用）
//   GET  ?action=recent&n=8        → 直近の依頼をまとめて（成否の一覧表示用）
//   GET  ?action=corp-stats&hub=JOH&from=&to=
//                                  → 制度枠の記録ごとの要約（詳細レポート用。最大95日。
//                                    同じ日の複数回もそのまま返す）
//   GET  ?action=weather&airports=HND,CTS&from=&to=
//                                  → 空港ごとの日次天気（詳細レポート用。過去の確定日のみ。
//                                    Open-Meteoから取ってこのテーブルにキャッシュする）
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

/* 合言葉は Supabase の環境変数にだけ置く。ここに既定値を書かないこと。
   2026-08-09、既定値を書いたまま public リポジトリに push されていて、
   誰でも読める状態だった（＝誰でもスナップショットを上書きできた）。
   未設定なら書き込みを一切通さない。黙って既定値に戻るより、止まったほうがよい。 */
const UPDATE_KEY = Deno.env.get("JAL_SEATS_UPDATE_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SNAPSHOTS = "jal_seat_snapshots";
const HISTORY = "jal_seat_history";
const REQUESTS = "jal_seat_requests";
const WEATHER = "jal_weather_daily";
const MAX_BODY = 2_000_000;

/* 天気を出す対象＝公式35路線の相手空港＋羽田（tools/collect-core.js の SPOKES と
   index.html の AP から緯度経度だけを写した）。ここに無いコードは無視する。
   任意の緯度経度をこの口から問い合わせさせないための許可リストも兼ねる。 */
const AIRPORT_LL: Record<string, [number, number]> = { // [lon, lat]
  HND: [139.78, 35.55], CTS: [141.68, 42.78], HKD: [140.82, 41.77], AKJ: [142.45, 43.67],
  KUH: [144.2, 43.04], OBO: [143.22, 42.73], MMB: [144.16, 43.88], AOJ: [140.69, 40.73],
  MSJ: [141.37, 40.7], AXT: [140.22, 39.61], GAJ: [140.37, 38.41], KMQ: [136.41, 36.39],
  NGO: [136.81, 34.86], ITM: [135.44, 34.79], KIX: [135.24, 34.43], SHM: [135.36, 33.66],
  IZO: [132.89, 35.41], OKJ: [133.86, 34.76], HIJ: [132.92, 34.44], UBJ: [131.28, 33.93],
  TAK: [134.02, 34.21], TKS: [134.61, 34.13], KCZ: [133.67, 33.55], MYJ: [132.7, 33.83],
  FUK: [130.45, 33.59], KKJ: [131.03, 33.85], OIT: [131.74, 33.48], NGS: [129.91, 32.92],
  KMJ: [130.86, 32.84], KMI: [131.45, 31.88], KOJ: [130.72, 31.8], ASJ: [129.71, 28.43],
  OKA: [127.65, 26.2], UEO: [126.71, 26.36], MMY: [125.29, 24.78], ISG: [124.25, 24.4],
};

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

/* 弾いた理由を分けておく。環境変数の設定漏れと、合言葉違いは対処が別。 */
const denied = () =>
  json({ error: UPDATE_KEY ? "合言葉が違います" : "保存先の合言葉が未設定です（JAL_SEATS_UPDATE_KEY）" }, 401);

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
  const authed = UPDATE_KEY !== "" && req.headers.get("x-update-key") === UPDATE_KEY;

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

  /* ---------------------------------------- 直近の収集が成功したか（公開） */
  /* 2026-08-15、収集が48時間サイレントに失敗し続けた（座席詳細が更新されない）
     のに、サイトのどこにも失敗が出ておらず気づけなかった。古いスナップショットが
     残っているだけだと外からは正常に見えてしまうため、依頼そのものの成否を
     別途出す。hub は問わない（HND・JOHをまとめて新しい順に返す）。 */
  if (req.method === "GET" && action === "recent") {
    await rpc("jal_expire_stale_requests");
    const n = Math.min(Number(url.searchParams.get("n")) || 8, 30);
    const rows = await db(
      `${REQUESTS}?order=requested_at.desc&limit=${n}` +
      `&select=id,hub,status,message,origin_label,requested_at,updated_at,day_offsets`,
    ).then((r) => r.json()).catch(() => null);
    if (!Array.isArray(rows)) return json({ error: "読み取りに失敗しました" }, 502);
    return json({ requests: rows });
  }

  /* ------------------------------------------------- 依頼を拾う（収集側） */
  if (req.method === "GET" && action === "claim") {
    if (!authed) return denied();
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
    if (!authed) return denied();
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
    if (!authed) return denied();
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

  /* --------------------------- 制度枠の集計だけを返す（詳細レポート用・公開） */
  /* データ元は jal_seat_snapshots ではなく jal_corp_log（トリガで自動収集）。
     **理由:** snapshots は (hub, flight_date) で upsert するため、同じ日に
     複数回「制度枠を記録」しても**最後の1回しか残らない**。1日3回（朝・昼・晩）
     記録しても、朝と昼の記録はレポートから見えなくなっていた（2026-08-18に発覚。
     本人が「1日3回、朝昼晩に記録する運用にしたい」と言ってから気づいた）。
     jal_corp_log は (flight_date, captured_at) が主キーなので、同じ日の
     複数回がそのまま残っている。ここではそれを読む。

     生の flights 配列は返さず、集計だけを返す（1件あたり数百バイト程度）。
     期間は呼ぶ側が区切る。 */
  if (req.method === "GET" && action === "corp-stats") {
    const to = url.searchParams.get("to") ?? todayJST();
    const from = url.searchParams.get("from") ?? to;
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (!ymd.test(from) || !ymd.test(to)) return json({ error: "from / to が不正です" }, 400);
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    // 1回で読む量に上限を置く（メモリと応答時間のため）。呼ぶ側が区切って何度か呼ぶ
    if (!(span >= 0 && span <= 95)) return json({ error: "期間は0〜95日にしてください" }, 400);

    const rows = await db(
      `jal_corp_log?flight_date=gte.${from}&flight_date=lte.${to}` +
      `&order=flight_date.asc,captured_at.asc&select=flight_date,captured_at,flights`,
    ).then((r) => r.json()).catch(() => null);
    if (!Array.isArray(rows)) return json({ error: "読み取りに失敗しました" }, 502);

    /* 出発時間帯は4つに丸める。サイト側と同じ区切りにすること。
       jal_corp_log の1便は {s:区間, n:便名, z:制度で取れたか, e:公式残席, d:出発時刻}。 */
    const slot = (dep: unknown) => {
      const h = Number(String(dep ?? "").slice(0, 2));
      return !Number.isFinite(h) ? -1 : h < 9 ? 0 : h < 14 ? 1 : h < 18 ? 2 : 3;
    };
    const isWeekend = (date: string) => {
      const [y, m, d] = date.split("-").map(Number);
      const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      return w === 0 || w === 6;
    };

    /* **1回の記録＝1件**として返す（1日に複数回あれば複数件）。
       時間帯（朝/昼/晩）どうしを比べたいのはまさにここなので、
       日ごとにまとめてしまうと比べる材料が消える。 */
    const captures: unknown[] = [];
    for (const row of rows) {
      let n = 0, ok = 0, avail = 0, availOnly = 0;
      const hour = [0, 0, 0, 0];
      const hourOk = [0, 0, 0, 0];
      for (const f of row.flights ?? []) {
        n++;
        if (f.z) ok++;
        if (f.e >= 9) { avail++; if (!f.z) availOnly++; }
        const i = slot(f.d);
        if (i >= 0) { hour[i]++; if (f.z) hourOk[i]++; }
      }
      captures.push({ date: row.flight_date, at: row.captured_at, n, ok, avail, availOnly, hour, hourOk });
    }

    /* 区間ごとの通算（取りやすい/取りにくい区間）は、**その日の最後の記録だけ**を使う。
       全記録を使うと、1日3回記録した日が1回だけの日の3倍の重みを持ってしまい、
       「その区間が取りやすい」のではなく「よく記録した日がたまたま取れていた」に
       化ける。日ごとの偏りを避けるため、代表は1日1件に絞る。 */
    const latestByDate = new Map<string, { flight_date: string; captured_at: string; flights: any[] }>();
    for (const row of rows) {
      const cur = latestByDate.get(row.flight_date);
      if (!cur || row.captured_at > cur.captured_at) latestByDate.set(row.flight_date, row);
    }
    const seg: Record<string, number[]> = {};
    for (const row of latestByDate.values()) {
      const we = isWeekend(row.flight_date);
      for (const f of row.flights ?? []) {
        const s = seg[f.s] ?? (seg[f.s] = [0, 0, 0, 0]);
        s[0]++; if (f.z) s[1]++;
        if (we) { s[2]++; if (f.z) s[3]++; }
      }
    }

    return json({ hub: "JOH", from, to, captures, seg });
  }

  /* ------------------------------------- 空港ごとの日次天気（公開・過去日のみ） */
  /* Open-Meteo（APIキー不要・CORS開放・実測で access-control-allow-origin: * を確認済み）
     から取る。過去の確定日はここでキャッシュし、同じ日を何度問い合わせても
     Open-Meteoへは1回しか行かない。**当日・翌日はここでは扱わない**（値が
     解放に向けて動き続け、キャッシュすると古い値を返し続けることになるため）。
     /seats/ の「今の天気」はサイトが直接 Open-Meteo の予報APIを叩く
     （そちらはCORSが開いているサイト自身の通信で、この口を経由する理由が無い）。 */
  if (req.method === "GET" && action === "weather") {
    const codes = (url.searchParams.get("airports") ?? "").split(",")
      .map((s) => s.trim().toUpperCase()).filter((s) => AIRPORT_LL[s]);
    const uniq = [...new Set(codes)];
    if (!uniq.length) return json({ error: "airports が不正です" }, 400);

    const to = url.searchParams.get("to") ?? todayJST();
    const from = url.searchParams.get("from") ?? to;
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (!ymd.test(from) || !ymd.test(to) || from > to) return json({ error: "from / to が不正です" }, 400);

    // 当日は解放中でまだ確定していないので、前日までに切り詰める
    const yesterday = new Date(Date.now() + 9 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
    const pastTo = to < yesterday ? to : yesterday;
    if (from > pastTo) return json({ from, to, airports: {} });
    const days = (Date.parse(pastTo) - Date.parse(from)) / 86_400_000 + 1;
    if (days > 370) return json({ error: "期間は370日までにしてください" }, 400);

    const cached = await db(
      `${WEATHER}?airport=in.(${uniq.join(",")})&date=gte.${from}&date=lte.${pastTo}` +
      `&order=date.asc&select=airport,date,code,precip,wind,snow,tmax,tmin`,
    ).then((r) => r.json()).catch(() => null);
    const byAirport = new Map<string, Record<string, unknown>[]>();
    if (Array.isArray(cached)) {
      for (const row of cached) {
        const { airport, ...rest } = row;
        if (!byAirport.has(airport)) byAirport.set(airport, []);
        byAirport.get(airport)!.push(rest);
      }
    }
    // 期間ぶんの日数が揃っていない空港だけ、Open-Meteoへ取りに行く
    const missing = uniq.filter((ap) => (byAirport.get(ap)?.length ?? 0) < days);

    if (missing.length) {
      const lat = missing.map((ap) => AIRPORT_LL[ap][1]).join(",");
      const lon = missing.map((ap) => AIRPORT_LL[ap][0]).join(",");
      const wx = await fetch(
        `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
        `&start_date=${from}&end_date=${pastTo}` +
        `&daily=precipitation_sum,windspeed_10m_max,weathercode,snowfall_sum,temperature_2m_max,temperature_2m_min` +
        `&timezone=Asia%2FTokyo`,
      ).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      // 地点が1つだけだと配列にならず単体オブジェクトで返るので揃える
      const list = missing.length === 1 ? [wx] : wx;
      if (Array.isArray(list)) {
        const toSave: Record<string, unknown>[] = [];
        missing.forEach((ap, i) => {
          const d = list[i]?.daily;
          if (!d?.time) return; // その空港ぶんだけ失敗。他の空港には影響させない
          const rows = d.time.map((date: string, j: number) => ({
            airport: ap, date,
            code: d.weathercode?.[j] ?? null,
            precip: d.precipitation_sum?.[j] ?? null,
            wind: d.windspeed_10m_max?.[j] ?? null,
            snow: d.snowfall_sum?.[j] ?? null,
            tmax: d.temperature_2m_max?.[j] ?? null,
            tmin: d.temperature_2m_min?.[j] ?? null,
          }));
          toSave.push(...rows);
          byAirport.set(ap, rows.map(({ airport: _a, ...rest }) => rest));
        });
        if (toSave.length) {
          await db(`${WEATHER}?on_conflict=airport,date`, {
            method: "POST",
            headers: { prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(toSave),
          }).catch(() => {});
        }
      }
    }

    const airports: Record<string, unknown[]> = {};
    for (const ap of uniq) airports[ap] = byAirport.get(ap) ?? [];
    return json({ from, to: pastTo, airports });
  }

  /* ------------------------------------------- 収集スクリプトを渡す（公開） */
  /* ブックマークレットに収集ロジックを埋め込むとURLが長くなりすぎ、
     Androidのブックマークでは切り捨てられて何も起きなくなる。
     ここで中継してCORSを許可することで、ブックマークレットは数百字で済み、
     ロジックを直しても登録し直さずに最新が読まれる。 */
  if (req.method === "GET" && action === "script") {
    const src = await fetch(
      "https://hirok61-cloud.github.io/jal-domestic-route-map/seats/collect.min.js",
      { headers: { "cache-control": "no-cache" } },
    ).catch(() => null);
    if (!src || !src.ok) {
      return new Response("alert('収集スクリプトを取得できませんでした');", {
        status: 502,
        headers: { ...CORS, "content-type": "text/javascript; charset=utf-8" },
      });
    }
    return new Response(await src.text(), {
      headers: {
        ...CORS,
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
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
  if (!authed) return denied();

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

  const prev = new Map<string, any>();
  if (prevPayload) {
    for (const r of prevPayload.routes ?? []) {
      for (const f of r.flights ?? []) prev.set(f.no, f);
    }
  }
  payload.prevAt = sameRun ? prevPayload.prevAt : prevPayload?.generatedAt;

  const SEAT_KEYS = ["sa", "st", "sw", "sl", "sj", "sf"];
  for (const r of payload.routes ?? []) {
    for (const f of r.flights ?? []) {
      const old = prev.get(f.no);
      if (!old) continue;

      const oldEco = sameRun ? old.pe : old.eco;
      const oldSeat = sameRun ? old.ps : old.sa;
      if (oldEco !== undefined) f.pe = oldEco;                 // 前回の運賃上の残席
      if (oldSeat !== undefined) f.ps = oldSeat;               // 前回の座席表の空席

      /* 1回の収集は運賃だけ先に保存するので、そのままだと表示から座席表の数字が
         10分ほど消えてしまう。前回の座席表を引き継いで、いつ時点かを添えておく。 */
      if (f.sa === undefined && old.sa !== undefined) {
        for (const k of SEAT_KEYS) if (old[k] !== undefined) f[k] = old[k];
        f.saAt = old.saAt ?? prevPayload.generatedAt;
      }
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
