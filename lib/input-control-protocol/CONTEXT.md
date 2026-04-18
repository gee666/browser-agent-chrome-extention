# Browser Context

The `context` field on every request (see [PROTOCOL.md](./PROTOCOL.md))
carries the browser's **viewport and window geometry** at the moment the
command was issued. OS-input backends use it to translate viewport-relative
coordinates into physical screen pixels, and to bounds-check the result
against the virtual desktop before actuating any input.

`context` is **always required**, even when the receiving backend ignores
some or all of the fields. This keeps the wire shape stable across backend
classes: a client does not need to know which backend is running to build
a valid request.

## Fields

All fields are **required numbers** (JSON numbers; no strings, no `null`).
They map 1-to-1 to `BrowserContext` in the reference Python implementation.

| Field              | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `screenX`          | Browser window top-left **X** in virtual-desktop coordinates.              |
| `screenY`          | Browser window top-left **Y** in virtual-desktop coordinates.              |
| `outerWidth`       | Full browser window **width**, including chrome (toolbar, borders).        |
| `outerHeight`      | Full browser window **height**, including chrome.                          |
| `innerWidth`       | Viewport (content area) **width** in CSS pixels.                           |
| `innerHeight`      | Viewport (content area) **height** in CSS pixels.                          |
| `devicePixelRatio` | CSS-px to device-px ratio of the window. Must be **greater than zero**.   |
| `scrollX`          | Current horizontal scroll offset of the document, in CSS pixels.           |
| `scrollY`          | Current vertical scroll offset of the document, in CSS pixels.             |

### Example

```json
{
  "screenX": 100,
  "screenY": 80,
  "outerWidth": 1280,
  "outerHeight": 900,
  "innerWidth": 1280,
  "innerHeight": 820,
  "devicePixelRatio": 1.25,
  "scrollX": 0,
  "scrollY": 420
}
```

## Validation Rules

The server rejects a request whose `context` violates any of these rules.
These rules mirror `_parse_browser_context` in the Python host; the exact
error strings are listed in [ERRORS.md](./ERRORS.md).

- `context` MUST be an object (not array, not `null`).
- Every field listed above MUST be present and MUST be a finite JSON number.
- `devicePixelRatio` MUST be **greater than zero**.
- `outerHeight`, `innerHeight`, `outerWidth`, `innerWidth` MUST be
  **greater than or equal to zero**.
- `outerHeight` MUST be `>= innerHeight`.
- `outerWidth` MUST be `>= innerWidth`.

Note that `screenX`, `screenY`, `scrollX`, and `scrollY` are allowed to be
negative (e.g. a window positioned on a monitor to the left of the primary
display, or a scroll offset of `-0`).

## Derived Quantities

The following quantities are derived at the server from the raw fields. OS
backends use them to offset viewport coordinates when translating into
screen space:

```text
browser_chrome_height = outerHeight - innerHeight
browser_chrome_width  = outerWidth  - innerWidth
```

The chrome height (toolbar + tab strip + top border) is the dominant Y
offset added when translating a viewport point `(x, y)` into a physical
screen point — roughly:

```text
physicalX = (screenX + scrollOffsetX + viewportX) * devicePixelRatio
physicalY = (screenY + browser_chrome_height + viewportY) * devicePixelRatio
```

(Exact translation is the backend's responsibility; this is a sketch.)

## Backend-Class Applicability

Different backends consume different subsets of `context`. Clients MUST
always send every field; it is the backend that chooses what to use.

| Backend class                                                          | Uses geometry                            | Notes                                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **OS-mapping** (pyautogui, pynput, enigo, robotjs, …)                  | **MUST** use all fields                  | Translates viewport → physical screen pixels, then bounds-checks against the virtual desktop.          |
| **Pure-viewport** (CDP `Input.dispatch*Event`, headless Chromium)      | MAY ignore all geometry fields           | Uses viewport-relative coordinates directly; no OS translation needed.                                 |
| **Headless / test** (fakes, in-memory stubs)                           | MAY ignore all fields                    | Typically records commands as-is for assertions.                                                       |

An OS-mapping backend that receives translated coordinates falling outside
the virtual desktop bounds MUST refuse to actuate input; see the
`"Coordinates (...) fall outside the virtual desktop bounds"` and
`"Virtual desktop bounds are unavailable; ..."` errors in
[ERRORS.md](./ERRORS.md).

## Computing `context` in the Page

A content script or injected helper can build a `context` object straight
from `window`:

```js
function buildBrowserContext() {
  return {
    screenX:          window.screenX,
    screenY:          window.screenY,
    outerWidth:       window.outerWidth,
    outerHeight:      window.outerHeight,
    innerWidth:       window.innerWidth,
    innerHeight:      window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    scrollX:          window.scrollX,
    scrollY:          window.scrollY,
  };
}
```

Capture `context` as close to the moment of the command as practical: any
scroll, resize, or window move between capture and dispatch will skew the
coordinate translation.
