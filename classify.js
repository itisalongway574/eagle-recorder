const EAGLE = 'http://localhost:41595';
const RECENT_LIMIT = 50;
const SEARCH_LIMIT = 100;

const $ = (id) => document.getElementById(id);
const els = {
  preview: $('preview'),
  meta: $('meta'),
  name: $('name'),
  url: $('url'),
  selected: $('selected'),
  tagInput: $('tagInput'),
  listTitle: $('listTitle'),
  tagList: $('tagList'),
  folder: $('folder'),
  save: $('save'),
  error: $('error'),
};

let selected = [];
let recentTags = [];
let allTags = [];
let token = '';

const api = async (path) => {
  const sep = path.includes('?') ? '&' : '?';
  const query = token ? `${sep}token=${encodeURIComponent(token)}` : '';
  const json = await (await fetch(`${EAGLE}/api/${path}${query}`)).json();
  if (json.status !== 'success') throw new Error(json.message || path);
  return json.data;
};

function flattenFolders(folders, depth = 0, out = []) {
  for (const f of folders) {
    out.push({ id: f.id, label: `${'　'.repeat(depth)}${f.name}` });
    if (f.children?.length) flattenFolders(f.children, depth + 1, out);
  }
  return out;
}

// ---------- 標籤 ----------
function toggleTag(name) {
  const i = selected.indexOf(name);
  if (i === -1) selected.push(name);
  else selected.splice(i, 1);
  render();
}

function addTypedTag() {
  const text = els.tagInput.value.trim();
  if (!text) return;
  const existing = allTags.find((t) => t.toLowerCase() === text.toLowerCase()) || text;
  if (!selected.includes(existing)) selected.push(existing);
  els.tagInput.value = '';
  render();
}

function chip(label, { on = false, isNew = false, removable = false, onClick }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `chip${on ? ' on' : ''}${isNew ? ' new' : ''}`;
  b.textContent = label;
  if (removable) {
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    b.append(x);
  }
  b.addEventListener('click', onClick);
  return b;
}

function render() {
  els.selected.replaceChildren(
    ...selected.map((t) => chip(t, { on: true, removable: true, onClick: () => toggleTag(t) })),
  );

  const q = els.tagInput.value.trim().toLowerCase();
  let list;
  if (q) {
    els.listTitle.textContent = '搜尋結果';
    list = allTags.filter((t) => t.toLowerCase().includes(q)).slice(0, SEARCH_LIMIT);
  } else {
    els.listTitle.textContent = `最近使用的 ${RECENT_LIMIT} 個標籤`;
    list = recentTags;
  }

  const nodes = list.map((t) => chip(t, { on: selected.includes(t), onClick: () => toggleTag(t) }));
  if (q && !allTags.some((t) => t.toLowerCase() === q)) {
    const text = els.tagInput.value.trim();
    nodes.unshift(chip(`＋ 新增「${text}」`, { isNew: true, onClick: addTypedTag }));
  }
  if (!nodes.length) {
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = q ? '沒有符合的標籤' : '還沒有標籤';
    nodes.push(empty);
  }
  els.tagList.replaceChildren(...nodes);
}

els.tagInput.addEventListener('input', render);
els.tagInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    addTypedTag();
  } else if (e.key === 'Backspace' && !els.tagInput.value && selected.length) {
    selected.pop();
    render();
  }
});

// ---------- 儲存 ----------
async function save() {
  els.save.disabled = true;
  els.error.textContent = '';
  if (els.tagInput.value.trim()) addTypedTag();
  const res = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'classify-save',
    data: {
      name: els.name.value,
      website: els.url.value,
      tags: selected,
      folderId: els.folder.value,
    },
  });
  if (!res?.ok) {
    els.error.textContent = res?.error || '儲存失敗';
    els.save.disabled = false;
  }
}

els.save.addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
    e.preventDefault();
    save();
  } else if (e.key === 'Escape') {
    window.close();
  }
});

// ---------- 初始化 ----------
async function init() {
  const { pending } = await chrome.storage.session.get('pending');
  if (!pending) {
    document.body.innerHTML = '<p style="padding:16px">沒有待分類的錄影。</p>';
    return;
  }

  const stored = await chrome.storage.local.get(['tags', 'folderId', 'token']);
  token = stored.token || '';
  selected = [...(stored.tags ?? [])];

  els.name.value = pending.title;
  els.url.value = pending.url;
  els.preview.src = pending.blobUrl;
  els.preview.addEventListener('error', () => els.preview.remove(), { once: true });
  if (pending.size) {
    const mb = pending.size / 1024 / 1024;
    els.meta.textContent = `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB・${(pending.ext || 'webm').toUpperCase()}`;
  }
  render();
  els.tagInput.focus();

  const [recent, all, folders] = await Promise.allSettled([
    api('tag/listRecent'),
    api('tag/list'),
    api('folder/list'),
  ]);

  if (all.status === 'fulfilled') allTags = all.value.map((t) => t.name);
  recentTags =
    recent.status === 'fulfilled'
      ? recent.value.map((t) => t.name).slice(0, RECENT_LIMIT)
      : allTags.slice(0, RECENT_LIMIT);

  if (folders.status === 'fulfilled') {
    for (const { id, label } of flattenFolders(folders.value)) els.folder.add(new Option(label, id));
    els.folder.value = stored.folderId || '';
    if (els.folder.value !== (stored.folderId || '')) els.folder.value = '';
  }
  if (all.status === 'rejected' && recent.status === 'rejected') {
    els.error.textContent = '讀不到 Eagle 的標籤，請確認 Eagle 已開啟';
  }
  render();
}

init();
