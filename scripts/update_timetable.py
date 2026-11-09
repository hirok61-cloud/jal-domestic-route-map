#!/usr/bin/env python3
"""JALグループ国内線の時刻表を取り直して data/domestic-timetable.js を作り直す。

GitHub Actions（.github/workflows/update-timetable.yml）から週1回動く。標準ライブラリのみ。
設計と運用は docs/TIMETABLE_AUTO.md を参照。

  python3 scripts/update_timetable.py              # 通常実行（data/ を書き換える）
  python3 scripts/update_timetable.py --dry-run    # 取得と検査だけ（書き込まない）
  python3 scripts/update_timetable.py --no-fa      # FlightAwareを使わない
  python3 scripts/update_timetable.py --fa-limit 300

終了コード: 0=成功（変更なし含む） / 1=取得失敗 / 2=安全弁が作動（書き込まず終了）
"""
import argparse
import collections
import datetime as dt
import hashlib
import html as htmllib
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
TIMETABLE_PATH = ROOT / "data" / "domestic-timetable.js"
AIRCRAFT_PATH = ROOT / "data" / "domestic-aircraft.json"
JS_PREFIX = "window.JAL_TIMETABLE = "

UA = "jal-route-map/1.0 (personal fan site timetable check)"
EKITAN = "https://ekitan.com/timetable/airplane/domestic"
SEATS_API = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats?action=all&hub=HND"
FA_URL = "https://ja.flightaware.com/live/flight/{}"

JST = dt.timezone(dt.timedelta(hours=9))

# 駅探の空港名 → IATA。リンクの dep=/arr= を優先し、無いときだけこの表を使う。
NAME_TO_IATA = {
    "羽田": "HND", "成田": "NRT", "新千歳": "CTS", "丘珠": "OKD", "函館": "HKD", "旭川": "AKJ",
    "釧路": "KUH", "帯広": "OBO", "女満別": "MMB", "根室中標津": "SHB", "利尻": "RIS", "奥尻": "OIR",
    "青森": "AOJ", "三沢": "MSJ", "秋田": "AXT", "山形": "GAJ", "花巻": "HNA", "仙台": "SDJ",
    "新潟": "KIJ", "松本": "MMJ", "小松": "KMQ", "静岡": "FSZ", "名古屋": "NKM", "中部国際": "NGO",
    "伊丹": "ITM", "関西国際": "KIX", "神戸": "UKB", "南紀白浜": "SHM", "但馬": "TJH", "隠岐": "OKI",
    "出雲": "IZO", "岡山": "OKJ", "広島": "HIJ", "山口宇部": "UBJ", "高松": "TAK", "徳島": "TKS",
    "高知": "KCZ", "松山": "MYJ", "福岡": "FUK", "北九州": "KKJ", "大分": "OIT", "長崎": "NGS",
    "対馬": "TSJ", "壱岐": "IKI", "五島福江": "FUJ", "熊本": "KMJ", "天草": "AXJ", "宮崎": "KMI",
    "鹿児島": "KOJ", "種子島": "TNE", "屋久島": "KUM", "奄美": "ASJ", "喜界": "KKX", "徳之島": "TKN",
    "沖永良部": "OKE", "与論": "RNJ", "那覇": "OKA", "久米島": "UEO", "北大東": "KTD", "南大東": "MMD",
    "宮古": "MMY", "多良間": "TRA", "新石垣": "ISG", "与那国": "OGN",
}
# 駅探はリンクに札幌を都市コード SPK で出す
IATA_ALIAS = {"SPK": "CTS"}
KNOWN_AIRPORTS = set(NAME_TO_IATA.values())

# 空席データの機材コード（JAL公式）→ このサイトの機材コード
SEATS_AC = {"73H": "B738", "767": "B763", "763": "B763", "359": "A359", "788": "B788", "E90": "E190",
            "E70": "E170", "E75": "E175", "7M8": "B38M"}
