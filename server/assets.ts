import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { MediaAsset } from '../src/types';
const schema = z.array(z.object({ clipId: z.string().regex(/^[a-z0-9-]+$/), url: z.string().regex(/^\/media\/[a-z0-9-]+\.mp4$/), duration: z.number().positive(), status: z.enum(['review', 'ready']), source: z.enum(['runninghub', 'import']), generatedAt: z.string() }));
export async function readAssets(): Promise<MediaAsset[]> {
  const assets = schema.parse(JSON.parse(await readFile(new URL('../data/assets.json', import.meta.url), 'utf8')));
  return Promise.all(assets.map(async asset => {
    if(asset.status==='ready')return asset;
    try {
      const review = JSON.parse(await readFile(new URL(`../data/reviews/${asset.clipId}.json`, import.meta.url),'utf8'));
      if(review.generatedAt===asset.generatedAt && review.url===asset.url) return {...asset,status:'ready' as const};
    } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
    return asset;
  }));
}
