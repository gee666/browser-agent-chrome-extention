export function createTaskError(code, message, details) {
  return { code, message, details };
}

export function isSettledByStatus(status) {
  return status === 'done' || status === 'stopped';
}

export function buildTaskResult(taskRun, status, extra = {}) {
  return {
    taskId: taskRun?.taskId || null,
    task: taskRun?.task || null,
    status,
    startedAt: taskRun?.startedAt || null,
    endedAt: Date.now(),
    ...extra,
  };
}

export function buildTaskResultFromRun(taskRun, { runResult = null, lastStatus = null } = {}) {
  if (lastStatus?.state === 'done') {
    return buildTaskResult(taskRun, 'done', {
      message: lastStatus.message || runResult || null,
      finalStatus: lastStatus,
    });
  }

  if (lastStatus?.state === 'stopped') {
    return buildTaskResult(taskRun, 'stopped', {
      message: lastStatus.message || 'Task stopped',
      finalStatus: lastStatus,
    });
  }

  const message = lastStatus?.message || runResult || 'Agent run ended without completion';
  return buildTaskResult(taskRun, 'error', {
    message,
    error: createTaskError('E_RUNTIME', message),
    finalStatus: lastStatus,
  });
}
