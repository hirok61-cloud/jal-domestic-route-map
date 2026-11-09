/* JAL国内線 本日の空席 コレクタ — バックグラウンド
 *
 * 役割は「更新依頼を拾って、JALのタブを1枚だけ開いて収集させ、後片付けする」こと。
 * 実際の収集は collect.js（JALの空席照会ページに注入）が行う。
 *
 * 依頼の出どころは2つ:
 *   - サイトの「最新に更新」ボタン（同じPCなら site-bridge.js が即座に知らせてくる）
 *   - スマホなど別端末からの依頼（Supabaseのキューに積まれるので1分おきに見に行く）
 */

const ENDPOINT = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats";
const TOP_URL = "https://www.jal.co.jp/ja-jp/top";
const BOOKING_RE = /^https:\/\/booking\.jal\.co\.jp\/jl\/dom-bkg\/upsell/;
/* tools/collect-core.js の CORP_HUB と同じ値。background.js はモジュールでないため
   import できず、ここに複製している（ENDPOINT も同様に複製済み）。 */
const CORP_HUB = "JOH";
const ALARM = "poll";
const AUTO_ALARM = "auto";

/* 自動更新の時刻（ローカル時間）。Macが起きているときだけ動くので回数は絞る。
   朝・昼は今日分、夜は翌日分を取る（22時には今日の便がほぼ終わっているため）。 */
/* 制度枠(JOH)の自動枠はここには置かない。別の時刻表 CORP_SCHEDULE と
   自動ログイン（下の「自動ログイン」の節）で動かす（2026-11-07）。 */
const AUTO_SCHEDULE = [
  { hour: 7, minute: 0, days: [0] },
  { hour: 12, minute: 0, days: [0] },
  { hour: 22, minute: 0, days: [1] },
];
/* 寝起きの連続発火よけ。ただし枠どうしの間隔（いまは朝→昼が5時間）より
   短くしないと、正常運転でも次の枠が「直近に実行済み」扱いで毎回見送られる
   （2026-08-10、枠を2つから3つに増やしたときに気づいた）。 */
const AUTO_MIN_GAP_MS = 4 * 60 * 60 * 1000;

/* Akamaiはページを開いた直後のセッションを信用しない。
   トップページで少し待ってからでないと、空席APIが429(cpr_chlge)で弾かれる。 */
const MATURE_MS = 30000;
const NAV_TIMEOUT_MS = 60000;
/* 収集の打ち切り方。**所要時間で切ってはいけない**（2026-09-01に特定）。
   1日分の所要は便数しだいで伸びる。座席表を全便ぶん取れるようになった
   2026-08-28以降、丸1日ぶん（朝7時＝今日 / 夜22時＝翌日、380〜390便・
   座席表300〜345便）は 17〜20分かかるようになり、固定20分の上限に
   ちょうど当たるようになった。実データ: 8/25〜9/1の丸1日ぶん12回のうち
   5回が「収集が時間内に終わりませんでした」。しかも**保存は間に合っていて
   データは正しく更新されている**（9/1の朝は開始19分19秒で最終保存まで
   終わり、その1分半後に打ち切りが発火した）ため、原因が見えにくかった。

   代わりに「進捗が途絶えたら打ち切る」で見る。collect.js は最長60秒に1回は
   必ず進捗を送る（tools/collect-extension.js の due()）ので、無音が続くのは
   明確に異常。所要が伸びただけの生きている収集は殺さない。
   HARD は暴走よけの保険（進捗を出しながら永久に終わらない場合）。 */
const COLLECT_SILENCE_MS = 6 * 60 * 1000;
const COLLECT_HARD_MS_PER_DAY = 45 * 60 * 1000;

/* 収集中かどうかは storage に置く。Service Worker は数十秒で止められるので、
   メモリ上のフラグだと再起動後に「動いていない」と誤認して二重に走ってしまう。 */
async function beginRun() {
  const { runningSince = 0 } = await chrome.storage.local.get("runningSince");
  /* 上限を大きく超えていたら、前回が異常終了したとみなして引き継ぐ。
     ふつうは poll() の watchdog() が先に片付けるので、ここは最後の受け皿。 */
  if (runningSince && Date.now() - runningSince < 2 * COLLECT_HARD_MS_PER_DAY + 10 * 60 * 1000) {
    return false;
  }
  await chrome.storage.local.set({ runningSince: Date.now() });
  return true;
}
const endRun = () => chrome.storage.local.remove("runningSince").catch(() => {});

/* 収集から最後に進捗が届いた時刻。runJob（同じService Worker内）は変数を見て、
   watchdog（別の起動でも動く）は storage を見る。両方に書いておく。 */
let lastProgressAt = 0;
function markProgress() {
  lastProgressAt = Date.now();
  chrome.storage.local.set({ lastProgressAt }).catch(() => {});
}

/* ------------------------------------------------------------------ 小道具 */

