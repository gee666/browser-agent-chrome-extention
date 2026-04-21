export function createTaskError(code, message, details) {
  return { code, message, details };
}

/**
 * Error raised when a startup phase detects that `taskRun.cancelRequested`
 * became true (or the run was already settled) between awaits. Callers can
 * distinguish this from generic runtime errors via `error.cancelled === true`
 * or `error.code === 'E_CANCELLED'`.
 */
export class TaskCancelledError extends Error {
  constructor(message = 'Task cancellation requested') {
    super(message);
    this.name = 'TaskCancelledError';
    this.code = 'E_CANCELLED';
    this.cancelled = true;
  }
}

/**
 * Throws TaskCancelledError when the task run has been cancelled or already
 * settled. Use this between awaited startup phases (`startAgentTask()`) so a
 * stop request that arrives mid-startup is honored before arming the
 * debugger, creating AgentCore, or beginning `run()`.
 *
 * @param {object|null} taskRun
 * @param {string} [phase] - human-readable phase label used in the error message
 */
export function throwIfCancelled(taskRun, phase = 'startup') {
  if (!taskRun) return;
  if (taskRun.cancelRequested || taskRun.settled) {
    throw new TaskCancelledError(`Task cancelled during ${phase}`);
  }
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
