import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { whisperWorker } from './whisper-worker';
import { validateAudio, VoiceError } from './asr-audio';

export interface Transcript { text: string; latencyMs: number; duration: number; engine: 'whisper-local'; }
type Pending = { id: string; finish: (error?: Error, result?: { text: string; latencyMs: number }) => void };
export async function resolveASRPython(): Promise<string> {
  if (process.env.ASR_PYTHON) return process.env.ASR_PYTHON;
  const local = path.resolve('.asr-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  try { await access(local); return local; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Reuse the Python environment of a locally installed Whisper CLI.
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    try {
      const firstLine = (await readFile(path.join(directory, 'whisper'), 'utf8')).split('\n')[0];
      const interpreter = firstLine.match(/^#!(\/[^\r\n]+)$/)?.[1];
      if (interpreter && !interpreter.includes(' ')) { await access(interpreter); return interpreter; }
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
  }
  return 'python3';
}

/** One warm, bounded worker; cancellation terminates inference and discards late output. */
export class LocalASR {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private pending: Pending | null = null;
  private cancelStartup: (() => void) | null = null;
  private generation = 0;
  readonly status: { state: 'starting' | 'ready' | 'unavailable'; engine: 'whisper-local'; model: string; message?: string } = {
    state: 'unavailable', engine: 'whisper-local', model: process.env.ASR_MODEL || 'base', message: '语音服务尚未启动。',
  };
  start(): Promise<void> {
    if (this.child && this.status.state === 'ready') return Promise.resolve();
    if (this.starting) return this.starting;
    const generation = ++this.generation;
    this.status.state = 'starting'; this.status.message = '正在准备本地语音识别。';
    this.starting = this.launch(generation).catch(error => {
      if (generation === this.generation) {
        this.status.state = 'unavailable';
        if (this.status.message === '正在准备本地语音识别。') this.status.message = '本地语音环境不可用，请运行 npm run voice:setup。';
      }
      throw error;
    }).finally(() => { if (generation === this.generation) this.starting = null; });
    return this.starting;
  }
  private async launch(generation: number): Promise<void> {
    const python = await resolveASRPython();
    if (generation !== this.generation) throw new VoiceError('语音连接已取消。', 499, 'aborted');
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-u', '-c', whisperWorker], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      this.child = child;
      let loaded = false;
      const fail = (message: string) => {
        if (this.child !== child) return;
        clearTimeout(timer); this.child = null; child.kill('SIGKILL');
        this.status.state = 'unavailable'; this.status.message = message;
        const error = new VoiceError(message, 503, 'asr_unavailable');
        this.pending?.finish(error); if (!loaded) reject(error);
      };
      const timer = setTimeout(() => fail('本地语音模型启动超时，请检查 Whisper 配置。'), 45000);
      this.cancelStartup = () => { clearTimeout(timer); if (!loaded) reject(new VoiceError('语音准备已取消。', 499, 'aborted')); };
      const reader = createInterface({ input: child.stdout });
      reader.on('line', line => {
        if (this.child !== child) return;
        try {
          const result = JSON.parse(line);
          if (result.type === 'ready') {
            loaded = true; clearTimeout(timer); this.cancelStartup = null; this.status.state = 'ready'; this.status.message = undefined; resolve();
          } else if (result.type === 'error') fail('本地 Whisper 模型未安装，请运行 npm run voice:setup。');
          else if (result.id === this.pending?.id) {
            if (result.type === 'result' && typeof result.text === 'string' && Number.isFinite(result.latencyMs)) this.pending?.finish(undefined, result);
            else this.pending?.finish(new VoiceError('这段语音未能识别，请再说一次。', 502, 'asr_failed'));
          }
        } catch { fail('语音服务返回异常，请重启本地服务。'); }
      });
      child.stderr.on('data', () => {}); // No audio, credentials or transcripts in logs.
      child.stdin.on('error', () => fail('语音连接中断，请重试。'));
      child.on('error', () => fail('本地 Whisper 环境不可用，请运行 npm run voice:setup。'));
      child.on('exit', () => { reader.close(); fail(loaded ? '本地语音进程已退出，请重试。' : '本地 Whisper 环境未就绪，请运行 npm run voice:setup。'); });
    });
  }
  async transcribe(bytes: Buffer, signal: AbortSignal): Promise<Transcript> {
    const audio = validateAudio(bytes);
    if (signal.aborted) throw new VoiceError('已取消。', 499, 'aborted');
    if (audio.silent) return { text: '', latencyMs: 0, duration: audio.duration, engine: 'whisper-local' };
    await this.start();
    if (signal.aborted) throw new VoiceError('已取消。', 499, 'aborted');
    if (this.pending) throw new VoiceError('上一段语音还在识别，请稍后再说。', 429, 'asr_busy');
    const result = await new Promise<{ text: string; latencyMs: number }>((resolve, reject) => {
      const id = randomUUID();
      const finish: Pending['finish'] = (error, value) => {
        if (this.pending?.id !== id) return;
        clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending = null;
        if (error) reject(error); else resolve(value!);
      };
      const terminate = (error: VoiceError) => {
        // An old write callback must never terminate a replacement worker.
        if (this.pending?.id !== id) return;
        finish(error); this.close();
      };
      const abort = () => terminate(new VoiceError('已取消。', 499, 'aborted'));
      const timer = setTimeout(() => terminate(new VoiceError('语音识别超时，请分成短句重试。', 504, 'asr_timeout')), 20000);
      this.pending = { id, finish };
      signal.addEventListener('abort', abort, { once: true });
      this.child!.stdin.write(JSON.stringify({ id, audio: bytes.toString('base64') }) + '\n', error => {
        if (error) terminate(new VoiceError('语音连接中断，请重试。', 503, 'asr_unavailable'));
      });
    });
    return { text: result.text.slice(0, 1500), latencyMs: result.latencyMs, duration: audio.duration, engine: 'whisper-local' };
  }
  close(): void {
    ++this.generation; this.cancelStartup?.(); this.cancelStartup = null; this.starting = null;
    this.pending?.finish(new VoiceError('语音识别已取消。', 499, 'aborted'));
    const child = this.child; this.child = null; child?.kill('SIGKILL');
    this.status.state = 'unavailable'; this.status.message = '语音服务将在下次请求时重新启动。';
  }
}
