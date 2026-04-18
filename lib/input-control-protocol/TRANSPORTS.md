# Input Control Protocol — Transports

The input control protocol is **transport-agnostic**: the envelope shape
(`{ id, command, params, context }` request / `{ id, status, error? }`
response) never changes. Only the framing and cancellation mechanics depend on
how the envelope travels between the extension and the backend.

Three transports are documented below. Two are **Normative (v1)** — required
to be supported by any v1 implementation — and one is **Informative (future)**
— design guidance only, with no reference code.

See also: [PROTOCOL.md](./PROTOCOL.md) · [CONTEXT.md](./CONTEXT.md) ·
[ERRORS.md](./ERRORS.md) · [BACKENDS.md](./BACKENDS.md).

---

## 1. Native messaging — **Normative (v1)**

Reference implementation: [`python-input-control/src/python_input_control/protocol.py`](../../../python-input-control/src/python_input_control/protocol.py).

### Framing

Every frame is a **4-byte little-endian unsigned length header** followed by a
**UTF-8 JSON** payload. Exactly one envelope per frame.

```python
# protocol.py
_NATIVE_MESSAGE_HEADER = struct.Struct("=I")
_MAX_NATIVE_MESSAGE_SIZE = 4 * 1024 * 1024  # 4 MiB
```

The `=I` `struct` format means native byte order with standard sizes and no
padding; on every platform Chrome supports this is a 32-bit little-endian
unsigned integer.

Encoder (for reference):

```python
def encode_native_message(message):
    payload = json.dumps(message, ensure_ascii=False,
                         separators=(",", ":")).encode("utf-8")
    return _NATIVE_MESSAGE_HEADER.pack(len(payload)) + payload
```

### Max payload size

| Limit             | Value                       |
|-------------------|-----------------------------|
| Max payload bytes | `4 * 1024 * 1024` (4 MiB)   |
| Header size       | 4 bytes                     |

If the length header declares a payload **larger than 4 MiB**, the host:

1. **MUST** drain (read and discard) exactly that many bytes from the stream
   so the framing stays aligned for the next message.
2. **MUST** respond with a framing error envelope
   (`{"status":"error","error":"Native message payload length … exceeds the
   maximum supported size …"}`).
3. **SHOULD** keep the connection open — over-limit is a `RecoverableFramingError`,
   not fatal.

Truncated payloads (EOF mid-frame) are a `FramingError` and **MUST** terminate
the host.

### Wiring (Chrome → host)

* Chrome side: `chrome.runtime.connectNative(hostName)` (see the bridge in
  [`browser-agent-core/background/input-control.js`](../../../browser-agent-core/background/input-control.js)).
* Host side: reads frames from **stdin**, writes frames to **stdout**, logs
  human-readable diagnostics to **stderr**.
* Host registration (manifest file location, `allowed_origins`, etc.) is
  **outside the scope of this protocol**.

### Cancellation semantics

| Trigger                                      | Effect                                                                |
|----------------------------------------------|-----------------------------------------------------------------------|
| JS calls `port.disconnect()` → stdin EOF     | Cancel in-flight command **and** terminate the host.                  |
| JS sends `{"command": "cancel"}` frame       | Cancel the in-flight command; connection stays open for more commands.|

Both paths are implemented in `NativeMessagingHost.serve_forever`:

* A dedicated **stdin reader thread** reads frames and enqueues them. When it
  reads EOF it enqueues a `None` sentinel. The main thread then sets
  `cancel_event` and joins the command thread.
* A `cancel` command sets the same `cancel_event`, joins the command thread,
  clears the event, and writes an `ok` response.

### Ordering

* Responses are serialised **per connection**: one command at a time, one
  response envelope per request.
* The host **MAY** read frames concurrently with command execution (the
  reference host does, on a separate thread) so that a `cancel` frame can
  arrive *during* a long-running command like `type` and stop it within one
  inter-key delay (~50–100 ms).

---

## 2. In-process direct call — **Normative (v1)**

Reference implementation: [`browser-agent-ext/lib/browser-agent-input-control`](../browser-agent-input-control).
The JS class `CdpInputControlBridge` implements the **same surface** as
`InputControlBridge` in
[`browser-agent-core/background/input-control.js`](../../../browser-agent-core/background/input-control.js):
`execute(command, params, context)`, `abort()`, and `disconnect()`.

### Framing

**None.** There is no wire. The request envelope is passed as a plain JS
object to an async method; the response envelope is the resolved value of the
returned `Promise`.

```js
// Conceptual signature — matches InputControlBridge.execute
const response = await bridge.execute(command, params, context);
// response === { id, status: 'ok' }  or  { id, status: 'error', error: '…' }
```

Both sides run in the same JS realm (the extension service worker), so JSON
encoding is skipped entirely. Envelope **shape** and **field semantics** are
still exactly the ones defined in [PROTOCOL.md](./PROTOCOL.md).

