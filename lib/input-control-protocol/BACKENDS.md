# Input Control Protocol — Backend Implementation Guide

This document is **guidance for someone implementing a backend** against the
input control protocol. If you are writing a new host — Python, Rust, Node,
CDP-based, headless, doesn’t matter — read this alongside
[PROTOCOL.md](./PROTOCOL.md), [CONTEXT.md](./CONTEXT.md),
[ERRORS.md](./ERRORS.md), and [TRANSPORTS.md](./TRANSPORTS.md).

The reference implementation lives in
[`python-input-control`](../../../python-input-control) and is the
ground-truth for all normative behaviour referenced below.

---

## Backend classes

Backends fall into three broad classes. Which one you are building determines
whether `context` coordinate translation applies and whether bounds-checking
is required.

### OS-input backends

*Examples:* [`python-input-control`](../../../python-input-control) (pyautogui
+ pynput), `enigo`, `robotjs`, AutoHotkey wrappers — anything that drives the
real OS input stack.

Requirements:

* **MUST** translate viewport coordinates to physical screen coordinates using
  the [`context`](./CONTEXT.md) block on every request. Reference:
  [`python-input-control/src/python_input_control/platform.py#translate_viewport_to_physical_screen`](../../../python-input-control/src/python_input_control/platform.py).

  Conceptual formula (follow whatever the reference host does — these are the
  core terms):

  ```
  screenX = context.screenX
          + (context.outerWidth  - context.innerWidth)  / 2
          + viewportX
  screenY = context.screenY
          + (context.outerHeight - context.innerHeight)
          + viewportY
  ```

  The exact split between top-chrome and side-chrome is platform-dependent;
  defer to `translate_viewport_to_physical_screen`.

* **MUST** bounds-check the translated point against
  `platform.virtual_desktop_bounds()` and reject commands that fall outside.
  Surface the exact protocol string:

  ```
  Coordinates (x, y) fall outside the virtual desktop bounds
  ```

  (Python class: `CoordinateOutOfBoundsError`.) If virtual desktop bounds
  cannot be determined, emit `DesktopBoundsUnavailableError` with the string
  `Virtual desktop bounds are unavailable; refusing to execute pointer-targeted command`.

### CDP / pure-viewport backends

*Examples:* `browser-agent-input-control` (planned, CDP-based).

Requirements:

* **MAY** ignore every geometry field in `context` (`screenX`, `screenY`,
  `outerWidth`, `outerHeight`, device pixel ratio, scroll offsets). Use the
  request `x` / `y` directly with `Input.dispatchMouseEvent` and
  `Input.dispatchKeyEvent`; CDP already operates in viewport coordinates.
* **MUST NOT** call any `virtual_desktop_bounds()`-style bounds check. The
  viewport is authoritative; out-of-viewport clicks are the page’s problem,
  not the backend’s.
* **SHOULD** still validate the envelope (shape, field types) and emit the
  same `ValidationError` strings as OS-input backends for parity.

### Headless / test backends

*Examples:* in-repo protocol-compliance tests, fuzzers, record-replay tools.

Requirements:

* **MAY** record every call and immediately return `{"status":"ok"}`.
* **SHOULD** still honour cancellation (`cancel` command, EOF, `abort()`) so
  the same test harness exercises real cancel paths.
* **SHOULD NOT** translate coordinates or bounds-check. If they do, they are
  effectively an OS-input backend under test.

---

## Human-like behaviour expectations

These apply to any backend that drives a real user-facing surface (OS-input
or CDP). Headless backends can skip them.

### Mouse motion

* **SHOULD** follow a smooth path rather than jumping. The reference uses a
  **cubic Bézier** with two randomised control points, sampled with an
  ease-in-out curve and small Gaussian jitter — see
  [`python-input-control/src/python_input_control/mouse_motion.py`](../../../python-input-control/src/python_input_control/mouse_motion.py)
  (`build_mouse_path`, `generate_bezier_control_points`, `cubic_bezier_point`).
* **SHOULD** derive the total motion time from distance. Reference:
  [`timing.py#estimate_mouse_duration_ms`](../../../python-input-control/src/python_input_control/timing.py):

  ```python
  def estimate_mouse_duration_ms(distance_px, minimum_ms=150, maximum_ms=1200):
      distance = max(0.0, distance_px)
      estimate = 120.0 + 180.0 * math.log2(1.0 + distance / 100.0)
      return int(round(clamp(estimate, minimum_ms, maximum_ms)))
  ```