/* Service Worker は「chrome.*のAPI呼び出しが何も無い素の待ち」が続くと、
   Chromeの判断で無言のまま終了させられることがある（2026-08-10、朝7時の
   自動更新がこの30秒待ちの最中に落ちて、進捗もエラーも記録されず消えた実績あり）。
   長く待つときは軽いAPI呼び出しを挟んで、Service Workerを起こしたままにする。 */
async function sleep(ms) {
  const STEP_MS = 15000;
  let remaining = ms;
  while (remaining > 0) {
    await new Promise((r) => setTimeout(r, Math.min(STEP_MS, remaining)));
    remaining -= STEP_MS;
    if (remaining > 0) await chrome.storage.local.get("runningSince").catch(() => {});
  }
}

async function getKey() {
  const { updateKey } = await chrome.storage.local.get("updateKey");
  return updateKey || "";
}

async function log(line) {
  const { runLog = [] } = await chrome.storage.local.get("runLog");
  runLog.unshift(`${new Date().toLocaleString("ja-JP")}  ${line}`);
  await chrome.storage.local.set({ runLog: runLog.slice(0, 40) });
}

async function api(path, init = {}) {
  const key = await getKey();
  return fetch(ENDPOINT + path, {
    ...init,
    headers: { "content-type": "application/json", "x-update-key": key, ...(init.headers ?? {}) },
  });
}

function setBadge(text, color = "#b7001e") {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}

/** URLを理由の文に入れるときの形（クエリは落とす。番号などが入りうるため）。 */
const shortUrl = (u) => {
  try { const x = new URL(u); return x.host + x.pathname; } catch { return String(u || "不明").slice(0, 80); }
};

/** タブが指定URLになるまで待つ。
 *  【2026-11-08 0:05 の失敗】以前は setTimeout とイベント待ちだけだったため、
 *  画面が予想外のURLで止まると chrome.* の呼び出しが30秒以上途絶え、
 *  Service Worker ごと止められて時間切れの処理も走らず、何も報告されずに消えた。
 *  2秒ごとに tabs.get で様子を見ることで、起こしたままにしつつ取りこぼしも拾う。 */
function waitForUrl(tabId, re, timeoutMs) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + timeoutMs;
    let lastUrl = "";
    let finished = false;
    const finish = (fn) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      fn();
    };
    const check = () => chrome.tabs.get(tabId).then((tab) => {
      lastUrl = tab.url || tab.pendingUrl || lastUrl;
      if (tab.url && re.test(tab.url) && tab.status === "complete") finish(() => resolve(tab));
      else if (Date.now() > until) {
        finish(() => reject(new Error(`ページの遷移が終わりませんでした（止まった画面: ${shortUrl(lastUrl)}）`)));
      }
    }).catch(() => finish(() => reject(new Error("ページを開いたウィンドウが閉じられました"))));
    const timer = setInterval(check, 2000);
    function onUpdated(id, info, tab) {
      if (id === tabId && tab.url && re.test(tab.url) && info.status === "complete") finish(() => resolve(tab));
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    check(); // すでに条件を満たしていることもある
  });
}

/* -------------------------------------------------------------- 収集の本体 */

/* JALオンライン（法人）にログイン済みのタブを、いま開いているものの中から探す。
   自動ログインはまだ無いので、新しいウィンドウを開いても未ログインの状態にしか
   ならず、法人フラグ付きのリクエストは通らない
   （2026-08-15、「JALに接続を断られています（Required Input not available）」で
   実機・実データから確認した）。
   見つかったタブへ collect.js を注入して使う。新規ウィンドウは開かない。

   **corpData が有るかどうかで見分けてはいけない**（2026-08-16 実測）。
   公式の検索フローでも corpData は作られ、中身は {"lastName":"","firstName":""}。
   これを法人と誤認すると、公式のタブに法人モードの収集を流し込んでしまう。
   確かな順に選ぶ: ①JOHNのページ（/jl/dom-corp/）を開いているタブ →
   ②corpData の中身が埋まっているタブ。 */
async function findCorpTab() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: "https://booking.jal.co.jp/*" });
  } catch {
    return null;
  }
  let fallback = null;
  for (const tab of tabs) {
    if (tab.status !== "complete" || tab.id == null) continue;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const creds = JSON.parse(sessionStorage.getItem("apiAuthCreds") || "{}");
          if (typeof creds.authToken !== "string" || creds.authToken.length <= 10) return 0;
          if (/\/jl\/dom-corp\//.test(location.pathname)) return 2; // JOHNのページそのもの
          try {
            const d = JSON.parse(sessionStorage.getItem("corpData") || "null");
            if (d && typeof d === "object"
              && Object.values(d).some((v) => typeof v === "string" && v.trim() !== "")) return 1;
          } catch { /* 壊れていれば法人ではないとみなす */ }
          return 0;
        },
      });
      if (result === 2) return tab.id;                  // これ以上確かなものは無い
      if (result === 1 && fallback == null) fallback = tab.id;
    } catch { /* このタブは読めなかった（拡張ページ等）。次を試す */ }
  }
  return fallback;
}

/* ------------------------------------------------- 自動ログイン（制度枠） */

