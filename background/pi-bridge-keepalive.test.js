import test from 'node:test';
import assert from 'node:assert/strict';

import { createKeepalivePump } from './pi-bridge-keepalive.js';

const INTERVAL = 20_000;
const ZOMBIE = INTERVAL * 2.5; // 50s
const GAP = INTERVAL * 3; // 60s

const silentLogger = { warn() {}, info() {}, error() {} };

function makePump(overrides = {}) {
  return createKeepalivePump({
    intervalMs: INTERVAL,
    zombieTimeoutMs: ZOMBIE,
    wakeGapMs: GAP,
    logger: silentLogger,
    ...overrides,
  });
}

function makeClient({
  url = 'ws://127.0.0.1:7878',
  isConnected = true,
  connectedForMs = 10 * 60_000,
  msSinceLastReceive = 1_000,
  sendResult = true,
} = {}) {
  return {
    url,
    isConnected,
    connectedForMs,
    msSinceLastReceive,
    sendResult,
    sent: [],
    kills: [],
    starts: 0,
    send(frame) {
      this.sent.push(frame);
      return this.sendResult;
    },
    forceReconnect(reason, options) {
      this.kills.push({ reason, options });
      return true;
    },
    start() {
      this.starts += 1;
      return Promise.resolve();
    },
  };
}

test('a freshly opened socket is probed but never killed for silence', () => {
  const pump = makePump();
  // Never received anything yet, but it has only been open for 5s: it has not
  // had a chance to answer a probe.
  const client = makeClient({ connectedForMs: 5_000, msSinceLastReceive: Infinity });

  const result = pump.pump({ clients: [client], now: 1_000_000 });

  assert.equal(client.kills.length, 0);
  assert.equal(result.probedAny, true);
  assert.deepEqual(result.probed, [client.url]);
  assert.deepEqual(result.killed, []);
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].kind, 'probe');
});

test('a settled socket silent for more than 2.5 cycles is force-reconnected', () => {
  const pump = makePump();
  const client = makeClient({ msSinceLastReceive: ZOMBIE + 5_000 });

  const result = pump.pump({ clients: [client], now: 0 });

  assert.equal(client.kills.length, 1);
  assert.match(client.kills[0].reason, /zombie socket/);
  assert.equal(client.kills[0].options.resetBackoff, true);
  assert.equal(client.sent.length, 0, 'a killed client is not also probed');
  assert.equal(result.probedAny, false);
  assert.equal(result.killed.length, 1);
});

test('the first pump never takes the wake-gap path', () => {
  const pump = makePump();
  const client = makeClient();

  const result = pump.pump({ clients: [client], now: Date.now() });

  assert.equal(result.gapMs, 0);
  assert.equal(result.wokeFromGap, false);
});

test('a pump delayed past the zombie timeout does not kill a healthy socket', () => {
  const pump = makePump();
  const client = makeClient({ msSinceLastReceive: 1_000 });
  pump.pump({ clients: [client], now: 0 });

  // The pump itself ran 55s late (host sleep / heavy load / debugger pause), so
  // every healthy socket looks silent for ~55s — above the 50s baseline but
  // below the 60s gap threshold. It must not be mistaken for a dead peer.
  client.msSinceLastReceive = 55_000;
  const result = pump.pump({ clients: [client], now: 55_000 });

  assert.equal(result.wokeFromGap, false);
  assert.deepEqual(client.kills, []);
  assert.equal(result.probedAny, true);
});

test('a wake gap only probes and warns; the next cycle decides who is dead', () => {
  const warnings = [];
  const pump = makePump({ logger: { ...silentLogger, warn: (...args) => warnings.push(args) } });
  const healthy = makeClient({ url: 'ws://127.0.0.1:7878', msSinceLastReceive: 1_000 });
  const dead = makeClient({ url: 'ws://127.0.0.1:7879', msSinceLastReceive: 1_000 });
  pump.pump({ clients: [healthy, dead], now: 0 });

  // 5 minutes later: both look silent for the whole gap.
  healthy.msSinceLastReceive = 300_000;
  dead.msSinceLastReceive = 300_000;
  const woke = pump.pump({ clients: [healthy, dead], now: 300_000 });

  assert.equal(woke.wokeFromGap, true);
  assert.deepEqual(woke.killed, [], 'no pre-emptive reconnects: they would fail in-flight requests');
  assert.equal(woke.probed.length, 2);
  assert.equal(warnings.length, 1);

  // One timely cycle later only the client that produced no frame dies.
  healthy.msSinceLastReceive = 1_000;
  dead.msSinceLastReceive = 320_000;
  const next = pump.pump({ clients: [healthy, dead], now: 320_000 });

  assert.deepEqual(next.killed.map((k) => k.url), [dead.url]);
  assert.deepEqual(next.probed, [healthy.url]);
});

test('a disconnected client gets a start() nudge instead of a kill', () => {
  const pump = makePump();
  const client = makeClient({ isConnected: false, msSinceLastReceive: Infinity, connectedForMs: 0 });

  const result = pump.pump({ clients: [client], now: 0 });

  assert.equal(client.starts, 1);
  assert.deepEqual(client.kills, []);
  assert.equal(client.sent.length, 0);
  assert.deepEqual(result.nudged, [client.url]);
  assert.equal(result.probedAny, false);
});

