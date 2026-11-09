#!/usr/bin/env python3
"""JALグループ国際線の時刻表を作り直して data/international-timetable.js を更新する。

GitHub Actions（.github/workflows/update-international.yml）から週1回動く。標準ライブラリのみ。
設計と運用は docs/INTERNATIONAL_AUTO.md を参照。

  JAL便 : data/jal-intl-plan.tsv（JAL公式の運航計画の書き写し）が正。機材だけFlightAwareで照合する
  他社便: FlightAware の findflight を空港ペアごとに見て更新する

  python3 scripts/update_international.py              # 通常実行（data/ を書き換える）
  python3 scripts/update_international.py --dry-run    # 取得と検査だけ（書き込まない）
  python3 scripts/update_international.py --check-plan # 運航計画の期間切れだけ確認する

終了コード: 0=成功（変更なし含む） / 1=取得失敗 / 2=安全弁が作動（書き込まず終了） / 3=運航計画の期間切れ
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
import zoneinfo

ROOT = pathlib.Path(__file__).resolve().parent.parent
TIMETABLE_PATH = ROOT / "data" / "international-timetable.js"
STATE_PATH = ROOT / "data" / "international-state.json"
PLAN_PATH = ROOT / "data" / "jal-intl-plan.tsv"
PAGE_PATH = ROOT / "international" / "index.html"
JS_PREFIX = "window.JAL_INTL_TIMETABLE = "

# 素性を偽らない。FlightAwareに断られたら迂回せず止める。
UA = "jal-route-map/1.0 (personal fan site timetable check)"
FIND_URL = "https://ja.flightaware.com/live/findflight?origin={}&destination={}"
FLIGHT_URL = "https://ja.flightaware.com/live/flight/{}"
JST = dt.timezone(dt.timedelta(hours=9))

# JAL公式の路線名 → IATA
PLAN_AIRPORT = {
    "羽田": "HND", "成田": "NRT", "関西": "KIX", "中部": "NGO", "ニューヨーク": "JFK", "ボストン": "BOS",
    "シカゴ": "ORD", "ダラス": "DFW", "サンフランシスコ": "SFO", "ロサンゼルス": "LAX", "サンディエゴ": "SAN",
    "シアトル": "SEA", "バンクーバー": "YVR", "ロンドン": "LHR", "パリ": "CDG", "フランクフルト": "FRA",
    "ヘルシンキ": "HEL", "バンコク": "BKK", "シンガポール": "SIN", "クアラルンプール": "KUL", "ジャカルタ": "CGK",
    "ハノイ": "HAN", "ホーチミンシティ": "SGN", "マニラ": "MNL", "デリー": "DEL", "ベンガルール": "BLR",
    "シドニー": "SYD", "メルボルン": "MEL", "北京": "PEK", "上海（虹橋）": "SHA", "上海（浦東）": "PVG",
    "広州": "CAN", "大連": "DLC", "天津": "TSN", "香港": "HKG", "台北（松山）": "TSA", "台北（桃園）": "TPE",
    "ソウル（金浦）": "GMP", "ホノルル": "HNL", "グアム": "GUM",
}
JAPAN = {"HND", "NRT", "KIX", "NGO", "CTS", "FUK", "OKA", "HIJ", "TAK", "KMJ", "KOJ", "TOY", "KMI", "KMQ",
         "OKJ", "SDJ", "UKB"}

# findflight にはICAOで聞く（IATAの HND は米国の Henderson Exec=KHND と解釈されて空振りする）
ICAO = {
    "AMS": "EHAM", "ATL": "KATL", "BKK": "VTBS", "BLR": "VOBL", "BNE": "YBBN", "BOS": "KBOS", "CAN": "ZGGG",
    "CDG": "LFPG", "CGK": "WIII", "CJU": "RKPC", "CMB": "VCBI", "CTS": "RJCC", "DEL": "VIDP", "DEN": "KDEN",
    "DFW": "KDFW", "DLC": "ZYTL", "DOH": "OTHH", "DTW": "KDTW", "EWR": "KEWR", "FRA": "EDDF", "FUK": "RJFF",
    "GMP": "RKSS", "GUM": "PGUM", "HAN": "VVNB", "HEL": "EFHK", "HIJ": "RJOA", "HKG": "VHHH", "HND": "RJTT",
    "HNL": "PHNL", "IAD": "KIAD", "IAH": "KIAH", "ICN": "RKSI", "JFK": "KJFK", "KHH": "RCKH", "KIX": "RJBB",
    "KMI": "RJFM", "KMJ": "RJFT", "KMQ": "RJNK", "KOJ": "RJFK", "KUL": "WMKK", "LAX": "KLAX", "LHR": "EGLL",
    "MEL": "YMML", "MNL": "RPLL", "MSP": "KMSP", "MUC": "EDDM", "NGO": "RJGG", "NRT": "RJAA", "OKA": "ROAH",
    "OKJ": "RJOB", "ORD": "KORD", "PEK": "ZBAA", "PUS": "RKPK", "PVG": "ZSPD", "RMQ": "RCMQ", "SAN": "KSAN",
    "SDJ": "RJSS", "SEA": "KSEA", "SFO": "KSFO", "SGN": "VVTS", "SHA": "ZSSS", "SIN": "WSSS", "SYD": "YSSY",
    "TAK": "RJOT", "TOY": "RJNT", "TPE": "RCTP", "TSA": "RCSS", "TSN": "ZBTJ", "UKB": "RJBE", "YVR": "CYVR",
}

# 精度フィルタ（docs/INTERNATIONAL_DESIGN.md）
EXCLUDE_ROUTE = {("AAL", "HND", "JFK"), ("UAL", "NRT", "CEB"), ("UAL", "NRT", "KHH"), ("DLH", "NRT", "ICN")}
EXCLUDE_IDENT_ROUTE = {("EVA683", "KIX", "ORD")}
# FlightAwareに実績が出なくても消さない、発表記事を根拠に載せている便
PROTECTED = {"CI170", "CI171", "CI370", "CI371"}

MAX_FLIGHT_CHANGE = 0.30   # 前回比でこれ以上便数が増減したら止める
MIN_PAGE_RATE = 0.80       # findflightの取得成功率の下限
MAX_CONSECUTIVE_ERRORS = 5 # 連続で失敗したら弾かれたとみなして止める
GONE_KEEP_DAYS = 56        # FlightAwareで確認できない便を残す日数
RECENT_DAYS = 21           # この日数以内に飛んだ実績があれば「運航中」とみなす


class Abort(Exception):
    """安全弁。data/ を書き換えずに終了する。"""


def log(*a):
    print(*a, flush=True)


def today_jst():
    return dt.datetime.now(JST).date()


def season_of(day):
    """IATAシーズン。3月最終日曜から10月最終日曜の前日までが夏。1〜3月の冬は前年の冬として数える。"""
    def last(year, month, weekday):
        d = dt.date(year, month + 1, 1) - dt.timedelta(days=1)
        return d - dt.timedelta(days=(d.weekday() - weekday) % 7)
    y = day.year
    s_start, s_end = last(y, 3, 6), last(y, 10, 6) - dt.timedelta(days=1)
    if s_start <= day <= s_end:
        return {"kind": "summer", "label": "夏ダイヤ", "short": f"{y}夏", "from": s_start.isoformat(), "to": s_end.isoformat()}
    wy = y if day > s_end else y - 1
    return {"kind": "winter", "label": "冬ダイヤ", "short": f"{wy}冬",
            "from": last(wy, 10, 6).isoformat(),
            "to": (last(wy + 1, 3, 6) - dt.timedelta(days=1)).isoformat()}


# ---------------------------------------------------------------- JAL公式の運航計画
def norm_time(t):
    h, m = t.split(":")
    return f"{int(h):02d}:{m}"


def parse_plan(text):
    """data/jal-intl-plan.tsv を読む。{period, updated, flights:[…]}"""
    meta = {}
    flights = []
    for ln, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        if line.startswith("#"):
            m = re.search(r"period:\s*(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)", line)
            if m:
                meta["from"], meta["to"] = m.group(1), m.group(2)
            m = re.search(r"更新日:\s*(\d{4}-\d\d-\d\d)", line)
            if m:
                meta["updated"] = m.group(1)
            continue
        cols = line.split("\t")
        if len(cols) != 6:
            raise Abort(f"jal-intl-plan.tsv {ln}行目の列数が6ではありません: {line[:40]}")
        no, route, dep, arr, opn, note = cols
        m = re.fullmatch(r"JL0*(\d+)", no)
        if not m:
            raise Abort(f"jal-intl-plan.tsv {ln}行目の便名が想定外: {no}")
        o_name, _, d_name = route.partition("→")
        if o_name not in PLAN_AIRPORT or d_name not in PLAN_AIRPORT:
            raise Abort(f"jal-intl-plan.tsv {ln}行目: 空港名の対応が未登録です: {route}")
        plus = 0
        am = re.fullmatch(r"(\d{1,2}:\d\d)(?:\+(\d))?", arr)
        if not am or not re.fullmatch(r"\d{1,2}:\d\d", dep):
            raise Abort(f"jal-intl-plan.tsv {ln}行目の時刻が想定外: {dep} / {arr}")
        if am.group(2):
            plus = int(am.group(2))
        freq = "" if opn == "毎日運航" else "期間限定" if opn.startswith("期間限定") else opn
        flights.append({"no": "JL" + m.group(1), "o": PLAN_AIRPORT[o_name], "d": PLAN_AIRPORT[d_name],
                        "dep": norm_time(dep), "arr": norm_time(am.group(1)), "plus": plus,
                        "freq": freq, "note": note.strip()})
    if not flights or "to" not in meta:
        raise Abort("jal-intl-plan.tsv に便または period がありません")
    return {"from": meta["from"], "to": meta["to"], "updated": meta.get("updated", ""), "flights": flights}


def check_plan(today):
    plan = parse_plan(PLAN_PATH.read_text(encoding="utf-8"))
    if today > dt.date.fromisoformat(plan["to"]):
        write_summary([f"::error::JAL便の運航計画が期間切れです（{plan['to']}まで）。"
                       "docs/INTERNATIONAL_AUTO.md の手順で data/jal-intl-plan.tsv を次の期間に差し替えてください"])
        return 3
    log(f"運航計画は有効です（{plan['from']}〜{plan['to']}）")
    return 0


# ---------------------------------------------------------------- ページの定数
def page_tables():
    """international/index.html から OPS と AP を読む（表の二重管理を避ける）。"""
    s = PAGE_PATH.read_text(encoding="utf-8")
    ops = json.loads(re.search(r"const OPS = (\{.*?\});\n", s).group(1))
    ap = {m.group(1): m.group(2) for m in re.finditer(r'^ ([A-Z]{3}):\["([^"]+)"', s, re.M)}
    return ops, ap


# ---------------------------------------------------------------- FlightAware
class Fetcher:
    """間隔を空けて取得する。403/429や連続失敗は「弾かれた」とみなして止める。"""

    def __init__(self, interval, cache_dir=None):
        self.interval, self.cache_dir = interval, cache_dir
        self.errors = 0

    def get(self, url, cache_name=None):
        if self.cache_dir and cache_name:
            p = pathlib.Path(self.cache_dir) / cache_name
            if p.exists():
                return p.read_text(encoding="utf-8", errors="replace")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=40) as res:
                text = res.read().decode("utf-8", "replace")
            self.errors = 0
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 429):
                raise RuntimeError(f"FlightAwareに拒否されました（HTTP {e.code}）。迂回せず停止します")
            self.errors += 1
            text = None
        except (urllib.error.URLError, TimeoutError):
            self.errors += 1
            text = None
        if self.errors >= MAX_CONSECUTIVE_ERRORS:
            raise RuntimeError("FlightAwareの取得が連続で失敗しました")
        time.sleep(self.interval)
        if text is not None and self.cache_dir and cache_name:
            (pathlib.Path(self.cache_dir) / cache_name).write_text(text, encoding="utf-8")
        return text


# 日本語・英語どちらのページでも読めるようにする
DOW = {"月": 0, "火": 1, "水": 2, "木": 3, "金": 4, "土": 5, "日": 6,
       "Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}
TIME_RE = r"(\d\d)(?:時|:)(\d\d)"
DAY_RE = r">(月|火|水|木|金|土|日|Mon|Tue|Wed|Thu|Fri|Sat|Sun)<"


def parse_find(text, o, d):
    """findflightの結果から o→d の直行便だけを {ident: [row…]} で返す。"""
    i = text.find("resultsContent = ")
    if i < 0:
        return {}
    rows = json.JSONDecoder().raw_decode(text[i + len("resultsContent = "):])[0]
    out = collections.defaultdict(list)
    for x in rows:
        if x.get("origin") != o or x.get("destination") != d or "layoverDuration" in x:
            continue
        idm = re.search(r'/live/flight/id/([A-Z0-9]+)-\d+-([a-z]+)[^"]*">([A-Z0-9]+)</a>', x.get("flightIdent", ""))
        dep = re.search(TIME_RE, x.get("flightDepartureTime", ""))
        arr = re.search(TIME_RE, x.get("flightArrivalTime", ""))
        dd = re.search(DAY_RE, x.get("flightDepartureDay", ""))
        ad = re.search(DAY_RE, x.get("flightArrivalDay", ""))
        if not idm or not dep or not arr or not dd or not ad:
            continue
        out[idm.group(3)].append({
            "kind": idm.group(2),
            "dep": f"{dep.group(1)}:{dep.group(2)}", "arr": f"{arr.group(1)}:{arr.group(2)}",
            "plus": (DOW[ad.group(1)] - DOW[dd.group(1)]) % 7,
            "ac": x.get("aircraftType") or "",
            "upcoming": x.get("flightStatus", "").startswith(("予定済み", "Scheduled")),
        })
    return out


def parse_flight_page(text, o, d, today):
    """live/flight の trackpollBootstrap から o→d の定刻を求める。

    戻り値: ("ok", {...}) / ("gone", None)=最近この区間を飛んでいない / ("unknown", None)=情報なし
    """
    m = re.search(r"trackpollBootstrap\s*=\s*(\{.*?\});\s*</script>", text or "", re.S)
    if not m:
        return "unknown", None
    try:
        boot = json.loads(m.group(1))
        first = next(iter(boot["flights"].values()))
        # 履歴が空のページは、最後の運航1本（ページ先頭）だけで判断する
        log_flights = first["activityLog"]["flights"] or [first]
    except (ValueError, KeyError, StopIteration, TypeError):
        return "unknown", None
    if not log_flights:
        return "unknown", None
    since = dt.datetime.combine(today - dt.timedelta(days=RECENT_DAYS), dt.time(), JST).timestamp()
    picked = collections.Counter()
    acs = collections.Counter()
    for f in log_flights:
        try:
            if f["origin"]["iata"] != o or f["destination"]["iata"] != d:
                continue
            ds, as_ = f["gateDepartureTimes"]["scheduled"], f["gateArrivalTimes"]["scheduled"]
            if not ds or not as_ or ds < since:
                continue
            tzo = zoneinfo.ZoneInfo(f["origin"]["TZ"].lstrip(":"))
            tzd = zoneinfo.ZoneInfo(f["destination"]["TZ"].lstrip(":"))
        except (KeyError, TypeError, zoneinfo.ZoneInfoNotFoundError):
            continue
        ld, la = dt.datetime.fromtimestamp(ds, tzo), dt.datetime.fromtimestamp(as_, tzd)
        picked[(ld.strftime("%H:%M"), la.strftime("%H:%M"), (la.date() - ld.date()).days)] += 1
        if f.get("aircraftType"):
            acs[f["aircraftType"]] += 1
    if not picked:
        return "gone", None
    (dep, arr, plus), _ = picked.most_common(1)[0]
    return "ok", {"dep": dep, "arr": arr, "plus": plus, "ac": acs.most_common(1)[0][0] if acs else ""}


def split_ident(ident):
    m = re.fullmatch(r"([A-Z]{3})(\d+)([A-Z]?)", ident)
    return (m.group(1), int(m.group(2))) if m else (None, None)


def excluded(ident, carrier, num, o, d, ac):
    """精度フィルタ。Trueなら載せない。"""
    if (carrier, o, d) in EXCLUDE_ROUTE or (carrier, d, o) in EXCLUDE_ROUTE:
        return True
    if (ident, o, d) in EXCLUDE_IDENT_ROUTE or (ident, d, o) in EXCLUDE_IDENT_ROUTE:
        return True
    if num >= 9000:                                      # コードシェア番号・臨時便
        return True
    if carrier == "CPA" and ("HKG" not in (o, d) or ac == "B748"):
        return True
    if carrier == "CAL" and 5000 <= num < 6000:          # 貨物便
        return True
    return False


def best(rows):
    """定刻が読める「予定済み」の行を優先し、多数決で1つに決める。"""
    pool = [r for r in rows if r["upcoming"]]
    if not pool:
        return None
    (dep, arr, plus), _ = collections.Counter((r["dep"], r["arr"], r["plus"]) for r in pool).most_common(1)[0]
    acs = collections.Counter(r["ac"] for r in rows if r["ac"])
    return {"dep": dep, "arr": arr, "plus": plus, "ac": acs.most_common(1)[0][0] if acs else ""}


# ---------------------------------------------------------------- 組み立て
def load_previous():
    if not TIMETABLE_PATH.exists():
        return None
    body = TIMETABLE_PATH.read_text(encoding="utf-8").strip()
    if not body.startswith(JS_PREFIX):
        raise RuntimeError("data/international-timetable.js の形式が想定と違います")
    return json.loads(body[len(JS_PREFIX):].rstrip(";"))


def flights_of(routes):
    """{(no, o, d): tuple} に展開する。"""
    out = {}
    for r in routes:
        for k, (o, d) in (("F0", (r["a"], r["b"])), ("F1", (r["b"], r["a"]))):
            for f in r[k]:
                out[(f[0], o, d)] = f
    return out


def icao_of(no, op, ops):
    m = re.fullmatch(r"[A-Z0-9]{2}(\d+)", no)
    return f"{op}{int(m.group(1))}" if m else None


def schedule_of(routes):
    return [[r["a"], r["b"], [f[:4] + f[5:] for f in r["F0"]], [f[:4] + f[5:] for f in r["F1"]]] for r in routes]


def fingerprint(obj):
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def write_summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    for line in lines:
        log(line)


def build(plan, prev_routes, state, fetcher, flight_limit, today, ops, airports, warnings):
    """(routes, state, stats) を返す。"""
    prev = flights_of(prev_routes)
    pairs = set()
    for r in prev_routes:
        pairs |= {(r["a"], r["b"]), (r["b"], r["a"])}
    for f in plan["flights"]:
        pairs.add((f["o"], f["d"]))

    # 1. findflight を全方向ぶん見る
    found = {}      # (o,d) -> {ident: rows}
    ok_pages = 0
    for i, (o, d) in enumerate(sorted(pairs), 1):
        text = fetcher.get(FIND_URL.format(ICAO.get(o, o), ICAO.get(d, d)), f"ff_{o}_{d}.html")
        if text is None:
            found[(o, d)] = {}
            continue
        if "resultsContent" in text:
            ok_pages += 1
        found[(o, d)] = parse_find(text, o, d)
        if i % 40 == 0:
            log(f"  findflight {i}/{len(pairs)}")
    if ok_pages < len(pairs) * MIN_PAGE_RATE:
        raise Abort(f"findflightの取得が少なすぎます（{ok_pages}/{len(pairs)}）")
    log(f"findflight: {ok_pages}/{len(pairs)} 方向")

    # 他社便を集める
    out = {}          # (no,o,d) -> tuple
    needs = []        # 定刻が読めず個別照会する他社便
    stats = collections.Counter()
    for (o, d), idents in found.items():
        for ident, rows in idents.items():
            carrier, num = split_ident(ident)
            if carrier is None or carrier == "JAL" or carrier not in ops:
                continue
            real = [r for r in rows if r["kind"] != "adhoc"]
            if not real:
                continue
            ac = collections.Counter(r["ac"] for r in real if r["ac"]).most_common(1)
            ac = ac[0][0] if ac else ""
            if excluded(ident, carrier, num, o, d, ac):
                continue
            no = f"{ops[carrier][0]}{num}"
            key = (no, o, d)
            if key not in prev and len(real) < 2 and not real[0]["upcoming"]:
                stats["単発で採用せず"] += 1
                continue
            sch = best(real)
            if sch:
                out[key] = [no, sch["dep"], sch["arr"], sch["plus"], sch["ac"] or ac, carrier, prev.get(key, [""] * 7)[6]]
                stats["他社便 findflight"] += 1
            else:
                needs.append((key, ident, carrier, ac, real))

    # 2. findflightで見えない前回の他社便は、便ごとのページで確かめる
    for key, f in prev.items():
        if f[5] == "JAL" or key in out or any(n[0] == key for n in needs):
            continue
        ident = icao_of(f[0], f[5], ops)
        needs.append((key, ident, f[5], f[4], None))

    new_state = {}
    calls = 0
    for key, ident, carrier, ac, rows in needs:
        no, o, d = key
        status, sch = "unknown", None
        if calls < flight_limit and ident:
            text = fetcher.get(FLIGHT_URL.format(ident), f"fl_{ident}.html")
            calls += 1
            status, sch = parse_flight_page(text, o, d, today)
        if status == "ok":
            out[key] = [no, sch["dep"], sch["arr"], sch["plus"], sch["ac"] or ac or (prev.get(key) or [0] * 5)[4], carrier,
                        prev.get(key, [""] * 7)[6]]
            stats["他社便 個別ページ"] += 1
        elif rows:          # 直近の実績行はあるが定刻が読めない
            (dep, arr, plus), _ = collections.Counter((r["dep"], r["arr"], r["plus"]) for r in rows).most_common(1)[0]
            out[key] = [no, dep, arr, plus, ac, carrier, prev.get(key, [""] * 7)[6]]
            stats["他社便 実績時刻"] += 1
        elif key in prev and status == "gone" and no not in PROTECTED:
            stats["他社便 運休で削除"] += 1
            warnings.append(f"{no} {o}→{d} はFlightAwareで最近の運航が確認できず削除")
        elif key in prev:   # 確認できない。前回値を保持し、期限が来たら落とす
            last = state.get(no, {}).get("lastSeen", today.isoformat())
            if no in PROTECTED or (today - dt.date.fromisoformat(last)).days <= GONE_KEEP_DAYS:
                out[key] = prev[key]
                new_state[no] = {"lastSeen": last}
                stats["他社便 前回値を保持"] += 1
                warnings.append(f"{no} {o}→{d} は確認できず前回値を保持")
            else:
                stats["他社便 期限切れで削除"] += 1
    # 3. JAL便は運航計画を正として全置換。機材だけFlightAwareから
    ac_pool = collections.defaultdict(collections.Counter)
    jal_rows = {}
    for (o, d), idents in found.items():
        for ident, rows in idents.items():
            carrier, num = split_ident(ident)
            if carrier == "JAL" and ident[-1].isdigit():
                acs = collections.Counter(r["ac"] for r in rows if r["ac"])
                if acs:
                    jal_rows[(f"JL{num}", o, d)] = acs.most_common(1)[0][0]
    for key, f in prev.items():
        if f[5] == "JAL":
            ac_pool[frozenset(key[1:])][f[4]] += 1
    route_notes = collections.defaultdict(list)
    for f in plan["flights"]:
        key = (f["no"], f["o"], f["d"])
        ac = jal_rows.get(key)
        if not ac and calls < flight_limit:
            text = fetcher.get(FLIGHT_URL.format("JAL" + f["no"][2:]), f"fl_JAL{f['no'][2:]}.html")
            calls += 1
            _, sch = parse_flight_page(text, f["o"], f["d"], today)
            ac = sch["ac"] if sch and re.fullmatch(r"[A-Z][A-Z0-9]{3}", sch["ac"]) else None
        if ac:
            stats["JAL便 機材FA"] += 1
        else:
            before = prev.get(key)
            if not before:
                # 区間が変わった同じ便名の前回値を探す
                before = next((v for k, v in prev.items() if k[0] == f["no"]), None)
            if before:
                ac = before[4]
                stats["JAL便 機材は前回値"] += 1
            else:
                pool = ac_pool.get(frozenset((f["o"], f["d"])))
                if not pool:
                    raise Abort(f"{f['no']} の機材を決められません")
                ac = pool.most_common(1)[0][0]
                stats["JAL便 機材は路線の多数派"] += 1
        out[key] = [f["no"], f["dep"], f["arr"], f["plus"], ac, "JAL", f["freq"]]
        if f["note"] or f["freq"] == "期間限定":
            route_notes[frozenset((f["o"], f["d"]))].append(f"{f['no']}: {f['note']}")
    stats["個別ページ照会"] = calls
    # 計画に無いJAL便は out に入らない（＝運休扱い）。同一社・同一時刻の重複便名を消す
    seen, dedup = set(), {}
    for key in sorted(out, key=lambda k: (k[1], k[2], out[k][1], int(re.sub(r"\D", "", k[0])))):
        f = out[key]
        sig = (key[1], key[2], f[5], f[1], f[2])
        if sig in seen:
            stats["重複便名を除外"] += 1
            continue
        seen.add(sig)
        dedup[key] = f

    # 4. 路線にまとめる（順序・region は前回を維持）
    by_pair = collections.defaultdict(lambda: {"F0": [], "F1": []})
    order = {}
    for r in prev_routes:
        order[(r["a"], r["b"])] = r
    for (no, o, d), f in dedup.items():
        if (o, d) in order:
            by_pair[(o, d)]["F0"].append(f)
        elif (d, o) in order:
            by_pair[(d, o)]["F1"].append(f)
        else:
            a, b = (o, d) if o in JAPAN else (d, o)
            order[(a, b)] = {"a": a, "b": b}
            by_pair[(a, b)]["F0" if a == o else "F1"].append(f)

    routes = []
    for pair, base in order.items():
        data = by_pair.get(pair)
        if not data or not (data["F0"] or data["F1"]):
            warnings.append(f"路線 {pair[0]}-{pair[1]} は便が無くなったため外しました")
            continue
        if pair[0] not in airports or pair[1] not in airports:
            warnings.append(f"路線 {pair[0]}-{pair[1]} は地図の空港表(AP)に無いので外しました")
            continue
        r = {"a": pair[0], "b": pair[1]}
        if "region" in base:
            r["region"] = base["region"]
        notes = route_notes.get(frozenset(pair))
        if notes:
            r["note"] = "／".join(notes)
        r["F0"] = sorted(data["F0"], key=lambda f: f[1])
        r["F1"] = sorted(data["F1"], key=lambda f: f[1])
        routes.append(r)
    return routes, new_state, stats


def safety_checks(routes, prev_routes, plan):
    n = sum(len(r["F0"]) + len(r["F1"]) for r in routes)
    p = sum(len(r["F0"]) + len(r["F1"]) for r in prev_routes)
    if not n:
        raise Abort("便が0件です")
    if p and abs(n - p) / p > MAX_FLIGHT_CHANGE:
        raise Abort(f"便数が前回 {p} から {n} に大きく変化しました（±{int(MAX_FLIGHT_CHANGE * 100)}%超）")
    jal = sum(1 for r in routes for k in ("F0", "F1") for f in r[k] if f[5] == "JAL")
    if jal != len(plan["flights"]):
        raise Abort(f"JAL便の数が運航計画と一致しません（{jal} / {len(plan['flights'])}）")


def diff_lines(prev_routes, routes):
    def pairs(rs):
        return {f"{r['a']}-{r['b']}": len(r["F0"]) + len(r["F1"]) for r in rs}
    a, b = pairs(prev_routes), pairs(routes)
    out = []
    if set(b) - set(a):
        out.append("新規路線: " + ", ".join(sorted(set(b) - set(a))))
    if set(a) - set(b):
        out.append("消えた路線: " + ", ".join(sorted(set(a) - set(b))))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check-plan", action="store_true")
    ap.add_argument("--flight-limit", type=int, default=300, help="個別ページ照会の上限")
    ap.add_argument("--interval", type=float, default=1.2)
    ap.add_argument("--cache-dir", help="開発用: 取得済みHTMLを使う")
    args = ap.parse_args()

    today = today_jst()
    if args.check_plan:
        return check_plan(today)

    warnings = []
    prev = load_previous()
    if not prev:
        write_summary(["::error::data/international-timetable.js がありません"])
        return 1
    state = json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.exists() else {}
    ops, airports = page_tables()

    try:
        plan = parse_plan(PLAN_PATH.read_text(encoding="utf-8"))
        fetcher = Fetcher(args.interval, args.cache_dir)
        routes, new_state, stats = build(plan, prev["routes"], state, fetcher, args.flight_limit, today, ops, airports, warnings)
        safety_checks(routes, prev["routes"], plan)
    except Abort as e:
        write_summary([f"::error::安全弁が作動したため更新しません: {e}"])
        return 2
    except RuntimeError as e:
        write_summary([f"::error::取得に失敗しました: {e}"])
        return 1

    schedule_changed = fingerprint(schedule_of(prev["routes"])) != fingerprint(schedule_of(routes))
    routes_changed = fingerprint(prev["routes"]) != fingerprint(routes)
    as_of = today if schedule_changed else dt.date.fromisoformat(prev["meta"]["asOf"])
    cities = sorted({x for r in routes for x in (r["a"], r["b"])})
    meta = {
        "asOf": as_of.isoformat(),
        "aircraftAsOf": today.isoformat() if routes_changed else prev["meta"].get("aircraftAsOf", as_of.isoformat()),
        "season": season_of(as_of),
        "jalPlan": {"from": plan["from"], "to": plan["to"], "updated": plan["updated"]},
        "flights": sum(len(r["F0"]) + len(r["F1"]) for r in routes),
        "routes": len(routes),
        "airports": len(cities),
    }
    payload = {"meta": meta, "routes": routes}
    uniq = list(dict.fromkeys(warnings))
    write_summary([
        f"### JAL国際線 時刻表の確認 {today}",
        f"- {meta['flights']}便 / {meta['routes']}路線 / {meta['airports']}空港（{meta['season']['short']}）",
        f"- ダイヤの変更: {'あり' if schedule_changed else 'なし'} / 機材を含む便データの変更: {'あり' if routes_changed else 'なし'}",
        f"- 根拠: {dict(stats)}",
    ] + [f"- {x}" for x in diff_lines(prev["routes"], routes)] + (
        [f"- 警告 {len(uniq)}件: " + " / ".join(uniq[:20])] if uniq else []))

    if args.dry_run:
        log("（--dry-run のため書き込みません）")
        return 0
    if routes_changed or prev["meta"] != meta:
        js = JS_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace('{"a":', '\n{"a":') + ";\n"
        TIMETABLE_PATH.write_text(js, encoding="utf-8")
        log("data/international-timetable.js を更新しました")
    state_text = json.dumps(new_state, ensure_ascii=False, sort_keys=True, indent=0) + "\n"
    if not STATE_PATH.exists() or STATE_PATH.read_text(encoding="utf-8") != state_text:
        STATE_PATH.write_text(state_text, encoding="utf-8")
        log("data/international-state.json を更新しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
