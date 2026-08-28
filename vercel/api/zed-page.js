// Password-gated proxy for the ZED fare page itself.
//
// The page's real source lives on GitHub Pages (same as the rest of this
// site). vercel.json rewrites /international/zed(/) to this function instead
// of the public catch-all rewrite, so a request only reaches the actual HTML
// after passing the Basic Auth check below.
const { requireAuth } = require("./_auth");

const UPSTREAM = "https://hirok61-cloud.github.io/jal-domestic-route-map/international/zed/";

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  try {
    const upstream = await fetch(UPSTREAM, { headers: { "User-Agent": "Mozilla/5.0" } });
    const body = await upstream.text();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).send("Upstream error");
  }
};
