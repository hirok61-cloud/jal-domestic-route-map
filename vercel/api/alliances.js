// Read-only proxy that resolves current airline-alliance membership.
//
// oneworld.com and skyteam.com both serve their member list as plain
// server-rendered HTML, so they can be live-scraped the same way flyzed.info
// is (see flyzed.js) — a fetch here, a slug->IATA-code lookup, done.
//
// Star Alliance's member page (staralliance.com/en/members) is different:
// the member grid is populated client-side by a Liferay portlet behind a
// session-bound `p_auth` token that only exists after Liferay's own JS runs
// in a real browser. There is no lightweight server-side way to reproduce
// that, so its list ships here as a static, manually-reviewed snapshot
// instead of a live scrape. Callers get a flag (`staralliance.live: false`)
// so the UI can be honest about which lists are actually live.

const { requireAuth } = require("./_auth");

const UA_PLAIN = "Mozilla/5.0 (+jal-route-map alliance checker)";
// skyteam.com 403s a bare/short UA string; it wants something that looks
// like a real desktop Chrome.
const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const ONEWORLD_SLUG_TO_CODE = {
  "alaska-airlines": "AS",
  "american-airlines": "AA",
  "british-airways": "BA",
  "cathay-pacific": "CX",
  "fiji-airways": "FJ",
  "finnair": "AY",
  "iberia": "IB",
  "japan-airlines": "JL",
  "malaysia-airlines": "MH",
  "oman-air": "WY",
  "philippine-airlines": "PR",
  "qantas": "QF",
  "qatar-airways": "QR",
  "royal-air-maroc": "AT",
  "royal-jordanian": "RJ",
  "srilankan-airlines": "UL",
};

const SKYTEAM_SLUG_TO_CODE = {
  "aerolineas-argentinas": "AR",
  "aeromexico": "AM",
  "air-europa": "UX",
  "air-france": "AF",
  "china-airlines": "CI",
  "china-eastern-airlines": "MU",
  "delta-airlines": "DL",
  "garuda-indonesia": "GA",
  "kenya-airways": "KQ",
  "klm-royal-dutch-airlines": "KL",
  "korean-air": "KE",
  "middle-east-airlines": "ME",
  "sas": "SK",
  "saudia": "SV",
  "tarom": "RO",
  "vietnam-airlines": "VN",
  "virgin-atlantic": "VS",
  "xiamenair": "MF",
};

// Manually reviewed against staralliance.com — 26 members. Air China (CA)
// isn't in this dataset, so its absence below is expected, not a mistake.
const STARALLIANCE_CODES = [
  "A3", "AC", "AI", "NZ", "NH", "OZ", "OS", "AV", "SN", "CM", "OU", "MS",
  "ET", "BR", "AZ", "LO", "LH", "ZH", "SQ", "SA", "LX", "TP", "TG", "TK", "UA",
];

async function fetchText(url, ua, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": ua },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOneworld() {
  const html = await fetchText("https://www.oneworld.com/members", UA_PLAIN, 15000);
  const slugs = new Set();
  const re = /href="\/members\/([a-z0-9-]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) slugs.add(m[1]);
  return [...slugs].map(s => ONEWORLD_SLUG_TO_CODE[s]).filter(Boolean);
}

async function fetchSkyteam() {
  const html = await fetchText("https://www.skyteam.com/en/about/", UA_CHROME, 15000);
  const slugs = new Set();
  const re = /href="en\/about\/([a-z0-9-]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) slugs.add(m[1]);
  return [...slugs].map(s => SKYTEAM_SLUG_TO_CODE[s]).filter(Boolean);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (!requireAuth(req, res)) return;

  const [oneworldR, skyteamR] = await Promise.allSettled([fetchOneworld(), fetchSkyteam()]);

  const result = {
    fetchedAt: new Date().toISOString(),
    oneworld: { live: oneworldR.status === "fulfilled", codes: [] },
    skyteam: { live: skyteamR.status === "fulfilled", codes: [] },
    staralliance: {
      live: false,
      codes: STARALLIANCE_CODES,
      note: "Star Alliance公式サイトはJS認証必須のポータル形式のため自動取得できません。手動確認済みの固定リストです。",
    },
  };

  if (oneworldR.status === "fulfilled" && oneworldR.value.length) {
    result.oneworld.codes = oneworldR.value;
  } else {
    result.oneworld.live = false;
    result.oneworld.error = oneworldR.reason ? String(oneworldR.reason.message || oneworldR.reason) : "empty";
  }

  if (skyteamR.status === "fulfilled" && skyteamR.value.length) {
    result.skyteam.codes = skyteamR.value;
  } else {
    result.skyteam.live = false;
    result.skyteam.error = skyteamR.reason ? String(skyteamR.reason.message || skyteamR.reason) : "empty";
  }

  res.status(200).json(result);
};
