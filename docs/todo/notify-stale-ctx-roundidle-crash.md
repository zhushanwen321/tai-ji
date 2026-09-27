# A1：轮终收口遇 stale extension ctx 崩溃 runtime 进程（P1，间歇性）

状态：已修复（2026-09-27 根治落地，commit 32c7db264——dispose 尾部回收 session 句柄；根因经 pi 0.84.4 实装核实闭环）。登记于 2026-09-22（B1/B2 修复真机复验发现）。

## 症状

GUI 派发 subagent，轮终收口时 runtime 进程崩溃（exit 1），当轮 record 丢失、manifest 投影（簿记⑫）未执行；随后 runtime supervisor 重启循环约 6 分钟。间歇性：复验 3 轮派发仅第 1 轮触发。

## 根因（已核实闭环，pi 0.84.4 dist 实装）

pi 官方生命周期契约：session 替换（`newSession`/`fork`/`switchSession`/`reload`）的 `teardownCurrent` 先对扩展发 `session_shutdown`，再调 `session.dispose()` → `runner.invalidate()`——此后**旧 pi ExtensionAPI 的所有方法调用一律抛 stale 错**（`loader.js` 各方法首行 `assertActive()`；契约原文在 `runner.js` invalidate 默认消息：「Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ...」）。

缺陷形态：SubagentService 是跨 session 单例，`_pi`（session_start 注入）在 `dispose()` 后**残留指向旧 session 的 handle**。session 替换窗口内迟到的异步收尾（轮终 `markRoundIdle` 簿记⑧ `emitPendingUnregister` → `pi.events.emit`、迟到 register 的 `appendEntry`）触达 stale handle → 未捕获异常 → 进程崩。间歇性来源：仅「session 替换 × 恰有收尾在飞行中」交叠时触发。

## 修复（根治 = 不在失效对象上调用）

`SessionBaselines.clearSessionHandles()`（单写者）：dispose 链最末尾（`flushPendingNotifications` 与 pending 落盘复写这两步合法 pi 消费之后）回收 `_pi` / `_streamSink`（ctx.ui.setWidget 闭包）/ `_isIdleFn`（ctx.isIdle 闭包）+ `RecordStore.setPi(null)`。消费点全部已有 `pi?.` 空短路 → 迟到写面降级为干净 no-op（旧 session 的通知本就无人消费，丢弃是正确语义）；新 `session_start` 经 `initSession` 重新注入。连带修正：`assertReady` 的 disposed 判定提前到 pi-null 判定之前（dispose 清 pi 后，原顺序会把 session 结束错误退化成误导性的「initSession 未调」提示）。

回归锚：`packages/subagent-core/src/execution/__tests__/subagent-service.test.ts`「dispose 回收 session 句柄：替换窗口内迟到的写面不触达 stale pi」——stale 抛错 pi 注入 + dispose 后迟到 register/markRoundIdle 不抛且簿记⑧照常走到（record 翻边 idle）。

同族面核查结论：notify-host 其余 emit 面（`emitPendingRegister` 等）与 `appendEntry`/`sendMessage` 消费点全部经 `deps.getPi()` 单点取 handle——句柄回收后全族构造性安全，无需逐点防御（防御性 try/catch 不采用：pi 契约下正确修法是不触达，不是捕获后吞）。

## 证据

- pi 实装锚：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`（events.emit 首行 assertActive）、`.../extensions/runner.js`（invalidate 契约消息）、`.../core/agent-session-runtime.js` `teardownCurrent`（shutdown 事件 → dispose 顺序）
- 复验产物（含崩溃日志，留存期至本登记关闭，现已随 .tmp 清理失效）：`.tmp/dev-flow/b1b2-verify/`
