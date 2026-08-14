// Pure decision logic for the MV3 keepalive/liveness pump.
//
// This lives outside sw.js on purpose: sw.js touches chrome.* at module scope
// and therefore cannot be imported by a test, which meant the liveness rules
// that recover the extension from a half-open ("zombie") broker socket were
// shipping unverified. Everything here is chrome-free and time is injected, so
// every branch is reachable from a unit test.

export const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * @param {object} options
 * @param {number} [options.intervalMs] nominal pump cadence.
 * @param {number} [options.zombieTimeoutMs] baseline silence budget.
 * @param {number} [options.wakeGapMs] pump delay that counts as suspend/freeze.
 * @param {number} [options.maxConsecutiveZombieKills] kills before escalation.
 * @param {number} [options.suppressionMs] how long escalation mutes the check.
 * @param {Console} [options.logger]
 */
export function createKeepalivePump({
  intervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
  zombieTimeoutMs = intervalMs * 2.5,
  wakeGapMs = intervalMs * 3,
  maxConsecutiveZombieKills = 3,
  suppressionMs = 5 * 60_000,
  logger = console,
} = {}) {
  // null, not 0, so an epoch-relative injected clock still yields a real cadence.
  let lastPumpAt = null;
  // url -> { kills, suppressedUntil }. Bounded by the number of configured
  // broker URLs: entries for URLs that are no longer configured are pruned on
  // every pump so a long browser session cannot leak here.
  const zombieState = new Map();

  const stateFor = (url) => {
    let entry = zombieState.get(url);
    if (!entry) {
      entry = { kills: 0, suppressedUntil: 0 };
      zombieState.set(url, entry);
    }
    return entry;
  };

  const pruneState = (clients) => {
    const live = new Set();
    for (const client of clients) {
      if (typeof client?.url === 'string') live.add(client.url);
    }
    for (const url of [...zombieState.keys()]) {
      if (!live.has(url)) zombieState.delete(url);
    }
  };

  const describeSilence = (silentFor) => (Number.isFinite(silentFor)
    // msSinceLastReceive is Infinity for a never-connected socket; formatting
    // that would log the literal string "Infinity" seconds.
    ? `${Math.round(silentFor / 1000)}s`
    : 'the whole connection');

  return {
    /** Forget cadence + escalation history (bridge disabled / loop stopped). */
    reset() {
      lastPumpAt = null;
      zombieState.clear();
    },

    /** Test/diagnostic view of the escalation bookkeeping. */
    inspect() {
      return {
        lastPumpAt,
        zombieState: new Map([...zombieState].map(([url, entry]) => [url, { ...entry }])),
      };
    },

    /**
     * Run one keepalive cycle over `clients`.
     * @returns {{ probedAny: boolean, gapMs: number, wokeFromGap: boolean,
     *   probed: string[], killed: Array<{ url: string, reason: string, escalated: boolean }>,
     *   nudged: string[], suppressed: string[] }}
     */
    pump({ clients = [], now = Date.now() } = {}) {
      const gap = lastPumpAt === null ? 0 : now - lastPumpAt;
      const wokeFromGap = gap > wakeGapMs;
      lastPumpAt = now;
      pruneState(clients);

      const result = {
        probedAny: false,
        gapMs: gap,
        wokeFromGap,
        probed: [],
        killed: [],
        nudged: [],
        suppressed: [],
      };

      if (wokeFromGap) {
        // We only report the gap; we deliberately do NOT force-reconnect
        // everything here. A forced reconnect makes the broker treat the new
        // `hello` as a bridge handoff and fail every in-flight request with
        // E_BRIDGE_DISCONNECTED, so a single long event-loop stall inside the
        // worker (one slow agent task) would sabotage the very call that caused
        // it. Instead we gather evidence: probe as usual and let the
        // cadence-aware zombie rule below kill, on the NEXT pump, only the
        // sockets that genuinely produced no frame. A real zombie therefore
        // dies one cycle (~intervalMs) later, which is a far better trade than
        // dropping healthy connections on every stall.
        logger.warn?.('[sw] pi bridge keepalive gap detected; revalidating all clients', { gapMs: gap });
      }

      for (const client of clients) {
        const url = typeof client?.url === 'string' ? client.url : '';

        if (!client?.isConnected) {
          if (typeof client?.start === 'function') {
            // Fire-and-forget; each client manages its own race / dedupe. This
            // cancels the client's internal backoff so a broker that just came
            // up on a watched port is picked up within one cycle.
            Promise.resolve(client.start()).catch((error) => {
              logger.warn?.('[sw] keepalive reconnect nudge failed', { url, error });
            });
            result.nudged.push(url);
          }
          continue;
        }

        const silentFor = typeof client.msSinceLastReceive === 'number' ? client.msSinceLastReceive : 0;
        // A socket that has only just opened has not had a chance to answer a
        // probe yet, so it can never be judged silent.
        const settled = typeof client.connectedForMs === 'number'
          ? client.connectedForMs > intervalMs
          : true;
        const entry = stateFor(url);
        const suppressed = entry.suppressedUntil > now;

        // Silence is judged against the OBSERVED cadence, not a fixed constant:
        // if this pump itself ran late (OS sleep short enough that Chrome keeps
        // the worker, heavy load, a debugger pause, timer throttling) then every
        // healthy socket looks silent for roughly that delay. Adding the gap to
        // the budget means a late pump can never be mistaken for a dead peer;
        // only a socket that stays silent through a *timely* cycle is a zombie.
        const silenceBudget = Math.max(zombieTimeoutMs, gap + intervalMs);
        const isZombie = settled && !suppressed && silentFor > silenceBudget;

        if (settled && silentFor <= zombieTimeoutMs) {
          // The peer answered within the normal window: it is demonstrably
          // alive, so any escalation history for this URL is stale.
          entry.kills = 0;
          entry.suppressedUntil = 0;
        }

        if (isZombie && typeof client.forceReconnect === 'function') {
          entry.kills += 1;
          // A peer that answers `hello` but never a `probe` (an older broker
          // build, or a foreign WebSocket server squatting the port such as a
          // Vite HMR endpoint) would otherwise be reconnected forever at one
          // kill per cycle, because a health-driven reconnect resets backoff.
          // After a few kills we stop resetting backoff and mute the zombie
          // check for a while, turning permanent churn into a rare retry.
          const escalated = entry.kills >= maxConsecutiveZombieKills;
          if (escalated) {
            entry.suppressedUntil = now + suppressionMs;
            result.suppressed.push(url);
            logger.warn?.('[sw] pi bridge client keeps failing keepalive probes; backing off', {
              url,
              kills: entry.kills,
              suppressedForMs: suppressionMs,
            });
          }
          const reason = `no broker frame for ${describeSilence(silentFor)} (zombie socket)`;
          client.forceReconnect(reason, { resetBackoff: !escalated });
          result.killed.push({ url, reason, escalated });
          continue;
        }

        const probeFrame = { v: 1, kind: 'probe', id: `keepalive-${now}-${url}` };
        try {
          // send() reports failure by returning false rather than throwing, so
          // the return value is the only signal that this socket is unusable;
          // counting it as "probed" would hide a broken connection.
          if (client.send(probeFrame) === false) {
            if (typeof client.forceReconnect === 'function') {
              const reason = 'probe send failed';
              client.forceReconnect(reason, { resetBackoff: true });
              result.killed.push({ url, reason, escalated: false });
            }
          } else {
            result.probed.push(url);
            result.probedAny = true;
          }
        } catch (error) {
          // Belt and braces: a future/foreign client implementation may throw.
          logger.warn?.('[sw] keepalive probe failed', { url, error });
          if (typeof client.forceReconnect === 'function') {
            const reason = 'probe send threw';
            client.forceReconnect(reason, { resetBackoff: true });
            result.killed.push({ url, reason, escalated: false });
          }
        }
      }

      return result;
    },
  };
}
