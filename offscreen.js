let recorder = null;
let chunks = [];
let stream = null;
let audioCtx = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start') start(msg.streamId, msg.options).catch(fail);
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

async function start(streamId, { maxWidth = 2560, maxHeight = 1440, bitrate = 4 } = {}) {
  if (recorder?.state === 'recording') return;

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

  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: pickMimeType(), videoBitsPerSecond: bitrate * 1_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const type = recorder.mimeType.split(';')[0] || 'video/webm';
    const blob = new Blob(chunks, { type });
    chunks = [];
    stream.getTracks().forEach((t) => t.stop());
    audioCtx?.close();
    recorder = stream = audioCtx = null;
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'recorded',
      blobUrl: URL.createObjectURL(blob),
      ext: type === 'video/mp4' ? 'mp4' : 'webm',
      size: blob.size,
    });
  };
  // 分頁關閉或擷取中斷時自動收尾
  stream.getVideoTracks()[0].onended = stop;
  recorder.start(1000);
  chrome.runtime.sendMessage({ target: 'background', type: 'started' });
}

function stop() {
  if (recorder?.state === 'recording') recorder.stop();
}
