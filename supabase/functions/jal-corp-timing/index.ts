// 制度枠の「いつ取れるか」集計（読み取り専用）。GET ?from=YYYY-MM-DD&to=YYYY-MM-DD（最大95日）
//
// jal_corp_log は1日に複数回の記録を持つ。時間が進むと出発済みの便が記録から消えるので、
// 記録ごとの割合をそのまま比べると母数が変わって「解放で増えた」ように見えてしまう。
// ここでは同じ日の同じ便を 深夜(0〜4時台)・朝(5〜9時台)・昼(10〜15時台) の3時点で追う。
// 16時以降の記録は定時の枠ではないので使わない。同じ枠に複数あれば最初の記録を使う。
//
// 返すもの:
//   dates[日付]  { p: [[oo,ox,xo,xx] 深夜→朝, [oo,ox,xo,xx] 朝→昼],
//                  seq: [ずっと○, 途中で消えた, 途中で出た, 出入りあり, ずっと×],
//                  last: [羽田発n, 羽田発ok, 羽田着n, 羽田着ok]（各便の出発前最後の記録） }
//   flt[区間|便名] [出発時刻, 深夜n,深夜ok, 朝n,朝ok, 昼n,昼ok, ○が続きを持つ日, 消えた日, ×が続きを持つ日, 出た日]
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" };
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8" } });

const slotOf = (iso: string) => {
  const h = new Date(new Date(iso).getTime() + 9 * 3_600_000).getUTCHours();
  return h < 5 ? 0 : h < 10 ? 1 : h < 16 ? 2 : -1;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(from) || !ymd.test(to)) return json({ error: "from / to が不正です" }, 400);
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!(span >= 0 && span <= 95)) return json({ error: "期間は0〜95日にしてください" }, 400);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/jal_corp_log?flight_date=gte.${from}&flight_date=lte.${to}` +
      `&order=flight_date.asc,captured_at.asc&select=flight_date,captured_at,flights`,
    { headers: { apikey: SERVICE_ROLE, authorization: `Bearer ${SERVICE_ROLE}` } },
  );
  if (!res.ok) return json({ error: "読み取りに失敗しました" }, 502);
  const rows: { flight_date: string; captured_at: string; flights: any[] }[] = await res.json();

  // 日付 → 便 → [深夜, 朝, 昼] の ○×（null=その時点の記録に無い）
  const byDate = new Map<string, Map<string, { dep: string; st: (boolean | null)[] }>>();
  const seen = new Set<string>();
  // 時期の比較用。各便の「出発前の最後の記録」（rows は captured_at の昇順なので後勝ち）
  const lastObs = new Map<string, Map<string, boolean>>();
  for (const row of rows) {
    const m = lastObs.get(row.flight_date) ?? new Map();
    lastObs.set(row.flight_date, m);
    for (const f of row.flights ?? []) if (typeof f.z === "boolean") m.set(`${f.s}|${f.n}`, f.z);
  }
  for (const row of rows) {
    const s = slotOf(row.captured_at);
    if (s < 0 || seen.has(`${row.flight_date}|${s}`)) continue;
    seen.add(`${row.flight_date}|${s}`);
    const day = byDate.get(row.flight_date) ?? new Map();
    byDate.set(row.flight_date, day);
    for (const f of row.flights ?? []) {
      if (typeof f.z !== "boolean") continue;
      const k = `${f.s}|${f.n}`;
      const e = day.get(k) ?? { dep: String(f.d ?? ""), st: [null, null, null] };
      e.st[s] = f.z;
      day.set(k, e);
    }
  }

  const dates: Record<string, { p: number[][]; seq: number[]; last?: number[] }> = {};
  const flt: Record<string, (string | number)[]> = {};
  for (const [date, day] of byDate) {
    const d = { p: [[0, 0, 0, 0], [0, 0, 0, 0]], seq: [0, 0, 0, 0, 0] };
    for (const [k, e] of day) {
      const x = flt[k] ?? (flt[k] = [e.dep, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      if (e.dep) x[0] = e.dep; // 日付の昇順なので最新のダイヤの時刻が残る
      e.st.forEach((v, i) => {
        if (v === null) return;
        (x[1 + i * 2] as number)++;
        if (v) (x[2 + i * 2] as number)++;
      });
      for (const i of [0, 1]) {
        const a = e.st[i], b = e.st[i + 1];
        if (a === null || b === null) continue;
        d.p[i][a ? (b ? 0 : 1) : (b ? 2 : 3)]++;
      }
      const seen3 = e.st.filter((v) => v !== null) as boolean[];
      if (seen3.length < 2) continue;
      let lost = 0, gain = 0;
      for (let i = 1; i < seen3.length; i++) {
        if (seen3[i - 1] && !seen3[i]) lost++;
        if (!seen3[i - 1] && seen3[i]) gain++;
      }
      d.seq[lost && gain ? 3 : lost ? 1 : gain ? 2 : seen3[0] ? 0 : 4]++;
      if (seen3.slice(0, -1).some(Boolean)) { (x[7] as number)++; if (lost) (x[8] as number)++; }
      if (seen3.slice(0, -1).some((v) => !v)) { (x[9] as number)++; if (gain) (x[10] as number)++; }
    }
    dates[date] = d;
  }
  for (const [date, m] of lastObs) {
    const d = dates[date] ?? (dates[date] = { p: [[0, 0, 0, 0], [0, 0, 0, 0]], seq: [0, 0, 0, 0, 0] });
    const last = [0, 0, 0, 0]; // [羽田発n, 羽田発ok, 羽田着n, 羽田着ok]
    for (const [k, z] of m) {
      const i = k.startsWith("HND-") ? 0 : 2;
      last[i]++;
      if (z) last[i + 1]++;
    }
    d.last = last;
  }
  return json({ from, to, dates, flt });
});
