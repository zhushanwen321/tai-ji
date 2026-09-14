# ext-simplify-17 D8 真机验收报告（V7）：select+marker RPC 原语三消费方端到端

- 日期：2026-09-14
- 仓库：dev-0.9.21 worktree（commit 057696113 之上，D8 = commit d997a7fa4 已在分支历史）
- 设计依据：`docs/architecture/ext-simplify-17-shared-extraction.md` §3.3 D8（v7 冻结形态）、§5.2 V7 条目
- 验证对象：`packages/extension-protocol/src/core/select-rpc.ts`（callMarkerRpc 原语）+ 三消费方迁移（session-manager `callSessionManager` / plugin-bridge `callBridge` / subagent-workflow `host/inflight-reporter.ts`）
- 结论先行：**V7 四项全部 PASS**——① session-manager raw 回包透传不破（list/create 双 action 实证）；② plugin-bridge sync + 工具执行 JSON 回包正常消费（synced 1 tool + kind:ok）；③ 构造非 JSON 回包 → agent 可见错误文本 + extension 留痕日志 + extension 层 isError:true（单测锚定；pi 记录层 isError 恒 false 为 pi 0.84.4 已知行为，见 §3.4）；④ inflight 冒烟无异常且零重试告警（reporter 侧 ack 推断）。runtime 代码终态零改动，dev 进程零残留。

## 0. 环境与操作序列总览

- dev 启动：`XYZ_DEV_BACKGROUND=1 pnpm dev`（装配器派生 Vite 1499 / CDP 9255 / runtime 3540）；browser-automation 经 `node pw.js http://localhost:9255` 连接（list-pages 确认 `localhost:1499/?windowId=win-1`）。共起停 4 轮 dev（run1 端口确认 / run2 数据目录勘误后重起 / run3 插件授权修正后重起 / run4 非 JSON patch 后重起），启动日志 `/tmp/v7-dev{,2,3,4}.log`。
- 会话操作全部经 GUI composer（`type ".composer-input"` + Enter），模型 MiMo-V2.5-Pro（模板预置默认）。
- 会话 cwd：`/private/tmp/ext-simplify-gui-accept/cwd`（沿用 V6 剧本的目录）。
- **环境事实勘误（影响操作路径，登记见 §5-1）**：dev 实际数据目录 = `~/.xyz-agent-dev`（`apps/electron/main/main.ts:137` dev 块无条件钉死，覆盖装配器注入的 `instances/dev-0.9.21`）——pi 会话/扩展日志/插件目录均在此，与 V6 报告路径一致。

## 1. 项 1：session-manager raw 回包路径 — PASS

**断言**：真机调用 session 管理工具成功，结果为正常文本，raw string 透传语义不破（`callMarkerRpc` 的 `value` 恒 raw，extension `executeTool` 原样进 content）。

**操作序列**：run2（未 patch runtime）GUI 新建会话 → prompt「调用 list_my_sessions 工具…贴出原文」→ prompt「调用 create_managed_session，cwd=/tmp/v7-child label=v7-accept-child」→ 读会话 JSONL。run3（未 patch，另一轮 dev）再重复 list 一次作交叉验证。

**证据**（会话文件 `~/.xyz-agent-dev/agent/sessions/--private-tmp-ext-simplify-gui-accept-cwd--/2026-09-14T12-40-19-029Z_01a09fee-bf55-7df1-86d6-91c5fc7da153.jsonl` 原文）：

```json
{"role": "toolResult", "toolCallId": "call_704c51fda51b4b07b9e1c131", "toolName": "list_my_sessions", "content": [{"type": "text", "text": "{\"sessions\":[]}"}], "isError": false}
{"role": "toolResult", "toolCallId": "call_75b71857513f4a9187a53a56", "toolName": "create_managed_session", "content": [{"type": "text", "text": "{\"sessionId\":\"01a09fef-f99d-781f-b3a6-d630bc306cea\",\"status\":\"created\",\"modelId\":\"xiaomi-token-plan-cn/mimo-v2.5-pro\"}"}], "isError": false}
```

run3 交叉验证（会话 `…12-50-28-490Z_01a09ff8-….jsonl`，timestamp 1789390390714）：`list_my_sessions` → `{"sessions":[]}`，isError:false。

**判定**：toolResult text = runtime handler `respond(JSON.stringify(data))` 产出的原始 JSON 字符串字节原样（extension 不改写、不二次序列化）——raw 透传语义成立；非空载荷（create 的 sessionId/status/modelId 三字段）与空载荷（list 空数组）双形态均 isError:false。PASS。

## 2. 项 2：plugin-bridge sync + 工具调用 JSON 回包路径 — PASS