/* 2026-11-07 追加。JALオンラインは無操作だと約1時間でログインが切れるので、
   「ログインしっぱなしのタブ」に頼らず、記録のたびにログイン → 記録 → ログアウトする。

   パスワードは拡張に持たせない。macOS のキーチェーンに置き、補助プログラム
   （native-host/host.py、Native Messaging）から記録の直前にだけ受け取る。

   **ロック対策（JALはパスワードを一定回数まちがえるとWebサイト全体をロックする）**
   - 1回の記録でログインを試すのは1回だけ。再試行しない
   - パスワードを送ったあとの失敗は、理由を問わずブレーカーを落とす。
     落ちたら設定画面で手で解除するまで二度と試さない
     （保存したパスワードが古くなったとき、毎回1回ずつ失敗を積み上げてロックするのを防ぐ）
   - パスワードを送る前の失敗（画面が開かない・形が違う等）はブレーカーを落とさない
   - 1日に試す回数にも上限を置く（サイトの依頼ボタンは誰でも押せるため） */
const NATIVE_HOST = "com.hirok61.jal_autologin";
const CORP_LOGIN_URL =
  "https://booking.jal.co.jp/jl/corp-john/login/member-login-user-before-process?lang=ja";
const CORP_ID = "G0000001"; // ＬＴ００＿ＪＡＬＩ（G0000002 のＬＴＺＬではない）
const CORP_ALARM = "corpauto";
/* 制度枠の記録時刻（2026-11-07 本人指定）。0時の一斉解放のあと／朝／昼前。
   空席(HND)の 7:00・12:00 と重ならないよう少しずらしてある。 */
const CORP_SCHEDULE = [
  { hour: 0, minute: 5 },
  { hour: 6, minute: 0 },
  { hour: 11, minute: 30 },
];
/* Macが寝ていて予定より大きく遅れて発火した回は捨てる（遅れた回が
   次の回とくっつくのを防ぐ）。 */
const CORP_LATE_LIMIT_MS = 60 * 60 * 1000;
const AUTO_LOGIN_DAILY_MAX = 8;
const AUTO_LOGIN_LIMIT_MS = 5 * 60 * 1000;

function native(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: `補助プログラムを呼べません（${chrome.runtime.lastError.message}）` });
        } else {
          resolve(res || { ok: false, error: "補助プログラムから応答がありません" });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: `補助プログラムを呼べません（${e?.message || e}）` });
    }
  });
}

const notifyMac = (message) =>
  native({ cmd: "notify", title: "JAL空席コレクタ", message }).catch(() => {});

/* 収集のあいだMacを眠らせない（2026-11-10 追加）。無人のMacでは定時の発火が
   短いメンテナンス起床(DarkWake)に当たるだけなので、1分ほどで眠り直して収集が凍り、
   「連絡が途絶えました」で失敗していた。時間切れつきなので、解き忘れても残らない。 */
async function holdAwake(seconds) {
  const res = await native({ cmd: "keep-awake", seconds });
  if (!res?.ok) await log(`スリープ防止を開始できません（${res?.error || "不明"}）`);
}
const releaseAwake = () => native({ cmd: "release-awake" });

/* 定時の発火直後に呼ぶ。起床の残り時間が短いので、依頼を積む前に確保する。
   別の収集が動いているときは、その長い保持を短いもので上書きしない。 */
const AWAKE_START_SECONDS = 5 * 60;
async function holdAwakeForStart() {
  const { runningSince = 0 } = await chrome.storage.local.get("runningSince");
  if (!runningSince) await holdAwake(AWAKE_START_SECONDS);
}

const localDate = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD（ローカル）

async function loginState() {
  const s = await chrome.storage.local.get(["autoLogin", "autoLoginTrip", "autoLoginCount"]);
  const count = s.autoLoginCount?.date === localDate() ? s.autoLoginCount.n : 0;
  return { enabled: !!s.autoLogin, trip: s.autoLoginTrip || null, count };
}

async function tripBreaker(reason) {
  await chrome.storage.local.set({ autoLoginTrip: { at: Date.now(), reason } });
  await log(`自動ログインを停止しました: ${reason}`);
  await notifyMac(`自動ログインを停止しました。設定画面で確認してください（${reason}）`);
}

/* ページに注入する関数（シリアライズされて送られるので外の変数は使えない）。
   入力欄はReact等で作られている前提で、ネイティブのsetter＋inputイベントで入れる。 */
function fillAndSubmit(id, pw) {
  const idEl = document.querySelector("#LB_input-jmbnumber-1")
    || document.querySelector('input[autocomplete="username"]');
  const pwEl = document.querySelector("#LB_input-password")
    || document.querySelector('input[type="password"]');
  if (!idEl || !pwEl) return "入力欄が見つかりません";
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  for (const [el, v] of [[idEl, id], [pwEl, pw]]) {
    el.focus();
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }
  if (idEl.value !== id || pwEl.value.length !== pw.length) return "入力欄に値が入りません";
  /* パスワード欄にいちばん近い「ログイン」ボタンを押す。
     同じ画面にパスキー用の「ログイン」ボタンもあるので、近い順に探す。 */
  let box = pwEl.parentElement;
  let btn = null;
  while (box && !btn) {
    btn = [...box.querySelectorAll("button, input[type=submit]")].find((b) =>
      (b.innerText || b.value || "").trim() === "ログイン" && b.offsetParent !== null && !b.disabled);
    box = box.parentElement;
  }
  if (!btn) return "ログインボタンが見つかりません";
  btn.click();
  return "sent";
}

