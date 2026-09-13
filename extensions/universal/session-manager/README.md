# @zhushanwen/pi-session-manager

agent-managed session pi extension：把 session 的创建/发送/读取/列表/状态/中止交给 agent 自主管理——agent 通过 6 个工具以子 session 形态并行工作，父 session 统一编排。

## 通道契约

- 工具调用经 `ctx.ui.select(SESSION_MANAGER_MARKER, [JSON], {timeout})` 发出，超时按 action 分档（create/history 60s、其余 30s，SSOT 在 `src/index.ts` 的 `SELECT_TIMEOUT_MS`）；marker 为 `\x00XYZ_SESSION_MANAGER`（NUL 前缀防与普通 select title 冲突，SSOT 在 `@xyz-agent/extension-protocol`）
- 请求体为嵌套形状 `{ action, params }`（形状 SSOT 在 `@xyz-agent/extension-protocol`）；**不要扁平化展开**——runtime event-adapter 按 `data.params` 提取，扁平化会导致 params 丢失
- 应答方是 xyz-agent runtime 的 `SessionManagerHandler`（select value 通道回写 JSON 字符串；取消/超时返回 null）

## 工具（6 个 action）

| 工具 | action | 说明 |
|------|--------|------|
| `create_managed_session` | create | 在指定 cwd 创建子 session（可选 label）；服务端注入 `spawnSource: 'agent'` 与父 session id，`.agent.json` sidecar 落盘供重启恢复 |
| `send_to_session` | send | 向子 session 发送 prompt（异步处理） |
| `read_session_history` | history | 读子 session 对话历史（可选 tailTurns 截尾部 N 个 turn） |
| `list_my_sessions` | list | 列出本 agent 管理的 session（无过滤参数，自动限定发起方 agent） |
| `get_session_status` | status | 查询子 session 状态与模型信息 |
| `abort_session` | abort | 中止运行中的子 session |

## 运行要求

应答端（runtime handler）在 xyz-agent 桌面应用内；独立 pi CLI 环境无 handler 时工具将等待至超时（create/history 60s、其余 30s）并返回 cancelled。

## 测试

```bash
cd extensions/universal/session-manager && npx vitest run
```
