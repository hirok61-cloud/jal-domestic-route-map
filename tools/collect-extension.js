/* ===========================================================================
   JAL国内線 空席コレクタ ── Chrome拡張用の外側

   収集ロジック本体は tools/collect-core.js にある（ブックマークレットと共通）。
   ここが受け持つのは、拡張との受け渡しだけ。
     - 合言葉と依頼（どの日を集めるか）を chrome.storage から取る
     - 進捗を background.js に流す（依頼の「無音時間」判定に使われる）
     - 終わったら collect-finished を返し、依頼を done にする

   このファイルは esbuild で extension/collect.js に生成する。
   直接 extension/collect.js を編集しないこと（次のビルドで消える）。
   =========================================================================== */

import { createRun, jstDate, ENDPOINT } from "./collect-core.js";

(async () => {
  const finish = (ok, extra) =>
    chrome.runtime.sendMessage({ type: "collect-finished", ok, ...extra });

  const { job, updateKey } = await chrome.storage.local.get(["job", "updateKey"]);
  if (!updateKey) return finish(false, { error: "合言葉が未設定です" });

  const creds = JSON.parse(sessionStorage.getItem("apiAuthCreds") || "{}");
  if (!creds.authToken) return finish(false, { error: "JALのセッションを取得できませんでした" });

  /* 依頼が日を指定していればそれに従う（0=今日 / 1=翌日）。 */
  const OFFSETS = Array.isArray(job?.days) && job.days.length ? job.days : [0, 1];

  const send = (path, body) => fetch(ENDPOINT + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-update-key": updateKey },
    body: JSON.stringify(body),
  });

  /* 進捗は10件ごとに送る。background.js は依頼の updated_at が5分止まったら
     中断とみなすので、間隔を空けすぎないこと。 */
  const post = (message) => chrome.runtime.sendMessage({ type: "collect-progress", job, message });
  const report = (kind, x) => {
    if (kind === "fares" && x.i % 10 === 0) post(`${x.label}分を取得中 ${x.i + 1}/${x.total}`);
    else if (kind === "seats" && x.i % 10 === 0) post(`${x.label}分の座席表 ${x.i + 1}/${x.total}`);
    else if (kind === "saving") post(`${x.label}分を保存しています`);
    else if (kind === "save-try") post(`保存を送信中（${x.host} / ${x.way} ${x.attempt}回目）`);
    else if (kind === "save-retry") post(`保存をやり直しています（${x.error}）`);
  };

  const run = createRun({
    auth: "Bearer " + creds.authToken,
    updateKey,
    runId: crypto.randomUUID(),
    report,
  });

  const parts = [];
  try {
    for (let d = 0; d < OFFSETS.length; d++) {
      const label = OFFSETS[d] === 0 ? "今日" : "翌日";
      const s = await run.collectDay({
        date: jstDate(OFFSETS[d]), label, dayIndex: d, dayCount: OFFSETS.length,
      });
      parts.push(`${label} ${s.flights}便中${s.withSeats}便に空席`
        + (s.seatChecked ? `（座席表確認 ${s.seatChecked}便・うち座席表満席 ${s.seatZero}便）` : ""));
    }

    const summary = parts.join(" / ");
    if (job?.id) await send(`?action=finish&id=${job.id}`, { ok: true, message: summary });
    finish(true, { summary });
  } catch (err) {
    // 途中まで取れていれば、そこまでは保存済み。捨てずに伝える
    finish(false, {
      error: String(err?.message || err)
        + (parts.length ? `（${parts.join(" / ")} まで保存済み）` : ""),
    });
  }
})();
