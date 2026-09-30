/** Turns fence routing responses, video loads and playback events together. */
export class TurnGate {
  private current = 0;
  next(): number { return ++this.current; }
  cancel(): void { ++this.current; }
  accept(id: number): boolean { return id === this.current; }
}

/** Some audio-output failures leave play() resolved but the media clock frozen. */
export function watchPlayback(video: HTMLVideoElement, signal: AbortSignal, onFailure: () => void, now = () => performance.now()): () => void {
  if (signal.aborted) return () => {};
  let previousTime = video.currentTime, lastProgress = now(), watching = true;
  const cleanup = () => {
    watching = false; clearInterval(timer);
    video.removeEventListener('ended', cleanup); video.removeEventListener('error', failed);
    signal.removeEventListener('abort', cleanup);
  };
  const failed = () => { if (watching) { cleanup(); onFailure(); } };
  const timer = setInterval(() => {
    if (video.ended || signal.aborted) { cleanup(); return; }
    if (video.currentTime !== previousTime) { previousTime = video.currentTime; lastProgress = now(); }
    else if (now() - lastProgress >= 4000) failed();
  }, 250);
  video.addEventListener('ended', cleanup, { once: true });
  video.addEventListener('error', failed, { once: true });
  signal.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}

export function readyVideo(video: HTMLVideoElement, url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('canplay', ready); video.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('视频加载失败')); };
    const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('视频加载超时')); }, 8000);
    if (signal.aborted) { aborted(); return; }
    video.addEventListener('canplay', ready, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
    if (video.getAttribute('src') === url && video.readyState >= 3) { video.currentTime = 0; ready(); }
    else { video.src = url; video.load(); }
  });
}

/** Decode offscreen before revealing a response; always release the frame callback. */
export function decodedFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let frame: number | undefined;
    const finish = () => {
      clearTimeout(timer);
      if (frame !== undefined) video.cancelVideoFrameCallback?.(frame);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) { finish(); return; }
    if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(finish);
    else finish();
  });
}
