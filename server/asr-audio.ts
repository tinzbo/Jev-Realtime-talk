export class VoiceError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_audio') { super(message); }
}
export function validateAudio(bytes: Buffer): { duration: number; silent: boolean } {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 16) !== 'WAVEfmt '
    || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1
    || bytes.readUInt32LE(24) !== 16000 || bytes.readUInt32LE(28) !== 32000 || bytes.readUInt16LE(32) !== 2
    || bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data'
    || bytes.readUInt32LE(40) !== bytes.length - 44 || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.length % 2 !== 0) {
    throw new VoiceError('录音格式不正确，请重新开始语音。');
  }
  const duration = (bytes.length - 44) / 32000;
  if (duration < .18 || duration > 20) throw new VoiceError('每段语音需要在 0.18 到 20 秒之间。');
  let voicedSamples = 0;
  for (let i = 44; i < bytes.length; i += 2) if (Math.abs(bytes.readInt16LE(i)) > 300) voicedSamples++;
  return { duration, silent: voicedSamples < 1600 };
}