# FlightAwareの機材コード → このサイトの機材コード
FA_AC = {"A359": "A359", "B788": "B788", "B763": "B763", "B738": "B738", "B38M": "B38M", "E190": "E190",
         "E170": "E170", "E75S": "E175", "E75L": "E175", "AT76": "AT7", "AT75": "AT7", "AT72": "AT7",
         "AT45": "AT4", "AT46": "AT4", "AT43": "AT4", "AT42": "AT4", "DH8D": "DH8"}
# 情報が何も無いときの最後の手段
OP_DEFAULT_AC = {"JAL": "B738", "JTA": "B738", "JAR": "E170", "JAC": "AT4", "HAC": "AT4", "RAC": "DH8",
                 "ORC": "DH8", "AMX": "AT4", "FDA": "E175"}

# 安全弁
MAX_FLIGHT_CHANGE = 0.30   # 前回比でこれ以上便数が増減したら止める
MAX_AIRPORT_DROP = 0.15    # 空港数がこれ以上減ったら止める
MIN_HND_FLIGHTS = 100      # 羽田発がこれ未満なら取得がおかしい
MIN_PAGES = 80             # 取得できた空港ページの下限
GONE_KEEP_DAYS = 400       # 時刻表から消えた路線を破線で残す日数


class Abort(Exception):
    """安全弁。data/ を書き換えずに終了する。"""


def log(*a):
    print(*a, flush=True)


