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
- AutoJev cache mode: `context` by default, including existing settings without `jevCacheMode`. `options` uses the options-first cache; `none` disables reuse; `server` omits `X-AutoJev-Cache-Mode`. Explicit modes override the retained legacy `X-AutoJev-Prefix-Cache` header on AutoJev; `server` leaves that legacy header effective. Image requests may bypass caching. The connection test uses the selected mode without saving. Other saved settings stay unchanged.
- Headers and request parameters: JSON objects. Credentials belong in the API-key field. Reserved request fields are rejected. Header names are checked case-insensitively; browser-controlled headers and custom `X-AutoJev-Cache-Mode` headers are reserved. Use the selector for cache mode.
- Timeout: 1,200,000 ms by default, matching local AutoJev's recommendation. Stop cancels agent requests rather than waiting for this timeout.
- Fallback: use the configured normal LLM on unavailable, invalid, or over-budget Jev classification.
- Helper model: blank reuses the main model/provider/authentication. For a different provider, use the main provider settings; this field only overrides the model name.

Normal LLM mode retains the existing agent flow. Its vision checkbox does not disable Jev's on-demand screenshots. Jev screenshot stages can send images to Jev and, on failure, to the configured LLM. Helpers can also receive that screenshot.

## Local AutoJev setup

Use `http://localhost:8765` and your API key. In AutoJev's `config/server.json`, set `"allowedOrigins": ["*"]` for all origins, or list specific origins. Run `AutoJev.cmd restart`; no rebuild or relay is needed.

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
node --test background/*.test.js options/*.test.js
cd lib/browser-agent-core && npm test -- --runInBand
```

The connection test invokes the configured Jev endpoint, not fallback. Do not put API keys in command-line arguments.

Manual fixtures can be served with:

```sh
python3 -m http.server 8879 --bind 127.0.0.1 --directory tools/fixtures/jev
```

- `/`: type a test name and save; verify the exact displayed result.
- `/visual.html`: choose the green circle; the text labels alone cannot distinguish the buttons.
- `/missing.html`: activate the plain-div custom control; the initial reader omits it, so screenshot escalation and DOM investigation are required.

Initial integration validation used the existing OAuth login with `gpt-6-luna` for all browser LLM calls. The local Jev connection through the now-removed relay succeeded. Those runs did not validate the direct AutoJev connection. Live traces showed direct Jev text → screenshot → missing-target investigation, with a saved report and the expected fixture outcome. Unavailable-Jev tests exercised normal-LLM typing/click decisions and screenshot-stage fallback. Native clicks interfered with other foreground apps during these runs; native testing was stopped and saved settings restored to CDP at the user's request. CDP execution was not tested in that session because its supplied project instructions required Python-only input. The browser-task RPC also timed out once despite task completion; page state and extension history were checked separately.

After removing the 8 relay tests, all 72 extension/options tests passed with the parent command above. The earlier core run passed 315 tests covering redirect rejection, per-image limits, schema overflow fallback, cancellation and blocked results; it was not rerun for this parent-only change. Parent tests cover settings round trips and runtime integration. They do not establish broad website reliability.

After deploying AutoJev commit `5ca3d64`, direct authenticated requests from the extension to port 8765 returned HTTP 200, and the extension's real Jev connection test returned `{ok:true}` without fallback or a relay. The saved endpoint was switched to port 8765. The 57 server origin-policy checks and existing queue checks passed. Live HTTP checks confirmed allowlisted preflight, required inference authentication, rejection of unlisted origins, and rejection of origin-bearing extension requests to local management routes. Originless local tools retain their existing server access.
