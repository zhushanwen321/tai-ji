# @zhushanwen/pi-session-manager

agent-managed session pi extension：把 session 的创建/发送/读取/列表/状态/中止/归档/删除交给 agent 自主管理——agent 通过 8 个工具以子 session 形态并行工作，父 session 统一编排。

## 通道契约

- 工具调用经 `ctx.ui.select(SESSION_MANAGER_MARKER, [JSON], {timeout})` 发出，超时按 action 分档（create/history 60s、其余 30s，SSOT 在 `src/index.ts` 的 `SELECT_TIMEOUT_MS`）；marker 为 `\x00TAIJI_SESSION_MANAGER`（NUL 前缀防与普通 select title 冲突，SSOT 在 `@zhushanwen/extension-protocol`）
- 请求体为嵌套形状 `{ action, params }`（形状 SSOT 在 `@zhushanwen/extension-protocol`）；**不要扁平化展开**——runtime event-adapter 按 `data.params` 提取，扁平化会导致 params 丢失
- 应答方是 taiji runtime 的 `SessionManagerHandler`（select value 通道回写 JSON 字符串；取消/超时返回 null）

## 工具（8 个工具，每工具 1 个 action）

| 工具 | action | 说明 |
|------|--------|------|
| `create_managed_session` | create | 在指定 cwd 创建子 session（可选 label；可选 `prompt` 作初始 prompt，create+send 原子完成）；服务端注入 `spawnSource: 'agent'` 与父 session id，`.agent.json` sidecar 落盘供重启恢复 |
| `send_to_session` | send | 向子 session 发送 prompt（异步处理） |
| `read_session_history` | history | 读子 session 对话历史（可选 tailTurns 截尾部 N 个 turn） |
| `list_my_sessions` | list | 列出本 agent 管理的 session（无过滤参数，自动限定发起方 agent） |
| `get_session_status` | status | 查询子 session 状态与模型信息 |
| `abort_session` | abort | 中止运行中的子 session |
| `archive_session` | archive | 归档子 session（可恢复）：会话退场进归档区（文件压缩搬移），用户可随时查看摘要并恢复；agent 可主动调用做任务收尾整理，生成中的会话拒绝归档（先 `abort_session` 或等完成） |
| `delete_session` | delete | 彻底删除子 session（不可恢复）：进程 + 历史 + 衍生数据整树进废纸篓。USER-INITIATED ONLY：仅当用户消息明确表达不可恢复的删除意图时调用，agent 永不主动发起；模糊表达（「清理掉/收掉」等）一律归 `archive_session` |

## 运行要求

应答端（runtime handler）在 taiji 桌面应用内；独立 pi CLI 环境无 handler 应答，工具会等待至超时（create/history 60s、其余 30s）后返回 isError 错误结果（文案 `cancelled or timed out`——pi 实装对取消与超时不可区分，见 protocol `callMarkerRpc`）。

## 安装

```bash
pi install npm:@zhushanwen/pi-session-manager
```

## 工具激活（deferred）

上表 8 个工具均为 `exposure: "deferred"`——不占常驻工具声明，由 pi 内置 `tool_search` 工具检索命中后按需激活。taiji 宿主内开箱即用（宿主启动时已激活 `tool_search`）；独立 pi 使用需在 `<agentDir>/settings.json`（默认 `~/.pi/agent/settings.json`）加 `"defaultTools": ["+tool_search"]`（`+` 前缀是增量修饰，保留 read/bash/edit/write 默认集）。注意独立 pi 下即便激活，工具功能仍依赖 taiji runtime handler（见上节「运行要求」）。

## 测试

```bash
cd extensions/universal/session-manager && npx vitest run
```
