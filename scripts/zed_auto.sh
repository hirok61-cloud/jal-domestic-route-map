#!/bin/bash
# ZED運賃条件の自動更新(定期タスク「ZED原文の自動更新」から呼ぶ)。
#
#   bash scripts/zed_auto.sh check     KVの現行data.jsonを取得→flyzed.info全社と照合→翻訳ジョブ生成
#   bash scripts/zed_auto.sh publish   out/ の和訳をマージ→KVへ反映→読み戻し検証→再照合
#   bash scripts/zed_auto.sh show <CODE>   新しい原文と旧訳を並べて表示(和訳の下見用)
#   bash scripts/zed_auto.sh notify "本文"   Mac通知を出すだけ
#
# 翻訳(jobs/<CODE>.json → out/<CODE>.json)だけはClaudeが行う。手順と翻訳ルールは docs/ZED_DATA.md。
# 作業dirは ~/.zed-auto/work(checkのたびに作り直す)。反映前のdata.jsonは ~/.zed-auto/backup/ に残す。
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$HOME/.zed-auto"
W="$BASE/work"
NS=f3957ad140ed4d39b59b0804c3971ea6
KEY="zed:data.json"
MAX_CHANGED=40   # これを超えたら正規化の破損かサイト改修を疑い、自動翻訳せず通知だけにする

notify() {
  osascript -e "display notification \"$1\" with title \"ZED運賃条件\"" >/dev/null 2>&1 || true
}

# wranglerは初回だけ401で落ちることがあるので3回まで再試行
kv_get() {
  for i in 1 2 3; do
    npx --yes wrangler@latest kv key get "$KEY" --namespace-id=$NS --remote --text >"$1" 2>"$BASE/kv.err" && [ -s "$1" ] && return 0
    sleep 3
  done
  return 1
}
kv_put() {
  for i in 1 2 3; do
    npx --yes wrangler@latest kv key put "$KEY" --path="$1" --namespace-id=$NS --remote >/dev/null 2>"$BASE/kv.err" && return 0
    sleep 3
  done
  return 1
}

cmd="${1:-}"
case "$cmd" in
check)
  mkdir -p "$BASE/backup"
  rm -rf "$W"; mkdir -p "$W"
  if ! kv_get "$W/cur.json"; then
    notify "KVからdata.jsonを取得できませんでした(wranglerの認証切れ?)"
    echo "ERROR: kv get failed"; cat "$BASE/kv.err"; exit 2
  fi
  if ! python3 -c "import json,sys;d=json.load(open(sys.argv[1]));assert isinstance(d,list) and len(d)>200" "$W/cur.json"; then
    notify "KVのdata.jsonが壊れています。自動更新を中止しました"
    echo "ERROR: cur.json invalid"; exit 2
  fi
  python3 "$REPO/scripts/fingerprint.py" --data "$W/cur.json" --workdir "$W/fp" >"$W/check.log" 2>&1
  rc=$?
  grep -E "same=|CHANGED|ERROR" "$W/check.log"
  [ $rc -ne 0 ] && { notify "原文チェックが失敗しました"; echo "ERROR: fingerprint.py rc=$rc"; exit 2; }
  mkdir -p "$W/fp"   # 変更0件だとfingerprint.pyはworkdirもchanged.jsonも作らない
  [ -f "$W/fp/changed.json" ] || echo "[]" >"$W/fp/changed.json"
  n=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$W/fp/changed.json")
  if [ "$n" -gt "$MAX_CHANGED" ]; then
    notify "原文の変更が${n}社もあります。正規化かサイト構成の変化を疑い、自動更新を止めました"
    echo "ABORT: changed=$n > $MAX_CHANGED"; exit 3
  fi
  mkdir -p "$W/fp/out"
  echo "CHANGED_COUNT=$n"
  echo "WORKDIR=$W/fp"
  ;;
publish)
  [ -f "$W/fp/changed.json" ] || { echo "ERROR: 先に check を実行"; exit 2; }
  n=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$W/fp/changed.json")
  [ "$n" -eq 0 ] && { echo "NOTHING: 変更なし"; exit 0; }
  today=$(date +%F)
  python3 "$REPO/scripts/zed_merge.py" --data "$W/cur.json" --workdir "$W/fp" --date "$today" --out "$W/new.json" || {
    notify "和訳の検証で問題があり、反映を中止しました"; exit 2; }
  # 反映前の版を保存(直近30件だけ残す)
  cp "$W/cur.json" "$BASE/backup/data-$(date +%Y%m%d-%H%M%S).json"
  ls -1t "$BASE"/backup/data-*.json 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null
  kv_put "$W/new.json" || { notify "KVへの書き込みに失敗しました"; cat "$BASE/kv.err"; exit 2; }
  # putは静かに失敗することがあるので必ず読み戻して比較
  kv_get "$W/rt.json" || { notify "書き込み後の読み戻しに失敗しました"; exit 2; }
  if ! python3 -c "import sys;a=open(sys.argv[1],'rb').read();b=open(sys.argv[2],'rb').read().rstrip(b'\n');sys.exit(0 if a==b else 1)" "$W/new.json" "$W/rt.json"; then
    notify "KVの中身が書き込んだ内容と一致しません。要確認"
    echo "ERROR: roundtrip mismatch"; exit 2
  fi
  echo "roundtrip OK"
  python3 "$REPO/scripts/fingerprint.py" --data "$W/rt.json" 2>&1 | grep -E "same=|CHANGED"
  codes=$(python3 -c "import json,sys;print('・'.join(c['code'] for c in json.load(open(sys.argv[1]))))" "$W/fp/changed.json")
  notify "${codes} を最新の原文に更新しました"
  echo "PUBLISHED: $codes ($today)"
  ;;
show)
  python3 - "$W/fp/jobs/${2:-}.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
print(f"### {j['code']} {j['name']}  {j['old_chars']} -> {j['new_chars']} chars")
print("=== NEW ORIGINAL ===")
print(j["new_original_text"])
print("=== OLD JA (old_entry.sections) ===")
for i, s in enumerate((j.get("old_entry") or {}).get("sections", [])):
    print(f"--[{i}] {s['title']}\n{s['text']}\n  (summary) {s.get('summary', '')}")
PY
  ;;
notify)
  notify "${2:-}"
  ;;
*)
  echo "usage: $0 check|publish|notify <msg>"; exit 1
  ;;
esac