/** 送信後の行き先を見て、成功か失敗かを決める。 */
async function waitLoginResult(tabId) {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    await sleep(1500);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, reason: "ログイン中にウィンドウが閉じられました" };
    const url = tab.url || "";
    if (/^https:\/\/booking\.jal\.co\.jp\/jl\/(corp-john\/login\/login-company-list|dom-corp\/)/.test(url)) {
      return { ok: true };
    }
    if (/jallogin\.jal\.co\.jp/.test(url) && tab.status === "complete") {
      const [{ result: text } = {}] = await chrome.scripting.executeScript({
        target: { tabId }, func: () => document.body?.innerText || "",
      }).catch(() => [{}]);
      if (/ワンタイムパスワードを入力|認証コード|確認コード/.test(text || "")) {
        return { ok: false, reason: "ワンタイムパスワードを求められました" };
      }
    }
  }
  // 時間切れ。画面に出ている注意書きを拾って理由にする（入力欄の値は innerText に出ない）
  const [{ result: msg } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = [...document.querySelectorAll('[class*="error" i], [role="alert"], .alert')]
        .find((e) => e.offsetParent !== null && e.innerText.trim());
      return (el?.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
    },
  }).catch(() => [{}]);
  return { ok: false, reason: msg ? `ログインできませんでした（画面の表示: ${msg}）` : "ログイン後の画面に進みませんでした" };
}

/** ログインして企業ＬＴ００を選び、JALオンラインのトップでトークンが入るまで進める。
 *  成功したら { win, tabId } を返す。失敗は Error を投げる（ウィンドウは閉じる）。 */
async function autoLogin({ visible = false } = {}) {
  const st = await loginState();
  if (st.trip) throw new Error(`自動ログインは停止中です（${st.trip.reason}）。拡張の設定画面で解除してください`);
  if (st.count >= AUTO_LOGIN_DAILY_MAX) {
    throw new Error(`自動ログインは1日${AUTO_LOGIN_DAILY_MAX}回までです。今日はもう試しません`);
  }
  const ping = await native({ cmd: "ping" });
  if (!ping.ok) throw new Error(ping.error);
  if (!ping.hasItem) throw new Error("キーチェーンにJALオンラインのログイン情報がありません");

  const win = await chrome.windows.create({
    url: CORP_LOGIN_URL, focused: visible, width: 1000, height: 760,
  });
  const tabId = win.tabs[0].id;
  // 途中で Service Worker が止められても、次の起動の watchdog が閉じられるよう覚えておく
  await chrome.storage.local.set({ autoWinId: win.id });
  let passedLogin = false;
  try {
    const first = await waitForUrl(tabId,
      /^https:\/\/(jallogin\.jal\.co\.jp\/|booking\.jal\.co\.jp\/jl\/(corp-john\/login\/login-company-list|dom-corp\/))/,
      NAV_TIMEOUT_MS);
    await log(`自動ログイン: 最初の画面 ${shortUrl(first.url)}`);

    if (/jallogin\.jal\.co\.jp/.test(first.url)) {
      await sleep(4000); // 画面の組み立て待ち
      const [{ result: ready } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!document.querySelector('input[type="password"]'),
      });
      if (!ready) throw new Error("ログイン画面の形が変わっています（パスワード欄が見つかりません）");

      const cred = await native({ cmd: "get" });
      if (!cred.ok) throw new Error(cred.error);
      await chrome.storage.local.set({ autoLoginCount: { date: localDate(), n: st.count + 1 } });
      await log("自動ログイン: ログイン画面に入力して送信します");
      const [{ result: sent } = {}] = await chrome.scripting.executeScript({
        target: { tabId }, func: fillAndSubmit, args: [cred.id, cred.password],
      });
      cred.password = null;
      // 送れていなければパスワードはJALに届いていない＝ロックの心配はないのでブレーカーは落とさない
      if (sent !== "sent") throw new Error(`ログイン画面に入力できませんでした（${sent || "不明"}）`);

      // ここから先の失敗は、パスワードを送ったあと → 理由を問わずブレーカーを落とす
      const res = await waitLoginResult(tabId);
      if (!res.ok) {
        await tripBreaker(res.reason);
        throw new Error(`自動ログインに失敗しました: ${res.reason}`);
      }
    }
    passedLogin = true;

    // 企業の選択（ログイン後に企業一覧が出たとき）
    const now = await chrome.tabs.get(tabId);
    if (/login-company-list/.test(now.url || "")) {
      await waitForUrl(tabId, /login-company-list/, NAV_TIMEOUT_MS);
      await sleep(1500);
      const [{ result: picked } = {}] = await chrome.scripting.executeScript({
        target: { tabId }, args: [CORP_ID],
        func: (corpId) => {
          const sel = document.querySelector('select[name="corpId"]');
          if (!sel) return "企業の選択欄が見つかりません";
          if (![...sel.options].some((o) => o.value === corpId)) return `企業 ${corpId} が一覧にありません`;
          sel.value = corpId;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          const b = document.querySelector('button[name="nextbutton"]');
          if (!b) return "企業選択の「次へ」ボタンが見つかりません";
          b.click();
          return "ok";
        },
      });
      if (picked !== "ok") throw new Error(picked || "企業を選べませんでした");
    }

    await waitForUrl(tabId, /^https:\/\/booking\.jal\.co\.jp\/jl\/dom-corp\//, NAV_TIMEOUT_MS);
    // トークンが入るのを待つ（ふつうは数百ms）
    for (let i = 0; i < 20; i++) {
      const [{ result: has } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try {
            const c = JSON.parse(sessionStorage.getItem("apiAuthCreds") || "{}");
            return typeof c.authToken === "string" && c.authToken.length > 10;
          } catch { return false; }
        },
      }).catch(() => [{}]);
      if (has) {
        await log("自動ログイン: ＬＴ００でログインしました");
        return { win, tabId };
      }
      await sleep(1000);
    }
    throw new Error("ログインはできましたが、JALオンラインの準備が終わりませんでした");
  } catch (e) {
    // 試験（見ている前で実行）のときは、何が起きたか見えるようウィンドウを残す
    if (!visible) {
      if (passedLogin) await autoLogout(tabId);
      chrome.windows.remove(win.id).catch(() => {});
      chrome.storage.local.remove("autoWinId").catch(() => {});
    }
    throw e;
  }
}

