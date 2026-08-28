// Shared HTTP Basic Auth gate for the ZED fare page.
//
// The rest of this site (domestic/international route maps) stays fully
// public; only /international/zed/* and the API it depends on are behind
// this. Credentials live in Vercel env vars (ZED_GATE_USER/ZED_GATE_PASS),
// never in source. If they aren't configured, this fails closed (denies
// everyone) rather than silently leaving the page open.
function checkAuth(req) {
  const user = process.env.ZED_GATE_USER;
  const pass = process.env.ZED_GATE_PASS;
  if (!user || !pass) return false;

  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch (e) {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  return decoded.slice(0, sep) === user && decoded.slice(sep + 1) === pass;
}

// Returns true if the request is authorized. Otherwise sends the 401
// challenge itself and returns false — callers should stop processing.
function requireAuth(req, res) {
  if (checkAuth(req)) return true;
  res.setHeader("WWW-Authenticate", 'Basic realm="restricted", charset="UTF-8"');
  res.status(401).send("Authentication required");
  return false;
}

module.exports = { checkAuth, requireAuth };
