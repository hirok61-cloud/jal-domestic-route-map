#!/bin/bash
# JAL空席コレクタの補助プログラム（キーチェーン読み出し）を Chrome に登録する。
# 何度実行してもよい（上書きするだけ）。パスワードには触らない。
set -euo pipefail

HOST_NAME="com.hirok61.jal_autologin"
EXT_ID="mlffhdcicmoieohlbgpiikbgdbmknnmj"   # extension/manifest.json の key から決まるID
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="$HOME/Library/Application Support/jal-autologin"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "python3 が見つかりません。" >&2
  exit 1
fi

mkdir -p "$DEST_DIR" "$CHROME_DIR"
# Chrome は最小限の PATH で起動するので、python3 の場所を先頭行に書き込んでおく
{ echo "#!$PY"; tail -n +2 "$SRC_DIR/host.py"; } > "$DEST_DIR/host.py"
chmod 755 "$DEST_DIR/host.py"

cat > "$CHROME_DIR/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "JAL空席コレクタ: キーチェーンからJALオンラインのログイン情報を読む",
  "path": "$DEST_DIR/host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON

echo "登録しました: $CHROME_DIR/$HOST_NAME.json"
echo "本体: $DEST_DIR/host.py（python3: $PY）"
if /usr/bin/security find-generic-password -s jal-online-autologin >/dev/null 2>&1; then
  echo "キーチェーンの項目: あり"
else
  echo "キーチェーンの項目: まだありません。次を実行して登録してください（パスワードは2回聞かれます）:"
  echo "  security add-generic-password -s jal-online-autologin -a <お得意様番号> -w"
fi
