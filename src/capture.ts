export interface Capture {
  sampleRate: number;
  setEnabled(enabled: boolean): void;
  close(): void;
}
export type CaptureFactory = (signal: AbortSignal, onFrame: (frame: Float32Array) => void, onLost: () => void) => Promise<Capture>;

const processor = `class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(1024); this.offset = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      this.buffer[this.offset++] = sample;
      if (this.offset === 1024) { this.port.postMessage(this.buffer, [this.buffer.buffer]); this.buffer = new Float32Array(1024); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor('xtasy-capture', CaptureProcessor);`;

async function wire(context: AudioContext, source: AudioNode, onFrame: (frame: Float32Array) => void): Promise<AudioWorkletNode> {
  const url = URL.createObjectURL(new Blob([processor], { type: 'text/javascript' }));
  try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const node = new AudioWorkletNode(context, 'xtasy-capture');
  const silence = context.createGain(); silence.gain.value = 0;
  source.connect(node); node.connect(silence); silence.connect(context.destination);
  node.port.onmessage = event => onFrame(event.data as Float32Array);
  return node;
}

export const captureMicrophone: CaptureFactory = async (signal, onFrame, onLost) => {
  const context = new AudioContext({ sampleRate: 16000 });
  let stream: MediaStream | undefined, node: AudioWorkletNode | undefined, closed = false;
  const close = () => {
    if (closed) return; closed = true;
    signal.removeEventListener('abort', close);
    if (node) { node.port.onmessage = null; node.disconnect(); }
    stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    void context.close();
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // Resume within the user gesture before waiting for the permission dialog.
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
    if (closed || signal.aborted) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Aborted', 'AbortError'); }
    node = await wire(context, context.createMediaStreamSource(stream), frame => { if (!closed) onFrame(frame); });
    if (signal.aborted) { node.port.onmessage = null; node.disconnect(); throw new DOMException('Aborted', 'AbortError'); }
    stream.getAudioTracks().forEach(track => { track.onended = onLost; });
    return { sampleRate: context.sampleRate, setEnabled: enabled => stream?.getAudioTracks().forEach(track => { track.enabled = enabled; }), close };
  } catch (error) { close(); throw error; }
};

/** Development-only input substitutes a synthetic speaker for the physical microphone. */
export function captureFixture(file: File): CaptureFactory {
  return async (signal, onFrame) => {
    const context = new AudioContext({ sampleRate: 16000 });
    let source: AudioBufferSourceNode | undefined, node: AudioWorkletNode | undefined, closed = false, enabled = true, started = false;
    const close = () => {
      if (closed) return; closed = true; signal.removeEventListener('abort', close);
      if (started) source?.stop(); if (node) { node.port.onmessage = null; node.disconnect(); } void context.close();
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await context.resume();
      const audio = await context.decodeAudioData(await file.arrayBuffer());
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      source = context.createBufferSource(); source.buffer = audio;
      node = await wire(context, source, frame => { if (!closed && enabled) onFrame(frame); });
      if (signal.aborted) { node.port.onmessage = null; node.disconnect(); throw new DOMException('Aborted', 'AbortError'); }
      // Supply silence after the file to exercise the same endpoint detector.
      const quiet = context.createConstantSource(); quiet.offset.value = 0; quiet.connect(node); quiet.start();
      source.start(context.currentTime + .15); started = true;
      return { sampleRate: context.sampleRate, setEnabled: value => { enabled = value; }, close };
    } catch (error) { close(); throw error; }
  };
}

export function canCaptureAudio(): boolean {
  return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof window.AudioContext === 'function' && typeof window.AudioWorkletNode === 'function';
}
