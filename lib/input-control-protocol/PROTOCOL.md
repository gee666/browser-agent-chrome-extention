# Input-Control Protocol

**Version:** 1.0.0 &nbsp;•&nbsp; **Frozen:** 2026-04-18

The input-control protocol is a **semantic, transport-agnostic, synchronous
request/response protocol** for driving OS-level user input (mouse, keyboard,
scroll) from a browser extension or other client. Every request carries a
single high-level action (e.g. "click at viewport coordinates", "type this
string") together with the browser geometry needed to translate it, and the
server returns exactly one response per request. The protocol is defined in
terms of JSON objects; it is independent of the wire transport used to carry
those objects (see the transports note at the end of this document).

## Request Envelope

Every request is a JSON object with exactly these four top-level fields:

```jsonc
{
  "id":      "string",          // non-empty; echoed verbatim in the response
  "command": "string",          // one of the supported commands (see below)
  "params":  { /* object */ },  // per-command; may be omitted or null
  "context": { /* object */ }   // required browser geometry (see CONTEXT.md)
}
```

### Field rules

- **`id`** — non-empty string. The server MUST echo it back unchanged in the
  response's `id` field.
- **`command`** — non-empty string. MUST be one of the action commands enumerated
  in [COMMANDS.md](./COMMANDS.md):
  `mouse_move`, `mouse_click`, `scroll`, `type`, `press_key`, `press_shortcut`,
  `pause`, `sequence`. The control command `cancel` is part of the transport
  layer and is described in [TRANSPORTS.md](./TRANSPORTS.md).
- **`params`** — object. If missing or `null`, treated as `{}`. The accepted
  keys and their types are defined per-command in
  [COMMANDS.md](./COMMANDS.md). Unknown keys SHOULD be ignored.
- **`context`** — object, **always required**, even when the receiving backend
  ignores some or all of the geometry fields. See [CONTEXT.md](./CONTEXT.md)
  for the full schema, validation rules, and backend-class applicability.

### One action per request

A request carries exactly one action. Multiple actions are expressed by using
the `sequence` command, whose `params.steps` is a list of step objects.
**Sequences MUST NOT be nested** — a `sequence` step inside another
`sequence` is a validation error (see [ERRORS.md](./ERRORS.md)).

### Example request

```jsonc
{
  "id": "cmd-42",
  "command": "mouse_click",
  "params": { "x": 120, "y": 340, "button": "left", "count": 1 },
  "context": {
    "screenX": 100, "screenY": 80,
    "outerWidth": 1280, "outerHeight": 900,
    "innerWidth": 1280, "innerHeight": 820,
    "devicePixelRatio": 1.0,
    "scrollX": 0, "scrollY": 0
  }
}
```

### JSON Schema — request

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "InputControlRequest",
  "type": "object",
  "required": ["id", "command", "context"],
  "additionalProperties": false,
  "properties": {
    "id":      { "type": "string", "minLength": 1 },
    "command": {
      "type": "string",
      "enum": [
        "mouse_move", "mouse_click", "scroll", "type",
        "press_key", "press_shortcut", "pause", "sequence"
      ]
    },
    "params":  { "type": ["object", "null"] },
    "context": {
      "type": "object",
      "required": [
        "screenX", "screenY",
        "outerWidth", "outerHeight",
        "innerWidth", "innerHeight",
        "devicePixelRatio",
        "scrollX", "scrollY"
      ],
      "properties": {
        "screenX":          { "type": "number" },
        "screenY":          { "type": "number" },
        "outerWidth":       { "type": "number", "minimum": 0 },
        "outerHeight":      { "type": "number", "minimum": 0 },
        "innerWidth":       { "type": "number", "minimum": 0 },
        "innerHeight":      { "type": "number", "minimum": 0 },
        "devicePixelRatio": { "type": "number", "exclusiveMinimum": 0 },
        "scrollX":          { "type": "number" },
        "scrollY":          { "type": "number" }
      }
    }
  }
}
```

## Response Envelope

Every response is a JSON object with these top-level fields:

```jsonc
{
  "id":     "string | null",  // echoes request.id, or null if unparseable
  "status": "ok" | "error",
  "error":  "string | null"   // human-readable; null (or absent) on ok
}
```

### Field rules

- **`id`** — echoes the request's `id` exactly. It MAY be `null` if the server
  could not parse the incoming payload far enough to extract an id (for example
  malformed JSON, or an `id` field that is missing / not a non-empty string).
- **`status`** — `"ok"` on success, `"error"` on any failure.
- **`error`** — a human-readable English message describing the failure.
  Present (as a string) when `status == "error"`. When `status == "ok"` the
  canonical Python host emits `"error": null` explicitly; clients MUST accept
  both `null` and an omitted field as equivalent.

### Example responses

```json
{ "id": "cmd-42", "status": "ok", "error": null }
```

```json
{ "id": "cmd-42", "status": "error", "error": "Field 'x' must be a number" }
```

```json
{ "id": null, "status": "error", "error": "Malformed JSON: Expecting value" }
```

### JSON Schema — response

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "InputControlResponse",
  "type": "object",
  "required": ["id", "status"],
  "additionalProperties": false,
  "properties": {
    "id":     { "type": ["string", "null"] },
    "status": { "type": "string", "enum": ["ok", "error"] },
    "error":  { "type": ["string", "null"] }
  },
  "allOf": [
    {
      "if":   { "properties": { "status": { "const": "error" } } },
      "then": { "properties": { "error": { "type": "string", "minLength": 1 } },
                "required": ["error"] }
    }
  ]
}
```

## Ordering and Concurrency

Requests on a single connection are handled **serially**: at most one action
command is in flight at any time, and the server sends exactly one response
per request in request order.

While a command is in flight, the only request a client SHOULD send is
`cancel`. A `cancel` request aborts the currently running command; the
aborted command's response will carry `status: "error"` with
`error: "Command cancelled"` (see [ERRORS.md](./ERRORS.md)). Clients that
send other commands before receiving a response have undefined ordering
guarantees with respect to the in-flight command and MUST be prepared for
the server to queue or reject them.

## Protocol vs Transport

This document describes the **semantic** envelopes only: request/response
shapes, field rules, validation. A concrete deployment wraps these envelopes
in a transport — for example Chromium native messaging (length-prefixed
framed JSON over stdio), WebSocket text frames, or an in-process function
call. Transport concerns — framing, EOF semantics, reconnection,
`cancel` delivery, maximum payload sizes, framing error recovery — are
specified in [TRANSPORTS.md](./TRANSPORTS.md). Error messages produced by
the transport layer are catalogued in [ERRORS.md](./ERRORS.md).
