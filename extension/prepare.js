/* JALのトップページから、人手の検索を挟まずに空席照会画面へ進む。
 *
 * トップページの検索ウィジェットが内部でやっていることと同じ:
 *   1. getDomEnc.cgi でセッションの種（hv_sid / dt_sid）をもらう
 *   2. その種を付けて booking.jal.co.jp へフォーム送信する
 *
 * この2つだけではセッションが「若すぎて」空席APIが429で弾かれるので、
 * 呼び出し側（background.js）がトップページで30秒待ってから実行している。
 */

(async () => {
  const ENC = "https://www.jal.co.jp/cgi-bin/jal/common_rn/domEnc/getDomEnc.cgi";
  const ACTION = "https://booking.jal.co.jp/jl/dom-bkg/upsell";

  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

  const seed = await fetch(`${ENC}?_=${Date.now()}`, {
    headers: { Accept: "application/json" },
    credentials: "include",
  }).then((r) => r.json());

  // 路線・日付は何でもよい。空席照会のセッションを作るためだけの検索
  const fields = {
    linkId: "02",
    langCd: "ja",
    hv_sid: seed.hv_sid,
    dt_sid: seed.dt_sid,
    tripType: "OW",
    depDate: today,
    depAirportCode1: "HND",
    arrAirportCode1: "ITM",
    adult: "1",
    child: "0",
    infant: "0",
    class: "ecoBusiness",
    discountType: "JCF",
  };

  const form = document.createElement("form");
  form.method = "POST";
  form.action = ACTION;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
})();