* **SHOULD** randomise click hold time (reference: 60–120 ms) and the
  post-action pause (reference: 50–150 ms).

### Typing

* Pace keystrokes at a target **WPM** with jitter. Reference jitter ratio:
  **±25 % sigma** via
  [`timing.py#jittered_delay_ms`](../../../python-input-control/src/python_input_control/timing.py):

  ```python
  def jittered_delay_ms(base_ms, rng, jitter_ratio=0.25, minimum_ms=0.0):
      sigma = abs(base_ms) * abs(jitter_ratio)
      return bounded_gauss(rng, base_ms, sigma, minimum_ms, float("inf"))
  ```

* **Default WPM when `params.wpm` is omitted:** random uniform
  `[60.0, 100.0]`. Reference:
  [`backends/pynput_keyboard.py`](../../../python-input-control/src/python_input_control/backends/pynput_keyboard.py):

  ```python
  _DEFAULT_MIN_WPM = 60.0
  _DEFAULT_MAX_WPM = 100.0
  # …
  wpm = command.wpm if command.wpm is not None \
        else context.rng.uniform(_DEFAULT_MIN_WPM, _DEFAULT_MAX_WPM)
  base_delay_ms = wpm_to_inter_key_delay_ms(wpm)
  ```

* **Extra pause after punctuation.** Reference characters: `{' ', ',', '.',
  ';', ':', '!', '?'}`; reference extra delay: 150–300 ms with probability
  0.35 for space / 0.6 for other punctuation (see
  `extra_pause_after_character_ms`).

### Scroll

* **SHOULD** break a scroll delta into multiple ticks spread across
  `duration_ms`. Reference: `build_scroll_steps` in
  [`mouse_motion.py`](../../../python-input-control/src/python_input_control/mouse_motion.py)
  — bell-curve weighting for tick magnitudes, edge-heavy weighting for
  inter-step delays, 8–15 steps for non-trivial scrolls.

---

## Rate limiting

Backends **SHOULD** clamp commanded durations so callers can’t freeze the UI
with a 10-minute `mouse_move` or a 1-ms zip across the screen.

| Helper                          | Minimum (ms) | Maximum (ms) |
|---------------------------------|--------------|--------------|
| `estimate_mouse_duration_ms`    | 150          | 1200         |
| `estimate_scroll_duration_ms`   | 150          | 1200         |

Replicate both clamps when porting to another language. The floor prevents
accidental-frame-perfect motion that would immediately be flagged as bot
behaviour; the ceiling prevents a single command from blocking the worker.

Key-press inter-key delay **SHOULD** have a non-negative floor. The reference
uses:

```python
_MIN_INTER_KEY_DELAY_MS = 10.0  # pynput_keyboard.py
```

Never let a jittered delay go negative — clamp to `0` at minimum, `10 ms`
recommended.

---

## Cancellation requirements

Cancellation is the single most important cross-cutting concern for a
backend. Every user of this protocol assumes that `abort()` / `cancel` stops
the host **within roughly one inter-step delay**.

Rules:

* **Every sleep MUST be cancellable.** The reference uses `Event.wait()`
  instead of `time.sleep()` so the sleep wakes immediately when cancel fires:

  ```python
  # pynput_keyboard.py
  def _sleep_ms(context, delay_ms):
      seconds = max(0.0, delay_ms) / 1000.0
      ev = context.cancel_event
      if ev is not None:
          if ev.wait(seconds):          # True ⇒ cancel fired
              raise CommandCancelledError("Command cancelled", None)
      else:
          context.sleep(seconds)
  ```

* **Check the cancel signal between every keystroke and every motion step.**
  Expected max latency to cancel: **≤ one inter-step delay** — typically
  50–100 ms for typing, up to ~150 ms for slow mouse motion.
* On cancel, raise your language equivalent of `CommandCancelledError`. The
  dispatcher **MUST** convert it into the exact response envelope:

  ```json
  {"status": "error", "error": "Command cancelled"}
  ```

  Reference: `CommandDispatcher.handle_message` in
  [`dispatch.py`](../../../python-input-control/src/python_input_control/dispatch.py).

* Transport-level triggers (EOF, `{"command":"cancel"}`, `abort()`,
  WebSocket close) all funnel into the same `cancel_event` — see
  [TRANSPORTS.md](./TRANSPORTS.md) for the table.

---

## Error mapping

