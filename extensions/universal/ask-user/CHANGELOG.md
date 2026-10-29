# @zhushanwen/pi-ask-user

## 7.4.4

### Patch Changes

- 701143b67: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.25.0 → @zhushanwen/extension-protocol@0.26.0)

## 7.4.3

### Patch Changes

- 3107549df: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.24.0 → @zhushanwen/extension-protocol@0.25.0)

## 7.4.2

### Patch Changes

- da658a786: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.23.0 → @zhushanwen/extension-protocol@0.24.0)

## 7.4.1

### Patch Changes

- df839883b: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.22.0 → @zhushanwen/extension-protocol@0.23.0)

## 7.4.0

### Minor Changes

- 796f01b29: ask_user 结果 details 新增 summary 收起态一行摘要（取消结果同样携带），TUI 折叠态渲染摘要行，旧会话条目缺 summary 时回退原渲染。

## 7.3.9

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.20.0 → @zhushanwen/extension-protocol@0.21.0, @zhushanwen/pi-ext-guards@0.4.4 → @zhushanwen/pi-ext-guards@0.5.0)

## 7.3.8

### Patch Changes

- 993ee907f: Slim the ask_user tool declaration: the description is tightened to one example plus structural anti-examples, and the promptGuidelines layer is removed because every guideline duplicated the description or schema field text — same calling discipline, fewer standing prompt tokens.

## 7.3.7

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.19.0 → @zhushanwen/extension-protocol@0.20.0, @zhushanwen/pi-ext-guards@0.4.3 → @zhushanwen/pi-ext-guards@0.4.4)

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
