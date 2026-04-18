# Input Control Protocol — Commands

This document specifies every command understood by a compliant
`python-input-control` host. Each request uses the envelope
`{id, command, params, context}` described in [./PROTOCOL.md](./PROTOCOL.md),
and each response uses the envelope `{id, status, error}`. Every `params`
schema below is for the `params` field only; the outer envelope and its
`context` object are defined in [./PROTOCOL.md](./PROTOCOL.md) and
[./CONTEXT.md](./CONTEXT.md). Error strings are normative and are
cross-referenced in [./ERRORS.md](./ERRORS.md). Transport-level concerns
(framing, ordering, cancellation) live in [./TRANSPORTS.md](./TRANSPORTS.md),
and backend-specific behavior is described in [./BACKENDS.md](./BACKENDS.md).

All coordinates are **viewport CSS pixels**. The host translates them to
physical-screen coordinates using the envelope `context` before dispatch.

---

## `mouse_move`

Moves the pointer to viewport coordinate `(x, y)` in CSS pixels.

### Params

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "mouse_move.params",
  "type": "object",
  "required": ["x", "y"],
  "additionalProperties": false,
  "properties": {
    "x": { "type": "number" },
    "y": { "type": "number" },
    "duration_ms": { "type": "integer", "minimum": 0 }
  }
}
```

### Behaviour

- MUST translate `(x, y)` from viewport CSS pixels to physical screen
  coordinates using the request `context` before dispatch.
- MUST reject translated coordinates that fall outside the virtual desktop
  bounds on OS backends (see [./BACKENDS.md](./BACKENDS.md)).
- SHOULD produce human-like motion (Bezier / eased trajectory, per-step
  delay) when `duration_ms` is absent.
- MUST teleport instantly when `duration_ms === 0`.
- SHOULD honor an explicit positive `duration_ms` by spacing intermediate
  steps across roughly that window.
- MUST be cancellable between motion steps.

### Errors

See [./ERRORS.md](./ERRORS.md) for the complete list. A compliant
implementation MUST surface at least:

- `"Missing required field 'x'"` / `"Missing required field 'y'"`
- `"Field 'x' must be a number"` / `"Field 'y' must be a number"`
- `"Field 'duration_ms' must be a non-negative integer"`
- `"Coordinates (<x>, <y>) fall outside the virtual desktop bounds"` (OS
  backends only)
- `"Command cancelled"` if cancelled mid-flight.

### Examples

Example 1 — happy path:

```jsonc
// request
{
  "id": "req-mm-1",
  "command": "mouse_move",
  "params": { "x": 420, "y": 300, "duration_ms": 180 },
  "context": {
    "screenX": 0, "screenY": 0,
    "outerHeight": 900, "innerHeight": 820,
    "outerWidth": 1440, "innerWidth": 1440,
    "devicePixelRatio": 1,
    "scrollX": 0, "scrollY": 0
  }
}
// response
{ "id": "req-mm-1", "status": "ok", "error": null }
```

Example 2 — teleport:

```jsonc
// request
{
  "id": "req-mm-2",
  "command": "mouse_move",
  "params": { "x": 10, "y": 10, "duration_ms": 0 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-mm-2", "status": "ok", "error": null }
```

Example 3 — validation error (missing `x`):

```jsonc
// request
{
  "id": "req-mm-3",
  "command": "mouse_move",
  "params": { "y": 50 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-mm-3", "status": "error", "error": "Missing required field 'x'" }
```

---

## `mouse_click`

Moves the pointer to `(x, y)` and then presses and releases the specified
mouse button. Supports multi-click via `count`.

### Params

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "mouse_click.params",
  "type": "object",
  "required": ["x", "y"],
  "additionalProperties": false,
  "properties": {
    "x": { "type": "number" },
    "y": { "type": "number" },
    "button": { "type": "string", "enum": ["left", "right", "middle"], "default": "left" },
    "count": { "type": "integer", "minimum": 1, "default": 1 },
    "move_duration_ms": { "type": "integer", "minimum": 0 },
    "hold_ms": { "type": "integer", "minimum": 0 },
    "interval_ms": { "type": "integer", "minimum": 0 }
  }
}
```

### Behaviour

- MUST move to `(x, y)` before the first press. The move SHOULD use
  `move_duration_ms` when provided, otherwise a human-like default.
- MUST pause between press and release — SHOULD be at least 10 ms,
  and SHOULD honor `hold_ms` when provided.
- When `count > 1`, MUST emit exactly `count` press/release pairs
  separated by `interval_ms` (SHOULD default to a short OS-like delay
  for double-click cadence when omitted).
- MUST reject translated coordinates outside the virtual desktop bounds
  on OS backends.
- MUST be cancellable between any two press/release boundaries.

### Errors

See [./ERRORS.md](./ERRORS.md). MUST surface at least:

- `"Missing required field 'x'"` / `"Missing required field 'y'"`
- `"Field 'button' must be one of: left, right, middle"`
- `"Field 'count' must be a positive integer"`
- `"Field 'move_duration_ms' must be a non-negative integer"` (and the
  same message pattern for `hold_ms`, `interval_ms`)
- `"Coordinates (<x>, <y>) fall outside the virtual desktop bounds"`
- `"Command cancelled"`

### Examples

Example 1 — single left click:

```jsonc
// request
{
  "id": "req-mc-1",
  "command": "mouse_click",
  "params": { "x": 512, "y": 360 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-mc-1", "status": "ok", "error": null }
```

Example 2 — double click with explicit interval:

```jsonc
// request
{
  "id": "req-mc-2",
  "command": "mouse_click",
  "params": { "x": 512, "y": 360, "count": 2, "interval_ms": 80, "hold_ms": 40 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-mc-2", "status": "ok", "error": null }
```

Example 3 — invalid button:

```jsonc
// request
{
  "id": "req-mc-3",
  "command": "mouse_click",
  "params": { "x": 100, "y": 100, "button": "side" },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-mc-3", "status": "error", "error": "Field 'button' must be one of: left, right, middle" }
```

---

## `scroll`

Dispatches a wheel event at `(x, y)` with the given deltas.

### Params

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "scroll.params",
  "type": "object",
  "required": ["x", "y", "delta_x", "delta_y"],
  "additionalProperties": false,
  "properties": {
    "x": { "type": "number" },
    "y": { "type": "number" },
    "delta_x": { "type": "number" },
    "delta_y": { "type": "number" },
    "duration_ms": { "type": "integer", "minimum": 0 }
  }
}
```

### Behaviour

- MUST position the pointer at `(x, y)` before emitting the wheel event.
- SHOULD emit multiple stepped deltas across `duration_ms` when
  `duration_ms > 0` instead of a single atomic jump.
- MAY emit a single wheel tick when `duration_ms` is absent or zero.
- Positive `delta_y` scrolls down; positive `delta_x` scrolls right.
- MUST be cancellable between wheel steps.

### Errors

See [./ERRORS.md](./ERRORS.md). MUST surface at least:

- `"Missing required field 'delta_x'"` / `"Missing required field 'delta_y'"`
- `"Field 'delta_x' must be a number"` / `"Field 'delta_y' must be a number"`
- `"Field 'duration_ms' must be a non-negative integer"`
- `"Coordinates (<x>, <y>) fall outside the virtual desktop bounds"`
- `"Command cancelled"`

### Examples

Example 1 — scroll down:

```jsonc
// request
{
  "id": "req-sc-1",
  "command": "scroll",
  "params": { "x": 720, "y": 400, "delta_x": 0, "delta_y": 600, "duration_ms": 250 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-sc-1", "status": "ok", "error": null }
```

Example 2 — horizontal scroll:

```jsonc
// request
{
  "id": "req-sc-2",
  "command": "scroll",
  "params": { "x": 500, "y": 500, "delta_x": -300, "delta_y": 0 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-sc-2", "status": "ok", "error": null }
```

Example 3 — missing delta (validation error):

```jsonc
// request
{
  "id": "req-sc-3",
  "command": "scroll",
  "params": { "x": 500, "y": 500, "delta_x": 0 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-sc-3", "status": "error", "error": "Missing required field 'delta_y'" }
```

---

## `type`

Types `text` one character at a time, firing real key events so that page
listeners see `keydown` / `keypress` / `keyup`.

### Params

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "type.params",
  "type": "object",
  "required": ["text"],
  "additionalProperties": false,
  "properties": {
    "text": { "type": "string" },
    "wpm": { "type": "number", "exclusiveMinimum": 0 }
  }
}
```

### Behaviour

- MUST fire real key events per character (e.g. via pynput on the OS
  backend). MUST NOT perform an atomic `insertText` / value-set shortcut,
  because page listeners need to observe real `keydown`/`keyup`.
- MUST compute an inter-key delay from the effective WPM. When `wpm` is
  omitted, the OS backend picks a uniform random in `[60.0, 100.0]`
  (see `pynput_keyboard.py` constants `_DEFAULT_MIN_WPM` / `_DEFAULT_MAX_WPM`).
  The extension-side client in
  `browser-agent-core/background/input-control.js` separately assumes a
  conservative `wpm = 60` when estimating a client-side timeout, so both
  sides agree on 60 as the slow-end floor.
- SHOULD jitter per-key delays by roughly ±25% to avoid a metronomic
  cadence.
- SHOULD insert an extra pause after whitespace and punctuation
  (`space`, `,`, `.`, `;`, `:`, `!`, `?`).
- MUST be cancellable between any two characters.

### Errors

See [./ERRORS.md](./ERRORS.md). MUST surface at least:

- `"Missing required field 'text'"`
- `"Field 'text' must be a string"`
- `"Field 'wpm' must be a positive finite number"`
- `"Command cancelled"`

### Examples

Example 1 — hello world at 60 WPM:

```jsonc
// request
{
  "id": "req-ty-1",
  "command": "type",
  "params": { "text": "hello world", "wpm": 60 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-ty-1", "status": "ok", "error": null }
```

Example 2 — no wpm (host picks uniform random in [60, 100]):

```jsonc
// request
{
  "id": "req-ty-2",
  "command": "type",
  "params": { "text": "Ready." },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-ty-2", "status": "ok", "error": null }
```

Example 3 — non-positive wpm (validation error):

```jsonc
// request
{
  "id": "req-ty-3",
  "command": "type",
  "params": { "text": "nope", "wpm": 0 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-ty-3", "status": "error", "error": "Field 'wpm' must be a positive finite number" }
```

---

## `press_key`

Presses a single logical key, optionally repeated. Key names are
logical (e.g. `enter`, `tab`, `escape`, `arrowleft`, `a`, `f5`).

### Params

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "press_key.params",
  "type": "object",
  "required": ["key"],
  "additionalProperties": false,
  "properties": {
    "key": { "type": "string", "minLength": 1 },
    "repeat": { "type": "integer", "minimum": 1, "default": 1 }
  }
}
```

### Behaviour

- MUST normalize common aliases before dispatch:
  - `esc` ↔ `escape`
  - `return` ↔ `enter`
  - `ctrl` / `ctl` ↔ `control`
  - `cmd` / `meta` / `super` / `win` / `windows` ↔ `command`
  - `opt` / `option` ↔ `alt`
  - `arrowup` / `arrowdown` / `arrowleft` / `arrowright` ↔
    `up` / `down` / `left` / `right`
  - (full list: see `backends/pynput_keyboard.py::_KEY_ALIASES`).
- MUST pause between press and release — SHOULD be at least 10 ms.
- When `repeat > 1`, MUST emit that many distinct press/release pairs
  with a short pause between them.
- MUST be cancellable between repeats.

### Errors

See [./ERRORS.md](./ERRORS.md). MUST surface at least:

- `"Missing required field 'key'"`
- `"Field 'key' must be a string"`
- `"Field 'repeat' must be a positive integer"`
- `"Command cancelled"`

### Examples

Example 1 — press Enter:

```jsonc
// request
{
  "id": "req-pk-1",
  "command": "press_key",
  "params": { "key": "enter" },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-pk-1", "status": "ok", "error": null }
```

Example 2 — repeat ArrowDown 5 times:

```jsonc
// request
{
  "id": "req-pk-2",
  "command": "press_key",
  "params": { "key": "arrowdown", "repeat": 5 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-pk-2", "status": "ok", "error": null }
```

Example 3 — bad `repeat` (validation error):

```jsonc
// request
{
  "id": "req-pk-3",
  "command": "press_key",
  "params": { "key": "tab", "repeat": 0 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-pk-3", "status": "error", "error": "Field 'repeat' must be a positive integer" }
```

---

## `press_shortcut`

Presses a chord of keys — holds the modifiers in order, presses the final
key, then releases everything in reverse order.

### Params

Either an array form:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "press_shortcut.params (array form)",
  "type": "object",
  "required": ["keys"],
  "additionalProperties": false,
  "properties": {
    "keys": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string", "minLength": 1 }
    }
  }
}
```

or a string form split on `+`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "press_shortcut.params (string form)",
  "type": "object",
  "required": ["shortcut"],
  "additionalProperties": false,
  "properties": {
    "shortcut": { "type": "string", "minLength": 1 }
  }
}
```

### Behaviour

- MUST accept either `keys` (array) or `shortcut` (string). When
  `shortcut` is used, MUST split on `+` and trim each part; empty parts
  are ignored.
- The resulting key list MUST be non-empty.
- MUST press each element in order and release in reverse order. All but
  the final key are treated as held modifiers.
- SHOULD apply a small randomized delay (~50–100 ms) between holds.
- MUST normalize aliases the same way as `press_key`.
- MUST be cancellable between press and release phases.

### Errors

See [./ERRORS.md](./ERRORS.md). MUST surface at least:

- `"Missing required field 'keys'"`
- `"Field 'keys' must be an array of strings"`
- `"Field 'keys' must contain at least one key"`
- `"Field 'keys[<index>]' must be a string"`
- `"Command cancelled"`

### Examples

Example 1 — reopen tab (array form):

```jsonc
// request
{
  "id": "req-ps-1",
  "command": "press_shortcut",
  "params": { "keys": ["ctrl", "shift", "t"] },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-ps-1", "status": "ok", "error": null }
```

Example 2 — string form:

```jsonc
// request
{
  "id": "req-ps-2",
  "command": "press_shortcut",
  "params": { "shortcut": "ctrl+c" },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-ps-2", "status": "ok", "error": null }
```

Example 3 — empty keys (validation error):

```jsonc
// request
{
  "id": "req-ps-3",
  "command": "press_shortcut",
  "params": { "keys": [] },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-ps-3", "status": "error", "error": "Field 'keys' must contain at least one key" }
```

---

## `pause`

Sleeps for `duration_ms` milliseconds.

### Params

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "pause.params",
  "type": "object",
  "required": ["duration_ms"],
  "additionalProperties": false,
  "properties": {
    "duration_ms": { "type": "integer", "minimum": 0 }
  }
}
```

### Behaviour

- MUST sleep for approximately `duration_ms` milliseconds.
- MUST be cancellable: if cancellation is requested during the sleep,
  the command MUST return the cancelled error within one sleep tick
  (see [./TRANSPORTS.md](./TRANSPORTS.md) for cancel semantics).
- `duration_ms === 0` MUST return immediately with `status: "ok"`.

### Errors

See [./ERRORS.md](./ERRORS.md). MUST surface at least:

- `"Missing required field 'duration_ms'"`
- `"Field 'duration_ms' must be a non-negative integer"`
- `"Command cancelled"`

### Examples

Example 1 — 250 ms pause:

```jsonc
// request
{
  "id": "req-pa-1",
  "command": "pause",
  "params": { "duration_ms": 250 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-pa-1", "status": "ok", "error": null }
```

Example 2 — zero-ms pause returns immediately:

```jsonc
// request
{
  "id": "req-pa-2",
  "command": "pause",
  "params": { "duration_ms": 0 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-pa-2", "status": "ok", "error": null }
```

Example 3 — negative duration (validation error):

```jsonc
// request
{
  "id": "req-pa-3",
  "command": "pause",
  "params": { "duration_ms": -10 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-pa-3", "status": "error", "error": "Field 'duration_ms' must be a non-negative integer" }
```

---

## `sequence`

Runs a list of steps in order. Each step uses the parent envelope's
`context` (steps do not carry their own context).

### Params

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "sequence.params",
  "type": "object",
  "required": ["steps"],
  "additionalProperties": false,
  "properties": {
    "steps": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["command"],
        "additionalProperties": false,
        "properties": {
          "command": {
            "type": "string",
            "enum": [
              "mouse_move", "mouse_click", "scroll",
              "type", "press_key", "press_shortcut", "pause"
            ]
          },
          "params": { "type": "object" }
        }
      }
    }
  }
}
```

### Behaviour

- MUST execute steps strictly in order.
- MUST share the parent envelope's `context` with every step.
- MUST NOT allow nested `sequence` steps.
- If any step fails (validation or execution), the sequence MUST stop at
  that step and the whole response MUST be an error response that echoes
  the parent `id` and the step's error message.
- MUST be cancellable between steps.

### Errors

See [./ERRORS.md](./ERRORS.md). MUST surface at least:

- `"Missing required field 'steps'"`
- `"Field 'steps' must be an array"`
- `"Field 'steps[<index>]' must be an object"`
- `"Nested sequence commands are not supported"`
- Any error produced by the failing step, verbatim.
- `"Command cancelled"`

### Examples

Example 1 — click, type, submit:

```jsonc
// request
{
  "id": "req-sq-1",
  "command": "sequence",
  "params": {
    "steps": [
      { "command": "mouse_click", "params": { "x": 300, "y": 220 } },
      { "command": "type", "params": { "text": "hello", "wpm": 75 } },
      { "command": "press_key", "params": { "key": "enter" } }
    ]
  },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-sq-1", "status": "ok", "error": null }
```

Example 2 — scroll then pause:

```jsonc
// request
{
  "id": "req-sq-2",
  "command": "sequence",
  "params": {
    "steps": [
      { "command": "scroll", "params": { "x": 720, "y": 400, "delta_x": 0, "delta_y": 300 } },
      { "command": "pause", "params": { "duration_ms": 150 } }
    ]
  },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-sq-2", "status": "ok", "error": null }
```

Example 3 — nested sequence is rejected:

```jsonc
// request
{
  "id": "req-sq-3",
  "command": "sequence",
  "params": {
    "steps": [
      { "command": "sequence", "params": { "steps": [] } }
    ]
  },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-sq-3", "status": "error", "error": "Nested sequence commands are not supported" }
```

---

## `cancel`

Control command. Aborts any in-flight command on the connection.

### Params

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "cancel.params",
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

### Behaviour

- Takes an empty params object.
- The `cancel` request itself MUST respond immediately with
  `{id, status: "ok", error: null}` echoing its own id.
- If a long-running command is in flight, that command's response
  MUST be an error response with the message `"Command cancelled"`,
  echoing the cancelled command's id.
- If no command is in flight, `cancel` MUST still succeed with `ok`.
- Connection-level semantics (per-connection cancel scope, ordering
  guarantees) are defined in [./TRANSPORTS.md](./TRANSPORTS.md).

### Errors

See [./ERRORS.md](./ERRORS.md). Under normal conditions the cancel
command itself does not produce errors; the affected in-flight command
surfaces:

- `"Command cancelled"`

### Examples

Example 1 — cancel with nothing in flight:

```jsonc
// request
{
  "id": "req-cn-1",
  "command": "cancel",
  "params": {},
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response
{ "id": "req-cn-1", "status": "ok", "error": null }
```

Example 2 — cancel during a long `type`:

```jsonc
// in-flight request being cancelled
{
  "id": "req-ty-long",
  "command": "type",
  "params": { "text": "a very long paragraph ...", "wpm": 60 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// cancel request
{
  "id": "req-cn-2",
  "command": "cancel",
  "params": {},
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// response to the cancel
{ "id": "req-cn-2", "status": "ok", "error": null }
// response to the cancelled `type`
{ "id": "req-ty-long", "status": "error", "error": "Command cancelled" }
```

Example 3 — cancel during a `pause`:

```jsonc
// in-flight
{
  "id": "req-pa-long",
  "command": "pause",
  "params": { "duration_ms": 10000 },
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// cancel
{
  "id": "req-cn-3",
  "command": "cancel",
  "params": {},
  "context": { "screenX": 0, "screenY": 0, "outerHeight": 900, "innerHeight": 820, "outerWidth": 1440, "innerWidth": 1440, "devicePixelRatio": 1, "scrollX": 0, "scrollY": 0 }
}
// cancel response
{ "id": "req-cn-3", "status": "ok", "error": null }
// cancelled-pause response
{ "id": "req-pa-long", "status": "error", "error": "Command cancelled" }
```