### Cancellation semantics

An **`AbortController`-style** `abort()` method on the bridge. Calling
`abort()`:

1. Rejects **all pending promises** immediately with an `InputControlError`
   whose `name === 'InputControlAbortError'`.
2. Tears down any in-process CDP sessions the bridge owns so the next
   `execute()` starts fresh.

This contract matches what `ActionExecutor` / `agent.js` already expects from
the native-messaging bridge:

```js
// input-control.js — shape the CdpInputControlBridge must also satisfy
abort() {
  const abortError = new InputControlError('Aborted: stop was requested');
  abortError.name = 'InputControlAbortError';
  for (const { reject, timer } of this._pending.values()) {
    clearTimeout(timer);
    reject(abortError);
  }
  this._pending.clear();
  // …tear down transport…
}
```

Clients **MUST NOT** rely on wire side-effects (e.g. EOF on a pipe) to detect
cancellation. Cancellation is purely in-memory: check for
`err.name === 'InputControlAbortError'` on the rejected promise.

### Timeouts

Timeouts are a **client concern** for this transport. The reference client
derives the `type` timeout from text length and WPM so long prompts never time
out:

```js
// input-control.js
_timeoutFor(command, params) {
  if (command === 'type' && typeof params?.text === 'string') {
    const wpm = params.wpm || 60;
    const chars = params.text.length;
    // ms to type the text at the given WPM (1 word ≈ 5 chars)
    const typingMs = Math.ceil((chars / (wpm * 5)) * 60_000);
    // add 10 s headroom for startup / inter-key jitter
    return Math.max(30_000, typingMs + 10_000);
  }
  return 30_000;
}
```

Default WPM when `params.wpm` is omitted is **60** on the client side for
timeout estimation; the backend’s own default is random uniform
`[60.0, 100.0]` — see
[`python-input-control/src/python_input_control/backends/pynput_keyboard.py`](../../../python-input-control/src/python_input_control/backends/pynput_keyboard.py).

---

## 3. WebSocket / TCP — **Informative (future) — NOT IMPLEMENTED in v1**

> This section is **informative, non-normative**. There is **no v1 reference
> code** for a WebSocket or raw-TCP transport. It is documented here only so
> that a future implementer knows the framing and cancellation rules the rest
> of the protocol expects.
>
> Design decision: v1 ships with native messaging and in-process only. A
> network transport can be added later **without any envelope change** — only
> framing differs.

### Recommended framing

* **One JSON envelope per WebSocket text frame** (UTF-8).
* Enforce the **same 4 MiB cap per frame** as native messaging. Over-limit
  frames **MUST** be rejected with a framing error envelope; the connection
  **SHOULD** stay open.
* For raw TCP (no WebSocket), reuse the native-messaging framing verbatim:
  4-byte little-endian length header + UTF-8 JSON payload.

### Keepalive

* **Ping interval: 30 seconds.** The server SHOULD send a WebSocket ping
  every 30 s.
* **Missed pong → disconnect → cancel.** If the peer fails to pong within one
  ping interval, the server treats it as a disconnect and cancels any
  in-flight command (same effect as stdin EOF for native messaging).

### Close-frame semantics

A WebSocket close frame from **either side** is a cancel: the backend aborts
any running command and the client rejects any pending promises. This matches
the native-messaging EOF path.

### Auth / TLS

**Out of scope for v1.** If a network transport is added, implementers:

* **SHOULD** use TLS (`wss://` / TLS-wrapped TCP) in any non-loopback setup.
* **SHOULD** require a shared secret, token, or origin check; a local-only
  backend SHOULD bind to `127.0.0.1` and reject non-loopback connections.

### Future work

If/when a network transport is added it **MUST** carry the exact same envelope
shape defined in [PROTOCOL.md](./PROTOCOL.md). Only the framing (length-prefix
vs. WebSocket frame) and the keepalive/close semantics change.

---

## Cancellation summary

| Transport              | Trigger for cancel                                    | Effect                                                            |
|------------------------|-------------------------------------------------------|-------------------------------------------------------------------|
| Native messaging       | JS calls `port.disconnect()` → stdin EOF              | Cancel in-flight command **and** terminate host process.          |
| Native messaging       | `{"command":"cancel"}` frame                          | Cancel in-flight command; connection stays open.                  |
| In-process direct call | `bridge.abort()`                                      | Reject all pending promises with `InputControlAbortError`; reset. |
| WebSocket *(future)*   | Close frame from either side, or missed pong (30 s)   | Cancel in-flight command; connection closed.                      |
| WebSocket *(future)*   | `{"command":"cancel"}` text frame                     | Cancel in-flight command; connection stays open.                  |

In every case the backend **MUST** respond to a cancelled command with
`{"status":"error","error":"Command cancelled"}` — see
[ERRORS.md](./ERRORS.md) and [BACKENDS.md](./BACKENDS.md).
