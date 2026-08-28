// Password-gated proxy for the ZED fare dataset (data.json).
//
// This is the part actually worth protecting — the translated content
// itself — so it gets the same gate as the page, not just the HTML shell.
const { requireAuth } = require("./_auth");

const UPSTREAM = "https://hirok61-cloud.github.io/jal-domestic-route-map/international/zed/data.json";

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  try {
    const upstream = await fetch(UPSTREAM, { headers: { "User-Agent": "Mozilla/5.0" } });
    const body = await upstream.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).send("Upstream error");
  }
};
