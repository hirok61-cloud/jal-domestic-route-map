/* 空席スナップショットの保存を、このドメイン経由でも受けられるようにする中継。
 *
 * このディレクトリ（relay/）は本体のサイトとは別の Vercel プロジェクトとして
 * 単独でデプロイしてある（https://jal-seats-relay.vercel.app）。
 *
 * なぜ別プロジェクトなのか
 * ------------------------
 * 当初 jal-domestic-route-map.vercel.app 配下に api/save.js を置いて
 * 中継にしようとしたが、**そのドメインは Vercel が GitHub Pages を
 * 中継しているだけ**で（応答に x-github-request-id が付く）、このリポジトリの
 * サーバ側コードは実行されない。2026-08-10、接続した Vercel アカウントで
 * list_projects を引いても該当プロジェクトが1件も無く（get_project も404）、
 * このアカウントからは触れないドメインだと確定した。
 * そこで新規に Vercel プロジェクト（jal-seats-relay）を立て、そちらへ
 * このファイルだけをデプロイしている。
 *
 * なぜ要るのか
 * ------------
 * 端末によっては、JALのページから supabase.co への通信だけが弾かれる
 * （広告ブロッカーやプライバシー系のアプリが既知のバックエンドのドメインを
 * 遮断していると起こる）。2026-08-09〜10、複数端末で「70区間は取れるのに
 * 保存だけが必ず失敗する」状態を確認し、Supabase側のログでも**その時間帯に
 * POSTが1件も届いていない**ことを裏付けた。fetch を XHR に変えても、
 * 宛先が同じなら同じように弾かれる。**宛先そのものを変える**必要がある。
 *
 * 合言葉はここでは検証しない。x-update-key をそのまま Edge Function に渡し、
 * 判定は今までどおり Edge Function 側で行う（合言葉をこの中継に持たせない）。
 *
 * 直したら（このファイルは自動デプロイされないので）手動で再デプロイが要る:
 *   Vercel MCP の deploy_to_vercel で projectName "jal-seats-relay"、
 *   target "production"、files に relay/api/save.js を1つ渡す。
 */
const UPSTREAM = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-update-key",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};

module.exports = async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST のみ受け付けます" });

  const key = req.headers["x-update-key"];
  if (!key) return res.status(401).json({ error: "合言葉がありません" });

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
};
