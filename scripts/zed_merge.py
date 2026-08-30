#!/usr/bin/env python3
"""再収録の翻訳結果(<workdir>/out/<CODE>.json)を data.json にマージする。

  python3 scripts/zed_merge.py --data <現行data.json> --workdir <fingerprint.pyのworkdir> \
      --date 2026-08-30 --out <新data.json>

<workdir> には fingerprint.py --workdir が書いた changed.json / jobs/ と、
Claudeによる和訳 out/<CODE>.json ({"sections":[{"title","text","summary"},...]}) が要る。
マージ内容: sections差し替え・fp/fpChars更新・updated(日付)付与・note除去。
検証で問題があれば data.json を書かずに終了コード1。
"""
import argparse, json, os, re, sys

JA_RE = re.compile(r'[ぁ-んァ-ヶ一-龯]')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--date", required=True, help="updated に入れる YYYY-MM-DD")
    ap.add_argument("--out", required=True, help="新しい data.json の書き出し先")
    args = ap.parse_args()

    data = json.load(open(args.data))
    changed = json.load(open(os.path.join(args.workdir, "changed.json")))
    problems, report = [], []

    for c in changed:
        code, src = c["code"], c["src"]
        p = os.path.join(args.workdir, "out", f"{code}.json")
        if not os.path.exists(p):
            problems.append(f"{code}: 翻訳出力なし ({p})")
            continue
        try:
            secs = json.load(open(p))["sections"]
        except Exception as e:
            problems.append(f"{code}: JSON不正 {e}")
            continue
        if not isinstance(secs, list) or not secs:
            problems.append(f"{code}: sectionsが空")
            continue
        for i, s in enumerate(secs):
            if not (isinstance(s.get("title"), str) and s["title"].strip()):
                problems.append(f"{code}: sec{i} titleなし")
            if not (isinstance(s.get("text"), str) and s["text"].strip()):
                problems.append(f"{code}: sec{i} textなし")
            if s.get("title") != "Index構成" and s.get("text") and not JA_RE.search(s["text"]):
                problems.append(f"{code}: sec{i}「{s.get('title', '')[:20]}」textが日本語でない")

        job = json.load(open(os.path.join(args.workdir, "jobs", f"{code}.json")))
        if re.search(r'embargo', job["new_original_text"], re.I):
            if not any('エンバーゴ' in (s.get("title") or "") for s in secs):
                report.append(f"  note {code}: 原文にembargo言及あり・エンバーゴ見出しなし(本文内かも)")
        orig_heads = re.findall(r'^## (.+)$', job["new_original_text"], re.M)
        core = [s for s in secs if s.get("title") != "Index構成" and "冒頭" not in (s.get("title") or "")]
        if orig_heads and len(core) != len(orig_heads):
            report.append(f"  WARN {code}: 原文見出し{len(orig_heads)}個 vs セクション{len(core)}個(構成保持か確認)")

        entry = next(x for x in data if x["src"] == src)
        old_n = len(entry.get("sections", []))
        entry["sections"] = secs
        entry["detailed"] = True
        entry["fp"] = c["new_hash"]
        entry["fpChars"] = c["new_chars"]
        entry["updated"] = args.date
        entry.pop("note", None)
        report.append(f"  ok  {code} {c['name']}: {old_n} -> {len(secs)} sections, fp={c['new_hash']}")

    print("\n".join(report))
    if problems:
        print("PROBLEMS(書き出し中止):")
        print("\n".join("  " + p for p in problems))
        sys.exit(1)

    json.dump(data, open(args.out, "w"), ensure_ascii=False, indent=1)
    n_upd = sum(1 for x in data if x.get("updated") == args.date)
    print(f"WROTE {args.out}: {len(data)}社 / 今回更新{n_upd}社 / {os.path.getsize(args.out)} bytes")


if __name__ == "__main__":
    main()
