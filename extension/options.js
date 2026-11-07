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
      body: JSON.stringify({
        from: "拡張",
        days: document.getElementById("day").value.split(",").map(Number),
      }),
    });
    chrome.runtime.sendMessage({ type: "run-now" });
  } catch (e) {
    $state.innerHTML = '<span class="warn">依頼を送れませんでした。</span>';
  }
  setTimeout(() => { $run.textContent = label; $run.disabled = !$key.value.trim(); }, 4000);
});

/* --- 自動更新の切り替え --- */
const $auto = document.getElementById("auto");
const $autonote = document.getElementById("autonote");

function showNext() {
  chrome.runtime.sendMessage({ type: "ping" }, (res) => {
    if (!res) return;
    $autonote.innerHTML = res.autoUpdate && res.next
      ? `次は <b>${res.next}</b> に実行します。Chromeが動いているときだけ実行され、`
        + "Macが寝ていた場合は起きたあとに1回だけ動きます。"
      : "<b>朝7時・昼12時に今日分／夜22時に明日分</b>を取り直します"
        + "（22時には今日の便がほぼ終わっているため）。"
        + "Chromeが動いているときだけ実行されます。";
  });
}

chrome.storage.local.get("autoUpdate").then(({ autoUpdate = false }) => {
  $auto.checked = autoUpdate;
  showNext();
});
$auto.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoUpdate: $auto.checked });
  setTimeout(showNext, 200);
});

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.storage.local.set({ runLog: [] });
  refreshLog();
});

/* --- 制度枠の自動記録（自動ログイン） --- */
const $corpauto = document.getElementById("corpauto");
const $corpstate = document.getElementById("corpstate");
const $corptest = document.getElementById("corptest");
const $corpreset = document.getElementById("corpreset");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function showCorp() {
  chrome.runtime.sendMessage({ type: "autologin-status" }, (st) => {
    if (!st) return;
    $corpauto.checked = st.enabled;
    const lines = [];
    if (!st.host?.ok) {
      lines.push(`<span class="warn">補助プログラムが動いていません。</span> ${esc(st.host?.error || "")}`
        + "<br>native-host/install.sh を実行してください。");
    } else if (!st.host.hasItem) {
      lines.push('<span class="warn">キーチェーンにログイン情報がありません。</span>'
        + "<br>ターミナルで <code>security add-generic-password -s jal-online-autologin -a お得意様番号 -w</code>");
    } else {
      lines.push(`<span class="ok">キーチェーン: 登録あり（番号の末尾 ${esc(st.host.idTail || "?")}）</span>`);
    }
    if (st.trip) {
      lines.push(`<span class="warn">停止中: ${esc(st.trip.reason)}</span>`
        + `（${new Date(st.trip.at).toLocaleString("ja-JP")}）`);
    } else if (st.enabled && st.next) {
      lines.push(`次は <b>${esc(st.next)}</b> に記録します。`);
    }
    lines.push(`今日の自動ログイン: ${st.count} / ${st.dailyMax} 回`);
    $corpstate.innerHTML = lines.join("<br>");
    $corpreset.hidden = !st.trip;
    $corptest.disabled = !st.host?.ok || !st.host?.hasItem || !!st.trip || !$key.value.trim();
  });
}
showCorp();

$corpauto.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoLogin: $corpauto.checked });
  setTimeout(showCorp, 200);
});
/* 拡張アイコンから開く小窓では confirm() を出すと小窓ごと閉じてしまうため、
   「1回目で確認の文言に変わり、2回目で実行」にしている。 */
function twoStep(btn, confirmLabel, action) {
  const label = btn.textContent;
  let armed = 0;
  btn.addEventListener("click", () => {
    if (Date.now() - armed > 5000) {
      armed = Date.now();
      btn.textContent = confirmLabel;
      setTimeout(() => { if (armed && Date.now() - armed >= 5000) { btn.textContent = label; armed = 0; } }, 5100);
      return;
    }
    armed = 0;
    btn.textContent = label;
    action();
  });
}
twoStep($corpreset, "もう一度押すと解除します", () => {
  chrome.runtime.sendMessage({ type: "autologin-reset" }, showCorp);
});
twoStep($corptest, "もう一度押すと開始します", () => {
  $corptest.disabled = true;
  chrome.runtime.sendMessage({ type: "autologin-test" }, (res) => {
    $corpstate.insertAdjacentHTML("beforeend", res?.ok
      ? "<br><b>試験を開始しました。</b>前面に開くウィンドウには触らず、結果は下の実行ログで確認してください。"
      : '<br><span class="warn">依頼を送れませんでした。</span>');
  });
});
chrome.storage.onChanged.addListener((c) => {
  if (c.autoLoginTrip || c.autoLoginCount || c.autoLogin) showCorp();
});
