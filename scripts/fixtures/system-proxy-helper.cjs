#!/usr/bin/env node
// Test-only process boundary. It never imports SystemConfiguration or changes OS settings.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const file = process.env.MOCK_MANAGER_PROXY_FIXTURE;
if (!file) throw new Error('Fixture path required');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (process.argv[2] === 'read') {
  process.stdout.write(JSON.stringify(state.snapshot));
} else if (process.argv[2] === 'write') {
  const { changes, expectedLocation } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (state.delayNextWrite) {
    const delay = state.delayNextWrite;
    delete state.delayNextWrite;
    fs.writeFileSync(file, JSON.stringify(state));
    fs.writeFileSync(file + '.restoring', '');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  if (state.cancelNext) {
    state.cancelNext = false;
    fs.writeFileSync(file, JSON.stringify(state));
    process.stdout.write('{"error":"authorization"}');
    process.exit(1);
  }
  if (expectedLocation) assert.equal(expectedLocation, state.snapshot.location);
  for (const change of changes) {
    const current = state.snapshot.services.find(service => service.id === change.id);
    assert.ok(current);
    assert.deepEqual({ enabled: current.enabled, configuration: current.configuration }, change.expected);
  }
  for (const change of changes) Object.assign(state.snapshot.services.find(service => service.id === change.id), change.next);
  state.writes = (state.writes || 0) + 1;
  fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write('{"ok":true}');
} else process.exit(2);
