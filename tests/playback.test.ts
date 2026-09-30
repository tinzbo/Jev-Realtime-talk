import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnGate, watchPlayback, startPlayback } from '../src/playback';
test('only the most recent turn can modify playback', () => {
  const gate = new TurnGate(); const old = gate.next(); const current = gate.next();
  assert.equal(gate.accept(old), false); assert.equal(gate.accept(current), true);
});
test('interrupt invalidates in-flight decisions', () => {
  const gate = new TurnGate(); const id = gate.next(); gate.cancel(); assert.equal(gate.accept(id), false);
});

class PlaybackFixture extends EventTarget {
  currentTime = 0;
  ended = false;
  paused = false;
  readyState = 4;
}

class StartingPlaybackFixture extends PlaybackFixture {
  playCalls = 0;
  pauseCalls = 0;
  pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  play(): Promise<void> {
    this.playCalls++;
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  pause(): void { this.pauseCalls++; this.paused = true; }
}

test('playback startup cannot wait forever for play() to settle', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const video = new StartingPlaybackFixture(), controller = new AbortController();
  const result = assert.rejects(startPlayback(video as unknown as HTMLVideoElement, controller.signal), /启动超时/);
  context.mock.timers.tick(4000); await result;
  assert.equal(video.pauseCalls, 1);
  video.pending[0].resolve(); await Promise.resolve();
  assert.equal(video.pauseCalls, 1);
});

test('late completion from an aborted start cannot pause a reused video', async () => {
  for (const completion of ['resolve', 'reject'] as const) {
    const video = new StartingPlaybackFixture(), old = new AbortController(), current = new AbortController();
    const cancelled = assert.rejects(startPlayback(video as unknown as HTMLVideoElement, old.signal), { name: 'AbortError' });
    old.abort(); await cancelled; assert.equal(video.pauseCalls, 1);
    const playing = startPlayback(video as unknown as HTMLVideoElement, current.signal);
    video.pending[1].resolve(); await playing;
    if (completion === 'resolve') video.pending[0].resolve(); else video.pending[0].reject(new Error('late'));
    await Promise.resolve(); assert.equal(video.pauseCalls, 1);
  }
});

test('an already cancelled start does not touch the video', async () => {
  const video = new StartingPlaybackFixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(startPlayback(video as unknown as HTMLVideoElement, controller.signal), { name: 'AbortError' });
  assert.equal(video.playCalls, 0); assert.equal(video.pauseCalls, 0);
});

test('successful startup removes timeout and abort listeners', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const video = new StartingPlaybackFixture(), controller = new AbortController();
  const result = startPlayback(video as unknown as HTMLVideoElement, controller.signal);
  video.pending[0].resolve(); await result;
  controller.abort(); context.mock.timers.tick(10000); video.dispatchEvent(new Event('error'));
  assert.equal(video.pauseCalls, 0);
});

test('a startup rejection or decoder error retains the reason and cleans up', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const video = new StartingPlaybackFixture(), controller = new AbortController();
  const denied = new DOMException('Sound blocked', 'NotAllowedError');
  const result = assert.rejects(startPlayback(video as unknown as HTMLVideoElement, controller.signal), denied);
  video.pending[0].reject(denied); await result;
  context.mock.timers.tick(10000); assert.equal(video.pauseCalls, 1);
  const decoding = assert.rejects(startPlayback(video as unknown as HTMLVideoElement, controller.signal), /播放失败/);
  video.dispatchEvent(new Event('error')); await decoding;
  controller.abort(); assert.equal(video.pauseCalls, 2);
});

test('a ready, unpaused video whose clock stops releases the reply once', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const video = new PlaybackFixture(), controller = new AbortController();
  let now = 0, failures = 0;
  watchPlayback(video as unknown as HTMLVideoElement, controller.signal, () => { failures++; }, () => now);
  now = 3999; context.mock.timers.tick(3999); assert.equal(failures, 0);
  now = 4250; context.mock.timers.tick(251); assert.equal(failures, 1);
  now = 20000; context.mock.timers.tick(20000); video.dispatchEvent(new Event('error'));
  assert.equal(failures, 1);
});

test('progress, short buffering and a loop boundary keep playback alive', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const video = new PlaybackFixture(), controller = new AbortController();
  let now = 0, failures = 0;
  const dispose = watchPlayback(video as unknown as HTMLVideoElement, controller.signal, () => { failures++; }, () => now);
  for (let i = 0; i < 40; i++) {
    now += 250; video.currentTime = (video.currentTime + .25) % 5;
    context.mock.timers.tick(250);
  }
  now += 3000; context.mock.timers.tick(3000); assert.equal(failures, 0);
  video.currentTime += .25; now += 250; context.mock.timers.tick(250);
  now += 3000; context.mock.timers.tick(3000); assert.equal(failures, 0);
  dispose(); now += 10000; context.mock.timers.tick(10000); assert.equal(failures, 0);
});

test('interrupt, natural end and a previously aborted turn remove playback monitoring', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0, failures = 0;
  for (const outcome of ['abort', 'ended', 'already-aborted']) {
    const video = new PlaybackFixture(), controller = new AbortController();
    if (outcome === 'already-aborted') controller.abort();
    watchPlayback(video as unknown as HTMLVideoElement, controller.signal, () => { failures++; }, () => now);
    if (outcome === 'abort') controller.abort();
    if (outcome === 'ended') { video.ended = true; video.dispatchEvent(new Event('ended')); }
    video.dispatchEvent(new Event('error'));
  }
  now = 10000; context.mock.timers.tick(10000); assert.equal(failures, 0);
});

test('a decoder error after playback starts is reported once', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const video = new PlaybackFixture(), controller = new AbortController();
  let now = 0, failures = 0;
  watchPlayback(video as unknown as HTMLVideoElement, controller.signal, () => { failures++; }, () => now);
  video.dispatchEvent(new Event('error')); video.dispatchEvent(new Event('error'));
  now = 10000; context.mock.timers.tick(10000); assert.equal(failures, 1);
});
