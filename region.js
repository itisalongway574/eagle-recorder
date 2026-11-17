// 這些函式會透過 chrome.scripting.executeScript 注入網頁，必須各自獨立、不能引用外部變數。

// 讓使用者在網頁上拖曳框選範圍；回傳 { x, y, w, h, vw, vh }（CSS px），取消則回傳 null
export function selectRegion() {
  return new Promise((resolve) => {
    document.getElementById('__eagle_region_select')?.remove();

    const host = document.createElement('div');
    host.id = '__eagle_region_select';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .layer { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; background: rgba(0,0,0,.4); }
        .layer.has-box { background: transparent; }
        .box { position: fixed; display: none; outline: 2px solid #3d7bff; box-shadow: 0 0 0 100vmax rgba(0,0,0,.4); }
        .size { position: absolute; left: 0; top: -26px; padding: 2px 6px; border-radius: 4px; background: #3d7bff; color: #fff;
                font: 12px/18px system-ui, sans-serif; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .tip { position: fixed; left: 50%; top: 20px; transform: translateX(-50%); padding: 6px 12px; border-radius: 999px;
               background: rgba(20,21,24,.9); color: #fff; font: 13px system-ui, "PingFang TC", sans-serif; pointer-events: none; }
        .bar { position: fixed; display: none; gap: 6px; }
        button { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 6px; background: #2a2b2f; color: #fff;
                 font: 600 13px system-ui, "PingFang TC", sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
        button.go { background: #3d7bff; }
      </style>
      <div class="layer"></div>
      <div class="box"><span class="size"></span></div>
      <div class="tip">拖曳框選要錄影的範圍・Enter 開始・Esc 取消</div>
      <div class="bar"><button data-a="redo">重選</button><button class="go" data-a="go">開始錄影</button></div>
    `;
    document.documentElement.append(host);

    const layer = root.querySelector('.layer');
    const box = root.querySelector('.box');
    const size = root.querySelector('.size');
    const bar = root.querySelector('.bar');
    let start = null;
    let rect = null;

    const draw = () => {
      Object.assign(box.style, {
        display: 'block',
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.w}px`,
        height: `${rect.h}px`,
      });
      size.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
      size.style.top = rect.y < 30 ? '6px' : '-26px';
      size.style.left = rect.y < 30 ? '6px' : '0';
    };

    const placeBar = () => {
      bar.style.display = 'flex';
      const below = rect.y + rect.h + 10;
      const top = below + 36 > innerHeight ? Math.max(rect.y - 46, 10) : below;
      bar.style.top = `${top}px`;
      bar.style.left = `${Math.max(10, Math.min(rect.x + rect.w - 170, innerWidth - 180))}px`;
    };

    const reset = () => {
      rect = start = null;
      box.style.display = 'none';
      bar.style.display = 'none';
      layer.classList.remove('has-box');
    };

    const finish = (result) => {
      removeEventListener('keydown', onKey, true);
      delete window.__eagleRegionCancel;
      host.remove();
      // 等畫面重繪兩次，確保框選介面已經消失才開始錄
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
    };

    const go = () => {
      if (rect) finish({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, vw: innerWidth, vh: innerHeight });
    };

    layer.addEventListener('pointerdown', (e) => {
      reset();
      start = { x: e.clientX, y: e.clientY };
      layer.setPointerCapture(e.pointerId);
    });
    layer.addEventListener('pointermove', (e) => {
      if (!start) return;
      const x = Math.max(0, Math.min(start.x, e.clientX));
      const y = Math.max(0, Math.min(start.y, e.clientY));
      rect = {
        x,
        y,
        w: Math.min(innerWidth, Math.max(start.x, e.clientX)) - x,
        h: Math.min(innerHeight, Math.max(start.y, e.clientY)) - y,
      };
      layer.classList.add('has-box');
      draw();
    });
    layer.addEventListener('pointerup', () => {
      start = null;
      if (!rect || rect.w < 20 || rect.h < 20) return reset();
      placeBar();
    });
    bar.addEventListener('click', (e) => {
      const action = e.target.closest('button')?.dataset.a;
      if (action === 'redo') reset();
      if (action === 'go') go();
    });

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === 'Enter' && rect) {
        e.preventDefault();
        e.stopPropagation();
        go();
      }
    };
    addEventListener('keydown', onKey, true);
    window.__eagleRegionCancel = () => finish(null);
  });
}

export function cancelRegionSelect() {
  window.__eagleRegionCancel?.();
}

// 錄影中在範圍外圍畫虛線框，框線落在裁切範圍外，不會被錄進去
export function showRegionFrame(rect) {
  document.getElementById('__eagle_region_frame')?.remove();
  const frame = document.createElement('div');
  frame.id = '__eagle_region_frame';
  Object.assign(frame.style, {
    position: 'fixed',
    left: `${rect.x - 4}px`,
    top: `${rect.y - 4}px`,
    width: `${rect.w + 8}px`,
    height: `${rect.h + 8}px`,
    border: '2px dashed #ff5a5f',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  document.documentElement.append(frame);
}

export function hideRegionFrame() {
  document.getElementById('__eagle_region_frame')?.remove();
}
