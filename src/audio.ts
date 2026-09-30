/** Bounded endpoint detector: pre-roll preserves consonants, pauses preserve one turn. */
export class SpeechSegmenter {
  private chunks: Float32Array[] = [];
  private samples = 0;
  private quietSamples = 0;
  private speaking = false;
  private onsetSamples = 0;
  private confirmed = false;
  private noise = .002;
  constructor(private readonly sampleRate: number) {}
  get bufferedSamples(): number { return this.samples; }
  get speechStarted(): boolean { return this.confirmed; }
  // Brief candidates delay a racing ASR result without treating a click as a turn.
  get hasPendingSpeech(): boolean { return this.speaking && !this.confirmed && this.quietSamples < this.sampleRate * .12; }
  reset(): void {
    this.chunks = []; this.samples = this.quietSamples = this.onsetSamples = 0;
    this.speaking = this.confirmed = false;
  }
  push(frame: Float32Array, onsetSeconds = .12): Float32Array | null {
    if (!frame.length) return null;
    let power = 0;
    for (const sample of frame) power += sample * sample;
    const rms = Math.sqrt(power / frame.length);
    const voiced = rms > Math.max(.012, this.noise * 3);
    if (!this.speaking && !voiced) this.noise = .97 * this.noise + .03 * rms;
    this.chunks.push(frame.slice()); this.samples += frame.length;
    if (voiced) {
      this.speaking = true; this.quietSamples = 0;
      this.onsetSamples += frame.length;
      if (this.onsetSamples >= this.sampleRate * onsetSeconds) this.confirmed = true;
    } else if (this.speaking) { this.quietSamples += frame.length; this.onsetSamples = 0; }
    else {
      while (this.samples > this.sampleRate * .32 && this.chunks.length > 1) this.samples -= this.chunks.shift()!.length;
      return null;
    }
    if (this.quietSamples < this.sampleRate * .9 && this.samples < this.sampleRate * 18) return null;
    if (!this.confirmed) { this.reset(); return null; }
    const result = new Float32Array(this.samples); let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.length; }
    this.reset(); return result;
  }
}

/** PCM is small, portable, and independently validated by the server. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const rate = 16000, length = Math.floor(samples.length * rate / sampleRate);
  const buffer = new ArrayBuffer(44 + length * 2), view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const from = Math.floor(i * sampleRate / rate), to = Math.max(from + 1, Math.floor((i + 1) * sampleRate / rate));
    let value = 0;
    for (let j = from; j < to && j < samples.length; j++) value += samples[j];
    value = Math.max(-1, Math.min(1, value / (to - from)));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}
