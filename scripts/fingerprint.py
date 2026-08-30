#!/usr/bin/env python3
"""ZED運賃条件の原文更新チェック(+再収録ジョブ生成)。

flyzed.info の全社ページを再取得し、data.json の fp(収録時ハッシュ)と照合する。

  python3 scripts/fingerprint.py --data international/zed/data.json
  python3 scripts/fingerprint.py --data ... --workdir /tmp/zed-update   # 再収録ジョブも生成

正規化(strip_html)は worker/index.js の stripHtml と**完全一致**させること。
ズレると全263社が「更新あり」になる。既知の罠:
  - <p class="go-to-top"> の除去漏れ
  - U+FEFF(BOM)。JSのfetchは自動で落とすがPythonは残る。画面上は不可視。
  - 空白の同一視は JS の \\s と同じ文字クラスで行う(U+00A0/U+3000等を含む)。

--workdir を与えると <workdir>/ に changed.json・raw/(原文HTML)・jobs/(翻訳ジョブ)を書く。
その後の流れ: jobs/ を Claude で和訳(見出し構成を保持・情報を落とさない)→ out/<CODE>.json
→ scripts/zed_merge.py でマージ → wrangler kv key put。詳細は docs/ZED_DATA.md。
"""
import argparse, hashlib, html, json, os, re, sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# JSの\sと同一の文字クラス(U+00A0/U+3000/U+FEFF等を含む)
JS_WS = "[\\f\\n\\r\\t\\v\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+"
BODY_RE = r'<div class="switchboard-info"[^>]*>([\s\S]*?)(?=<div class="switchboard-detail"|$)'


def strip_html(fragment: str) -> str:
    """worker/index.js の stripHtml と同一順序・同一置換。"""
    fragment = re.sub(r'<p class="go-to-top">[\s\S]*?</p>', ' ', fragment)
    fragment = re.sub(r'<[^>]+>', ' ', fragment)
    fragment = fragment.replace('&amp;', '&')
    fragment = fragment.replace('&nbsp;', ' ')
    fragment = fragment.replace('&quot;', '"')
    fragment = fragment.replace('&#39;', "'")
    fragment = fragment.replace('&lt;', '<')
    fragment = fragment.replace('&gt;', '>')
    fragment = fragment.replace('﻿', '')
    fragment = re.sub(JS_WS, ' ', fragment)
    return fragment.strip(' ')


def sha16(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]


def fetch(src: str):
    url = f"https://www.flyzed.info/{src}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (+jal-route-map ZED checker)"})
    last = None
    for _ in range(2):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                page = r.read().decode('utf-8', errors='replace')
            m = re.search(BODY_RE, page)
            body = strip_html(m.group(1)) if m else ""
            return {"src": src, "hash": sha16(body), "chars": len(body), "page": page}
        except Exception as e:
            last = e
    return {"src": src, "error": str(last)}