/** 自分でログインした回は、終わったらログアウトしてから閉じる。
 *  ボタンが見つからなければ閉じるだけ（無操作で約1時間後に切れる）。 */
async function autoLogout(tabId) {
  const click = (labels) => chrome.scripting.executeScript({
    target: { tabId }, args: [labels],
    func: (labels) => {
      const el = [...document.querySelectorAll("a, button")].find((e) =>
        e.offsetParent !== null && labels.includes((e.innerText || "").trim()));
      if (!el) return false;
      el.click();
      return true;
    },
  }).then(([{ result } = {}]) => !!result).catch(() => false);

  if (!(await click(["ログアウト"]))) {
    await log("自動ログイン: ログアウトのボタンが見つからないため、ウィンドウを閉じるだけにしました");
    return false;
  }
  await sleep(2500);
  await click(["はい", "OK", "ログアウトする"]); // 確認が出る場合
  await sleep(2500);
  await log("自動ログイン: ログアウトしました");
  return true;
}

async function runJob(job) {
  if (!(await beginRun())) return;
  setBadge("…");
  const corporate = job?.hub === CORP_HUB;
  const days = Array.isArray(job?.days) && job.days.length ? job.days.length : 2;
  await holdAwake((COLLECT_HARD_MS_PER_DAY * days + AUTO_LOGIN_LIMIT_MS) / 1000);

  let win = null;
  let tabId = null;
  let stopWait = () => {};
  let loggedInByUs = false;
  let triedAutoLogin = false;
  let visibleTest = false;
  /* 収集が始まるまで（ログイン・画面の準備）にも長い待ちがある。待ちの種類によらず
     Service Worker を起こしたままにするため、実行中はずっと10秒ごとに軽く呼ぶ。 */
  const keepAlive = setInterval(() => chrome.storage.local.get("runningSince").catch(() => {}), 10000);
  try {
    // watchdog が依頼番号を知れるよう、最初に置く（以前はログイン後だったので、
    // ログイン中に止まると依頼が宙に浮き、サーバー側の10分切れまで誰も片付けなかった）
    await chrome.storage.local.set({ job });
    await log(`開始（依頼#${job?.id ?? "-"}）`);

    if (corporate) {
      tabId = await findCorpTab();
      if (tabId != null) {
        await api(`?action=progress&id=${job.id}`, {
          method: "POST",
          body: JSON.stringify({ message: "見つかったJALオンラインのタブで収集します" }),
        }).catch(() => {});
      } else {
        const st = await loginState();
        // 設定画面の「いま1回だけ試す」から10分以内なら、定時記録を有効にしていなくても試す
        const { autoLoginVisible = 0 } = await chrome.storage.local.get("autoLoginVisible");
        const testing = Date.now() - autoLoginVisible < 10 * 60 * 1000;
        if (!st.enabled && !testing) {
          throw new Error(
            "JALオンラインにログインしたタブが見つかりません。"
            + "サイトの「JALオンライン ↗」からログインし、企業（ＬＴ００）を選んだ状態で、"
            + "もう一度実行してください。",
          );
        }
        await api(`?action=progress&id=${job.id}`, {
          method: "POST",
          body: JSON.stringify({ message: "JALオンラインに自動でログインしています" }),
        }).catch(() => {});
        await chrome.storage.local.remove("autoLoginVisible");
        triedAutoLogin = true;
        visibleTest = testing;
        // ふつうは1分前後。どこかで想定外に止まっても、必ず理由つきで失敗として返す
        let limit;
        const r = await Promise.race([
          autoLogin({ visible: testing }), // 試験のときはウィンドウを前面に出す
          new Promise((_, rej) => { limit = setTimeout(() => rej(new Error("自動ログインが5分以内に終わりませんでした")), AUTO_LOGIN_LIMIT_MS); }),
        ]).finally(() => clearTimeout(limit));
        win = r.win;
        tabId = r.tabId;
        loggedInByUs = true;
      }
    } else {
      // 別ウィンドウで開く。前面は奪わないが、最小化はしない
      // （完全に隠れたタブはタイマーが絞られて収集が終わらないため）
      win = await chrome.windows.create({ url: TOP_URL, focused: false, width: 900, height: 700 });
      tabId = win.tabs[0].id;

      await waitForUrl(tabId, /^https:\/\/www\.jal\.co\.jp\//, NAV_TIMEOUT_MS);
      await api(`?action=progress&id=${job.id}`, {
        method: "POST",
        body: JSON.stringify({ message: "JALのページを準備しています" }),
      }).catch(() => {});

      // セッションが認められるまで待つ
      await sleep(MATURE_MS);

      // 空席照会ページへ送り込む（人手での検索は不要）
      await chrome.scripting.executeScript({ target: { tabId }, files: ["prepare.js"] });
      await waitForUrl(tabId, BOOKING_RE, NAV_TIMEOUT_MS);
      await sleep(6000);
    }

    // 収集させる。結果の送信は collect.js が自分で行う。
    // 注入したスクリプトは storage.session を読めない（TRUSTED_CONTEXTS 限定）ので
    // 受け渡しは storage.local を使う。
    await chrome.storage.local.set({ job });
    markProgress(); // 注入の直前を起点にする（前回の残りを引きずらない）

    /* 見張りとキープアライブを兼ねた1本のタイマー。
       【2026-08-15に特定した重大バグの名残】ここは最大で数十分かかる待ちなのに、
       chrome.*のAPI呼び出しを一切挟んでいなかった時期があり、Service Worker ごと
       落ちて進捗もエラーも残らずに消えていた（直近48時間の12回中11回）。
       15秒ごとの storage 参照でService Workerを起こしたままにする。 */
    const startedAt = Date.now();
    const hardMs = COLLECT_HARD_MS_PER_DAY * days;
    let lastTick = Date.now();
    let macSlept = false; // 15秒おきのタイマーに1分以上の穴があけばMacが眠っていた
    const done = new Promise((resolve, reject) => {
      stopWait = () => stop();
      const timer = setInterval(() => {
        chrome.storage.local.get("runningSince").catch(() => {}); // keep-alive
        if (Date.now() - lastTick > 60000) macSlept = true;
        lastTick = Date.now();
        const silent = Date.now() - lastProgressAt;
        if (silent > COLLECT_SILENCE_MS) {
          stop();
          reject(new Error(`収集からの連絡が${Math.round(silent / 60000)}分途絶えました${macSlept ? "（途中でMacがスリープしました）" : ""}`));
        } else if (Date.now() - startedAt > hardMs) {
          stop();
          reject(new Error("収集が時間内に終わりませんでした"));
        }
      }, 15000);
      function stop() {
        clearInterval(timer);
        chrome.runtime.onMessage.removeListener(onMsg);
      }
      function onMsg(msg) {
        if (msg?.type !== "collect-finished") return;
        stop();
        msg.ok ? resolve(msg) : reject(new Error(msg.error || "収集に失敗しました"));
      }
      chrome.runtime.onMessage.addListener(onMsg);
    });
    /* 注入に失敗しても done が宙に浮かないよう、無視用のcatchを先に付けておく
       （15秒ごとのタイマーが誰にも止められず走り続けるのを防ぐ。止めるのは finally）。 */
    done.catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ["collect.js"] });

    const result = await done;
    await log(`完了: ${result.summary}`);
    setBadge("");
  } catch (err) {
    const message = String(err?.message || err);
    await log(`失敗: ${message}`);
    setBadge("!", "#8c0017");
    // 自動ログインで記録しようとした回は、夜中でも気づけるようMacに知らせる
    if (corporate && triedAutoLogin) await notifyMac(`制度枠の記録に失敗しました（${message}）`);
    if (job?.id) {
      await api(`?action=finish&id=${job.id}`, {
        method: "POST",
        body: JSON.stringify({ ok: false, message }),
      }).catch(() => {});
    }
  } finally {
    clearInterval(keepAlive);
    stopWait();
    if (loggedInByUs && tabId != null) await autoLogout(tabId).catch(() => {});
    if (win?.id != null) chrome.windows.remove(win.id).catch(() => {});
    // 時間切れで autoLogin を置き去りにした場合も、開いたウィンドウは閉じる
    const { autoWinId } = await chrome.storage.local.get("autoWinId");
    if (autoWinId != null && autoWinId !== win?.id && !visibleTest) {
      chrome.windows.remove(autoWinId).catch(() => {});
    }
    await chrome.storage.local.remove(["job", "autoWinId"]).catch(() => {});
    await releaseAwake();
    await endRun();
  }
}

