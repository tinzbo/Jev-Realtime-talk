import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clips } from '../src/catalog';
import type { MediaAsset } from '../src/types';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets: MediaAsset[] = JSON.parse(await readFile(path.join(root, 'data/assets.json'), 'utf8'));
const checksums: { clipId: string; url: string; bytes: number; sha256: string }[] = JSON.parse(await readFile(path.join(root, 'data/media-checksums.json'), 'utf8'));
if (assets.length !== clips.length || checksums.length !== clips.length) throw new Error('素材数量与内容库不一致');
await Promise.all(clips.map(async clip => {
  const matches = assets.filter(asset => asset.clipId === clip.id);
  if (matches.length !== 1 || matches[0].status !== 'ready') throw new Error(`${clip.id}: 缺少唯一已验收素材`);
  const asset = matches[0];
  if (!/^\/media\/[a-z0-9-]+\.mp4$/.test(asset.url)) throw new Error(`${clip.id}: 不是仓库内的 MP4`);
  const record = checksums.filter(entry => entry.clipId === clip.id && entry.url === asset.url);
  if (record.length !== 1) throw new Error(`${clip.id}: 缺少唯一校验值`);
  const bytes = await readFile(path.join(root, 'public', asset.url));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== record[0].sha256 || bytes.length !== record[0].bytes) throw new Error(`${clip.id}: 文件完整性不匹配`);
}));
console.log(`${clips.length} 个完整 MP4 与内容库匹配，SHA-256 全部通过。`);
