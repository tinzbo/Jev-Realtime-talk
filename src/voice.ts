import { SpeechSegmenter, encodeWav } from './audio';
import type { Capture, CaptureFactory } from './capture';
export type VoiceState = 'off' | 'starting' | 'listening' | 'transcribing' | 'responding';
export type Transcription = { text: string; latencyMs: number; duration: number; engine: string };
export type Transcribe = (audio: ArrayBuffer, signal: AbortSignal) => Promise<Transcription>;
type Options = {
  capture: CaptureFactory;
  transcribe: Transcribe;
  onUtterance: (text: string) => void;
  onState: (state: VoiceState) => void;
  onError: (message: string) => void;
  onRecognized?: (result: Transcription) => void;
  /** Cancel a preceding reply synchronously; do not reset the current capture. */
  onSpeechStart?: () => void;
  schedule?: (task: () => void, delay: number) => () => void;
};

export class VoiceSession {
  private enabled = false;
  private held = false;
  private generation = 0;
  private input: Capture | null = null;
  private detector: SpeechSegmenter | null = null;
  private captureRequest: AbortController | null = null;
  private request: AbortController | null = null;
  private pendingAudio: Float32Array | null = null;
  private deferredResult: { result: Transcription; generation: number; controller: AbortController } | null = null;
  private cancelTimer: (() => void) | null = null;
  private readonly schedule: NonNullable<Options['schedule']>;
  constructor(private readonly options: Options) {
    this.schedule = options.schedule ?? ((task, delay) => { const timer = setTimeout(task, delay); return () => clearTimeout(timer); });
  }
  async start(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true; this.held = false;
    const generation = ++this.generation, controller = new AbortController(); this.captureRequest = controller;
    this.options.onState('starting');
    this.cancelTimer = this.schedule(() => {
      if (this.generation !== generation) return;
      this.stop(); this.options.onError('还没有获得麦克风权限。请允许当前页面使用麦克风，然后重试。');
    }, 30000);
    try {
      const input = await this.options.capture(controller.signal, frame => {
        if (this.captureRequest === controller && !controller.signal.aborted) this.consume(frame);
      }, () => {
        if (!this.enabled || controller.signal.aborted) return;
        this.stop(); this.options.onError('麦克风已断开，请检查输入设备后重新开始。');
      });
      if (!this.enabled || generation !== this.generation) { input.close(); return; }
      this.cancelTimer?.(); this.cancelTimer = null;
      this.input = input; this.detector = new SpeechSegmenter(input.sampleRate);
      input.setEnabled(true); this.options.onState(this.held ? 'responding' : 'listening');
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      const name = error instanceof Error ? error.name : '';
      this.options.onError(name === 'NotAllowedError' ? '麦克风权限未开启，请在地址栏允许当前页面使用麦克风。'
        : name === 'NotFoundError' ? '没有找到麦克风，请连接输入设备后重试。' : '无法采集麦克风声音，请检查设备和浏览器权限。');
    }
  }
  stop(): void {
    this.enabled = false; this.held = false; ++this.generation;
    this.cancelTimer?.(); this.cancelTimer = null;
    this.captureRequest?.abort(); this.captureRequest = null;
    this.request?.abort(); this.request = null; this.pendingAudio = null; this.deferredResult = null;
    this.input?.close(); this.input = null; this.detector = null;
    this.options.onState('off');
  }
  dispose(): void { this.stop(); }
  hold(): void {
    if (!this.enabled) return;
    if (!this.input) { this.stop(); return; }
    this.held = true; ++this.generation; this.request?.abort(); this.request = null;
    this.pendingAudio = null; this.deferredResult = null;
    this.cancelTimer?.(); this.cancelTimer = null;
    this.detector?.reset(); this.options.onState('responding');
  }
  resume(): void {
    if (!this.enabled || !this.held) return;
    this.cancelTimer?.(); this.cancelTimer = null;
    // Capture never stopped. Preserve any word already starting as the reply ends.
    this.held = false; this.options.onState('listening');
  }
  interrupt(): void {
    if (!this.enabled) return;
    if (!this.input) { this.stop(); return; }
    ++this.generation; this.request?.abort(); this.request = null;
    this.pendingAudio = null; this.deferredResult = null;
    this.cancelTimer?.(); this.cancelTimer = null;
    this.held = false; this.detector?.reset(); this.options.onState('listening');
  }
  private consume(frame: Float32Array): void {
    if (!this.enabled || !this.input || !this.detector) return;
    const detector = this.detector, wasSpeaking = detector.speechStarted;
    const segment = detector.push(frame, this.held ? .24 : .12);
    if (!wasSpeaking && detector.speechStarted) {
      // An unfinished ASR turn retains its audio. A reply has already committed it.
      ++this.generation; this.request?.abort(); this.request = null; this.deferredResult = null;
      this.held = false; this.options.onState('listening'); this.options.onSpeechStart?.();
      if (!this.enabled || this.detector !== detector) return;
    }
    if (segment) this.recognize(segment);
    else if (this.deferredResult && !detector.hasPendingSpeech && !detector.speechStarted) {
      const completed = this.deferredResult; this.deferredResult = null;
      this.acceptRecognition(completed.result, completed.generation, completed.controller);
    }
  }
  private recognize(segment: Float32Array): void {
    if (!this.input) return;
    const previous = this.pendingAudio;
    if (previous) {
      if (previous.length + segment.length > this.input.sampleRate * 20) {
        this.stop(); this.options.onError('这段话加上补充超过 20 秒，请分成短句再说一次。'); return;
      }
      const combined = new Float32Array(previous.length + segment.length);
      combined.set(previous); combined.set(segment, previous.length); segment = combined;
    }
    this.pendingAudio = segment;
    const generation = ++this.generation, controller = new AbortController(); this.request = controller;
    this.options.onState('transcribing');
    void this.options.transcribe(encodeWav(segment, this.input.sampleRate), controller.signal).then(result => {
      if (!this.enabled || generation !== this.generation || controller.signal.aborted) return;
      // Do not let a fast ASR completion erase the first 120 ms of a supplement.
      if (this.detector?.hasPendingSpeech) { this.deferredResult = { result, generation, controller }; return; }
      this.acceptRecognition(result, generation, controller);
    }).catch(error => {
      if (!this.enabled || generation !== this.generation || controller.signal.aborted) return;
      this.request = null; this.stop();
      this.options.onError(error instanceof Error ? error.message : '语音识别未能完成，请再试一次。');
    });
  }
  private acceptRecognition(result: Transcription, generation: number, controller: AbortController): void {
    if (!this.enabled || generation !== this.generation || controller.signal.aborted) return;
    this.request = null; this.pendingAudio = null; this.deferredResult = null;
    if (!result.text.trim()) { this.options.onState('listening'); return; }
    this.hold();
    const delivery = this.generation;
    this.options.onRecognized?.(result);
    if (this.enabled && delivery === this.generation) this.options.onUtterance(result.text.trim().slice(0, 1500));
  }
}

export function serverTranscriber(request: typeof fetch = fetch): Transcribe {
  let token = '', issuedAt = 0;
  return async (audio, signal) => {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(65000)]);
    try {
      if (!token || Date.now() - issuedAt > 25 * 60 * 1000) {
        const session = await request('/api/voice/session', { signal: combined });
        if (!session.ok) throw new Error('无法连接本地语音服务，请确认工作室仍在运行。');
        const data = await session.json(); token = data.token; issuedAt = Date.now();
      }
      const response = await request('/api/voice/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Voice-Token': token }, body: audio,
        signal: combined,
      });
      const result = await response.json();
      if (response.status === 403) token = '';
      if (!response.ok) throw new Error(result.error || '本地识别暂不可用，请重试。');
      return result as Transcription;
    } catch (error) {
      if (signal.aborted) throw error;
      if (combined.aborted) throw new Error('语音识别超时，请分成短句重试。');
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('无法连接本地语音服务，请确认工作室仍在运行。');
      throw error;
    }
  };
}
