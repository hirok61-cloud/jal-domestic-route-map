#!/usr/bin/env python3
"""JAL空席コレクタ（Chrome拡張）の補助プログラム。

拡張から Native Messaging で呼ばれ、次の2つだけを行う。

  {"cmd": "ping"}            → キーチェーンに項目があるか（パスワードは返さない）
  {"cmd": "get"}             → JALオンラインのお得意様番号とパスワードを返す
  {"cmd": "notify", ...}     → Macの通知センターに知らせを出す
  {"cmd": "keep-awake", "seconds": N} → 収集のあいだMacをスリープさせない
  {"cmd": "release-awake"}   → 上の保持を解く

パスワードはファイルにもログにも書かない。置き場所は macOS のキーチェーンだけで、
登録は利用者本人がターミナルで行う（docs/AUTO_LOGIN.md）:

    security add-generic-password -s jal-online-autologin -a <お得意様番号> -w

Chrome から起動されるときの PATH は最小限なので、外部コマンドは絶対パスで呼ぶ。
"""

import json
import os
import re
import signal
import struct
import subprocess
import sys

SERVICE = "jal-online-autologin"
SECURITY = "/usr/bin/security"
OSASCRIPT = "/usr/bin/osascript"
CAFFEINATE = "/usr/bin/caffeinate"
PS = "/bin/ps"
AWAKE_PIDFILE = os.path.expanduser("~/Library/Application Support/jal-autologin/caffeinate.pid")
AWAKE_MAX_SECONDS = 2 * 60 * 60


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    if length > 64 * 1024:
        return None
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def find_account():
    """項目の属性だけを読む（-w を付けないとパスワードは出力されない）。"""
    r = subprocess.run([SECURITY, "find-generic-password", "-s", SERVICE],
                       capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        return None
    m = re.search(r'"acct"<blob>="([^"]*)"', r.stdout)
    return m.group(1) if m else None


def get_password():
    r = subprocess.run([SECURITY, "find-generic-password", "-s", SERVICE, "-w"],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return None
    return r.stdout.rstrip("\n")


def notify(title, message):
    # AppleScript の文字列に埋め込むので、引用符とバックスラッシュを潰しておく
    clean = lambda s: str(s).replace("\\", "＼").replace('"', "”")[:200]
    script = f'display notification "{clean(message)}" with title "{clean(title)}" sound name "Basso"'
    subprocess.run([OSASCRIPT, "-e", script], capture_output=True, timeout=15)


def release_awake():
    try:
        with open(AWAKE_PIDFILE) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return
    # PIDは使い回されるので、本当に caffeinate のときだけ止める
    r = subprocess.run([PS, "-p", str(pid), "-o", "comm="],
                       capture_output=True, text=True, timeout=15)
    if r.stdout.strip().endswith("caffeinate"):
        os.kill(pid, signal.SIGTERM)
    try:
        os.unlink(AWAKE_PIDFILE)
    except OSError:
        pass


def keep_awake(seconds):
    """-s は「電源接続中はシステムを眠らせない」。

    -i（アイドルスリープ防止）では足りない。Macが一度眠ったあとのメンテナンス起床
    (DarkWake)中は -i 相当の保持があっても1分ほどで眠り直すのを実測した（2026-11-10）。
    この補助プログラムはすぐ終わるので別セッションで起動し、-t で必ず時間切れにする。
    """
    release_awake()
    seconds = max(30, min(int(seconds), AWAKE_MAX_SECONDS))
    p = subprocess.Popen([CAFFEINATE, "-s", "-t", str(seconds)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    with open(AWAKE_PIDFILE, "w") as f:
        f.write(str(p.pid))


def handle(msg):
    cmd = (msg or {}).get("cmd")
    if cmd == "ping":
        acct = find_account()
        return {"ok": True, "hasItem": acct is not None,
                "idTail": acct[-3:] if acct else None}
    if cmd == "get":
        acct = find_account()
        if not acct:
            return {"ok": False, "error": "キーチェーンに jal-online-autologin の項目がありません"}
        if not re.fullmatch(r"\d{7}|\d{9}", acct):
            return {"ok": False, "error": "キーチェーンのアカウント名がお得意様番号（数字7桁か9桁）になっていません"}
        pw = get_password()
        if not pw:
            return {"ok": False, "error": "キーチェーンからパスワードを読めませんでした"}
        return {"ok": True, "id": acct, "password": pw}
    if cmd == "notify":
        notify(msg.get("title", "JAL空席コレクタ"), msg.get("message", ""))
        return {"ok": True}
    if cmd == "keep-awake":
        keep_awake(msg.get("seconds", 0))
        return {"ok": True}
    if cmd == "release-awake":
        release_awake()
        return {"ok": True}
    return {"ok": False, "error": "unknown command"}


def main():
    try:
        msg = read_message()
        send_message(handle(msg))
    except Exception as e:  # 例外の中身にパスワードは含まれない（標準出力は使っていない）
        send_message({"ok": False, "error": type(e).__name__})


if __name__ == "__main__":
    main()
