# @zhushanwen/pi-ext-guards

## 0.5.0

### Minor Changes

- 7babdefa7: 新增 taiji GUI 宿主判定谓词共享导出：isTaijiHost（env 信号腿）、isTaijiGuiHost（env + rpc 模式完整谓词）、TAIJI_GUI_HOST_ENV（判定 env 键）与 GuiHostContextLike（宿主形态最小结构面）——plan / canvas 两扩展的原双实现收敛至本包单点（dmg-r1-7），一致性由构造保证。

## 0.4.4

### Patch Changes

- 0c4bec66e: Add `isErrnoWithCode(error, code)` shared predicate: a parameterized generalization of `isEnoentError` that matches Node system-call errors by any errno code, keeping the same zero-cast narrowing discipline (`"code" in error`, no type assertions). Extension packages adopt it instead of duplicated inline error-code checks.

## 0.4.3

### Patch Changes

- 802af968f: Pin the pi peer dependency range to ^1.0.0 (smart-context also pins typebox; stale pi implementation anchors in comments refreshed to 1.0.0). No behavior change.

## 0.4.2

### Patch Changes

- 50f31a73c: `oncePerProcess` no longer caches failures: a synchronous throw or a rejected Promise leaves no cached record, so the next call with the same key re-executes instead of replaying the old error. Successful results are still cached and replayed by reference exactly once. This lets process-level maintenance guards (crash recovery, config migration) retry on the next trigger after a transient failure instead of staying broken for the rest of the process; the retry cadence is up to the caller, and a failed operation may run twice across retries (by design, since only successes are memoized).

## 0.4.1

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