def html_to_text(frag: str) -> str:
    """翻訳ジョブ用: 原文HTMLを構造を保った読みやすいテキストに(## 見出し / **強調** / - リスト / | 表)。"""
    s = frag
    s = re.sub(r'<p class="go-to-top">[\s\S]*?</p>', '\n', s)
    s = re.sub(r'<!--[\s\S]*?-->', '', s)
    s = re.sub(r'<script[\s\S]*?</script>', '', s)

    def table_repl(m):
        rows = re.findall(r'<tr[^>]*>([\s\S]*?)</tr>', m.group(0))
        out = []
        for r in rows:
            cells = [re.sub(r'<[^>]+>', ' ', c).strip()
                     for c in re.findall(r'<t[dh][^>]*>([\s\S]*?)</t[dh]>', r)]
            out.append('| ' + ' | '.join(cells) + ' |')
        return '\n' + '\n'.join(out) + '\n'
    s = re.sub(r'<table[\s\S]*?</table>', table_repl, s)

    def a_repl(m):
        href, inner = html.unescape(m.group(1)), re.sub(r'<[^>]+>', '', m.group(2)).strip()
        if href.startswith('#') or not inner:
            return inner
        clean = inner.rstrip('/')
        if href.rstrip('/') in (clean, 'https://' + clean, 'http://' + clean, 'mailto:' + clean):
            return inner
        return f'{inner} ({href})'
    s = re.sub(r'<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>', a_repl, s)

    s = re.sub(r'<h3[^>]*>([\s\S]*?)</h3>', lambda m: '\n\n## ' + re.sub(r'<[^>]+>', ' ', m.group(1)).strip() + '\n', s)
    s = re.sub(r'<h4[^>]*>([\s\S]*?)</h4>', lambda m: '\n\n### ' + re.sub(r'<[^>]+>', ' ', m.group(1)).strip() + '\n', s)
    s = re.sub(r'<(strong|b)>([\s\S]*?)</\1>', lambda m: '**' + m.group(2).strip() + '**', s)
    s = re.sub(r'<li[^>]*>', '\n- ', s)
    s = re.sub(r'<blockquote[^>]*>', '\n> ', s)
    s = re.sub(r'</p>|</li>|</ul>|</ol>|</blockquote>|</div>|<br\s*/?>', '\n', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = s.replace('﻿', '')
    s = re.sub(r'[ \t ]+', ' ', s)
    s = re.sub(r' ?\n ?', '\n', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="international/zed/data.json")
    ap.add_argument("--workdir", help="変更社の raw/・jobs/・changed.json を書く作業ディレクトリ")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    data = json.load(open(args.data))
    results = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch, e["src"]): e for e in data}
        for i, f in enumerate(as_completed(futs), 1):
            results[futs[f]["src"]] = f.result()
            if i % 40 == 0:
                print(f"  ...{i}/{len(data)}", file=sys.stderr)

    changed, errors, same = [], [], 0
    for e in data:
        r = results[e["src"]]
        if "error" in r:
            errors.append((e["code"], e["name"], r["error"]))
        elif r["hash"] == e["fp"]:
            same += 1
        else:
            changed.append({"code": e["code"], "src": e["src"], "name": e["name"],
                            "old_fp": e["fp"], "new_hash": r["hash"],
                            "old_chars": e.get("fpChars"), "new_chars": r["chars"]})

    print(f"same={same} changed={len(changed)} errors={len(errors)} total={len(data)}")
    for c in changed:
        print(f"  CHANGED {c['code']:>3} ({c['src']}) {c['name']}: {c['old_chars']} -> {c['new_chars']} chars")
    for code, name, err in errors:
        print(f"  ERROR   {code:>3} {name}: {err}")

    if args.workdir and changed:
        raw_dir = os.path.join(args.workdir, "raw")
        jobs_dir = os.path.join(args.workdir, "jobs")
        os.makedirs(raw_dir, exist_ok=True)
        os.makedirs(jobs_dir, exist_ok=True)
        os.makedirs(os.path.join(args.workdir, "out"), exist_ok=True)
        json.dump(changed, open(os.path.join(args.workdir, "changed.json"), "w"),
                  ensure_ascii=False, indent=1)
        for c in changed:
            page = results[c["src"]]["page"]
            with open(os.path.join(raw_dir, f"{c['src'].replace('*', '_star')}.html"), "w") as fh:
                fh.write(page)
            m = re.search(BODY_RE, page)
            old = next(x for x in data if x["src"] == c["src"])
            job = {"code": c["code"], "src": c["src"], "name": c["name"],
                   "new_chars": c["new_chars"], "old_chars": c["old_chars"],
                   "old_entry": {k: old.get(k) for k in ("name", "code", "sections", "note") if k in old},
                   "new_original_text": html_to_text(m.group(1)) if m else ""}
            json.dump(job, open(os.path.join(jobs_dir, f"{c['code']}.json"), "w"),
                      ensure_ascii=False, indent=1)
        print(f"workdir: {args.workdir} に changed.json / raw / jobs を書きました")

    sys.exit(2 if changed else 0)


if __name__ == "__main__":
    main()
