# session-trace fixtures（trace-runtime 单元）

两类产物：**RPC 真实录制**（探针 P1 执行产物 = 测试 fixture，一鱼两吃）+ **文件直读路径 fixture**（A32）。

## RPC 录制（get-entries-*.json / .jsonl，A24 parity + A31 mock 数据源）

用本地 pi CLI（workspace 缓存二进制 pi 0.84.1，与 `@earendil-works/pi-coding-agent` 锁定版本一致）
对 3 个 session 文件真实调用 `get_entries` RPC 录制（`switch_session` 加载 → 等响应 → `get_entries`
→ 收响应后 EOF 退出）。全程无 prompt，零 LLM 调用。录制脚本：
`packages/runtime/scripts/record-get-entries-fixtures.mjs`（pi 版本升级需重录时执行）。

| 产物 | 源（core fixture） | 覆盖面 | 录得 entries |
|---|---|---|---|
| `get-entries-1-mixed-kinds` | real-mixed-kinds.jsonl（真实 session 脱敏，124 行） | custom×44 / custom_message / model_change / id-less session_info 侧支 | 123 |
| `get-entries-2-compaction-single` | synthetic-compaction-single.jsonl | compaction（firstKeptEntryId）+ model_change | 11 |
| `get-entries-3-fork-header` | real-fork-header.jsonl | fork header `parentSession` = 源 sessionId fallback 形态 | 3 |

- `.json`：get_entries 响应原样（含 `__recordedAt` / `__piBin` / `__sourceFixture` / `__elapsedMs`
  meta 头，供 P3 附注核对）+ `response.data.entries`（pi 权威解析产物）。
- `.jsonl`：pi 读取后落盘的 session 文件——A24 parity 测试对 `.json` 的 entries 与本文件直读
  产物逐条 diff（见 `src/services/session/__tests__/trace-parity.test.ts`）。

与 core 源 fixture 的两处固定差异（录制必然，不破坏 parity——RPC 与文件**同时**包含）：

1. header.cwd 改写到临时工作区（源是脱敏假路径，pi 的 `assertSessionCwdExists` 拒载；
   entries 逐行不变）。
2. pi resume 追加 1 条 `thinking_level_change`（session 无历史 thinking level 时应用默认档；
   真实 pi 行为的如实录制）。

隔离：`PI_CODING_AGENT_DIR` 指向临时空目录 + 剥离 `PI_*` 环境变量——不加载用户
extensions（首次录制曾混入本机 `unified-hooks:loaded` / `subagent-identity` 等 extension
entry，且宿主 pi 会话的 `PI_MODEL` 泄漏给嵌套 pi 导致模型选型报 ambiguous）。

## 文件直读路径（A32）

| 文件 | 用途 |
|---|---|
| `file-path-malformed.jsonl` | 坏行容错：第 3 行纯文本 + 第 5 行半截 JSON；含无 id 的 session_info（真实文件侧支形态） |
| `file-path-malformed.jsonl.meta.json` | sidecar session_end（done 终态，BOUNDARY 行合并来源） |
