# /session-pick 仅 TUI 注册，GUI（taiji 桌面）不可用

状态：独立立项待设计（pi1-disposition-chat-flow 设计 D14④ / §1.3 Out of scope，2026-10-04 登记；非 pi 1.0 引入的既有现状）。

- 现状：session-reader 的 /session-pick 命令与 `#` 会话引用补全仅 `ctx.mode === 'tui'` 注册（`extensions/universal/session-reader/src/index.ts:250`——RPC 模式（taiji 子进程形态）不用 pi TUI editor / slash 命令，加载即跳过该注册分支）。taiji 桌面对话流内输入 /session-pick 不在 pi 命令清单（未注册），按普通文本开回合。
- 影响面：GUI 用户无法经 /session-pick 拾取会话；taiji 侧有独立的会话切换入口，功能不受阻，仅该命令形态缺位。
- 恢复通道：GUI 补齐独立立项设计（方案未定，立项前不动代码）。
- 重审触发：GUI 侧出现该命令的实际使用需求时立项。
