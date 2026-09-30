/** Turns fence routing responses, video loads and playback events together. */
export class TurnGate {
  private current = 0;
  next(): number { return ++this.current; }
  cancel(): void { ++this.current; }
  accept(id: number): boolean { return id === this.current; }
}

/** Bound startup as well as playback, without touching a reused element later. */
export function startPlayback(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener('abort', aborted);
      video.removeEventListener('error', failedMedia);
    };
    const failed = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); video.pause(); reject(error);
    };
    const aborted = () => failed(new DOMException('Aborted', 'AbortError'));
    const failedMedia = () => failed(new Error('视频播放失败'));
    const timer = setTimeout(() => failed(new Error('视频启动超时')), 4000);
    signal.addEventListener('abort', aborted, { once: true });
    video.addEventListener('error', failedMedia, { once: true });
    try {
      void Promise.resolve(video.play()).then(() => {
        if (settled) return;
        settled = true; cleanup(); resolve();
      }, failed);
    } catch (error) { failed(error); }
  });
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
