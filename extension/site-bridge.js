/* ルートマップのページに「この拡張が入っている」ことを知らせ、
   ページの更新ボタンからの合図を拡張本体へ中継する。

   拡張IDは開発者モードで読み込むたびに変わるので、ページ側からIDを指定せずに
   済むよう、content script と window.postMessage を挟んでいる。 */

document.documentElement.dataset.jalSeatsExt = "1";

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const type = ev.data?.type;

  if (type === "JAL_SEATS_RUN") {
    chrome.runtime.sendMessage({ type: "run-now" }, () => void chrome.runtime.lastError);
  }

  if (type === "JAL_SEATS_PING") {
    chrome.runtime.sendMessage({ type: "ping" }, (res) => {
      void chrome.runtime.lastError;
      window.postMessage({ type: "JAL_SEATS_PONG", configured: !!res?.configured, running: !!res?.running }, "*");
    });
  }
});