Every backend **MUST** emit error messages verbatim from
[ERRORS.md](./ERRORS.md). The table below maps the on-wire `error` string to
the reference Python class and explains when to emit it.

| Protocol `error` string                                                                  | Python class                      | When to emit                                                                                                      |
|------------------------------------------------------------------------------------------|-----------------------------------|-------------------------------------------------------------------------------------------------------------------|
| `Missing required field '<name>'`                                                        | `ValidationError`                 | Request envelope is missing a required field (e.g. `x`, `y`, `text`, `context.screenX`).                          |
| `Field '<name>' must be a <type>` (e.g. `must be a number`, `must be a string`)          | `ValidationError`                 | Field is present but has the wrong JSON type.                                                                     |
| `Field '<name>' must be finite`                                                          | `ValidationError`                 | A numeric field is NaN or ±Infinity.                                                                              |
| `Field '<name>' must be a positive integer`                                              | `ValidationError`                 | Integer-typed field is `≤ 0` or non-integer numeric.                                                              |
| `Field '<name>' must be a non-negative integer`                                          | `ValidationError`                 | Integer-typed field is `< 0` or non-integer numeric.                                                              |
| `Field '<name>' must be a positive finite number`                                        | `ValidationError`                 | Positive-number field (e.g. `wpm`) is `≤ 0`, NaN, or ±Infinity.                                                   |
| `Field 'button' must be one of: left, right, middle`                                     | `ValidationError`                 | `mouse_click.button` is present but not one of the three legal values.                                            |
| `Field 'keys' must be an array of strings`                                               | `ValidationError`                 | `press_shortcut.keys` is not a JSON array of strings.                                                             |
| `Field 'keys' must contain at least one key`                                             | `ValidationError`                 | `press_shortcut.keys` is an empty array (or `shortcut` string resolved to no parts).                              |
| `Field 'steps[<i>]' must be an object`                                                   | `ValidationError`                 | A sequence step is not a JSON object.                                                                             |
| `Nested sequence commands are not supported`                                             | `ValidationError`                 | A `sequence` step contains another `sequence`.                                                                    |
| `Browser heights must be greater than or equal to zero`                                  | `ValidationError`                 | `context.outerHeight` or `context.innerHeight` is negative.                                                       |
| `Browser widths must be greater than or equal to zero`                                   | `ValidationError`                 | `context.outerWidth` or `context.innerWidth` is negative.                                                         |
| `Field 'context.outerHeight' must be greater than or equal to 'context.innerHeight'`     | `ValidationError`                 | Chrome-supplied context is physically impossible.                                                                 |
| `Field 'context.outerWidth' must be greater than or equal to 'context.innerWidth'`       | `ValidationError`                 | Chrome-supplied context is physically impossible.                                                                 |
| `Field 'context.devicePixelRatio' must be greater than zero`                             | `ValidationError`                 | `context.devicePixelRatio ≤ 0`.                                                                                   |
| `Unknown command: <name>`                                                                | `UnknownCommandError`             | Envelope `command` is not in the supported set.                                                                   |
| `Coordinates (<x>, <y>) fall outside the virtual desktop bounds`                         | `CoordinateOutOfBoundsError`      | OS-input backend: translated point is outside `virtual_desktop_bounds()`. CDP backends must not emit this.        |
| `Virtual desktop bounds are unavailable; refusing to execute pointer-targeted command`   | `DesktopBoundsUnavailableError`   | OS-input backend: platform adapter could not determine the desktop bounds.                                        |
| `Command cancelled`                                                                      | `CommandCancelledError`           | `cancel_event` fired mid-command (from `cancel` frame, EOF, or `abort()`).                                        |
| `<backend-specific message>` (backend unavailable)                                       | `BackendUnavailableError`         | Required OS dependency (e.g. `pynput`, `pyautogui`) failed to import or initialise.                               |
| `<backend-specific message>` (execution failure)                                         | `CommandExecutionError`           | An otherwise-valid command raised an unexpected backend exception; wrap the original `str(exc)`.                  |
| `Unhandled host error: <repr>`                                                           | *(fallback in dispatcher)*        | Defensive catch-all in `CommandDispatcher.handle_message` for non-`InputControlError` exceptions.                 |

All error envelopes use `"status": "error"` and include the originating
`"id"` when it was parseable. When the error happens before the `id` can be
read (framing error, malformed JSON), the envelope’s `id` is `null` — see
[PROTOCOL.md](./PROTOCOL.md).