**断言**：真机触发 plugin sync（bridge:sync JSON 回包 = BridgeSyncPayload 消费）+ 一个 bridge 工具调用（bridge:tool_execute JSON 回包 = BridgeToolExecuteResponse 消费）。

**触发手段构造**（全托管决策）：数据目录放 sandbox 外部插件 `~/.xyz-agent-dev/plugins/v7-probe/`（package.json 声明 `permissions: ["tools.register"]` + index.js `api.tools.register` 注册 `v7_echo` 工具，execute 回 `{content: "v7-echo: <text>"}`）+ 预授权 `permissions.json`（短形 `"tools.register"`，load 时归一化为成对方法 `plugin.tools.register`+`plugin.tools.unregister`——成对授权是硬要求，第一版只授单方法导致 activation 挂起 30min 权限等待，见 §5-2）。

**操作序列**：run3 启动（插件激活）→ GUI 新建会话 → prompt「调用 v7_echo 工具，参数 text="hello-from-v7"」→ 读会话 JSONL + 扩展日志。

**证据 A（sync，JSON 回包 → isBridgeSyncPayload → registerTool）**：`~/.xyz-agent-dev/agent/logs/plugin-bridge-2026-09-14.log`：

```
2026-09-14T12:48:04.258Z [info] [plugin-bridge] synced 1 plugin tool(s)   ← reattach 会话 ×3
2026-09-14T12:50:29.398Z [info] [plugin-bridge] synced 1 plugin tool(s)   ← 本项新会话
```

插件激活侧（`/tmp/v7-dev3.log`）：`[plugin-process:sandbox-v7-probe] [plugin-sandbox] CJS require interception active…` + `[runtime] plugins initialized`（breakdown plugins=184.9ms）。

**证据 B（tool_execute，JSON 回包 → isBridgeToolExecuteResponse → content 透传）**（会话 `…12-50-28-490Z_01a09ff8-….jsonl` 原文）：

```json
assistant toolCall: {"type": "toolCall", "id": "call_b90310ccd1f34a938122e4ed", "name": "v7_echo", "arguments": {"text": "hello-from-v7"}}
toolResult: {"role": "toolResult", "toolCallId": "call_b90310ccd1f34a938122e4ed", "toolName": "v7_echo", "content": [{"type": "text", "text": "v7-echo: hello-from-v7"}], "details": {"kind": "ok"}, "isError": false}
```

**判定**：`details: {kind: "ok"}` 只在 `forwardToolExecute` 的 `isBridgeToolExecuteResponse(raw)` 命中分支产出——即 select 通道回包经原语 JSON 检测后 parse、形状守卫消费、content 透传全链路闭合。sandbox 子进程真实执行（fork 独立进程）+ 首轮 sync 注册 + 工具往返两条 JSON 路径均正常。PASS。

## 3. 项 3：构造非 JSON 回包 → isError + 留痕（行为微变①直接验证点）— PASS

**断言**：patch runtime respond 链注入畸形串后，session-manager 工具结果转为错误形态（agent 可见提示文本 + extension 层 isError:true）且留痕日志落盘；还原后零残留。

### 3.1 patch 前正常路径绿（同源码未 patch）

- run2（12:40/12:41）：list + create 均 isError:false 原文透传（§1 证据）。
- run3（12:53:10，timestamp 1789390390714）：list 再次 isError:false、text=`{"sessions":[]}`。
- 以上与 patch 属同一 worktree 源码状态（期间仅数据目录插件文件变化，runtime 源码零改动）。

### 3.2 patch 注入

`packages/runtime/src/transport/session-manager-handler.ts` `respond()` 临时替换为固定回 `'not-json{{{'`（带 `[V7-ACCEPTANCE-PATCH-TEMPORARY]` 注释标记），重启 dev（run4，runtime 不热重载）→ GUI 新建会话 → prompt 调 list_my_sessions。

### 3.3 patch 后证据

**agent 可见错误文本**（会话 `…12-54-40-069Z_01a09ffb-….jsonl` 原文）：

```json
{"role": "toolResult", "toolCallId": "call_5e28f5d916ef4ee0bb2681d9", "toolName": "list_my_sessions", "content": [{"type": "text", "text": "Session manager list: non-JSON response from runtime (protocol mismatch — redeploy same-version runtime + extension; see extension logs)."}], "isError": false, "timestamp": 1789390484154}
```

（GUI 同步可见：agent 复述该错误文本并停止——不再把畸形串当成功载荷消费。）

**留痕日志**（`~/.xyz-agent-dev/agent/logs/session-manager-2026-09-14.log`，原语 `log` 注入产出）：