/* ---------------------------------------------------------- 自動更新 */

/** 次に来る自動更新の時刻を求める。 */
function nextAutoAt(now = new Date()) {
  let best = null;
  for (const slot of AUTO_SCHEDULE) {
    for (const addDay of [0, 1]) {
      const t = new Date(now);
      t.setDate(t.getDate() + addDay);
      t.setHours(slot.hour, slot.minute, 0, 0);
      if (t > now && (!best || t < best.at)) best = { at: t, slot };
    }
  }
  return best;
}

async function scheduleAuto() {
  const { autoUpdate } = await chrome.storage.local.get("autoUpdate");
  if (!autoUpdate) return chrome.alarms.clear(AUTO_ALARM);
  const next = nextAutoAt();
  chrome.alarms.create(AUTO_ALARM, { when: next.at.getTime() });
}

/** 自動更新の時刻になったので、自分で依頼を積んで拾いに行く。 */
async function runAuto() {
  const store = await chrome.storage.local.get(["autoUpdate", "lastAutoBy"]);
  await scheduleAuto(); // まず次回を仕掛け直す
  if (!store.autoUpdate) return;
  if (!(await getKey())) return;

  // いま時刻に近いほうの枠を採用する（寝坊した場合も、その枠の対象日で取る）
  const hour = new Date().getHours() + new Date().getMinutes() / 60;
  const slot = AUTO_SCHEDULE.reduce((a, b) =>
    Math.abs(a.hour - hour) <= Math.abs(b.hour - hour) ? a : b);
  const hub = slot.hub || "HND";

  /* Macが寝ていると予定時刻を過ぎてから発火する。起きた直後に朝と夜の分が
     続けて走らないよう、直近に自動更新していたら見送る。
     **ハブごとに覚えること。** 1つの値で見ていると、22時（空席）の直後に来る
     0時5分（制度枠）が毎回「直近に実行済み」で見送られてしまう（2026-08-15）。 */
  const lastBy = store.lastAutoBy || {};
  if (lastBy[hub] && Date.now() - lastBy[hub] < AUTO_MIN_GAP_MS) {
    await log(`自動更新: ${hub} は直近に実行済みのため見送り`);
    return;
  }

  try {
    await holdAwakeForStart();
    const res = await api(`?action=request&hub=${hub}`, {
      method: "POST",
      body: JSON.stringify({ from: "自動更新", days: slot.days }),
    });
    if (!res.ok) return;
    await chrome.storage.local.set({ lastAutoBy: { ...lastBy, [hub]: Date.now() } });
    await log(`自動更新を開始（${hub === CORP_HUB ? "制度枠・今日分"
      : slot.days[0] === 0 ? "今日分" : "明日分"}）`);
    await poll();
  } catch { /* オフライン等。次の枠で拾い直す */ }
}

