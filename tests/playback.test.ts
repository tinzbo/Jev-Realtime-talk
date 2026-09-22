import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnGate } from '../src/playback';
test('only the most recent turn can modify playback', () => {
  const gate = new TurnGate(); const old = gate.next(); const current = gate.next();
  assert.equal(gate.accept(old), false); assert.equal(gate.accept(current), true);
});
test('interrupt invalidates in-flight decisions', () => {
  const gate = new TurnGate(); const id = gate.next(); gate.cancel(); assert.equal(gate.accept(id), false);
});
