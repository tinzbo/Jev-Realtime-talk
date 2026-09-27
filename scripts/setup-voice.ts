import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveASRPython } from '../server/asr';

function run(command: string, args: string[], quiet = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: quiet ? 'ignore' : 'inherit' });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('语音环境准备超时，请检查网络后重试。')); }, 10 * 60 * 1000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`语音安装步骤未完成，退出码 ${code}。`)); });
  });
}
let python = await resolveASRPython();
try { await run(python, ['-c', 'import whisper, torch, numpy'], true); }
catch (error) {
  if (process.env.ASR_PYTHON) throw new Error('ASR_PYTHON 指向的环境缺少 Whisper；请修正路径或在该环境安装 openai-whisper。', { cause: error });
  console.log('创建项目专用 .asr-venv 并安装 Whisper，不修改系统 Python。');
  await run('python3', ['-m', 'venv', '.asr-venv']);
  python = path.resolve('.asr-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await run(python, ['-m', 'pip', 'install', 'openai-whisper==20250625']);
}
await run(python, ['-c', String.raw`
import os, whisper
name = os.environ.get('ASR_MODEL', 'base')
if name not in ('tiny', 'base', 'small', 'medium', 'turbo'):
    raise ValueError('ASR_MODEL must be tiny, base, small, medium, or turbo')
whisper.load_model(name, device='cpu', download_root=os.environ.get('ASR_MODEL_DIR'))
print('本地 Whisper 模型已准备：' + name)
`]);
console.log('语音环境就绪。重启工作室后在「设置」查看状态。');
