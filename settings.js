// 背景、選單、分類視窗共用的設定預設值
export const DEFAULTS = {
  scrollSpeed: 450,
  resolution: '1440',
  bitrate: 4,
  folderId: '',
  tags: [],
};

export const RESOLUTIONS = {
  1080: { label: '1080p', width: 1920, height: 1080 },
  1440: { label: '2K', width: 2560, height: 1440 },
  2160: { label: '4K', width: 3840, height: 2160 },
};

export const BITRATES = [2, 4, 8];

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}
