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
const ALARM = "poll";
const AUTO_ALARM = "auto";

/* 自動更新の時刻（ローカル時間）。Macが起きているときだけ動くので回数は絞る。
   朝・昼は今日分、夜は翌日分を取る（22時には今日の便がほぼ終わっているため）。 */
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
/* 収集の上限時間。座席表まで見るので1日分で8〜10分かかる。
   余裕をみて1日あたり20分とる。 */
const COLLECT_MS_PER_DAY = 20 * 60 * 1000;

/* 収集中かどうかは storage に置く。Service Worker は数十秒で止められるので、
   メモリ上のフラグだと再起動後に「動いていない」と誤認して二重に走ってしまう。 */
async function beginRun() {
  const { runningSince = 0 } = await chrome.storage.local.get("runningSince");
  // 上限時間を大きく超えていたら、前回が異常終了したとみなして引き継ぐ
  if (runningSince && Date.now() - runningSince < 2 * COLLECT_MS_PER_DAY + 10 * 60 * 1000) {
    return false;
  }
  await chrome.storage.local.set({ runningSince: Date.now() });
  return true;
}
const endRun = () => chrome.storage.local.remove("runningSince").catch(() => {});

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

/** タブが指定URLになるまで待つ。 */
function waitForUrl(tabId, re, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("ページの遷移が終わりませんでした"));
    }, timeoutMs);

    function done(tab) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    }
    function onUpdated(id, info, tab) {
      if (id === tabId && tab.url && re.test(tab.url) && info.status === "complete") done(tab);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    // すでに条件を満たしていることもある
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.url && re.test(tab.url) && tab.status === "complete") done(tab);
    }).catch(() => {});
  });
}

/* -------------------------------------------------------------- 収集の本体 */

async function runJob(job) {
  if (!(await beginRun())) return;
  setBadge("…");
  const days = Array.isArray(job?.days) && job.days.length ? job.days.length : 2;
  const collectTimeoutMs = COLLECT_MS_PER_DAY * days;

  let win = null;
  try {
    await log(`開始（依頼#${job?.id ?? "-"}）`);

    // 別ウィンドウで開く。前面は奪わないが、最小化はしない
    // （完全に隠れたタブはタイマーが絞られて収集が終わらないため）
    win = await chrome.windows.create({ url: TOP_URL, focused: false, width: 900, height: 700 });
    const tabId = win.tabs[0].id;

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

    // 収集させる。結果の送信は collect.js が自分で行う。
    // 注入したスクリプトは storage.session を読めない（TRUSTED_CONTEXTS 限定）ので
    // 受け渡しは storage.local を使う。
    await chrome.storage.local.set({ job });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(onMsg);
        reject(new Error("収集が時間内に終わりませんでした"));
      }, collectTimeoutMs);
      function onMsg(msg) {
        if (msg?.type !== "collect-finished") return;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(onMsg);
        msg.ok ? resolve(msg) : reject(new Error(msg.error || "収集に失敗しました"));
      }
      chrome.runtime.onMessage.addListener(onMsg);
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["collect.js"] });

    const result = await done;
    await log(`完了: ${result.summary}`);
    setBadge("");
  } catch (err) {
    const message = String(err?.message || err);
    await log(`失敗: ${message}`);
    setBadge("!", "#8c0017");
    if (job?.id) {
      await api(`?action=finish&id=${job.id}`, {
        method: "POST",
        body: JSON.stringify({ ok: false, message }),
      }).catch(() => {});
    }
  } finally {
    if (win?.id != null) chrome.windows.remove(win.id).catch(() => {});
    await chrome.storage.local.remove("job").catch(() => {});
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
  const store = await chrome.storage.local.get(["autoUpdate", "lastAutoAt"]);
  await scheduleAuto(); // まず次回を仕掛け直す
  if (!store.autoUpdate) return;
  if (!(await getKey())) return;

  /* Macが寝ていると予定時刻を過ぎてから発火する。起きた直後に朝と夜の分が
     続けて走らないよう、直近に自動更新していたら見送る。 */
  if (store.lastAutoAt && Date.now() - store.lastAutoAt < AUTO_MIN_GAP_MS) {
    await log("自動更新: 直近に実行済みのため見送り");
    return;
  }

  // いま時刻に近いほうの枠を採用する（寝坊した場合も、その枠の対象日で取る）
  const hour = new Date().getHours();
  const slot = AUTO_SCHEDULE.reduce((a, b) =>
    Math.abs(a.hour - hour) <= Math.abs(b.hour - hour) ? a : b);

  try {
    const res = await api("?action=request", {
      method: "POST",
      body: JSON.stringify({ from: "自動更新", days: slot.days }),
    });
    if (!res.ok) return;
    await chrome.storage.local.set({ lastAutoAt: Date.now() });
    await log(`自動更新を開始（${slot.days[0] === 0 ? "今日分" : "明日分"}）`);
    await poll();
  } catch { /* オフライン等。次の枠で拾い直す */ }
}

/* ------------------------------------------------------------ 依頼を拾う */

/* sleep() を keep-alive にしても、Service Worker が本当に落ちることはありうる
   （Chrome自体の再起動・強制終了など）。落ちると runningSince が残ったまま
   誰も片付けないので、そのジョブの想定所要時間を大きく超えていたら「無応答」と
   みなして自分で片付け、次の周期ですぐ拾い直す。50分固定だった旧実装だと、
   1日分（20分程度）のジョブが落ちても最大50分も次を拾えなかった。 */
async function watchdog() {
  const { runningSince = 0, job = null } = await chrome.storage.local.get(["runningSince", "job"]);
  if (!runningSince) return false;
  const days = Array.isArray(job?.days) && job.days.length ? job.days.length : 2;
  const maxMs = COLLECT_MS_PER_DAY * days + 5 * 60 * 1000; // 収集の上限＋余裕5分
  if (Date.now() - runningSince < maxMs) return true; // まだ動いていておかしくない

  await log(`自動復旧: 前回の収集が無応答のため中断扱いにしました（依頼#${job?.id ?? "-"}）`);
  if (job?.id) {
    await api(`?action=finish&id=${job.id}`, {
      method: "POST",
      body: JSON.stringify({ ok: false, message: "拡張のバックグラウンド処理が途中で止まりました" }),
    }).catch(() => {});
  }
  await chrome.storage.local.remove(["runningSince", "job"]).catch(() => {});
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
poll();

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); scheduleAuto(); poll(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); scheduleAuto(); poll(); });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) poll();
  if (a.name === AUTO_ALARM) runAuto();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoUpdate) scheduleAuto();
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
  if (msg?.type === "collect-progress" && msg.job?.id) {
    api(`?action=progress&id=${msg.job.id}`, {
      method: "POST",
      body: JSON.stringify({ message: msg.message }),
    }).catch(() => {});
  }
});
