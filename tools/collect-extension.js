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

import { createRun, jstDate, ENDPOINT, CORP_HUB } from "./collect-core.js";

(async () => {
  const finish = (ok, extra) =>
    chrome.runtime.sendMessage({ type: "collect-finished", ok, ...extra });

  const { job, updateKey } = await chrome.storage.local.get(["job", "updateKey"]);
  if (!updateKey) return finish(false, { error: "合言葉が未設定です" });

  const creds = JSON.parse(sessionStorage.getItem("apiAuthCreds") || "{}");
  if (!creds.authToken) return finish(false, { error: "JALのセッションを取得できませんでした" });

  /* 依頼のハブで、公式サイトぶんか JALオンライン（法人・制度利用）ぶんかを分ける。
     依頼テーブルは前から hub を運んでいるので、サーバ側の変更は要らない
     （`?action=request&hub=JOH` で積むと `?action=claim` が job.hub で返す）。 */
  const corporate = job?.hub === CORP_HUB;

  /* 依頼が日を指定していればそれに従う（0=今日 / 1=翌日）。
     制度枠は当日ぶんしか出ない（翌日以降は「まだ解放されていない」が返る）ので、
     法人モードでは翌日を見に行かない。詳細は docs/JAL_ONLINE_CORP.md */
  const OFFSETS = corporate
    ? [0]
    : (Array.isArray(job?.days) && job.days.length ? job.days : [0, 1]);

  const send = (path, body) => fetch(ENDPOINT + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-update-key": updateKey },
    body: JSON.stringify(body),
  });

  /* 進捗は「10件ごと、ただし前回から60秒たっていれば必ず」送る。
     **件数だけで間引くと、遅い実行が誤って殺される。**
     JALへのリクエストは30秒でタイムアウトする（TIMEOUT_MS）ので、
     座席表が10便続けてタイムアウトすると 10×30秒＝300秒＝
     「無進捗5分で中断」の閾値にちょうど達してしまう。
     2026-08-15、実際にこれで「座席表 1/284（進捗が止まったため中断しました）」
     と表示された（拡張側は失敗も完了も記録しておらず、まだ動いていた）。
     時間でも送るようにして、生きている実行が黙って殺されないようにする。 */
  let lastPostAt = 0;
  const post = (message) => {
    lastPostAt = Date.now();
    chrome.runtime.sendMessage({ type: "collect-progress", job, message });
  };
  const due = (i) => i % 10 === 0 || Date.now() - lastPostAt > 60000;
  const report = (kind, x) => {
    if (kind === "fares" && due(x.i)) post(`${x.label}分を取得中 ${x.i + 1}/${x.total}`);
    else if (kind === "seats" && due(x.i)) post(`${x.label}分の座席表 ${x.i + 1}/${x.total}`);
    else if (kind === "saving") post(`${x.label}分を保存しています`);
    else if (kind === "save-try") post(`保存を送信中（${x.host} / ${x.way} ${x.attempt}回目）`);
    else if (kind === "save-retry") post(`保存をやり直しています（${x.error}）`);
  };

  const run = createRun({
    auth: "Bearer " + creds.authToken,
    updateKey,
    runId: crypto.randomUUID(),
    report,
    corporate,
  });

  const parts = [];
  try {
    for (let d = 0; d < OFFSETS.length; d++) {
      const label = OFFSETS[d] === 0 ? "今日" : "翌日";
      const s = await run.collectDay({
        date: jstDate(OFFSETS[d]), label, dayIndex: d, dayCount: OFFSETS.length,
      });
      parts.push(corporate
        ? `${label} 制度で予約できる便 ${s.withSeats}便（${s.flights}便中）`
        : `${label} ${s.flights}便中${s.withSeats}便に空席`
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
