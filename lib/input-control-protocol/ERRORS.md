# Errors

All failures — validation, unknown command, backend problems, cancellation,
transport framing — are reported through the standard response envelope
described in [PROTOCOL.md](./PROTOCOL.md). This document enumerates the
canonical error messages emitted by the reference Python host, groups them
by cause, and gives guidance on when a client should surface an error to
its caller versus retry.

## Error Envelope

```jsonc
{
  "id":     "string | null",   // echoes request id; null if unextractable
  "status": "error",
  "error":  "<human-readable message>"
}
```

- `id` echoes the request's `id`. It is `null` only when the server could
  not parse the incoming payload far enough to extract one — for example
  malformed JSON, a payload that isn't a JSON object, or an `id` field
  that is missing / not a non-empty string.
- `error` is a non-empty human-readable English string. Clients SHOULD
  treat messages as opaque for presentation but MAY match them as
  documented below for programmatic handling.

Example:

```json
{ "id": "cmd-42", "status": "error", "error": "Field 'x' must be a number" }
```

## Standard Error Messages

The strings below are emitted verbatim by the Python host. Message
templates use angle brackets (`<name>`, `<x>`, `<y>`, `<N>`, `<M>`,
`<detail>`) for values substituted at runtime.

### Validation (request schema)

Raised while parsing the request envelope, `params`, or `context`. All
surface as `ValidationError` in the Python host.

| When                                                      | Message                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `id` missing / not a non-empty string                     | `Field 'id' must be a non-empty string`                                                            |
| `command` missing / not a non-empty string                | `Field 'command' must be a non-empty string`                                                       |
| Numeric field has wrong type                              | `Field '<name>' must be a number`                                                                  |
| Required field absent                                     | `Missing required field '<name>'`                                                                  |
| Integer field not a non-negative int                      | `Field '<name>' must be a non-negative integer`                                                    |
| Integer field not a positive int                          | `Field '<name>' must be a positive integer`                                                        |
| Number field is `NaN` / infinite                          | `Field '<name>' must be finite`                                                                    |
| `button` not in `{left, right, middle}`                   | `Field 'button' must be one of: left, right, middle`                                               |
| `keys` not an array of strings                            | `Field 'keys' must be an array of strings`                                                         |
| `keys` array is empty                                     | `Field 'keys' must contain at least one key`                                                       |
| A `sequence` step is itself a `sequence`                  | `Nested sequence commands are not supported`                                                       |
| `context` missing or not an object                        | `Field 'context' must be an object`                                                                |
| `context.devicePixelRatio <= 0`                           | `Field 'context.devicePixelRatio' must be greater than zero`                                       |
| `context.outerHeight < context.innerHeight`               | `Field 'context.outerHeight' must be greater than or equal to 'context.innerHeight'`               |
| Any browser height is negative                            | `Browser heights must be greater than or equal to zero`                                            |

### Unknown command

Raised when `command` is a string but not one of the supported names.

```text
Unknown command: <name>
```

### Cancellation

Raised when the in-flight command is aborted, either because the client
sent a `cancel` request or because the transport closed (e.g. native
messaging port disconnect).

```text
Command cancelled
```

### Coordinate / desktop bounds

Raised by pointer-targeted commands (`mouse_move`, `mouse_click`, `scroll`)
after viewport→screen translation.

| When                                                 | Message                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Translated point outside the virtual desktop         | `Coordinates (<x>, <y>) fall outside the virtual desktop bounds`                           |
| Virtual desktop bounds couldn't be discovered        | `Virtual desktop bounds are unavailable; refusing to execute pointer-targeted command`     |

### Backend unavailable

Produced by `BackendUnavailableError` in the Python host when no concrete
mouse/keyboard backend is wired in, or when the selected backend fails to
initialize. The exact message is **implementation-defined** (e.g.
`"No mouse backend configured"`, or a platform-specific import-failure
message). Clients SHOULD treat this as a class of error identified by the
`status: "error"` envelope rather than by exact string match.

### Framing errors (transport-level)

Produced by the native-messaging layer before a JSON payload is even
available. See [TRANSPORTS.md](./TRANSPORTS.md) for the full framing
discussion. The canonical messages are:

| Recoverability | Message                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| Recoverable    | `Native message payload length <N> exceeds the maximum supported size <M>`                  |
| Fatal          | `Unexpected EOF while reading native message stream`                                        |
| Recoverable    | `Payload must be valid UTF-8`                                                               |
| Recoverable    | `Malformed JSON: <detail>`                                                                  |
| Recoverable    | `Incoming JSON payload must be an object`                                                   |

For recoverable framing errors the host writes an error response with
`id: null`, discards the bad frame, and keeps serving. For fatal framing
errors the host writes the error response (with `id: null`), cancels any
in-flight command, and terminates.

## Error Classes in Implementations

### Python host (reference)

From `python_input_control.errors`:

- `InputControlError` — base class for every protocol-level error.
- `ValidationError` — request schema violations (including context).
- `UnknownCommandError` — subclass of `ValidationError`; unknown `command`.
- `CoordinateOutOfBoundsError` — subclass of `ValidationError`; pointer
  translated outside the virtual desktop.
- `DesktopBoundsUnavailableError` — subclass of `ValidationError`; no
  desktop bounds discovered.
- `CommandCancelledError` — in-flight command aborted.
- `CommandExecutionError` — backend raised while executing a validated
  command.
- `BackendUnavailableError` — no concrete backend wired in / selected.
- `FramingError`, `RecoverableFramingError`, `ProtocolDecodeError` —
  transport-level decode failures.

### Browser-extension client (JavaScript)

The `browser-agent-ext` input-control bridge surfaces failures through
three error classes:

- `InputControlError` — generic protocol/backend error; carries the
  message from the response envelope.
- `InputControlTimeoutError` — the client gave up waiting for a response
  (client-side only; not part of the wire protocol).
- An abort error with `name === "InputControlAbortError"` — the local
  pending request was aborted (e.g. the bridge disconnected while the
  caller was awaiting a response).

## Surfacing vs Retrying

Guidance for clients on how to react to each class of error:

| Class                                   | Client action                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Validation (incl. context, params, id)  | **Surface** to caller. Do not retry — the request is malformed and will always fail.                |
| Unknown command                         | **Surface**. Do not retry.                                                                          |
| Coordinate out of bounds                | **Surface**. Do not retry blindly; caller may recompute coordinates and re-issue a new request.     |
| Desktop bounds unavailable              | **Surface**. Retrying with the same host process is unlikely to help.                               |
| Cancelled (`"Command cancelled"`)       | **Expected outcome** of a `cancel` / disconnect. Do not treat as a failure; propagate as a cancel.  |
| Backend unavailable                     | **Surface**. Retry only if the implementer can reload / reconfigure the backend.                    |
| Framing error — recoverable             | The server discards the bad frame and keeps serving. Client SHOULD retry the next request as usual. |
| Framing error — fatal                   | The server terminates. Client SHOULD **reconnect**, then retry.                                     |
| Client-side timeout                     | Not part of the envelope. The client decides: typically cancel the in-flight command, then retry.   |

See [PROTOCOL.md](./PROTOCOL.md) for the envelope contract and
[CONTEXT.md](./CONTEXT.md) for the validation rules that produce most of
the validation errors above.