test('a peer that never answers probes is suppressed after 3 kills instead of churning', () => {
  const pump = makePump({ suppressionMs: 300_000 });
  // A foreign WebSocket server (or an old broker with no probe support): it
  // accepts the connection but never sends a frame back.
  const client = makeClient({ msSinceLastReceive: ZOMBIE + 5_000 });

  const first = pump.pump({ clients: [client], now: 0 });
  const second = pump.pump({ clients: [client], now: INTERVAL });
  const third = pump.pump({ clients: [client], now: INTERVAL * 2 });

  assert.equal(first.killed[0].escalated, false);
  assert.equal(second.killed[0].escalated, false);
  assert.equal(third.killed[0].escalated, true);
  assert.deepEqual(third.suppressed, [client.url]);
  // The escalating kill must stop resetting backoff so the client's own
  // reconnect schedule can grow.
  assert.equal(first.killed[0].reason.includes('zombie'), true);
  assert.deepEqual(client.kills.map((k) => k.options.resetBackoff), [true, true, false]);

  // Inside the suppression window the socket is left alone (only probed).
  for (let now = INTERVAL * 3; now <= 320_000; now += INTERVAL) {
    const quiet = pump.pump({ clients: [client], now });
    assert.deepEqual(quiet.killed, [], `unexpected kill at ${now}`);
    assert.deepEqual(quiet.probed, [client.url]);
  }

  // Once the window expires the check resumes.
  const after = pump.pump({ clients: [client], now: 340_000 });
  assert.equal(after.killed.length, 1);
  assert.equal(after.killed[0].escalated, true);
});

test('a client that answers again clears its escalation history', () => {
  const pump = makePump();
  const client = makeClient({ msSinceLastReceive: ZOMBIE + 5_000 });
  pump.pump({ clients: [client], now: 0 });
  pump.pump({ clients: [client], now: INTERVAL });
  assert.equal(pump.inspect().zombieState.get(client.url).kills, 2);

  client.msSinceLastReceive = 1_000;
  pump.pump({ clients: [client], now: INTERVAL * 2 });
  assert.equal(pump.inspect().zombieState.get(client.url).kills, 0);

  // Fresh silence therefore starts from a clean slate rather than escalating.
  client.msSinceLastReceive = ZOMBIE + 5_000;
  const result = pump.pump({ clients: [client], now: INTERVAL * 3 });
  assert.equal(result.killed[0].escalated, false);
});

test('escalation bookkeeping is pruned to the currently configured client urls', () => {
  const pump = makePump();
  const a = makeClient({ url: 'ws://127.0.0.1:7878', msSinceLastReceive: ZOMBIE + 5_000 });
  const b = makeClient({ url: 'ws://127.0.0.1:7879', msSinceLastReceive: ZOMBIE + 5_000 });

  pump.pump({ clients: [a, b], now: 0 });
  assert.deepEqual([...pump.inspect().zombieState.keys()], [a.url, b.url]);

  pump.pump({ clients: [a], now: INTERVAL });
  assert.deepEqual([...pump.inspect().zombieState.keys()], [a.url]);
});

test('a client whose send fails is reconnected and not counted as probed', () => {
  const pump = makePump();
  const client = makeClient({ sendResult: false });

  const result = pump.pump({ clients: [client], now: 0 });

  assert.equal(result.probedAny, false);
  assert.deepEqual(result.probed, []);
  assert.deepEqual(result.killed.map((k) => k.reason), ['probe send failed']);
});

test('a client whose send throws is reconnected as belt-and-braces', () => {
  const pump = makePump();
  const client = makeClient();
  client.send = () => { throw new Error('boom'); };

  const result = pump.pump({ clients: [client], now: 0 });

  assert.deepEqual(result.killed.map((k) => k.reason), ['probe send threw']);
  assert.equal(result.probedAny, false);
});

test('probe ids identify the target url and never contain Infinity in kill reasons', () => {
  const pump = makePump();
  const a = makeClient({ url: 'ws://127.0.0.1:7878' });
  const b = makeClient({ url: 'ws://127.0.0.1:7879' });
  pump.pump({ clients: [a, b], now: 1234 });

  assert.equal(a.sent[0].id, 'keepalive-1234-ws://127.0.0.1:7878');
  assert.equal(b.sent[0].id, 'keepalive-1234-ws://127.0.0.1:7879');

  const never = makeClient({ msSinceLastReceive: Infinity });
  const result = pump.pump({ clients: [never], now: 1234 + INTERVAL });
  assert.equal(result.killed.length, 1);
  assert.doesNotMatch(result.killed[0].reason, /Infinity/);
});

test('reset() forgets the cadence so a re-enabled bridge does not see a fake gap', () => {
  const pump = makePump();
  const client = makeClient();
  pump.pump({ clients: [client], now: 0 });

  pump.reset();
  const result = pump.pump({ clients: [client], now: 600_000 });

  assert.equal(result.gapMs, 0);
  assert.equal(result.wokeFromGap, false);
  assert.equal(pump.inspect().zombieState.size, 1);
});
