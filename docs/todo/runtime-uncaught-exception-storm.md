# 缺陷登记：dev 实例 runtime uncaught-exception 风暴死循环（find-in-surface 验收中发现）

- **状态**：未解决（2026-10-07 登记）
- **影响范围**：dev 实例（`~/.taiji-dev` 树）。生产打包版未复现未验证。
- **发现路径**：find-in-surface 第一期 overlay 真机验收（commit c7e97ef86 之后），非该改动引入——该 commit 仅改 renderer/ui 展示层，新增代码零 WS 出站消息，物理上不可达 runtime。

## 现象

1. 浏览器浮层打开（主进程 `browser-view create → show`）或 session restore 自动重发 prompt（respawn）后短时间内：runtime 进程（tsx node）CPU 升至 ~100% 持续不降。
2. runtime 主线程被异常风暴占满 → WS 心跳/请求全部无响应 → renderer 判定断连，整页 navigate 重载（App.vue 连接屏「连接中…」），重载后无法恢复，直到手工重启 dev。
3. 复现 2 次（同一实例两次浮层打开后均复现）；一次触发前有 respawn 自动重发 prompt。

## 证据（2026-10-07 采样与日志）

- `sample <runtime-pid>`：主线程 2450 样本全部停在 `TriggerUncaughtException → InspectorConsoleCall → ErrorStackGetter/FormatStackTrace/PrepareStackTraceCallback`——**无限抛 uncaught exception 且每次格式化深栈**，业务帧为 JIT（`??? in <unknown binary>`），无法直接定位源码位置。
- dev stdout 日志：终止于 `[browser-view] show` 之后，runtime 心跳（`get_state`/`get_session_stats`）全部消失。
- runtime 落盘日志（logs/runtime-*.log）：终止时刻与 renderer 重载（performance timeOrigin）吻合，无异常文本落盘（异常输出走 inspector console 通道，未达 logger）。
- vite 端口（1556）同时关闭。

## 排障入口（按序）

1. 复现环境：`TAIJI_DEV_BACKGROUND=1 pnpm dev` → 开会话 → 对话流内点击 localhost 链接（→ openBrowser → browser-view show）→ 观察 runtime CPU（`ps aux | grep tsx`）。备用触发：切到含未完成 turn 的会话触发 respawn prompt。
2. 死循环进程存活期间 `sample <pid> 3` 采栈；配合 `TAIJI_AGENT_DEBUG=1` 看 `~/.pi/agent/logs/`；runtime 日志尾部对齐时刻。
3. 重点怀疑面：browser-view 相关 runtime handler、session restore/respawn prompt 链路、`runtime:out` tee（RelayTee）——三者在日志终止点前后活跃。
4. 异常风暴的异常内容未捕获（inspector 通道）：可在 runtime 入口挂 `process.on('uncaughtException')` 落盘定位。

## 关联

- 阻塞了 find-in-surface overlay 内搜索交互的真机验收（overlay 表面标记渲染已验证；FindBar 与 drawer 同构且有单测覆盖，见 `.tmp/dev-flow/find-in-surface-phase1.md`）。