```
2026-09-14T12:54:44.153Z [error] [session-manager] non-JSON response (marker "\u0000XYZ_SESSION_MANAGER") {"responseHead":"not-json{{{"}
```

### 3.4 isError:true 的证据分层（重要说明，非 fail）

- **pi 记录层 isError 恒 false**：pi 0.84.4 agent-loop 对正常 return 的 tool execute 硬编码 `isError: false`（实装锚点 `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` `executePreparedToolCall` 末行 `return { result, isError: false }`，仅 catch 分支置 true），extension 返回对象上的 `isError` 字段不进 pi 会话记录——该行为已在 `extensions/taiji/plugin-bridge/src/index.ts:135-142` 【坑】注释登记，且对三消费方一致（plugin-bridge errorResult 同形态同被剥）。
- **extension 层 isError:true**：D8 自带单测钉值（验收中实跑 `npx vitest run src/__tests__/tool-non-json-response.test.ts` → 3 tests passed，断言非 JSON → isError:true + 提示文本）。
- **结论**：行为微变①「isError + 留痕」在 extension AgentToolResult 层面成立且与 plugin-bridge 形态对齐（D8 等价性主张不受 pi 记录层行为影响）；agent 可判错信号 = content 文本（LLM 实际依据）。

### 3.4' 还原与零残留核验（三重）

1. `git diff packages/runtime/` → 空（0 行输出）；
2. `git status --porcelain packages/runtime/` → 0 条目；
3. `grep -n "JSON.stringify(data)" packages/runtime/src/transport/session-manager-handler.ts` → :133 原句复位。

还原采用 Edit 精确逆替换（非 git checkout——工作区存在认知外的 impl-plan 既有改动，见 §6 领地说明）。

## 4. 项 4：inflight 真机冒烟（评审 S4 补项）— PASS

**断言**：引擎 subagent 任务完成后 runtime 侧在途镜像正常（任务无异常 + 无 inflight 报错日志；ack 收到更佳）。

**操作序列**（run3，复用 V6 剧本）：同会话 prompt「派一个 pi 引擎 subagent 执行：bash `echo inflight-smoke-v7`」→ 主 agent 派发 subagent（record sa-eddd9d52）→ 等待完成通知。

**证据**：

- GUI 对话流：「已派发 pi 引擎 subagent（sa-eddd9d52），正在等待完成通知……」→「后台任务完成 · 已继续处理」→ 结果 `inflight-smoke-v7` 原样返回（截图 `/tmp/v7-shot-perm.png` 为同时段界面）。
- subagent 会话文件 `~/.xyz-agent-dev/agent/subagents/--private-tmp-ext-simplify-gui-accept-cwd--/sessions/2026-09-14T12-51-33-889Z_01a09ff9-0b81-7172-96e6-5d987b4b5176.jsonl` 含 `inflight-smoke-v7`（toolCall + toolResult 双出现）。
- **零 inflight 报错**：`~/.xyz-agent-dev/agent/logs/subagents-2026-09-14.log` 全文件 grep `inflight|in-flight` 零命中——无 `in-flight report failed`（首败必 warn）、无 `gave up`；runtime 日志同窗口零 `subagent-inflight frame dropped`。
- **ack 收到的推断依据**（reporter 侧，构造性）：inflight-reporter 的送达判据 = runtime 回 `INFLIGHT_REPORT_ACK`（`'{"ack":true}'`）全等匹配；ack 缺失必进延迟重试且**首败 warn 留痕**（`logFailure` firstFailureLogged 机制）。整个验收窗口（含本项 0→1→0 多帧迁移）零告警 ⇒ 每帧首试即收到 ack。runtime 侧 mirror `applyReport` 静默无日志面（设计如此），故 ack 确认取 reporter 侧反证，未做 runtime 内存探针（决策 §7-6）。

## 5. 发现登记（既有问题，非 D8 引入，不擅自修）

