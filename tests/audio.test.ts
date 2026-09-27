import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechSegmenter, encodeWav } from '../src/audio';
import { validateAudio } from '../server/asr-audio';

const frame = (amplitude = 0, seconds = .032) => new Float32Array(Math.round(seconds * 16000)).map((_, i) => Math.sin(i * .2) * amplitude);
test('a minute of silence never produces a request and keeps bounded pre-roll', () => {
  const vad = new SpeechSegmenter(16000);
  for (let i = 0; i < 1900; i++) assert.equal(vad.push(frame()), null);
  assert.ok(vad.bufferedSamples <= 16000);
});
test('a short hesitation stays in one utterance and a completed pause ends it', () => {
  const vad = new SpeechSegmenter(16000);
  for (let i = 0; i < 15; i++) assert.equal(vad.push(frame(.08)), null);
  for (let i = 0; i < 12; i++) assert.equal(vad.push(frame()), null);
  for (let i = 0; i < 15; i++) assert.equal(vad.push(frame(.08)), null);
  let result: Float32Array | null = null;
  for (let i = 0; i < 31; i++) result = vad.push(frame()) ?? result;
  assert.ok(result && result.length > 16000);
});
test('one click or tiny burst does not count as a spoken turn', () => {
  const vad = new SpeechSegmenter(16000); vad.push(frame(.2));
  for (let i = 0; i < 40; i++) assert.equal(vad.push(frame()), null);
});
test('an uninterrupted long utterance is bounded', () => {
  const vad = new SpeechSegmenter(16000); let result: Float32Array | null = null;
  for (let i = 0; i < 600 && !result; i++) result = vad.push(frame(.1));
  assert.ok(result && result.length <= 19 * 16000);
});
test('48 kHz captured audio becomes valid 16 kHz mono PCM', () => {
  const wav = encodeWav(new Float32Array(48000).fill(.1), 48000);
  const audio = validateAudio(Buffer.from(wav));
  assert.equal(audio.duration, 1); assert.equal(audio.silent, false);
});
test('valid silence is classified before model inference', () => {
  assert.equal(validateAudio(Buffer.from(encodeWav(frame(0, 1), 16000))).silent, true);
});
test('malformed audio, disguised non-audio, bad sample rate and long uploads are rejected', () => {
  assert.throws(() => validateAudio(Buffer.from('not audio')));
  const invalid = Buffer.from(encodeWav(frame(.1, 1), 16000)); invalid.writeUInt32LE(48000, 24);
  assert.throws(() => validateAudio(invalid));
  assert.throws(() => validateAudio(Buffer.from(encodeWav(frame(.1, 21), 16000))));
});
