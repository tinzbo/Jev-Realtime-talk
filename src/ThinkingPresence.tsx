import { useEffect, useRef, useState } from 'react';
import { decodedFrame, readyVideo, startPlayback, watchPlayback } from './playback';
import './ThinkingPresence.css';

interface ThinkingPresenceProps { url?: string; waiting: boolean; }

/** A quiet gesture for longer pauses; never delays or owns the actual reply. */
export default function ThinkingPresence({ url, waiting }: ThinkingPresenceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visibleSource, setVisibleSource] = useState<string | null>(null);

  useEffect(() => {
    setVisibleSource(null);
    const video = videoRef.current;
    if (!waiting || !url || !video) return;
    const controller = new AbortController();
    const { signal } = controller;
    let revealed = false;
    const hide = () => {
      if (signal.aborted) return;
      controller.abort(); video.pause(); setVisibleSource(null);
      if (!revealed && video.hasAttribute('src')) {
        video.removeAttribute('src'); video.load();
      }
    };
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await readyVideo(video, url, signal);
          if (signal.aborted) return;
          video.muted = true;
          await startPlayback(video, signal);
          await decodedFrame(video, signal);
          if (signal.aborted) return;
          revealed = true; setVisibleSource(url);
          watchPlayback(video, signal, hide);
        } catch {
          // The listening layer remains available if this optional gesture fails.
          hide();
        }
      })();
    }, 400);

    return () => {
      clearTimeout(timer); controller.abort(); video.pause();
      if (!revealed && video.hasAttribute('src')) {
        video.removeAttribute('src'); video.load();
      }
    };
  }, [url, waiting]);

  return <video ref={videoRef} className={`thinking-video ${waiting && visibleSource === url ? 'is-visible' : ''}`} muted loop playsInline preload="metadata" aria-hidden="true" />;
}
