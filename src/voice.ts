export type VoiceState = 'off' | 'starting' | 'listening' | 'responding';
export interface RecognitionResultEvent {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
  resultIndex: number;
}
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type Options = {
  createRecognition: () => Recognition;
  onUtterance: (text: string) => void;
  onTranscript: (text: string) => void;
  onState: (state: VoiceState) => void;
  onError: (message: string) => void;
  schedule?: (task: () => void, delay: number) => () => void;
};

/** A session spans many browser recognition connections and avatar replies. */
export class VoiceSession {
  private enabled = false;
  private held = false;
  private recognition: Recognition | null = null;
  private cancelRestart: (() => void) | null = null;
  private cancelStartTimeout: (() => void) | null = null;
  private readonly schedule: NonNullable<Options['schedule']>;

  constructor(private readonly options: Options) {
    this.schedule = options.schedule ?? ((task, delay) => {
      const timer = setTimeout(task, delay);
      return () => clearTimeout(timer);
    });
  }
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.held = false;
    this.connect(true);
  }
  stop(): void {
    this.enabled = false;
    this.held = false;
    this.release();
    this.options.onTranscript('');
    this.options.onState('off');
  }
  dispose(): void { this.stop(); }
  hold(): void {
    if (!this.enabled) return;
    this.held = true;
    this.release();
    this.options.onTranscript('');
    this.options.onState('responding');
  }
  resume(): void {
    if (!this.enabled || !this.held) return;
    this.held = false;
    // Let the last syllable leave the speakers before opening the microphone.
    this.restart(350);
  }
  interrupt(): void {
    if (!this.enabled) return;
    this.held = false;
    this.release();
    this.options.onTranscript('');
    this.connect(true);
  }
  private release(): void {
    this.cancelRestart?.();
    this.cancelRestart = null;
    this.cancelStartTimeout?.();
    this.cancelStartTimeout = null;
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
    recognition.abort();
  }
  private restart(delay = 500): void {
    this.release();
    if (!this.enabled || this.held) return;
    // Silent disconnects stay visually in the same listening state.
    this.cancelRestart = this.schedule(() => {
      this.cancelRestart = null;
      if (this.enabled && !this.held) this.connect();
    }, delay);
  }
  private connect(announce = false): void {
    if (!this.enabled || this.held || this.recognition) return;
    const recognition = this.options.createRecognition();
    this.recognition = recognition;
    const live = () => this.enabled && !this.held && this.recognition === recognition;
    recognition.lang = 'zh-CN';
    // Native end-of-utterance detection, with a persistent session around it.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (!live()) return;
      this.cancelStartTimeout?.(); this.cancelStartTimeout = null;
      this.options.onState('listening');
    };
    recognition.onresult = event => {
      if (!live()) return;
      let transcript = '', final = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        transcript += result[0].transcript;
        if (result.isFinal) final += result[0].transcript;
      }
      this.options.onTranscript(transcript);
      if (!final.trim()) return;
      // Fence duplicate/late callbacks before invoking application code.
      this.hold();
      this.options.onUtterance(final.trim().slice(0, 1500));
    };
    recognition.onend = () => { if (live()) { this.options.onTranscript(''); this.restart(); } };
    recognition.onerror = event => {
      if (!live()) return;
      if (event.error === 'no-speech' || event.error === 'aborted') {
        this.options.onTranscript('');
        this.restart();
        return;
      }
      this.stop();
      const messages: Record<string, string> = {
        'not-allowed': '麦克风权限未开启。请在浏览器地址栏允许麦克风后重试，也可以先用文字聊。',
        'service-not-allowed': '浏览器暂不能使用语音服务。请使用支持语音识别的 Chrome，或先用文字聊。',
        'audio-capture': '没有找到可用的麦克风。请检查系统输入设备后重试。',
        network: '语音服务暂时连接不上。请检查网络后重试，或先用文字聊。',
      };
      this.options.onError(messages[event.error] ?? '语音识别暂时不可用，请重试或使用文字输入。');
    };
    if (announce) this.options.onState('starting');
    this.cancelStartTimeout = this.schedule(() => {
      if (!live()) return;
      this.stop();
      this.options.onError('当前浏览器未能启动语音服务。请用支持语音识别的 Chrome 打开此页面，或先用文字聊。');
    }, 10000);
    try { recognition.start(); }
    catch { this.stop(); this.options.onError('麦克风启动失败，请重新点击语音按钮。'); }
  }
}

export function browserRecognition(): (new () => Recognition) | undefined {
  const browser = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}
