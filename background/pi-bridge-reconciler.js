export function createPiBridgeReconciler({
  refreshBridge,
  setRuntimeEnabled,
  ensureReconnectAlarm,
  clearReconnectAlarm,
  startKeepaliveLoop,
  stopKeepaliveLoop,
  logger = console,
}) {
  let requested = false;
  let running = null;
  // Unknown defaults to retrying: until storage is read successfully, the
  // reconciler must not strand an enabled installation without a wake-up.
  let lastKnownEnabled;

  const preserveRetryAlarm = async () => {
    if (lastKnownEnabled !== false) await ensureReconnectAlarm();
  };

  const reconcileOnce = async () => {
    let bridge;
    try {
      bridge = await refreshBridge();
    } catch (error) {
      try {
        await preserveRetryAlarm();
      } catch (alarmError) {
        logger.warn?.('[sw] failed to preserve pi bridge retry alarm', alarmError);
      }
      throw error;
    }

    // A controller may return null when a refresh was superseded or failed.
    // Preserve only the retry backstop; never infer runtime/loop state from it.
    if (!bridge) {
      await preserveRetryAlarm();
      return;
    }

    const enabled = bridge.config?.enabled !== false;
    lastKnownEnabled = enabled;
    if (enabled) {
      // Arm the retry backstop before runtime startup. If startup fails, the
      // alarm will wake the worker for another serialized reconciliation.
      await ensureReconnectAlarm();
      await setRuntimeEnabled(true);
      startKeepaliveLoop();
    } else {
      await setRuntimeEnabled(false);
      stopKeepaliveLoop();
      await clearReconnectAlarm();
    }
  };

  return function reconcile() {
    requested = true;
    if (running) return running;

    running = (async () => {
      while (requested) {
        requested = false;
        try {
          await reconcileOnce();
        } catch (error) {
          logger.error?.('[sw] pi bridge startup failed', error);
        }
      }
    })().finally(() => {
      running = null;
    });

    return running;
  };
}
