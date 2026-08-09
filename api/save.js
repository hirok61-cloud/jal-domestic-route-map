/* 空席スナップショットの保存を、このサイトのドメイン経由でも受けられるようにする中継。
 *
 * なぜ要るのか
 * ------------
 * 端末によっては、JALのページから supabase.co への通信だけが弾かれる。
 * 2026-08-09、2台の端末で「70区間は取れるのに保存だけが必ず失敗する」状態を確認し、
 * Supabase 側のログでも**その時間帯にPOSTが1件も届いていない**ことを裏付けた。
 * 広告ブロッカーやプライバシー系の拡張・アプリが、既知のバックエンドのドメインを
 * 遮断していると起こる。fetch を XHR に変えても、宛先が同じなら同じように弾かれる。
 *
 * そこで**宛先そのものを変えられる**ようにする。収集スクリプトは
 * Supabase → このサイト の順に保存先を試し、どちらかが通れば保存できる。
 * このサイトのドメインは収集スクリプトの配信元でもあるので、
 * ここに届く端末なら中継でも届く見込みが高い。
 *
 * 合言葉はここでは検証しない。x-update-key をそのまま Edge Function に渡し、
 * 判定は今までどおり Edge Function 側で行う（合言葉をこの中継に持たせない）。
 */
const UPSTREAM = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-update-key",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST のみ受け付けます" });

  const key = req.headers["x-update-key"];
  if (!key) return res.status(401).json({ error: "合言葉がありません" });

  /* Vercel は content-type: application/json の本文を勝手に JSON へ変換する。
     そのまま文字列に戻して上流へ渡す（中身には触らない）。 */
  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json", "x-update-key": String(key) },
      body,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: "保存先に中継できませんでした（" + (e.message || e) + "）" });
  }
}
