# input-control-protocol

A small, language-agnostic request/response protocol for driving a single
host's mouse and keyboard from a browser extension (or any other client).
It describes **what** an input command looks like on the wire, not **how**
a backend executes it — so a Python host using OS-level input, a JavaScript
bridge using Chrome DevTools Protocol, and a hypothetical Rust/Go host using
anything else can all be drop-in replacements for each other as long as they
honour the same envelope shape.

## Canonical implementations

| Implementation | Language | Transport | Backend class | Repo / path |
|---|---|---|---|---|
| [`python-input-control`](../../../python-input-control) | Python | Native messaging (stdio, 4-byte LE length + UTF-8 JSON) | OS-input (pyautogui + pynput) | sibling dir in this workspace |
| [`browser-agent-input-control`](../browser-agent-input-control) | JavaScript (MV3 service worker) | In-process direct async call | CDP (`chrome.debugger` + `Input.dispatch*Event`) | sibling lib |

Any third-party implementation that accepts the same envelope shape and emits
the same response envelope is, by definition, protocol-compatible.

## Versioning

This protocol follows [semantic versioning](https://semver.org/) applied to the
**message shape**, not to any particular implementation:

- **Major** bumps indicate a breaking change to the request or response
  envelope, to the set of supported commands, to a required field on an
  existing command, or to a standard error string that clients parse.
- **Minor** bumps add a new command, a new optional field, or a new
  informative transport, in a way that existing clients keep working.
- **Patch** bumps are editorial-only (docs clarifications, typo fixes).

The current version is **v1.0.0**, frozen on 2026-04-18. See
[`CHANGELOG.md`](./CHANGELOG.md).

## Contents

- [`PROTOCOL.md`](./PROTOCOL.md) — canonical request / response envelope,
  JSON Schema, field rules.
- [`COMMANDS.md`](./COMMANDS.md) — one section per command with params
  schema, behavioural contract, error cases, and three worked examples.
- [`CONTEXT.md`](./CONTEXT.md) — `BrowserContext` fields and which
  backend classes use them.
- [`ERRORS.md`](./ERRORS.md) — error envelope, standard error messages,
  and guidance on surfacing vs retrying.
- [`TRANSPORTS.md`](./TRANSPORTS.md) — normative native-messaging and
  in-process transports, plus an informative WebSocket/TCP section (no
  v1 reference code).
- [`BACKENDS.md`](./BACKENDS.md) — implementer guidance for OS-input,
  CDP/viewport, and headless/test backends, including rate-limit and
  human-like-jitter expectations.
- [`CHANGELOG.md`](./CHANGELOG.md) — version history.
- [`examples/`](./examples) — ≥ 12 request/response JSON pairs covering
  happy paths and error paths.
- [`LICENSE`](./LICENSE) — MIT.

## Quick shape

Request:

```json
{
  "id": "b3e2a7f4-8ce2-4c6a-94ab-1f7e55cafed0",
  "command": "mouse_click",
  "params": { "x": 320, "y": 240 },
  "context": {
    "screenX": 0, "screenY": 0,
    "outerHeight": 900, "innerHeight": 820,
    "outerWidth": 1440, "innerWidth": 1440,
    "devicePixelRatio": 1,
    "scrollX": 0, "scrollY": 0
  }
}
```

Response:

```json
{ "id": "b3e2a7f4-8ce2-4c6a-94ab-1f7e55cafed0", "status": "ok", "error": null }
```

See [`PROTOCOL.md`](./PROTOCOL.md) for the full schema.
