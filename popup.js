import { getSettings, RESOLUTIONS, BITRATES } from './settings.js';

const EAGLE = 'http://localhost:41595';
const $ = (id) => document.getElementById(id);

// 這頁同時當作擴充功能的「選項」頁；不是從工具列打開時只顯示設定
const isPopup = chrome.extension.getViews({ type: 'popup' }).includes(window);

const save = (patch) => chrome.storage.local.set(patch);
const showError = (msg) => ($('error').textContent = msg);

// ---------- 錄影控制 ----------
async function start(mode) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'popup-start',
      mode,
      streamId,
      tab: { id: tab.id, title: tab.title, url: tab.url },
    }).catch(() => {});
    window.close();
  } catch (err) {
    showError(`無法錄製這個分頁：${err?.message || err}`);
  }
}

$('normal').addEventListener('click', () => start('normal'));
$('scroll').addEventListener('click', () => start('scroll'));
$('stop').addEventListener('click', async () => {
  chrome.runtime.sendMessage({ target: 'background', type: 'popup-stop' }).catch(() => {});
  window.close();
});
$('editKeys').addEventListener('click', () => {
  const isEdge = navigator.userAgent.includes('Edg/');
  chrome.tabs.create({ url: `${isEdge ? 'edge' : 'chrome'}://extensions/shortcuts` });
});

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const key = (name) => commands.find((c) => c.name === name)?.shortcut || '未設定';
  $('normalKey').textContent = key('normal-record');
  $('scrollKey').textContent = key('scroll-record');
}

let timer = null;
async function renderStatus() {
  const { rec, pending } = await chrome.storage.session.get(['rec', 'pending']);
  $('idle').hidden = !isPopup || !!rec || !!pending;
  $('recording').hidden = !isPopup || !rec;
  $('pending').hidden = !isPopup || !pending || !!rec;

  clearInterval(timer);
  if (rec) {
    $('recLabel').textContent = rec.mode === 'scroll' ? '捲動錄影中' : '錄影中';
    const tick = () => {
      const s = Math.floor((Date.now() - rec.startedAt) / 1000);
      $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    timer = setInterval(tick, 500);
  }
  if (pending) {
    $('focusClassify').onclick = () => chrome.windows.update(pending.windowId, { focused: true });
  }
}
chrome.storage.session.onChanged.addListener(renderStatus);

// ---------- 設定 ----------
function segmented(container, options, current, onPick) {
  container.replaceChildren(
    ...options.map(({ value, label }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(String(value) === String(current)));
      b.addEventListener('click', () => {
        for (const other of container.children) other.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        onPick(value);
      });
      return b;
    }),
  );
}

const sizeText = (mbps) => `約 ${Math.round((mbps * 60) / 8)} MB／分鐘`;

async function renderSettings() {
  const s = await getSettings();

  const speed = $('speed');
  speed.value = Math.min(2000, Math.max(100, Number(s.scrollSpeed)));
  const speedLabel = () => ($('speedOut').textContent = `${speed.value} px／秒`);
  speedLabel();
  speed.addEventListener('input', speedLabel);
  speed.addEventListener('change', () => save({ scrollSpeed: Number(speed.value) }));

  segmented(
    $('resolution'),
    Object.entries(RESOLUTIONS).map(([value, r]) => ({ value, label: r.label })),
    s.resolution,
    (value) => save({ resolution: value }),
  );

  $('sizeOut').textContent = sizeText(s.bitrate);
  segmented(
    $('bitrate'),
    BITRATES.map((v) => ({ value: v, label: `${v} Mbps` })),
    s.bitrate,
    (value) => {
      $('sizeOut').textContent = sizeText(value);
      save({ bitrate: value });
    },
  );

  const folder = $('folder');
  folder.addEventListener('change', () => save({ folderId: folder.value }));
  try {
    const { token = '' } = await chrome.storage.local.get('token');
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const json = await (await fetch(`${EAGLE}/api/folder/list${query}`)).json();
    if (json.status !== 'success') throw new Error();
    const flatten = (list, depth = 0) =>
      list.flatMap((f) => [{ id: f.id, label: `${'　'.repeat(depth)}${f.name}` }, ...flatten(f.children || [], depth + 1)]);
    for (const { id, label } of flatten(json.data)) folder.add(new Option(label, id));
    folder.value = s.folderId;
    if (folder.value !== s.folderId) folder.value = '';
  } catch {
    showError('連不到 Eagle，請確認 Eagle 已開啟');
  }
}

renderShortcuts();
renderStatus();
renderSettings();
