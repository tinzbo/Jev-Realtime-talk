// Python is the native inference runtime; the application and process supervisor stay typed.
// JSON-lines over stdio avoids opening a second network service or persisting recordings.
export const whisperWorker = String.raw`
import base64, io, json, os, sys, time, wave
import numpy as np
import torch
import whisper
torch.set_num_threads(max(1, min(8, int(os.environ.get('ASR_THREADS', '4')))))
model_name = os.environ.get('ASR_MODEL', 'base')
model_dir = os.environ.get('ASR_MODEL_DIR', os.path.expanduser('~/.cache/whisper'))
model_file = os.path.join(model_dir, model_name + '.pt')
if model_name not in ('tiny', 'base', 'small', 'medium', 'turbo') or not os.path.isfile(model_file):
    print(json.dumps({'type': 'error', 'code': 'missing_model'}), flush=True)
    sys.exit(1)
model = whisper.load_model(model_file, device='cpu')
# Warm the encoder once instead of making the first user utterance pay that cost.
with torch.no_grad():
    model.encoder(whisper.log_mel_spectrogram(whisper.pad_or_trim(np.zeros(1600, dtype=np.float32)), n_mels=model.dims.n_mels).unsqueeze(0))
print(json.dumps({'type': 'ready', 'model': model_name}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    started = time.monotonic()
    try:
        with wave.open(io.BytesIO(base64.b64decode(request['audio'])), 'rb') as audio_file:
            audio = np.frombuffer(audio_file.readframes(audio_file.getnframes()), np.int16).astype(np.float32) / 32768.0
        result = model.transcribe(audio, language='zh', fp16=False, temperature=0, beam_size=3,
            condition_on_previous_text=False,
            initial_prompt='以下是简体中文对话。人物名：小岚。话题：数字人视频、批量制作、网站接入。常用指令：停一下，等一下，继续说，重新播放。',
            no_speech_threshold=0.6, logprob_threshold=-1.0, verbose=None)
        text = ''.join(segment['text'] for segment in result['segments']
            if segment.get('avg_logprob', -10) > -1.0 and segment.get('no_speech_prob', 1) < .75).strip()
        print(json.dumps({'type': 'result', 'id': request['id'], 'text': text,
            'latencyMs': round((time.monotonic() - started) * 1000)}), flush=True)
    except Exception:
        print(json.dumps({'type': 'failed', 'id': request['id']}), flush=True)
`;
