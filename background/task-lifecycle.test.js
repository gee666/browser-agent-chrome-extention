import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSettledByStatus,
  buildTaskResultFromRun,
  buildTaskResult,
} from './task-lifecycle.js';

test('recoverable error status is not treated as settled', () => {
  assert.equal(isSettledByStatus('error'), false);
  assert.equal(isSettledByStatus('done'), true);
  assert.equal(isSettledByStatus('stopped'), true);
});

test('run completion after recoverable error becomes terminal error result', () => {
  const taskRun = {
    taskId: 'task-1',
    task: 'do task',
    startedAt: 123,
  };

  const result = buildTaskResultFromRun(taskRun, {
    runResult: null,
    lastStatus: {
      state: 'error',
      message: 'Max iterations reached',
      timestamp: 456,
    },
  });

  assert.equal(result.taskId, 'task-1');
  assert.equal(result.status, 'error');
  assert.equal(result.message, 'Max iterations reached');
  assert.equal(result.error.code, 'E_RUNTIME');
  assert.equal(result.finalStatus.state, 'error');
});

test('blocked staged completion remains machine-readable in both settlement paths', () => {
  const finalStatus = { state: 'done', success: false, blocked: true, message: 'Required input missing' };
  for (const result of [buildTaskResult({}, 'done', { finalStatus }), buildTaskResultFromRun({}, { lastStatus: finalStatus })]) {
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
    assert.equal(result.finalStatus.success, false);
  }
  assert.equal(buildTaskResult({}, 'done', { finalStatus: { success: true } }).success, true);
});

test('run completion preserves done message', () => {
  const result = buildTaskResultFromRun({ task: 'do task' }, {
    runResult: 'Finished successfully',
    lastStatus: {
      state: 'done',
      message: 'Verified complete',
      timestamp: 456,
    },
  });

  assert.equal(result.status, 'done');
  assert.equal(result.message, 'Verified complete');
  assert.equal(result.finalStatus.state, 'done');
});
