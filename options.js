const EAGLE = 'http://localhost:41595';
const select = document.getElementById('folder');
const status = document.getElementById('status');

function flatten(folders, depth = 0, out = []) {
  for (const f of folders) {
    out.push({ id: f.id, label: `${'　'.repeat(depth)}${f.name}` });
    if (f.children?.length) flatten(f.children, depth + 1, out);
  }
  return out;
}

async function load() {
  status.textContent = '讀取中…';
  select.length = 1;
  const { folderId = '', token = '' } = await chrome.storage.local.get(['folderId', 'token']);
  try {
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const json = await (await fetch(`${EAGLE}/api/folder/list${query}`)).json();
    if (json.status !== 'success') throw new Error();
    for (const { id, label } of flatten(json.data)) select.add(new Option(label, id));
    select.value = folderId;
    if (select.value !== folderId) {
      select.value = '';
      status.textContent = '原本選的資料夾不存在了';
    } else {
      status.textContent = '';
    }
  } catch {
    status.textContent = '連不到 Eagle，請確認 Eagle 已開啟';
  }
}

select.addEventListener('change', async () => {
  await chrome.storage.local.set({ folderId: select.value });
  status.textContent = '已儲存';
});
document.getElementById('reload').addEventListener('click', load);
load();

const speed = document.getElementById('speed');
const speedStatus = document.getElementById('speedStatus');
chrome.storage.local.get('scrollSpeed').then(({ scrollSpeed }) => {
  if (scrollSpeed) speed.value = scrollSpeed;
});
speed.addEventListener('change', async () => {
  const value = Math.min(3000, Math.max(50, Number(speed.value) || 450));
  speed.value = value;
  await chrome.storage.local.set({ scrollSpeed: value });
  speedStatus.textContent = '已儲存';
});
