/* ===========================================================================
   JAL国内線 空席コレクタ ── ブックマークレット用の外側

   収集ロジック本体は tools/collect-core.js にある（拡張と共通）。
   ここが受け持つのは、JALのページ上に出す進捗表示と、
   「今日 / 明日 / 両日」の聞き取り、それに www 側で押されたときの誘導だけ。

   使い方は /seats/update.html を参照。

   なぜブラウザ上で動かすのか
   --------------------------
   jal.co.jp / booking.jal.co.jp は Akamai Bot Manager 配下で、curl も
   Playwright/Selenium で起動したブラウザも弾かれる(JALのアプリ自身のAPI
   呼び出しごと失敗する)。空席APIも booking.jal.co.jp オリジンからしか
   呼べない。人が普通に開いたブラウザのセッションを間借りするのが、
   いちばん確実で JAL 側への負荷も小さい。

   合言葉について
   --------------
   このファイルは公開サイトから配信されるので、書き込み用の合言葉は
   持たせない。ブックマークレットが window.__JAL_SEATS_KEY に入れて渡す。
   =========================================================================== */

import { createRun, jstDate, SITE } from "./collect-core.js";

/* ブックマークレットは配信元を順に試すので、「読み込めて動き出した」ことを
   同期的に伝える目印を最初に置く。script タグの load は中身の実行後に鳴るので、
   これが立っていなければ次の配信元へ進んでよい、と判断できる。 */
window.__JAL_SEATS_BOOTED = Date.now();

