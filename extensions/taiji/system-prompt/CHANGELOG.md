# @zhushanwen/pi-system-prompt

## 1.3.2

### Patch Changes

- 32854b942: Align the markdown-sanitize allowlist source-path comment after the file's move from packages/renderer to packages/ui (comment-only change).

## 1.3.1

### Patch Changes

- 802af968f: Pin the pi peer dependency range to ^1.0.0 (smart-context also pins typebox; stale pi implementation anchors in comments refreshed to 1.0.0). No behavior change.

## 1.3.0

### Minor Changes

- 52eb51327: Expands the "TaiJi capabilities" section into a precise rendering contract and injects the per-turn session artifacts directory. The section now carries a positive allowlist (usable inline HTML tag families and presentational attributes) and a negative list (`class`/`style`/`script`/`iframe`/`form`/`svg` are stripped), plus the HTML delivery convention — write large HTML into the session artifacts directory `<dataDir>/artifacts/<sessionId>/` and reference it with an `html-preview` fenced block instead of pasting the full markup — and the preview constraints (sandboxed preview has no network access; scripts, styles and images may be inline or reference local files next to the HTML file, while fonts must be inlined as `data:` URIs — relative-path font files are blocked by the browser's CORS policy for the opaque-origin preview). The artifacts directory absolute path is derived per turn from `ctx.sessionManager.getSessionId()` and the in-package env-based `resolveDataDir()`, and degrades to a "not available this turn" line when the session id is missing. List members are rendered from structured constants so the text stays machine-checkable against the renderer sanitize allowlist.

## 1.2.0

### Minor Changes

- 8285841af: Appends a "TaiJi capabilities" section to the system prompt describing how markdown responses are rendered (HTML allowlist, relative image/link resolution against the session cwd, remote images not rendered). Configurable via the `capability.enabled` setting (defaults to on).

## 1.1.6

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