1. **dev 数据目录装配与 main.ts 钉死不一致（P3）**：`dev-instance.mjs --print` 声称数据目录 `~/.xyz-agent-dev/instances/dev-0.9.21`（buildDevEnv 也注入），但 `apps/electron/main/main.ts:137` dev 块无条件 `XYZ_AGENT_DATA_DIR = ~/.xyz-agent-dev`（2026-09-08 泄漏事故钉死）——实例级数据隔离在 Electron 层被覆盖，多 worktree dev 实际共享同一数据目录（本次共享日志里可见 feat-optimize-* 与 fix-composer-* 各 worktree 的历史行；端口隔离仍生效）。与 V6 报告路径一致。处置建议另行裁决（main.ts 钉死 vs 装配器权威，两者注释自述矛盾）。
2. **插件冷启动权限审批广播先于 renderer 认证（P3）**：runtime 插件初始化（ready 后即时）早于 renderer WS authenticated（本次实测 12:37:25.5 vs 12:37:29.3），`plugin:permissionRequest` 广播丢失时 activation 挂起至 `PERMISSION_TIMEOUT_MS`（默认 30min），「Runtime broadcast 时序竞争」已知形态在插件面的实例。规避：预授权 permissions.json（须用短形/成对完整方法，见 §2）。
3. **reattach 会话 plugin-bridge stale-ctx 重试噪音（P3）**：dev 重启后 reattach 的 pi 会话 sync 循环报 `extension ctx is stale after session replacement or reload` 直至 30 次上限 Degraded（12:48:10–12:49:03，120 条；当日 05:00 他 worktree 运行有同形态）——reattach 相关既有行为。值得注意的是 D8 迁移后的失败折叠路径（channel-error → 有界重试 → 放弃 + warn）在该噪音下按设计工作。
4. **pi 记录层 isError 剥离**（§3.4）：pi 0.84.4 已知行为，plugin-bridge 源码已登记，本次真机再次证实，随 C-proc-08 探针族重验。

## 6. 领地与未触碰项

- **git 终态**：`git status --porcelain` 仅剩 `.tmp/dev-flow/ext-simplify-17-shared-extraction.impl-plan.md`（验收开始前即存在的认知外改动，本验收未触碰）；`packages/runtime/` 零条目。
- **未改任何产品代码**：非 JSON patch 为临时 dev patch，已还原并三重核验。
- **数据目录侧产物**（`~/.xyz-agent-dev`，非仓库）：v7-probe 插件 + permissions.json 已删除（plugins/ 复空）；验收产生的 GUI 会话（01a09fee/01a09ff8/01a09ffb）、subagent 会话（01a09ff9）、managed 子会话 record（01a09fef）保留作证据（V6 先例同款）。
- 未触碰：生产 TaiJi.app 及其全部 pi/relay 进程与数据（`~/.xyz-agent`）、其他 worktree 的 fake-engine 测试进程。

## 7. 决策清单（全托管模式）

1. bridge 工具触发采用「数据目录 sandbox 外部插件 + 预授权」而非往 `resources/plugins/` 加 built-in 插件——后者污染 git 仓库，与「runtime 终态零改动」验收线冲突。
2. 权限预授权文件第一版写全名单 `["plugin.tools.register"]` 失败（成对授权缺 unregister），改短形 `["tools.register"]`（load 归一化补齐成对方法）后激活成功——根因定位经 tsx 本地探针（PermissionChecker.getUnapproved + descriptor stub）+ `plugin-permission-map.ts` CAPABILITY_ALIASES 实读。
3. 发现数据目录实际为 `~/.xyz-agent-dev`（main.ts 钉死）后，将插件从 instances 路径移至实际目录并重启，不改产品代码，仅登记发现 §5-1。
4. isError 断言采用双证据分层（extension 层单测 + pi 实装锚点解释记录层差异），不判 fail——pi 剥离行为对三消费方一致且已在 plugin-bridge 登记。
5. patch 还原用 Edit 精确逆替换 + 三重核验（diff/status/grep），不用 git checkout（避免卷入工作区认知外改动）。
6. inflight ack 确认取 reporter 侧「零重试告警」构造性反证（首败必 warn），不做 runtime 内存探针——侵入性高且 mirror 无日志面。
7. kill 仅逐 PID（69998/70032/70064 孤儿 fake-engine fixture），四轮 dev 停止经 task stop 整树自然收敛，终态 env 感知扫描（XYZ_AGENT_DATA_DIR 含 xyz-agent-dev 的 pi/引擎/插件进程）零残留；宽泛 pkill 未使用。

## 8. 测试与检查汇总

| 检查 | 结果 |
|------|------|
| 项 1 raw 透传（list/create/run3 交叉） | PASS（isError:false + 原文字节一致） |
| 项 2 sync + tool_execute JSON 回包 | PASS（synced 1 tool ×4 + details.kind:ok） |
| 项 3 非 JSON → 错误文本 + 留痕 | PASS（文本 + `[error] … non-JSON response` + responseHead 畸形串） |
| 项 3 extension 层 isError:true | PASS（D8 单测 3 例绿；pi 记录层差异已锚定解释） |
| 项 3 还原零残留 | PASS（diff 空 / status 0 / :133 复位） |
| 项 4 inflight 冒烟 | PASS（任务完成 + 零 inflight 告警 ⇒ ack 首试命中） |
| `git status packages/runtime/` | 0 条目 |
| dev 进程清理 | 零残留（端口 9255/1499/3540 释放；生产进程未触碰） |