/* ------------------------------------------------- 制度枠の定時記録 */

function nextCorpAt(now = new Date()) {
  let best = null;
  for (const slot of CORP_SCHEDULE) {
    for (const addDay of [0, 1]) {
      const t = new Date(now);
      t.setDate(t.getDate() + addDay);
      t.setHours(slot.hour, slot.minute, 0, 0);
      if (t > now && (!best || t < best)) best = t;
    }
  }
  return best;
}

async function scheduleCorpAuto() {
  const { autoLogin } = await chrome.storage.local.get("autoLogin");
  if (!autoLogin) return chrome.alarms.clear(CORP_ALARM);
  chrome.alarms.create(CORP_ALARM, { when: nextCorpAt().getTime() });
}

async function runCorpAuto(alarm) {
  await scheduleCorpAuto(); // まず次回を仕掛け直す
  const st = await loginState();
  if (!st.enabled || !(await getKey())) return;
  const late = Date.now() - (alarm?.scheduledTime || Date.now());
  if (late > CORP_LATE_LIMIT_MS) {
    await log(`制度枠の定時記録: 予定より${Math.round(late / 60000)}分遅れたため見送り（Macが寝ていた等）`);
    return;
  }
  if (st.trip) {
    await log(`制度枠の定時記録: 自動ログインが停止中のため見送り（${st.trip.reason}）`);
    return;
  }
  try {
    await holdAwakeForStart();
    const res = await api(`?action=request&hub=${CORP_HUB}`, {
      method: "POST",
      body: JSON.stringify({ from: "自動（制度枠）", days: [0] }),
    });
    if (!res.ok) return;
    await log("制度枠の定時記録を開始");
    await poll();
  } catch { /* オフライン等。次の枠で */ }
}

/* ------------------------------------------------------------ 依頼を拾う */

/* sleep() を keep-alive にしても、Service Worker が本当に落ちることはありうる
   （Chrome自体の再起動・強制終了など）。落ちると runningSince が残ったまま
   誰も片付けないので、そのジョブの想定所要時間を大きく超えていたら「無応答」と
   みなして自分で片付け、次の周期ですぐ拾い直す。50分固定だった旧実装だと、
   1日分（20分程度）のジョブが落ちても最大50分も次を拾えなかった。 */
