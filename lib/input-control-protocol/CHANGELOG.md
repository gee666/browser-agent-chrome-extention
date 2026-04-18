# Changelog

All notable changes to the `input-control-protocol` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/) on
the message shape — see [`README.md`](./README.md#versioning).

## v1.0.0 — 2026-04-18

*Initial frozen shape.* Distills the behaviour of the
`python-input-control` reference host and freezes it as the canonical
protocol, adjusted so that pure-viewport backends (CDP, headless) MAY
ignore geometry fields in `context` without losing compliance.

### Added

- Request envelope `{id, command, params, context}` with field rules
  (see [`PROTOCOL.md`](./PROTOCOL.md)).
- Response envelope `{id, status, error?}` with `status ∈ {"ok", "error"}`.
- Command set (see [`COMMANDS.md`](./COMMANDS.md)):
  `mouse_move`, `mouse_click`, `scroll`, `type`, `press_key`,
  `press_shortcut`, `pause`, `sequence`. Plus the connection-level
  control command `cancel`.
- `BrowserContext` field definitions and backend-class applicability
  table (see [`CONTEXT.md`](./CONTEXT.md)).
- Standard error-message catalogue (see [`ERRORS.md`](./ERRORS.md)).
- Normative transports: Chrome **native messaging** (4-byte LE length +
  UTF-8 JSON, 4 MiB cap) and **in-process** direct async call
  (see [`TRANSPORTS.md`](./TRANSPORTS.md)).
- Informative (non-normative for v1) WebSocket / TCP transport sketch.
- Backend-implementer guide covering OS-input, CDP/viewport, and
  headless/test classes plus rate-limit and human-like-jitter
  expectations (see [`BACKENDS.md`](./BACKENDS.md)).
- 14 worked JSON example pairs under [`examples/`](./examples) covering
  every command's happy path plus validation, unknown-command,
  out-of-bounds, and cancelled error paths.

### Clarified (relative to the Python reference host)

- `context` fields are **required** on the wire but are **advisory** for
  pure-viewport backends (CDP, headless), which MAY ignore every
  geometry field. OS-input backends MUST continue to use them for
  viewport→screen translation and bounds checking.
