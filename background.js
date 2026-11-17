import { prepareScroll, runScroll, cancelScroll } from './scroller.js';
import { getSettings, RESOLUTIONS, DEFAULTS } from './settings.js';
import { selectRegion, cancelRegionSelect, showRegionFrame, hideRegionFrame } from './region.js';

const EAGLE = 'http://localhost:41595';
const DOWNLOAD_DIR = 'eagle-recorder';

// ---------- 狀態（存在 session storage，service worker 被回收也不會遺失） ----------
const getState = async () => (await chrome.storage.session.get('rec')).rec || null;
const setState = (rec) => chrome.storage.session.set({ rec });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setBadge(text, color = '#d93025', title) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (title) chrome.action.setTitle({ title });
}

// ---------- 觸發方式：快捷鍵，或點圖示開選單（popup.js 傳訊息過來） ----------
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'normal-record') toggle(tab, 'normal');
  if (command === 'scroll-record') toggle(tab, 'scroll');
  if (command === 'region-record') toggle(tab, 'region');
});

async function toggle(tab, mode) {
  const rec = await getState();
  if (rec) return stopRecording(rec);
  startRecording(tab, mode);
}

// streamId 由選單先取得時直接沿用；快捷鍵觸發時才在這裡取
async function startRecording(tab, mode, streamId) {
  try {
    await eagleCheck();
    if (mode === 'scroll') await inject(tab.id, prepareScroll);
    await ensureOffscreen();
    streamId ??= await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const settings = await getSettings();
    const res = RESOLUTIONS[settings.resolution] || RESOLUTIONS[DEFAULTS.resolution];
    const isRegion = mode === 'region';
    await setState({
      tabId: tab.id,
      mode,
      phase: isRegion ? 'selecting' : 'recording',
      title: tab.title || 'Untitled',
      url: tab.url,
      startedAt: Date.now(),
    });
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start',
      streamId,
      deferred: isRegion,
      options: { maxWidth: res.width, maxHeight: res.height, bitrate: Number(settings.bitrate) || DEFAULTS.bitrate },
    });
    if (isRegion) await runRegionSelect(tab.id);
  } catch (err) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel' }).catch(() => {});
    await setState(null);
    showError(err);
  }
}

// 範圍錄影：先讓使用者在網頁上框選，框好才真正開始錄
async function runRegionSelect(tabId) {
  setBadge('…', '#3d7bff', '框選錄影範圍中');
  const [{ result: crop } = {}] = await inject(tabId, selectRegion);
  const rec = await getState();
  if (!crop || !rec || rec.stopping) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel' }).catch(() => {});
    await setState(null);
    setBadge('', '#888', 'Eagle Tab Recorder');
    await chrome.offscreen.closeDocument().catch(() => {});
    return;
  }
  await setState({ ...rec, phase: 'recording', crop, startedAt: Date.now() });
  await inject(tabId, showRegionFrame, [crop]).catch(() => {});
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'begin', crop });
}

async function stopRecording(rec) {
  if (rec.stopping) return;
  // 還在框選時再按一次＝取消框選
  if (rec.phase === 'selecting') return inject(rec.tabId, cancelRegionSelect).catch(() => {});
  await setState({ ...rec, stopping: true });
  if (rec.mode === 'scroll') await inject(rec.tabId, cancelScroll).catch(() => {});
  if (rec.mode === 'region') await inject(rec.tabId, hideRegionFrame).catch(() => {});
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  setBadge('…', '#888', '處理中…');
}

// ---------- offscreen／網頁回報 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'classify-save') {
    finishPending(msg.data).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
    );
    return true;
  }
  if (msg.type === 'popup-start') startRecording(msg.tab, msg.mode, msg.streamId);
  if (msg.type === 'popup-stop') getState().then((rec) => rec && stopRecording(rec));
  if (msg.type === 'started') onStarted().catch(showError);
  if (msg.type === 'scroll-done') onScrollDone().catch(showError);
  if (msg.type === 'recorded') handleRecorded(msg.blobUrl, msg.ext, msg.size).catch(showError);
  if (msg.type === 'error') {
    getState().then((rec) => rec?.mode === 'region' && inject(rec.tabId, hideRegionFrame).catch(() => {}));
    setState(null);
    showError(msg.message);
  }
});

