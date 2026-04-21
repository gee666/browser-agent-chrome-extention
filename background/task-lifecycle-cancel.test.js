import test from 'node:test';
import assert from 'node:assert/strict';

import {
  throwIfCancelled,
  TaskCancelledError,
} from './task-lifecycle.js';

// These tests cover the cancellation helper used by `startAgentTask()` in
// `background/sw.js` to gate each awaited startup phase (config load, tab
// resolution, bridge creation, initial navigation, agent construction).
//
// The helper is what keeps a stop request during startup from silently
// escalating into arming the debugger and running the agent.

test('throwIfCancelled is a no-op when the task run is fresh', () => {
  const taskRun = { cancelRequested: false, settled: false };
  assert.doesNotThrow(() => throwIfCancelled(taskRun, 'config load'));
});

test('throwIfCancelled throws TaskCancelledError when cancel was requested', () => {
  const taskRun = { cancelRequested: true, settled: false };
  assert.throws(
    () => throwIfCancelled(taskRun, 'tab resolution'),
    (error) => {
      assert.ok(error instanceof TaskCancelledError);
      assert.equal(error.code, 'E_CANCELLED');
      assert.equal(error.cancelled, true);
      assert.match(error.message, /tab resolution/);
      return true;
    },
  );
});

test('throwIfCancelled throws when the task run has already settled', () => {
  const taskRun = { cancelRequested: false, settled: true };
  assert.throws(() => throwIfCancelled(taskRun, 'initial navigation'), TaskCancelledError);
});

test('throwIfCancelled tolerates a missing task run', () => {
  assert.doesNotThrow(() => throwIfCancelled(null, 'startup'));
  assert.doesNotThrow(() => throwIfCancelled(undefined, 'startup'));
});

// Integration-style simulation of the `startAgentTask()` startup pipeline.
// Each phase is represented as an async function. Cancellation is requested
// at a configurable point; the harness asserts that startup stops at the
// FIRST post-cancel gate and that no later phase runs (no tab activation,
// no debugger arming, no agent construction).
async function simulateStartup(taskRun, { cancelAfter } = {}) {
  const phasesRun = [];

  const runPhase = async (name) => {
    phasesRun.push(name);
    // Yield a tick so the test can mutate taskRun between awaits, just like
    // a real stop request arriving mid-startup.
    await Promise.resolve();
    if (name === cancelAfter) {
      taskRun.cancelRequested = true;
    }
  };

  try {
    await runPhase('loadAgentConfig');
    throwIfCancelled(taskRun, 'config load');

    await runPhase('resolveRunTaskTab');
    throwIfCancelled(taskRun, 'tab resolution');

    await runPhase('createAgentBrowserBridge');
    throwIfCancelled(taskRun, 'bridge creation');

    await runPhase('initialNavigate');
    throwIfCancelled(taskRun, 'initial navigation');

    await runPhase('constructAgent');
    throwIfCancelled(taskRun, 'agent construction');

    await runPhase('agentRun');
    return { cancelled: false, phasesRun };
  } catch (error) {
    if (error instanceof TaskCancelledError) {
      return { cancelled: true, phase: error.message, phasesRun };
    }
    throw error;
  }
}

test('cancellation after loadAgentConfig prevents tab resolution', async () => {
  const taskRun = { cancelRequested: false, settled: false };
  const result = await simulateStartup(taskRun, { cancelAfter: 'loadAgentConfig' });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.phasesRun, ['loadAgentConfig']);
  assert.match(result.phase, /config load/);
});

test('cancellation after resolveRunTaskTab prevents bridge creation', async () => {
  const taskRun = { cancelRequested: false, settled: false };
  const result = await simulateStartup(taskRun, { cancelAfter: 'resolveRunTaskTab' });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.phasesRun, ['loadAgentConfig', 'resolveRunTaskTab']);
  assert.match(result.phase, /tab resolution/);
});

test('cancellation after createAgentBrowserBridge prevents initial navigate', async () => {
  const taskRun = { cancelRequested: false, settled: false };
  const result = await simulateStartup(taskRun, { cancelAfter: 'createAgentBrowserBridge' });
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    result.phasesRun,
    ['loadAgentConfig', 'resolveRunTaskTab', 'createAgentBrowserBridge'],
  );
  assert.match(result.phase, /bridge creation/);
});

test('cancellation after initialNavigate prevents agent construction', async () => {
  const taskRun = { cancelRequested: false, settled: false };
  const result = await simulateStartup(taskRun, { cancelAfter: 'initialNavigate' });
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    result.phasesRun,
    ['loadAgentConfig', 'resolveRunTaskTab', 'createAgentBrowserBridge', 'initialNavigate'],
  );
  assert.match(result.phase, /initial navigation/);
});

test('no cancellation runs every phase including agentRun', async () => {
  const taskRun = { cancelRequested: false, settled: false };
  const result = await simulateStartup(taskRun, { cancelAfter: null });
  assert.equal(result.cancelled, false);
  assert.deepEqual(
    result.phasesRun,
    [
      'loadAgentConfig',
      'resolveRunTaskTab',
      'createAgentBrowserBridge',
      'initialNavigate',
      'constructAgent',
      'agentRun',
    ],
  );
});