async function watchdog() {
  const store = await chrome.storage.local.get(["runningSince", "job", "lastProgressAt"]);
  const { runningSince = 0, job = null } = store;
  if (!runningSince) return false;
  const days = Array.isArray(job?.days) && job.days.length ? job.days.length : 2;
  /* こちらも所要時間ではなく無音で見る（runJob と同じ理由）。ただし runJob 自身の
     見張りが先に決着をつけるべきなので、少し長めに待つ。準備中（ウィンドウを開いて
     30秒待つ間など）はまだ進捗が出ないので、起点は runningSince との遅いほう。 */
  const quiet = Date.now() - Math.max(runningSince, store.lastProgressAt || 0);
  const overall = Date.now() - runningSince;
  if (quiet < COLLECT_SILENCE_MS + 3 * 60 * 1000
    && overall < COLLECT_HARD_MS_PER_DAY * days + 5 * 60 * 1000) return true;

  await log(`自動復旧: 前回の収集が無応答のため中断扱いにしました（依頼#${job?.id ?? "-"}）`);
  const { autoWinId } = await chrome.storage.local.get("autoWinId");
  if (autoWinId != null) chrome.windows.remove(autoWinId).catch(() => {});
  if (job?.hub === CORP_HUB) await notifyMac("制度枠の記録が途中で止まったため中断しました");
  if (job?.id) {
    await api(`?action=finish&id=${job.id}`, {
      method: "POST",
      body: JSON.stringify({ ok: false, message: "拡張のバックグラウンド処理が途中で止まりました" }),
    }).catch(() => {});
  }
  await chrome.storage.local.remove(["runningSince", "job", "autoWinId"]).catch(() => {});
  await releaseAwake();
  setBadge("");
  return false;
}

async function poll() {
  if (await watchdog()) return; // 収集中（本当にまだ動いていそうなときだけ待つ）
  if (!(await getKey())) return; // 未設定のうちは何もしない
  try {
    const res = await api("?action=claim");
    if (!res.ok) return;
    const { job } = await res.json();
    if (job) await runJob(job);
  } catch { /* オフライン等。次の周期で拾い直す */ }
}

/* 巡回の仕掛け直し。Service Worker は寝たり起きたりするので、
   読み込まれたら毎回そろえておく（同名アラームは作り直しになるだけ）。
   periodInMinutes だけだと初回が1分後になるので、起きた直後にも1回見に行く。 */
function ensureAlarm() {
  chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 1 });
}
ensureAlarm();
scheduleAuto();
scheduleCorpAuto();
poll();

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); scheduleAuto(); scheduleCorpAuto(); poll(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); scheduleAuto(); scheduleCorpAuto(); poll(); });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) poll();
  if (a.name === AUTO_ALARM) runAuto();
  if (a.name === CORP_ALARM) runCorpAuto(a);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoUpdate) scheduleAuto();
  if (changes.autoLogin) scheduleCorpAuto();
});

// サイトのボタンから「いま来た」と知らせが届いたら、次の周期を待たずに拾う
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "run-now") {
    poll();
    sendResponse({ accepted: true });
    return true;
  }
  if (msg?.type === "ping") {
    Promise.all([getKey(), chrome.storage.local.get(["runningSince", "autoUpdate"])])
      .then(([k, { runningSince = 0, autoUpdate = false }]) => {
        const next = autoUpdate ? nextAutoAt().at.toLocaleString("ja-JP", {
          month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
        }) : null;
        sendResponse({ ok: true, configured: !!k, running: !!runningSince, autoUpdate, next });
      });
    return true;
  }
  if (msg?.type === "autologin-status") {
    Promise.all([loginState(), native({ cmd: "ping" })]).then(([st, host]) => {
      const next = st.enabled ? nextCorpAt().toLocaleString("ja-JP", {
        month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      }) : null;
      sendResponse({ ...st, next, host, dailyMax: AUTO_LOGIN_DAILY_MAX });
    });
    return true;
  }
  if (msg?.type === "autologin-reset") {
    chrome.storage.local.remove("autoLoginTrip")
      .then(() => log("自動ログインの停止を手で解除しました"))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "autologin-test") {
    // 見ている前で1回だけ試す。ログインのウィンドウを前面に出す
    (async () => {
      await chrome.storage.local.set({ autoLoginVisible: Date.now() });
      const res = await api(`?action=request&hub=${CORP_HUB}`, {
        method: "POST",
        body: JSON.stringify({ from: "拡張（自動ログインの試験）", days: [0] }),
      }).catch(() => null);
      sendResponse({ ok: !!res?.ok });
      if (res?.ok) poll();
    })();
    return true;
  }
  if (msg?.type === "collect-progress") {
    markProgress(); // 生きている証。打ち切りの判定はこれだけを見ている
    if (msg.job?.id) {
      api(`?action=progress&id=${msg.job.id}`, {
        method: "POST",
        body: JSON.stringify({ message: msg.message }),
      }).catch(() => {});
    }
  }
});
