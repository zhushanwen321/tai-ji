# @zhushanwen/pi-ask-user

## 7.3.6

### Patch Changes

- 32854b942: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.18.0 → @zhushanwen/extension-protocol@0.19.0)

## 7.3.5

### Patch Changes

- 802af968f: Pin the pi peer dependency range to ^1.0.0 and correct the isError semantics comment (pi 1.0.0 honors isError on normal tool returns); no behavior change.

## 7.3.4

### Patch Changes

- 0d36077d4: 跨包握手标识与 subagent-core 对齐：channel registry 的 `Symbol.for` slot key 由 `@zhushanwen/pi-subagents.channelHandshake` 改为 `@zhushanwen/subagent-core.channelHandshake`（core `GLOBAL_SLOT_KEYS` 同值）。需与 subagent-core / subagent-workflow 同批升级；混装旧版时两侧 slot 不共享，握手会降级 warn 并重建通道。

## 7.3.3

### Patch Changes

- 8aa4b40e8: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.15.0 → @zhushanwen/extension-protocol@0.16.0)

## 7.3.2

### Patch Changes

- 50f31a73c: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.14.0 → @zhushanwen/extension-protocol@0.15.0, @zhushanwen/pi-ext-guards@0.4.1 → @zhushanwen/pi-ext-guards@0.4.2)

## 7.3.1

### Patch Changes

- 43a50ae2e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.13.0 → @zhushanwen/extension-protocol@0.14.0)

## 7.3.0

### Minor Changes

- 8285841af: Migrates ask_user to the unified form protocol: question payloads are adapted through a dedicated form adapter, channel registration is reworked around the shared registry, and GUI/TUI renderers consume the same form schema end to end.

## 7.2.4

### Patch Changes

- 10bde2f26: Fix README inaccuracies found in a fact-check pass: correct trigger conditions, config keys, and feature descriptions against current source behavior.

## 7.2.3

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
