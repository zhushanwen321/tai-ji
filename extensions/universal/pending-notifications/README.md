# @zhushanwen/pi-pending-notifications

跨 extension 的异步操作注册/查询机制：workflow / subagent / bash 后台任务等长耗时异步操作在启动与结束时经 Pi EventBus 广播事件，本扩展监听事件并将注册/注销落盘为 session entries，同时提供 `pending_notifications` 工具供 LLM 查询当前活跃的异步操作（数量或列表）。

## 提供的工具

### `pending_notifications`

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | `"count"` \| `"list"` | `count` 返回活跃操作数量；`list` 返回列表（类型 / 名称 / id） |

`list` 返回文本示例：

```
2 pending operation(s):
- [subagent] 审查登录模块 (id=sa-xxxx)
- [workflow] 重构数据层 (id=run-xxxx)
```

## 核心机制

- **事件契约**：异步操作的宿主扩展经 Pi EventBus 广播：
  - `pending:register { id, type, name }` —— 操作启动（`type` ∈ `workflow` / `subagent` / `bash`）
  - `pending:unregister { id, reason }` —— 操作结束（`reason` 映射为终态 status）
  - 发送方：subagent-core（subagent 生命周期）、base-tool-enhance（bash 后台任务）、subagent-workflow（崩溃恢复补注销）
- **session entries 唯一状态源**：register/unregister 经 `appendEntry` 落盘，无内存第二份状态；活跃集合 = register − unregister 差集，工具投影与写侧去重对同一份 entries 现算，结构上不可分歧
- **写侧幂等**：重复 register、未知/已注销 id 的 unregister 均忽略，天然不重复落盘
- **无 TTL**：三类操作均按进程存活口径处理，长任务（>1h）仍视为活跃
- **跨 session 残留过滤**：查询按当前 session id 过滤 fork 继承的父级注册残留
- **跨扩展导出**：`countActiveFromEntries()` 供 goal（continuation 守卫）、subagent-workflow（后代存活判定）直接复用差集计算；差集本体单点在 `@zhushanwen/extension-protocol`

## 安装

```bash
# npm 方式（正式）
pi install npm:@zhushanwen/pi-pending-notifications
```

本地开发可用 `--extension` 直接加载：

```bash
pi --extension <repo>/extensions/universal/pending-notifications/index.ts "<prompt>"
```

## 使用示例

LLM 在决定「继续推进还是等待异步操作」前主动查询：

```json
{ "action": "count" }
```

```json
{ "action": "list" }
```

典型场景：agent 想确认是否真有后台任务在跑（workflow run / subagent / bash 后台命令），避免在异步操作未收口时提前下结论或重复派发。

## 文件结构

```
pending-notifications/
├── index.ts            # 入口 — re-export src/index.ts
├── mocks/
│   └── typebox.ts      # 测试用 typebox mock
└── src/
    ├── index.ts        # 工厂入口（EventBus 监听 + session 基准 + pending_notifications 工具注册）
    ├── state.ts        # PendingEntry 类型 + 差集/写侧判断纯函数（countActiveFromEntries / hasPendingId / isPendingActive）
    └── __tests__/
        └── pending-notifications.test.ts
```
