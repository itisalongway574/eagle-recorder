// 這兩個函式會透過 chrome.scripting.executeScript 注入網頁，必須各自獨立、不能引用外部變數。
// 兩次注入共用同一個 isolated world，所以 prepare 找到的捲動元素可以留給 run 使用。

export function prepareScroll() {
  const root = document.scrollingElement || document.documentElement;
  const scrollable = (el) =>
    el.scrollHeight - el.clientHeight > 2 &&
    /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);

  // 一般網頁捲的是整個文件；有些網站把內容放在內層容器捲動，就挑畫面上最大的那個
  let el = root;
  if (root.scrollHeight - root.clientHeight <= 2) {
    let bestArea = 0;
    for (const node of document.querySelectorAll('body *')) {
      if (!scrollable(node)) continue;
      const area = node.clientWidth * node.clientHeight;
      if (area > bestArea) {
        bestArea = area;
        el = node;
      }
    }
  }

  // 網站若設了 scroll-behavior: smooth，逐格捲動會被拖慢，暫時關掉
  root.style.setProperty('scroll-behavior', 'auto', 'important');
  el.style.setProperty('scroll-behavior', 'auto', 'important');
  window.__eagleScroll = { el, stop: false };
}

export function runScroll(speed) {
  const state = window.__eagleScroll;
  if (!state) return;
  const { el } = state;
  let pos = el.scrollTop;
  let last = null;
  let bottomSince = null;

  function step(ts) {
    if (state.stop) return;
    if (last === null) last = ts;
    const dt = Math.min(ts - last, 100) / 1000;
    last = ts;

    const max = el.scrollHeight - el.clientHeight;
    pos = Math.min(pos + speed * dt, max);
    el.scrollTop = pos;

    // 到底後停留一下，等延遲載入的內容把頁面撐長；長度沒變才算真的到底
    if (pos >= max - 1) {
      bottomSince ??= ts;
      if (ts - bottomSince > 1500) {
        chrome.runtime.sendMessage({ target: 'background', type: 'scroll-done' });
        return;
      }
    } else {
      bottomSince = null;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

export function cancelScroll() {
  if (window.__eagleScroll) window.__eagleScroll.stop = true;
}
