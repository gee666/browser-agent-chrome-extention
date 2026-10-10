# Jev-like decision mode

## Implementation plan and task split

1. Core library: add a choice API adapter, text-first classification, screenshot escalation, normal-LLM fallback using the same choices, helper parameters, and bounded read-only DOM investigation. Preserve the existing extractor, coordinate contract, input pacing, and normal LLM mode.
2. Extension settings: choose Normal LLM or Jev-like; configure endpoint, API key, model, custom headers, request parameters, timeout, fallback, and optional helper model. Keep existing provider/OAuth credentials.
3. Runtime: map saved settings to the core; persist redacted discovery reports and decision metadata; add connection testing.
4. Review and test: core and settings workers self-review; separate integration review; unit tests and real local browser fixtures. Commit the modified core repository first, then the parent gitlink.

## Configure

Open extension Settings. Keep the normal provider configured and authenticated; it supplies fallback classification and, by default, all helper work. Select **Jev-like** and configure:

- Endpoint: API origin, `/v1`, or full `/v1/systemone` URL.
- API key: stored in `chrome.storage.local` alongside existing credentials, not in the repository.
- Model: `jev-latest` by default.
- Headers and request parameters: JSON objects. Credentials belong in the API-key field. Reserved request fields and browser-controlled headers are rejected.
- Timeout: 1,200,000 ms by default, matching local AutoJev's recommendation. Stop cancels agent requests rather than waiting for this timeout.
- Fallback: use the configured normal LLM on unavailable, invalid, or over-budget Jev classification.
- Helper model: blank reuses the main model/provider/authentication. For a different provider, use the main provider settings; this field only overrides the model name.

Normal LLM mode retains the existing agent flow. Its vision checkbox does not disable Jev's on-demand screenshots. Jev screenshot stages can send images to Jev and, on failure, to the configured LLM. Helpers can also receive that screenshot.

## Local AutoJev relay

AutoJev's `/docs` specifies same-origin restrictions and requires other browser origins to use their own backend. Direct extension requests to port 8765 return HTTP 403. A small relay is provided rather than changing AutoJev's security policy:

```sh
node tools/autojev-relay.mjs YOUR_CHROME_EXTENSION_ID
```

The relay listens on `127.0.0.1:8878` and forwards only `POST /v1/systemone` to `127.0.0.1:8765`. Set the extension endpoint to `http://localhost:8878`. The supplied API key is forwarded, preserving application usage attribution. The relay stores and logs no keys or request bodies.

Only the selected `chrome-extension://` origin is allowed. Management endpoints, arbitrary destinations, redirects, browser cookies and referrers are not forwarded. The relay must run on the machine reachable as localhost from Chrome. Node.js 20+ is recommended. It is a foreground service; arrange startup yourself if needed. Stop with Ctrl+C. Optional environment variables are `AUTOJEV_EXTENSION_ID`, `AUTOJEV_RELAY_PORT`, `AUTOJEV_UPSTREAM`, which must remain a loopback origin, and `AUTOJEV_RELAY_TIMEOUT_MS`. The relay deadline defaults to 1,200,000 ms and accepts up to 3,600,000 ms. Set it at least as long as the extension deadline when allowing longer queued requests. The transport has no separate five-minute response-header timeout.

## Decision flow

1. Goal, recent action results and observed page context go to text-only classification.
2. Jev chooses the operation and speculative per-operation targets in one request. Only the selected operation's target is consumed. Our existing reader supplies targets; no narrow HTML-role filtering is introduced.
3. `SCREENSHOT_NEEDED` captures a screenshot and repeats classification with the same context. This stage replaces the screenshot option with `TARGET_NOT_LISTED` in target choices.
4. A missing target invokes the LLM for up to three read-only CSS queries. A unique visible element is registered with the existing extractor and executed through the existing coordinate contract. No model-provided JavaScript is executed.
5. Typing and dropdown selection ask the helper for the required value. Missing required information stops instead of inventing a value.
6. HTTP errors, timeouts, invalid choices and conservative context-budget failures can use the normal LLM at the same stage. Valid BLOCKED decisions do not trigger provider fallback. Outputs are validated locally, even when a provider cannot use strict schema output.

The main action loop still waits and uses natural mouse movement and typing. Existing DOM-focus and DOM-scroll executor shortcuts were removed to honor the project's input-control policy. Failed native actions do not switch to synthetic browser input.

## Reports and diagnostics

Settings links to the DOM discovery report viewer. Each report has a shareable extension-local fragment URL:

```text
options/discovery-reports.html#DISCOVERY_ID
```

Reports include a sanitized page path, structural locator, structural target/ancestor/child descriptions, original target coverage, reason and execution outcome. They do not contain saved screenshots, text values, raw prompts or credentials. Structural reports intentionally omit content that cannot be safely redacted. URL redaction is heuristic; inspect reports before sharing them. At most 50 reports are retained in `domDiscoveryReports`.

`agentDecisionTrace` in extension local storage retains up to 100 metadata-only decisions for the latest task: stage, provider, selected action/target and duration. It contains no task text, screenshots or credentials. An unsuccessful Jev attempt has a null action, followed by the fallback record if enabled. Task results preserve `success:false` and `blocked:true` when completion was unsuccessful.

## Limits

- DOM investigation currently covers light DOM only, not iframe or shadow-root traversal.
- A classification offers at most 253 existing targets. Coverage is explicit; omitted targets may be recovered through visual escalation and investigation.
- Local AutoJev has a 12,288-token context by default. The client uses conservative size checks and falls back without silently truncating the current DOM. Larger sites can therefore use the LLM more often.
- Strict OpenAI schemas have an enum-count limit. Larger choice sets use JSON-object output plus the same local validation.
- Discovery reports are diagnostic evidence, not automatic selector-rule modifications.
- Native input requires the intended browser window/tab to remain available. A successful input command is not proof the page changed; inspect observed results.

## Tests

```sh
node --test background/*.test.js options/*.test.js tools/autojev-relay.test.mjs
cd lib/browser-agent-core && npm test -- --runInBand
```

The connection test invokes the configured Jev endpoint, not fallback. Do not expose the relay to the network or put API keys in command-line arguments.

Manual fixtures can be served with:

```sh
python3 -m http.server 8879 --bind 127.0.0.1 --directory tools/fixtures/jev
```

- `/`: type a test name and save; verify the exact displayed result.
- `/visual.html`: choose the green circle; the text labels alone cannot distinguish the buttons.
- `/missing.html`: activate the plain-div custom control; the initial reader omits it, so screenshot escalation and DOM investigation are required.

Initial integration validation used the existing OAuth login with `gpt-6-luna` for all browser LLM calls. The local Jev connection through the relay succeeded. Live traces showed direct Jev text → screenshot → missing-target investigation, with a saved report and the expected fixture outcome. Unavailable-Jev tests exercised normal-LLM typing/click decisions and screenshot-stage fallback. Native clicks interfered with other foreground apps during these runs; native testing was stopped and saved settings restored to CDP at the user's request. CDP execution was not tested in that session because its supplied project instructions required Python-only input. The browser-task RPC also timed out once despite task completion; page state and extension history were checked separately.

Final automated checks: 315 core tests and 80 extension/options/relay tests passed. These checks include redirect rejection, per-image limits, schema overflow fallback, cancellation, blocked results, settings round trips and relay transport deadlines/disconnects. They do not establish broad website reliability.