def fetch(url, limit=None, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read(limit) if limit else res.read()
    return raw.decode("utf-8", "replace")


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


def flight_no(raw):
    """駅探の JAL303 / JTA552 / RAC892 を、サイトの表記 JL303 / NU552 / RAC892 にする。"""
    m = re.fullmatch(r"(JAL|JTA|RAC)(\d+)", raw)
    if not m:
        return None
    return {"JAL": "JL", "JTA": "NU", "RAC": "RAC"}[m.group(1)] + m.group(2)


def icao_ident(no):
    m = re.fullmatch(r"(JL|NU|RAC)(\d+)", no)
    return {"JL": "JAL", "NU": "JTA", "RAC": "RAC"}[m.group(1)] + m.group(2)


# ---------------------------------------------------------------- 駅探
def parse_page(text, warnings):
    """1空港ページから JALグループの便を取り出す。"""
    out = []
    for block in re.split(r'<tr class="search-result-data-rec', text)[1:]:
        if not block.startswith(" company-data-jal"):
            continue
        row = block.split("</tr>")[0]
        no_m = re.search(r'td-required-time">\s*([^<\s]+)', row)
        times = re.findall(r'(\d\d:\d\d)<span class="dep-arr-airpot">([^<]+)', row)
        if not no_m or len(times) != 2:
            warnings.append(f"解釈できない行: {htmllib.unescape(re.sub(r'<[^>]+>', ' ', row))[:60]}")
            continue
        no = flight_no(no_m.group(1))
        if not no:
            warnings.append(f"未知の便名形式: {no_m.group(1)}")
            continue
        (dep, dep_name), (arr, arr_name) = times
        link = re.search(r"dep=([A-Z]{3})&(?:amp;)?af=&(?:amp;)?arr=([A-Z]{3})", row)
        o, d = None, None
        if link:
            o, d = IATA_ALIAS.get(link.group(1), link.group(1)), IATA_ALIAS.get(link.group(2), link.group(2))
        o = o or NAME_TO_IATA.get(dep_name)
        d = d or NAME_TO_IATA.get(arr_name)
        if o not in KNOWN_AIRPORTS or d not in KNOWN_AIRPORTS:
            warnings.append(f"地図に無い空港のため除外: {no} {dep_name}→{arr_name}")
            continue
        out.append({"no": no, "o": o, "d": d, "dep": dep, "arr": arr})
    return out


def scrape_ekitan(cache_dir, interval, warnings):
    top = fetch(f"{EKITAN}/jal")
    ids = sorted({int(x) for x in re.findall(r"/departure/jal/(\d+)", top)})
    if len(ids) < MIN_PAGES:
        raise RuntimeError(f"駅探の空港一覧が取れません（{len(ids)}件）。ページ構成の変更かアクセス拒否の可能性があります")
    log(f"駅探: {len(ids)}空港を取得します")
    flights, failed, parsed_pages = {}, [], 0
    for i, pid in enumerate(ids, 1):
        cache = pathlib.Path(cache_dir) / f"{pid}.html" if cache_dir else None
        try:
            if cache and cache.exists():
                text = cache.read_text(encoding="utf-8")
            else:
                text = fetch(f"{EKITAN}/departure/jal/{pid}")
                time.sleep(interval)
        except (urllib.error.URLError, TimeoutError) as e:
            failed.append(pid)
            warnings.append(f"空港ページ{pid}の取得に失敗: {e}")
            continue
        if "国内線時刻表" not in text:
            failed.append(pid)
            warnings.append(f"空港ページ{pid}が時刻表ではありません")
            continue
        parsed_pages += 1
        for f in parse_page(text, warnings):
            flights[f["no"]] = f
        if i % 20 == 0:
            log(f"  {i}/{len(ids)} …{len(flights)}便")
    if parsed_pages < MIN_PAGES:
        raise RuntimeError(f"取得できた空港ページが {parsed_pages} 件しかありません（失敗 {len(failed)} 件）")
    return flights


# ---------------------------------------------------------------- 機材
def seats_aircraft(warnings):
    """空席データ（読み取り専用のGET）から、羽田路線の直近の実機材を得る。"""
    try:
        data = json.loads(fetch(SEATS_API, timeout=60))
    except Exception as e:  # 取れなくても FlightAware と前回値で続行できる
        warnings.append(f"空席データを読めませんでした: {e}")
        return {}
    out = {}
    for _, day in sorted(data.get("days", {}).items()):
        for route in day.get("routes", []):
            for f in route.get("flights", []) or []:
                ac = SEATS_AC.get(f.get("ac"))
                if f.get("no") and ac:
                    out[f["no"]] = ac
                elif f.get("no") and f.get("ac"):
                    warnings.append(f"空席データの未知の機材コード: {f['ac']}")
    return out


def fa_lookup(no):
    """FlightAwareの <meta name="aircrafttype">。頭の方にあるので先頭だけ読む。"""
    text = fetch(FA_URL.format(icao_ident(no)), limit=120_000, timeout=25)
    m = re.search(r'<meta name="aircrafttype" content="([A-Z0-9]+)"', text)
    return m.group(1) if m else None


def fa_targets(flights, official, state, limit, today):
    """今回FlightAwareに聞く便。未解決を先に、残りは週替わりで順番に回す。

    「いつ確認したか」を状態に持つと毎週の差分になるので、順番は週番号から決める。
    """
    others = sorted(n for n in flights if n not in official)
    def unresolved(n):
        e = state.get(n)
        return not e or (e.get("src") in ("seed", "majority") and not e.get("faMiss"))
    first = [n for n in others if unresolved(n)]
    rest = [n for n in others if not unresolved(n)]
    picked = first[:limit]
    room = limit - len(picked)
    if room > 0 and rest:
        iso = today.isocalendar()
        start = (iso[0] * 53 + iso[1]) * room % len(rest)
        picked += [rest[(start + i) % len(rest)] for i in range(min(room, len(rest)))]
    return picked


def resolve_aircraft(flights, state, official, fa_limit, fa_interval, today, warnings):
    """優先順: 空席データ → FlightAware → 前回値 → 同じ路線の多数派。"""
    fa_found, fa_missed, fa_tried = {}, set(), 0
    if fa_limit > 0:
        errors = 0
        targets = fa_targets(flights, official, state, fa_limit, today)
        log(f"FlightAware: {len(targets)}便を照会します")
        for i, no in enumerate(targets, 1):
            try:
                raw = fa_lookup(no)
                errors = 0
                fa_tried += 1
            except (urllib.error.URLError, TimeoutError) as e:
                errors += 1
                if errors >= 5 or getattr(e, "code", 0) in (403, 429):
                    warnings.append(f"FlightAwareの照会を途中で打ち切り（{i}/{len(targets)}件目）: {e}")
                    break
                continue
            finally:
                time.sleep(fa_interval)
            if raw is None:
                fa_missed.add(no)
                continue
            ac = FA_AC.get(raw)
            if not ac:
                warnings.append(f"FlightAwareの未知の機材コード: {no} {raw}")
                ac = raw
            fa_found[no] = ac
            if i % 50 == 0:
                log(f"  {i}/{len(targets)} …機材あり {len(fa_found)}")

    since = today.isoformat()
    new_state = {}

    def put(no, ac, src, extra=None):
        prev = state.get(no, {})
        same = prev.get("ac") == ac
        e = {"ac": ac, "op": prev.get("op"), "src": src, "since": prev.get("since", since) if same else since}
        if extra:
            e.update(extra)
        new_state[no] = e

    pending = []
    for no in flights:
        prev = state.get(no)
        if no in official:
            put(no, official[no], "jal")
        elif no in fa_found:
            put(no, fa_found[no], "fa")
        elif prev and prev.get("ac"):
            put(no, prev["ac"], prev.get("src", "seed"), {"faMiss": True} if no in fa_missed or prev.get("faMiss") else None)
        else:
            pending.append(no)

    # 運航会社: 前回値 → 便名の接頭辞 → 同じ路線で機材も同じ便 → 便番号の百の位の多数派
    def route_key(no):
        f = flights[no]
        return tuple(sorted((f["o"], f["d"])))

    by_route, by_hundred = collections.defaultdict(list), collections.defaultdict(collections.Counter)
    for no, e in {**state, **new_state}.items():
        if e.get("op") and no.startswith("JL"):
            by_hundred[int(no[2:]) // 100][e["op"]] += 1
    for no, e in new_state.items():
        by_route[route_key(no)].append(e)

    # 機材が全く分からない便は、路線の多数派で補う
    for no in pending:
        cnt = collections.Counter(e["ac"] for e in by_route[route_key(no)] if e.get("ac"))
        ac = cnt.most_common(1)[0][0] if cnt else None
        new_state[no] = {"ac": ac, "op": None, "src": "majority", "since": since}
        if no in fa_missed:
            new_state[no]["faMiss"] = True
        by_route[route_key(no)].append(new_state[no])

    for no, e in new_state.items():
        if e.get("op"):
            continue
        if no.startswith("NU"):
            e["op"] = "JTA"
        elif no.startswith("RAC"):
            e["op"] = "RAC"
        else:
            peers = [p["op"] for p in by_route[route_key(no)] if p.get("op") and p.get("ac") == e.get("ac")]
            if peers:
                e["op"] = collections.Counter(peers).most_common(1)[0][0]
            elif by_hundred.get(int(no[2:]) // 100):
                e["op"] = by_hundred[int(no[2:]) // 100].most_common(1)[0][0]
            else:
                e["op"] = "JAL"
        if not e.get("ac"):
            e["ac"] = OP_DEFAULT_AC.get(e["op"], "B738")

    stats = collections.Counter(e["src"] for e in new_state.values())
    log(f"機材の根拠: {dict(stats)} / FlightAware 照会 {fa_tried} 件・機材あり {len(fa_found)}")

    # 時刻表に無い便も前回値は残す（季節便が戻ってきたとき用）
    merged = dict(state)
    merged.update(new_state)
    return merged, new_state, dict(stats), (fa_tried, len(fa_found))


# ---------------------------------------------------------------- 組み立て
def load_previous():
    if not TIMETABLE_PATH.exists():
        return None
    body = TIMETABLE_PATH.read_text(encoding="utf-8").strip()
    if not body.startswith(JS_PREFIX):
        raise RuntimeError("data/domestic-timetable.js の形式が想定と違います")
    return json.loads(body[len(JS_PREFIX):].rstrip(";"))


def build_routes(flights, resolved, prev, today):
    prev_routes = prev["routes"] if prev else []
    order = {tuple(sorted((r["a"], r["b"]))): (i, r) for i, r in enumerate(prev_routes)}
    grouped = collections.defaultdict(list)
    for no, f in flights.items():
        grouped[tuple(sorted((f["o"], f["d"])))].append(no)

    routes = []
    keys = sorted(grouped, key=lambda k: (order.get(k, (10**6, None))[0], k))
    for key in keys:
        known = order.get(key, (None, None))[1]
        a, b = (known["a"], known["b"]) if known else key
        legs = {0: [], 1: []}
        cnt = collections.Counter()
        for no in grouped[key]:
            f, e = flights[no], resolved[no]
            legs[0 if f["o"] == a else 1].append([no, f["dep"], f["arr"], e["ac"], e["op"]])
            cnt[e["op"]] += 1
        for leg in legs.values():
            leg.sort(key=lambda x: (x[1], x[0]))
        routes.append({"a": a, "b": b, "ops": [op for op, _ in cnt.most_common()],
                       "note": (known or {}).get("note", ""), "F0": legs[0], "F1": legs[1]})

    # 前回まで在って今回の時刻表に無い路線は、破線で残す（一定期間で消す）
    current = set(grouped)
    for r in prev_routes:
        key = tuple(sorted((r["a"], r["b"])))
        if key in current:
            continue
        season = r.get("season") or {}
        gone = season.get("goneSince") or today.isoformat()
        if (today - dt.date.fromisoformat(gone)).days > GONE_KEEP_DAYS:
            continue
        routes.append({"a": r["a"], "b": r["b"], "ops": r.get("ops") or ["JAL"], "note": r.get("note", ""),
                       "F0": [], "F1": [], "planned": True,
                       "season": {"txt": "現在の時刻表に掲載なし", "active": False, "goneSince": gone}})
    return routes


def schedule_of(routes):
    return [[r["a"], r["b"], [f[:3] for f in r["F0"]], [f[:3] for f in r["F1"]]]
            for r in routes if not r.get("planned")]


def fingerprint(obj):
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def safety_checks(flights, prev):
    n = len(flights)
    if n == 0:
        raise Abort("便が1件も取れていません")
    hnd = sum(1 for f in flights.values() if f["o"] == "HND")
    if hnd < MIN_HND_FLIGHTS:
        raise Abort(f"羽田発が {hnd} 便しかありません（{MIN_HND_FLIGHTS}便未満）")
    airports = {x for f in flights.values() for x in (f["o"], f["d"])}
    if not prev:
        return
    old_n = sum(len(r["F0"]) + len(r["F1"]) for r in prev["routes"])
    if old_n and abs(n - old_n) / old_n > MAX_FLIGHT_CHANGE:
        raise Abort(f"便数が前回 {old_n} → 今回 {n} と大きく変わりました（±{MAX_FLIGHT_CHANGE:.0%}超）")
    old_ap = {x for r in prev["routes"] if not r.get("planned") for x in (r["a"], r["b"])}
    if old_ap and (len(old_ap) - len(airports)) / len(old_ap) > MAX_AIRPORT_DROP:
        raise Abort(f"空港数が前回 {len(old_ap)} → 今回 {len(airports)} に減りました")


def write_summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    for line in lines:
        log(line)


def diff_lines(prev, routes):
    if not prev:
        return []
    def pairs(rs):
        return {f'{r["a"]}-{r["b"]}' for r in rs if not r.get("planned")}
    old, new = pairs(prev["routes"]), pairs(routes)
    out = []
    if new - old:
        out.append("新規路線: " + ", ".join(sorted(new - old)))
    if old - new:
        out.append("掲載が消えた路線: " + ", ".join(sorted(old - new)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-fa", action="store_true")
    ap.add_argument("--fa-limit", type=int, default=150)
    ap.add_argument("--fa-interval", type=float, default=1.2)
    ap.add_argument("--interval", type=float, default=1.0, help="駅探への取得間隔(秒)")
    ap.add_argument("--cache-dir", help="開発用: 保存済みの駅探HTMLを使う")
    args = ap.parse_args()

    today = today_jst()
    warnings = []
    prev = load_previous()
    state = json.loads(AIRCRAFT_PATH.read_text(encoding="utf-8")) if AIRCRAFT_PATH.exists() else {}

    try:
        flights = scrape_ekitan(args.cache_dir, args.interval, warnings)
    except (RuntimeError, urllib.error.URLError, TimeoutError) as e:
        write_summary([f"::error::駅探の取得に失敗しました: {e}"])
        return 1
    log(f"取得: {len(flights)}便")

    try:
        safety_checks(flights, prev)
    except Abort as e:
        write_summary([f"::error::安全弁が作動したため更新しません: {e}"])
        return 2

    official = {n: ac for n, ac in seats_aircraft(warnings).items() if n in flights}
    log(f"空席データの実機材: {len(official)}便")
    merged, resolved, src_stats, fa_stats = resolve_aircraft(
        flights, state, official, 0 if args.no_fa else args.fa_limit, args.fa_interval, today, warnings)

    routes = build_routes(flights, resolved, prev, today)

    schedule_changed = not prev or fingerprint(schedule_of(prev["routes"])) != fingerprint(schedule_of(routes))
    routes_changed = not prev or fingerprint(prev["routes"]) != fingerprint(routes)
    as_of = today if schedule_changed else dt.date.fromisoformat(prev["meta"]["asOf"])
    aircraft_as_of = today.isoformat() if routes_changed else prev["meta"]["aircraftAsOf"]
    airports = sorted({x for f in flights.values() for x in (f["o"], f["d"])})
    meta = {
        "asOf": as_of.isoformat(),
        "aircraftAsOf": aircraft_as_of,
        "season": season_of(as_of),
        "flights": len(flights),
        "routes": sum(1 for r in routes if not r.get("planned")),
        "airports": len(airports),
    }
    payload = {"meta": meta, "routes": routes}

    state_text = json.dumps(merged, ensure_ascii=False, sort_keys=True, indent=0) + "\n"
    old_state_text = AIRCRAFT_PATH.read_text(encoding="utf-8") if AIRCRAFT_PATH.exists() else ""
    uniq = list(dict.fromkeys(warnings))

    summary = [
        f"### JAL国内線 時刻表の確認 {today}",
        f"- {meta['flights']}便 / {meta['routes']}路線 / {meta['airports']}空港（{meta['season']['short']}）",
        f"- ダイヤの変更: {'あり' if schedule_changed else 'なし'} / 機材を含む便データの変更: {'あり' if routes_changed else 'なし'}",
        f"- 機材の根拠: {src_stats} / FlightAware 照会 {fa_stats[0]}件・機材あり {fa_stats[1]}件",
    ] + [f"- {x}" for x in diff_lines(prev, routes)]
    if uniq:
        summary.append(f"- 警告 {len(uniq)}件: " + " / ".join(uniq[:15]))
    write_summary(summary)

    if args.dry_run:
        log("（--dry-run のため書き込みません）")
        return 0
    if routes_changed or (prev and prev["meta"] != meta):
        js = JS_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace('{"a":', '\n{"a":') + ";\n"
        TIMETABLE_PATH.write_text(js, encoding="utf-8")
        log("data/domestic-timetable.js を更新しました")
    if state_text != old_state_text:
        AIRCRAFT_PATH.write_text(state_text, encoding="utf-8")
        log("data/domestic-aircraft.json を更新しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
