let recorder = null;
let chunks = [];
let stream = null;
let audioCtx = null;
let acquiring = null;
let options = {};
let extraTracks = [];

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    // 範圍錄影會先拿到畫面串流，等使用者框選完再收到 begin 才開始錄
    options = msg.options || {};
    acquiring = acquire(msg.streamId);
    acquiring.catch(fail);
    if (!msg.deferred) acquiring.then(() => begin(null)).catch(fail);
  }
  if (msg.type === 'begin') acquiring?.then(() => begin(msg.crop)).catch(fail);
  if (msg.type === 'cancel') cancel();
  if (msg.type === 'stop') stop();
});

function fail(err) {
  chrome.runtime.sendMessage({ target: 'background', type: 'error', message: String(err?.message || err) });
}

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function acquire(streamId) {
  const { maxWidth = 2560, maxHeight = 1440 } = options;
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const dpr = window.devicePixelRatio || 1;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: source },
    video: {
      mandatory: {
        ...source,
        maxWidth: Math.min(Math.round(screen.width * dpr), maxWidth),
        maxHeight: Math.min(Math.round(screen.height * dpr), maxHeight),
        maxFrameRate: 30,
      },
    },
  });

  // tabCapture 會讓分頁靜音，把聲音接回喇叭
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  // 分頁關閉或擷取中斷時自動收尾
  stream.getVideoTracks()[0].onended = () => (recorder ? stop() : cancel());
}

// 把整個分頁畫面裁成框選的範圍：crop 是 CSS px，依實際畫面大小換算成像素
function cropTrack(track, crop) {
  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const even = (n) => Math.max(2, n - (n % 2));

  const transformer = new TransformStream({
    transform(frame, controller) {
      const src = frame.visibleRect;
      const sx = src.width / crop.vw;
      const sy = src.height / crop.vh;
      // 起點往內取偶數、寬高往內縮，確保外圍提示框不會被裁進畫面
      let x = Math.ceil((crop.x * sx) / 2) * 2;
      let y = Math.ceil((crop.y * sy) / 2) * 2;
      const right = Math.min(Math.floor((crop.x + crop.w) * sx), src.width);
      const bottom = Math.min(Math.floor((crop.y + crop.h) * sy), src.height);
      const width = even(right - x);
      const height = even(bottom - y);
      x = Math.min(x, src.width - width);
      y = Math.min(y, src.height - height);
      const out = new VideoFrame(frame, {
        visibleRect: { x: src.x + x, y: src.y + y, width, height },
      });
      frame.close();
      controller.enqueue(out);
    },
  });

  processor.readable.pipeThrough(transformer).pipeTo(generator.writable).catch(() => {});
  return generator;
}

function begin(crop) {
  if (!stream || recorder) return;

  let recStream = stream;
  if (crop) {
    const cropped = cropTrack(stream.getVideoTracks()[0], crop);
    extraTracks = [cropped];
    recStream = new MediaStream([cropped, ...stream.getAudioTracks()]);
  }

  chunks = [];
  recorder = new MediaRecorder(recStream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: (options.bitrate || 4) * 1_000_000,
  });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const type = recorder.mimeType.split(';')[0] || 'video/webm';
    const blob = new Blob(chunks, { type });
    cleanup();
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'recorded',
      blobUrl: URL.createObjectURL(blob),
      ext: type === 'video/mp4' ? 'mp4' : 'webm',
      size: blob.size,
    });
  };
  recorder.start(1000);
  chrome.runtime.sendMessage({ target: 'background', type: 'started' });
}

function cleanup() {
  chunks = [];
  stream?.getTracks().forEach((t) => t.stop());
  extraTracks.forEach((t) => t.stop());
  audioCtx?.close();
  recorder = stream = audioCtx = acquiring = null;
  extraTracks = [];
}

function cancel() {
  if (recorder?.state === 'recording') {
    recorder.onstop = null;
    recorder.stop();
  }
  cleanup();
}

function stop() {
  if (recorder?.state === 'recording') recorder.stop();
}
