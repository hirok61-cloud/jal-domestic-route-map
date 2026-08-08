"use strict";

const ENDPOINT = "https://xymbknvwllwhmqlexege.supabase.co/functions/v1/jal-seats";

const $key = document.getElementById("key");
const $state = document.getElementById("state");
const $log = document.getElementById("log");
const $run = document.getElementById("run");

async function refreshLog() {
  const { runLog = [] } = await chrome.storage.local.get("runLog");
  $log.textContent = runLog.length ? runLog.join("\n") : "まだ実行していません。";
}

function showState(key) {
  $run.disabled = !key;
  $state.innerHTML = key
    ? '<span class="ok">合言葉を保存しました。</span>'
    : '<span class="warn">合言葉を入れると使えるようになります。</span>';
}

chrome.storage.local.get("updateKey").then(({ updateKey = "" }) => {
  $key.value = updateKey;
  showState(updateKey);
});
refreshLog();
chrome.storage.onChanged.addListener(refreshLog);

$key.addEventListener("input", async () => {
  const key = $key.value.trim();
  await chrome.storage.local.set({ updateKey: key });
  showState(key);
});

// 拡張から直接依頼を積んで、そのまま自分で拾わせる
$run.addEventListener("click", async () => {
  $run.disabled = true;
  const label = $run.textContent;
  $run.textContent = "依頼しました…";
  try {
    await fetch(`${ENDPOINT}?action=request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "拡張" }),
    });
    chrome.runtime.sendMessage({ type: "run-now" });
  } catch (e) {
    $state.innerHTML = '<span class="warn">依頼を送れませんでした。</span>';
  }
  setTimeout(() => { $run.textContent = label; $run.disabled = !$key.value.trim(); }, 4000);
});

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.storage.local.set({ runLog: [] });
  refreshLog();
});
