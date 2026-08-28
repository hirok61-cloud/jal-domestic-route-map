// Read-only proxy for flyzed.info airline pages.
//
// The ZED page ships a fingerprint of the source text we translated from.
// The browser cannot fetch flyzed.info itself (no CORS headers), so this
// endpoint re-fetches the page server-side and returns the normalized body
// plus its hash. The page compares that hash against the stored one to tell
// the reader whether the original has changed since translation.

const crypto = require("crypto");
const { requireAuth } = require("./_auth");

// Only ever fetch flyzed.info, and only a carrier-code shaped path.
const CODE_RE = /^[A-Za-z0-9]{2,3}\*?$/;

function stripHtml(fragment) {
  return fragment
    // Repeated "Go to top" anchors are chrome, not policy text — drop them so
    // the hash tracks only content the reader cares about. Must stay identical
    // to scripts/fingerprint.py or every page would look "changed".
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");

  if (req.method === "OPTIONS") {
    // Preflight has no Authorization header by design; let it through so the
    // browser's actual (authenticated) GET can proceed.
    res.status(204).end();
    return;
  }

  if (!requireAuth(req, res)) return;

  const code = String((req.query && req.query.code) || "").trim();
  if (!CODE_RE.test(code)) {
    res.status(400).json({ error: "invalid code" });
    return;
  }

  const url = `https://www.flyzed.info/${encodeURIComponent(code)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (+jal-route-map ZED checker)" },
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      res.status(502).json({ error: `upstream ${upstream.status}` });
      return;
    }

    const html = await upstream.text();

    const bodyMatch = html.match(
      /<div class="switchboard-info"[^>]*>([\s\S]*?)(?=<div class="switchboard-detail"|$)/
    );
    const body = bodyMatch ? stripHtml(bodyMatch[1]) : "";

    const headings = [];
    const headingRe = /<h3 id="heading-\d+">([\s\S]*?)<\/h3>/g;
    let m;
    while ((m = headingRe.exec(html)) !== null) headings.push(stripHtml(m[1]));

    const hash = crypto
      .createHash("sha256")
      .update(body, "utf8")
      .digest("hex")
      .slice(0, 16);

    res.status(200).json({
      code,
      url,
      hash,
      chars: body.length,
      headings,
      text: body.slice(0, 60000),
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    const reason = err && err.name === "AbortError" ? "timeout" : "fetch failed";
    res.status(504).json({ error: reason });
  }
};
