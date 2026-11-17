const EAGLE = 'http://localhost:41595';
const DOWNLOAD_DIR = 'eagle-recorder';

// ---------- 狀態（存在 session storage，service worker 被回收也不會遺失） ----------
const getState = async () => (await chrome.storage.session.get('rec')).rec || null;
const setState = (rec) => chrome.storage.session.set({ rec });

function setBadge(text, color = '#d93025', title) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (title) chrome.action.setTitle({ title });
}

// ---------- 點圖示：開始／停止 ----------
chrome.action.onClicked.addListener(async (tab) => {
  const rec = await getState();
  if (rec) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
    setBadge('…', '#888', '處理中…');
    return;
  }
  try {
    await eagleCheck();
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await setState({
      tabId: tab.id,
      title: tab.title || 'Untitled',
      url: tab.url,
      startedAt: Date.now(),
    });
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId });
  } catch (err) {
    await setState(null);
    showError(err);
  }
});

// ---------- offscreen 回報 ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'started') setBadge('REC', '#d93025', '停止錄影並存到 Eagle');
  if (msg.type === 'recorded') handleRecorded(msg.blobUrl, msg.ext).catch(showError);
  if (msg.type === 'error') {
    setState(null);
    showError(msg.message);
  }
});

async function handleRecorded(blobUrl, ext = 'webm') {
  const rec = await getState();
  await setState(null);
  if (!rec) return;

  const stamp = new Date(rec.startedAt);
  const fileStamp = stamp.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeTitle = rec.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

  const path = await downloadAndWait(blobUrl, `${DOWNLOAD_DIR}/${safeTitle} ${fileStamp}.${ext}`);
  const { tags = ['screen-recording'], folderId = '', token = '' } =
    await chrome.storage.local.get(['tags', 'folderId', 'token']);
  const query = token ? `?token=${encodeURIComponent(token)}` : '';

  const res = await fetch(`${EAGLE}/api/item/addFromPath${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      name: rec.title,
      website: rec.url,
      tags,
      ...(folderId && { folderId }),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 'success') throw new Error(`Eagle 匯入失敗：${JSON.stringify(json)}`);

  setBadge('✓', '#188038', '已存到 Eagle，點擊開始新錄影');
  setTimeout(() => setBadge('', '#888', '開始錄影（存到 Eagle）'), 3000);
  await chrome.offscreen.closeDocument().catch(() => {});
}

// ---------- 工具 ----------
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