(async () => {
  "use strict";

  /* ---------------------------------------------------------------- 進捗表示 */

  document.getElementById("jal-seat-collector")?.remove();
  document.getElementById("jsc-boot")?.remove(); // ブックマークレットが出した起動枠
  const ui = document.createElement("div");
  ui.id = "jal-seat-collector";
  ui.style.cssText = [
    "position:fixed", "right:18px", "bottom:18px", "z-index:2147483647",
    "width:320px", "max-width:calc(100vw - 36px)", "padding:16px 18px", "border-radius:14px",
    "background:#fff", "color:#1b1e24", "border:1px solid #e2e0da",
    "box-shadow:0 12px 34px rgba(30,20,20,.28)",
    'font:13px/1.6 "Hiragino Sans","Yu Gothic UI",-apple-system,sans-serif',
  ].join(";");
  ui.innerHTML = `
    <div style="font-size:10px;letter-spacing:.22em;color:#b7001e;font-weight:700">JAL SEAT COLLECTOR</div>
    <div id="jsc-msg" style="margin-top:6px;font-weight:700">準備しています…</div>
    <div style="margin-top:10px;height:6px;border-radius:99px;background:#eceae5;overflow:hidden">
      <div id="jsc-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#b7001e,#8c0017);transition:width .2s"></div>
    </div>
    <div id="jsc-sub" style="margin-top:7px;font-size:11.5px;color:#6b7480">&nbsp;</div>`;
  document.body.appendChild(ui);

  const $msg = ui.querySelector("#jsc-msg");
  const $sub = ui.querySelector("#jsc-sub");
  const $bar = ui.querySelector("#jsc-bar");
  const show = (msg, sub, pct) => {
    if (msg != null) $msg.textContent = msg;
    if (sub != null) $sub.innerHTML = sub;
    if (pct != null) $bar.style.width = pct + "%";
  };

  /* 失敗の枠は消さない。20秒で消していたため、何が起きたのか読む前に消えてしまい、
     原因の切り分けができなかった。文面をそのまま渡せるよう、コピーもできるようにする。 */
  const fail = (msg, sub) => {
    show(msg, sub, 100);
    $bar.style.background = "#b7001e";
    if (ui.querySelector("#jsc-acts")) return;
    const acts = document.createElement("div");
    acts.id = "jsc-acts";
    acts.style.cssText = "display:flex;gap:6px;margin-top:10px";
    const mkBtn = (text, onClick) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = "flex:1;cursor:pointer;border:1px solid #e2e0da;background:#faf9f7;"
        + "color:#1b1e24;border-radius:999px;padding:8px 10px;font:700 12px/1 inherit";
      b.onclick = onClick;
      return b;
    };
    const copy = mkBtn("内容をコピー", async () => {
      const text = `[JAL空席] ${msg}\n${$sub.textContent}\n${location.host} / ${navigator.userAgent}`;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ui.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch { /* 手で選んでもらう */ }
        ta.remove();
      }
      copy.textContent = "コピーしました ✓";
    });
    acts.append(copy, mkBtn("閉じる", () => ui.remove()));
    ui.appendChild(acts);
  };

  /* -------------------------------------------------------------- 事前チェック */

  /* JALのトップページなど www 側で押された場合は、空席照会画面まで自分で進む。
     （空席APIは booking.jal.co.jp オリジンからしか呼べないため）
     ページ遷移でこのスクリプトは消えるので、着いたらもう一度押してもらう。 */
  if (/(^|\.)jal\.co\.jp$/.test(location.host) && !location.host.startsWith("booking.")) {
    try {
      // Akamaiは開いた直後のセッションを信用しない。読み込みから30秒経つまで待つ
      const openedFor = performance.now();
      const waitMs = Math.max(0, 30000 - openedFor);
      if (waitMs > 0) {
        for (let left = Math.ceil(waitMs / 1000); left > 0; left--) {
          show("JALの空席照会を開きます", `あと${left}秒お待ちください`,
            Math.round((1 - left / (waitMs / 1000)) * 100));
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      show("空席照会の画面へ移動します…", "移動したら、もう一度このブックマークを押してください", 100);

      const seed = await fetch(
        "https://www.jal.co.jp/cgi-bin/jal/common_rn/domEnc/getDomEnc.cgi?_=" + Date.now(),
        { headers: { Accept: "application/json" }, credentials: "include" },
      ).then((r) => r.json());

      const fields = {
        linkId: "02", langCd: "ja", hv_sid: seed.hv_sid, dt_sid: seed.dt_sid,
        tripType: "OW", depDate: jstDate(0), depAirportCode1: "HND", arrAirportCode1: "ITM",
        adult: "1", child: "0", infant: "0", class: "ecoBusiness", discountType: "JCF",
      };
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "https://booking.jal.co.jp/jl/dom-bkg/upsell";
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      fail("空席照会の画面へ進めませんでした", String(e.message || e));
    }
    return;
  }

  if (!location.host.startsWith("booking.jal.co.jp")) {
    // Androidでブックマーク一覧から開くと新規タブ側で走ってしまい、ここに来る
    fail("この画面では実行できません",
      "<b>JALのサイトを表示した状態で</b>実行してください。"
      + "トップページで押せば、空席照会の画面まで自動で進みます。"
      + "<br>Androidは、JALの画面でアドレスバーに <b>jalseat</b> と入力して"
      + "<b>ブックマークの候補をタップ</b>してください（ブックマーク一覧から開くと、"
      + "JALのページではなく新しいタブで動いてしまいます）。");
    return;
  }
  const creds = JSON.parse(sessionStorage.getItem("apiAuthCreds") || "{}");
  if (!creds.authToken) {
    fail("ログイン情報が見つかりません",
      "先に国内線を1回検索して、便が並んだ画面で実行してください。");
    return;
  }

  /* ------------------------------------------------------------ 収集する日 */

  /* 座席表まで見ると1日8〜10分かかるので、両日まとめると20分近くになる。
     要る日だけ選べるほうが実用的。 */
  const OFFSETS = await new Promise((resolve) => {
    const md = (n) => {
      const d = new Date(Date.now() + 9 * 3600000 + n * 86400000);
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    };
    show("どの日を更新しますか？",
      "座席表まで見るので<b>1日あたり8〜10分</b>かかります", 0);
    const box = document.createElement("div");
    box.style.cssText = "display:flex;gap:6px;margin-top:10px;flex-wrap:wrap";
    const mk = (text, value) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = "flex:1;min-width:84px;cursor:pointer;border:1px solid #e2e0da;"
        + "background:#faf9f7;color:#1b1e24;border-radius:999px;padding:8px 10px;"
        + "font:700 12px/1 inherit";
      b.onclick = () => { box.remove(); resolve(value); };
      return b;
    };
    box.append(
      mk(`今日 ${md(0)}`, [0]),
      mk(`明日 ${md(1)}`, [1]),
      mk("両日", [0, 1]),
    );
    ui.appendChild(box);
  });

  /* ------------------------------------------------------------------ 収集 */

  const download = (out) => {
    const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `availability-${out.date}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const KEEP_OPEN = "<br><span style='color:#b7001e'>この画面を開いたままにしてください</span>";
  const run = createRun({
    auth: "Bearer " + creds.authToken,
    updateKey: window.__JAL_SEATS_KEY || "",
    runId: crypto.randomUUID(),
    onSaveFailed: download,
    report: (kind, x) => {
      if (kind === "fares") {
        show(`${x.label}分を取得中… ${x.i + 1} / ${x.total}`,
          `${x.origin} → ${x.destination}　全体の残り約${x.leftSec}秒` + KEEP_OPEN, x.pct);
      } else if (kind === "seats") {
        show(`${x.label}分の座席表… ${x.i + 1} / ${x.total}`,
          `${x.origin} → ${x.destination} ${x.no}　残り約${x.leftSec}秒` + KEEP_OPEN, x.pct);
      } else if (kind === "saving") {
        show(`${x.label}分を保存しています…`,
          x.phase === "fares"
            ? `${x.stats.flights}便中${x.stats.withSeats}便に空席`
            : `座席表 ${x.stats.seatChecked}便分`, null);
      } else if (kind === "save-try") {
        show(null, `${x.way === "fetch" ? "通常の方法" : "別の方法（XHR）"}で送信中…`
          + ` ${x.attempt}回目（最大${x.seconds}秒待ちます）`, null);
      } else if (kind === "save-retry") {
        show(null, `保存に失敗しました。${x.wait}秒後にもう一度試します（${x.error}）`, null);
      }
    },
  });

  if (!window.__JAL_SEATS_KEY) {
    fail("合言葉がありません", "設定ページで合言葉を入れて、登録し直してください。");
    return;
  }

  /* スマホだと収集中に画面が消えるとタイマーが絞られて途中で止まるので、
     可能なら画面スリープを抑止する（iOS 16.4+ / Android Chrome）。 */
  let wakeLock = null;
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
  } catch { /* 非対応。そのまま続行する */ }
  const releaseWakeLock = () => { try { wakeLock?.release(); } catch {} wakeLock = null; };

  // 画面を消されたことに気づけるようにしておく（止まった理由がわからないと困るため）
  let wentHidden = false;
  const onHide = () => { if (document.visibilityState === "hidden") wentHidden = true; };
  document.addEventListener("visibilitychange", onHide);

  const started = Date.now();
  const parts = [];
  try {
    for (let d = 0; d < OFFSETS.length; d++) {
      const label = OFFSETS[d] === 0 ? "今日" : "翌日";
      const s = await run.collectDay({
        date: jstDate(OFFSETS[d]), label, dayIndex: d, dayCount: OFFSETS.length,
      });
      parts.push(`${label} ${s.flights}便中<b>${s.withSeats}便</b>に空席`
        + (s.seatChecked ? `／座席表を見ると<b>${s.seatZero}便</b>は座席なし` : "")
        + (s.failed ? `（取得失敗 ${s.failed}区間）` : ""));
    }
  } catch (e) {
    document.removeEventListener("visibilitychange", onHide);
    releaseWakeLock();
    fail(parts.length ? "翌日分の途中で止まりました" : "更新できませんでした",
      `${String(e.message || e)}`
      + (parts.length ? `<br>${parts.join("<br>")}（ここまでは保存済み）` : "")
      + (wentHidden ? "<br>途中で画面が消えたのが原因かもしれません。" : ""));
    return;
  }

  document.removeEventListener("visibilitychange", onHide);
  releaseWakeLock();

  const took = Math.round((Date.now() - started) / 1000);
  show("更新しました ✈",
    `${parts.join("<br>")}（${took}秒）`
    + `<br><a href="${SITE}" target="_blank" style="color:#b7001e;font-weight:700">空席状況を開く</a>`, 100);
  $bar.style.background = "#1a7f4b";
  setTimeout(() => ui.remove(), 30000);
})();