async function onStarted() {
  setBadge('REC', '#d93025', '停止錄影並存到 Eagle');
  const rec = await getState();
  if (rec?.mode !== 'scroll') return;
  // 開頭先停一下，影片開頭才會有一段靜止的起始畫面
  await sleep(800);
  const { scrollSpeed } = await getSettings();
  await inject(rec.tabId, runScroll, [Number(scrollSpeed) || DEFAULTS.scrollSpeed]);
}

async function onScrollDone() {
  const rec = await getState();
  if (!rec || rec.mode !== 'scroll') return;
  await sleep(500);
  stopRecording(await getState());
}

async function handleRecorded(blobUrl, ext = 'webm', size = 0) {
  const rec = await getState();
  await setState(null);
  if (!rec) return;

  const stamp = new Date(rec.startedAt);
  const fileStamp = stamp.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeTitle = rec.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

  const path = await downloadAndWait(blobUrl, `${DOWNLOAD_DIR}/${safeTitle} ${fileStamp}.${ext}`);

  // 上一支還沒分類完就先照預設存掉，避免被新的蓋過
  if (await getPending()) await finishPending(null).catch(showError);

  const win = await chrome.windows.create({
    url: 'classify.html',
    type: 'popup',
    width: 860,
    height: 680,
    focused: true,
  });
  await setPending({ path, title: rec.title, url: rec.url, blobUrl, size, ext, windowId: win.id });
  setBadge('…', '#888', '等待分類');
}

// ---------- 分類視窗 ----------
const getPending = async () => (await chrome.storage.session.get('pending')).pending || null;
const setPending = (pending) => chrome.storage.session.set({ pending });

// 視窗被直接關掉（或按 Esc）時照預設值存，錄好的影片不會遺失
chrome.windows.onRemoved.addListener(async (windowId) => {
  const pending = await getPending();
  if (pending?.windowId === windowId) finishPending(null).catch(showError);
});

async function finishPending(data) {
  const pending = await getPending();
  if (!pending) return;
  await setPending(null);

  const defaults = await chrome.storage.local.get(['tags', 'folderId']);
  try {
    await importToEagle({
      path: pending.path,
      name: data?.name?.trim() || pending.title,
      website: data?.website?.trim() ?? pending.url,
      tags: data?.tags ?? defaults.tags ?? [],
      folderId: data ? data.folderId : defaults.folderId,
    });
  } catch (err) {
    if (data) await setPending(pending);
    throw err;
  }

  if (data) chrome.windows.remove(pending.windowId).catch(() => {});
  setBadge('✓', '#188038', '已存到 Eagle，點擊開始新錄影');
  setTimeout(() => setBadge('', '#888', '開始錄影（存到 Eagle）'), 3000);
  await chrome.offscreen.closeDocument().catch(() => {});
}

async function importToEagle({ path, name, website, tags, folderId }) {
  const { token = '' } = await chrome.storage.local.get('token');
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const res = await fetch(`${EAGLE}/api/item/addFromPath${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, name, website, tags, ...(folderId && { folderId }) }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 'success') throw new Error(`Eagle 匯入失敗：${JSON.stringify(json)}`);
}

// ---------- 工具 ----------
function inject(tabId, func, args = []) {
  return chrome.scripting.executeScript({ target: { tabId }, func, args });
}

async function eagleCheck() {
  try {
    const res = await fetch(`${EAGLE}/api/application/info`);
    const json = await res.json();
    if (json.status !== 'success') throw new Error();
  } catch {
    throw new Error('連不到 Eagle，請確認 Eagle 已開啟');
  }
}

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument?.();
  if (exists) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '用 MediaRecorder 錄製分頁畫面',
  });
}

function downloadAndWait(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        return reject(new Error(chrome.runtime.lastError?.message || '下載失敗'));
      }
      const onChanged = async (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(onChanged);
          const [item] = await chrome.downloads.search({ id });
          resolve(item.filename);
        } else if (delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error('下載中斷'));
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  });
}

function showError(err) {
  const message = String(err?.message || err);
  console.error('[eagle-recorder]', message);
  setBadge('ERR', '#d93025', `錯誤：${message}`);
  setTimeout(() => setBadge('', '#888', '開始錄影（存到 Eagle）'), 5000);
}
