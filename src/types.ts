export type ClipKind = 'response' | 'idle' | 'bridge' | 'fallback';
export interface Clip {
  id: string; title: string; intent: string; category: string; kind: ClipKind;
  text: string; duration: number; cues: string[]; keywords: string[];
  emotion: string; startPose: string; endPose: string; loop: boolean;
}
export interface MediaAsset {
  clipId: string; url: string; duration: number; status: 'review' | 'ready';
  source: 'runninghub' | 'import'; generatedAt: string;
}
export interface Catalog { clips: Clip[]; assets: MediaAsset[]; }
export interface Turn { role: 'user' | 'assistant'; text: string; clipId?: string; }
export interface RouteInput {
  requestId: number; text: string; history: Turn[]; currentClipId?: string;
  recentlyPlayed: string[]; mode: 'preview' | 'live';
}
export interface Decision {
  requestId: number; clipId: string | null; engine: 'jev' | 'demo' | 'fallback';
  confidence: number | null; probability: number | null; interrupt: boolean;
  latencyMs: number; reason: string; candidates: { id: string; probability: number }[];
  model?: string; usage?: { input_tokens: number; output_tokens: number };
}
export interface ServiceStatus { jev: boolean; jevVerified: boolean; jevModel?: string; runninghub: boolean; portrait: boolean; readyClips: number; reviewClips: number; totalClips: number; production: { submitted: number; pending: number; complete: number; needsAttention: number }; }
