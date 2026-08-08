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

/* Akamaiはページを開いた直後のセッションを信用しない。
   トップページで少し待ってからでないと、空席APIが429(cpr_chlge)で弾かれる。 */
const MATURE_MS = 30000;
const NAV_TIMEOUT_MS = 60000;
const COLLECT_TIMEOUT_MS = 4 * 60 * 1000;

let running = false;

/* ------------------------------------------------------------------ 小道具 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (running) return;
  running = true;
  setBadge("…");

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
      }, COLLECT_TIMEOUT_MS);
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
    running = false;
  }
}

/* ------------------------------------------------------------ 依頼を拾う */

async function poll() {
  if (running) return;
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
poll();

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); poll(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); poll(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) poll(); });

// サイトのボタンから「いま来た」と知らせが届いたら、次の周期を待たずに拾う
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "run-now") {
    poll();
    sendResponse({ accepted: true, running });
    return true;
  }
  if (msg?.type === "ping") {
    getKey().then((k) => sendResponse({ ok: true, configured: !!k, running }));
    return true;
  }
  if (msg?.type === "collect-progress" && msg.job?.id) {
    api(`?action=progress&id=${msg.job.id}`, {
      method: "POST",
      body: JSON.stringify({ message: msg.message }),
    }).catch(() => {});
  }
});
