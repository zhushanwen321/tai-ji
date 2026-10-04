# Session 文件读者普查清单（census SSOT）

> 约束登记：[C-proc-28](../constraints.json)——session 文件读者必须登记于本清单并按二分准则归类；新增派生读者时同 commit 更新本清单。

## 1. 普查对象与归类准则

普查对象 = 读取 taiji pi session `.jsonl` 内容（entries）的全部代码点。两个通道：

- **extension 侧**：pi 进程内经 `ctx.sessionManager.getEntries()`（ReadonlySessionManager）
- **runtime 侧**：fs 直读 `.jsonl` / jsonl 解析原语（`packages/runtime/src/utils/jsonl.ts`）/ 提取扫描函数族

不在普查对象内（另行登记理由）：

- zcode 会话库（sqlite）与多 coding-agent 导入源的源格式读取域——见 [session-import-sources.md](session-import-sources.md)
- subagent 引擎自身 spawn 的 session 文件——独立文件、独立进程写（C-sw-01），主 session 树回退不触碰；runtime 侧对它们的读取点在本清单登记归类，判定理由注明文件独立性
- pi stdout tee 日志（`infra/logger.ts`）——写流非读者（R3 锚点命中的排除项）
- extension 侧旁路数据文件（非 session .jsonl）：plan 的 `.plan/` markdown 与模板（`plan/src/compact.ts` / `command.ts` / `templates.ts` / `exec-skills.ts`）、scheduler importer、system-prompt / system-prompt-trace baseline、llm-shared config、smart-context 的 compact sidecar 重注入（`compact-handler.ts` `readFileForReinject`）——均为配置/自产物文件读取；其中 smart-context compact sidecar 与撤回语义的交互（重启重注入是否需按活跃路径判定）属 message-revoke 设计域裁决事项，不在本普查清单判定

**归类准则（G2 二分）**：

| 归类 | 定义 | 判据 |
|------|------|------|
| **未来状态随树** | 读取物是可由活跃路径确定性重建的当前状态；撤回后按活跃路径重算，被撤子树内容不进派生态 | 语义是「现在是什么」（todo 列表 / plan 状态 / goal / pending 定时任务 / 模型绑定），不是「发生过什么」 |
| **已发生事实照实** | 读取物是发生过的事实记录；重建即伪造事实（run 真实执行过、token 真实消耗、通知真实发过、名字与结局真实发生过） | 撤回不回滚世界与审计面（G2 口径：不从文件/日志中抹除） |

补充登记形态（非二分成员）：

- **非投影读者**：格式归一化 / 导入复制类——逐行透传或文件复制，不派生展示投影、不丢行
- **非文件读者**：`session_tree` 事件消费者——不读 session 文件，仅消费事件；知悉登记
- **消费面委托**：锚点命中但自身不读文件（port 聚合 / 类型声明 / 一行委托）——登记防漏，不判归类

## 2. 机器锚点（清单闭合的复现命令）

```bash
# E1 · extension 侧 getEntries 全量读者（11 包族 / 20 文件，含 extensions/shared 两库：notify-ledger-host 装配工厂 / session-path 活跃路径裁剪单一实现）
grep -rln 'getEntries(' extensions/ --include='*.ts' | grep -v '\.test\.' | grep -v __tests__

# E2 · extension 侧 fs 直读 .jsonl 审计工具面（唯一包：session-reader；两个 pattern 取并集）
grep -rln "from '@zhushanwen/session-core'" extensions --include='*.ts' | grep -v '\.test\.' | grep -v __tests__
grep -rln 'createReadStream' extensions/ --include='*.ts' | grep -v '\.test\.' | grep -v __tests__

# R1 · runtime 侧 jsonl 解析原语消费（6 文件）
grep -rln "utils/jsonl" packages/runtime/src --include='*.ts' | grep -v '\.test\.' | grep -v __tests__ | grep -v 'src/utils/jsonl.ts'

# R2 · runtime 侧提取器/扫描器/header 函数族（39 文件，含消费面委托）
grep -rln 'FromSessionFile\|scanPiSessions\|scanExternalSessions\|getHistoryFromFilePath\|extractLatestModelFromJsonl\|extractSessionName\|extractSessionOutcome\|scanSessionMeta\|scanSubagentEntries\|scanWorkflowEntries\|scanPlanStateEntries\|readSessionHeader\|parseSessionHeader' packages/runtime/src --include='*.ts' | grep -v '\.test\.' | grep -v __tests__

# R3 · runtime 侧流式逐行扫描（2 文件：usage-stats-service 读者 + logger 写流排除项）
grep -rln 'createReadStream' packages/runtime/src --include='*.ts' | grep -v '\.test\.' | grep -v __tests__
# P3 · plugin 族读者（经 runtime session-api readEntries 通道，不经 extensions/ 的 getEntries 锚——2026-09-25 A14 验收补锚）
grep -rln 'readEntries' resources/plugins --include='*.ts' | grep -v '\.test\.' | grep -v __tests__

# R4 · runtime 侧 getEntries RPC 通道读者（2026-10-01 分支审查补锚：N13/N14 补登暴露的通道盲区——E1 只扫 extensions/、R1/R2/R3 只扫 runtime fs 通道，runtime 侧经 RpcClient.getEntries 读 session 的读者此前不可检索；命中面 session-api / session-records / history-rebuild-cache / trace-sync / revoke-orchestrator / session-delivery-registry 六文件均已登记）
grep -rn 'client\.getEntries(' packages/runtime/src --include='*.ts' | grep -v '\.test\.' | grep -v __tests__
```

闭合规则：任一锚点出现本清单未登记的新命中 → 按 C-proc-28 同 commit 归类登记后再合入。「接入单元」列 = message-revoke 流水线内承接裁剪/重建接线的单元（U6a-U6d）；「—」= 照实/非投影/豁免，无代码改动。

## 3. Extension 侧读者清单（E1 + E2）

| 包 | 读取点 | 归类 | 判定理由 | 接入单元 |
|----|--------|------|----------|----------|
| todo | `handlers.ts` `reconstructState`（全文件正序回放取最后一条 todo toolResult；已有 `session_tree` handler 即时重建） | 随树 | todo 列表 = 当前状态；回放改「活跃路径内最后一条」；被撤子树 todo 快照不得经 `<todo_context>` 注入模型上下文 | U6b |
| plan | `state.ts` `reconstructPlanState`（逆序取最后一条 plan-state entry） | 随树 | plan 状态 = 当前状态；逆序扫描接活跃路径裁剪 + 新增 `session_tree` handler 即时重建（纯重建两行体，无 steer 副作用） | U6b |
| plan | `session_before_compact` / `session_before_tree` 摘要注入面（摘要从 plan state 派生） | 随树 | 随 state 重建生效；撤回走 `summarize:false` 不触发 tree summary（注入面安全前提） | U6b |
| goal | `session.ts` `reconstructGoalState`（全文件倒序重建；`before_agent_start` 注入读内存态不重算） | 随树 | goal 状态 = 当前状态；同款裁剪 + 新增 `session_tree` handler 即时重建（否则被撤 goal 逐轮注入模型上下文） | U6c |
| goal | `ports.ts` SessionPort 接口声明 + `adapters/ports.ts` 一行委托（`getEntries: () => ctx.sessionManager.getEntries()`） | 消费面委托（随树） | 锚点命中但自身不读文件（类型声明 / 一行委托）；读取语义落在 `session.ts` `reconstructGoalState`，随树判定由 U6c 覆盖 | U6c |
| goal | `adapters/event-handlers/agent-end.ts` + `command-adapter.ts` `countActiveFromEntries` 活跃性守卫 / `goal-history` 展示 | 照实 | 活跃 run 是已发生事实（与撤回互斥由编排 workflow-running 检查承载）；history 命令展示历史记录 | — |
| scheduler | `backend.ts` `loadTasks` 折叠（全文件折叠恢复 pending 定时任务） | 随树 | pending 定时任务 = 未来将发生的事；被撤子树任务不得复活触发（重折叠 + `session_tree` handler） | U6c |
| scheduler | `ack-turn.ts` `hasAssistantEntry` 落盘判据（fail-closed 只读） | 照实 | 判据 = 文件是否已有 assistant flush（文件事实），非状态投影 | — |
| subagent-workflow | `jsonl-run-store.ts` `loadAll()`（workflow-record entry 重建 run 记录） | 照实 | run 真实执行过，与 runtime 侧 workflow-extractor 同概念域同口径 | — |
| subagent-workflow | `session-lifecycle.ts` `bindLedgerHostAndRecover`（notify ledger/ack 差集恢复） | 照实 | 通知发送/销账是已发生事实；对账照实才能幂等 | — |
| pending-notifications | `index.ts` 每 turn 全量扫描（pending register/unregister 对账） | 照实 | 后台任务活跃性是已发生事实；run 在跑则照实（撤回遇活跃 run 由编排前置检查阻止，两口径互斥不冲突） | — |
| session-manager | `watch-coordinator.ts` `recoverStaleRegisters`（session_start 重启收口腿：`scanPendingEntries` 差集对账后逐条重开活跃 type 'session' 的 watch，D7③） | 照实 | pending 注册活跃性是已发生事实——与 §3 pending-notifications 行同口径（同一 protocol 差集单点对账，撤回遇活跃 run 由编排前置检查阻止） | — |
| notify-ledger-host（extensions/shared） | `src/index.ts` 装配工厂 `readSessionEntries: () => ctx.sessionManager.getEntries()`（NotifyLedgerHost 的 pi 扩展侧装配点） | 消费面委托（照实） | 锚点命中但读取语义落在装配方——session-manager（`notify-ledger.ts`）与 subagent-workflow（§3 `session-lifecycle.ts` 行）的 notify/ack 差集恢复均经此工厂，照实对账才幂等 | — |
| session-path（extensions/shared） | `src/index.ts` `filterActivePath`（活跃路径裁剪单一实现：todo/plan/goal/scheduler 四包状态重建输入的共用读点——四包原同构副本收编于此，回退取值口径随之统一） | 随树（随消费方） | 防御语义与 pi `buildSessionPath` 同构（leafId 缺失/失效回退文件尾，详见 §4.1 异源登记）；读取语义落在四消费包（§3 各行随树判定不变）；runtime/plugin 两侧不经本包（有意异源） | U6b / U6c（四包各自承接） |
| base-tool-enhance | `index.ts` / `background/pending-reconcile.ts` `reconcilePendingEntries` | 照实 | bash 后台 pending 对账 = 已发生事实 | — |
| rename-session | `index.ts` / `llm.ts` / `landing.ts`（`countUserMessages` / `extractUserPromptText` 起名输入） | 照实 | 会话起名是历史事实分析（用户确实说过）；输出为展示性标签，被撤消息进入起名视野属可接受残影（见 §7 边界 ①） | — |
| smart-context | `index.ts` / `tool.ts` `countCompactions`（压缩计数 + 分档提醒） | 照实 | 压缩已发生、provider 已消耗（与 usage 统计同口径）；分档提醒按真实历史校准 | — |
| session-reader | `@zhushanwen/session-core` 读取原语（`readTailIdentity` / `createReadStream`，fs 直读 `.jsonl`） | 豁免登记 | 审计工具面，G2「不从文件/日志中抹除」口径——撤回后旧分支经 session_read 仍可查（A1 验收锚「session 文件仍含 M」的消费面） | — |

> **§3 收编注记**：todo / plan / goal / scheduler 四行的活跃路径裁剪读点 = `extensions/shared/session-path`（E1 锚点命中该库 `src/index.ts`）。收编后 `plan/src/state.ts` 不再直接命中 E1（读取语义不变，经共享库流转）；`todo/src/handlers.ts` 的命中为既有 H1 注释提及（`getEntries()` filter-copy 语义说明，非读取点）。

## 4. Runtime 侧读者清单（R1 + R2 + R3）

### 4.1 重建链族（随树）

| 模块 | 读取点 | 归类 | 判定理由 | 接入单元 |
|------|--------|------|----------|----------|
| `infra/pi/entry-tree-builder.ts` | `rebuildHistoryFromEntries`（get_entries RPC 全量 → 重建 Message[]，含 msg-id-mapper `taiji.client-msg-id` custom entry 映射回填） | 随树 | 对话流历史 = 模型视角投影（G2 主张「该消息从未发生」）；leafId 沿 parentId 回溯裁剪。映射回填随裁剪构造性覆盖：被撤消息的映射目标不在活跃路径，映射失效即正确语义 | U6a |
| `infra/pi/session-entry-mapper.ts` | `mapSessionEntries`（RPC / 文件两条历史链共用映射单点） | 随树 | 喂入裁剪后 entries；无分支 session leafId 缺省 = 文件尾 = 现行为 | U6a |
| `services/session-history.ts` | `getHistoryFromFilePath` + 离线尾读（`tailReadOffline`） | 随树 | 同一历史投影的文件源腿；离线尾读等价裁剪 | U6a |
| `services/session/history-rebuild-cache.ts` | 全量重建缓存 | 随树 | 缓存基线语义 = 活跃路径投影（非全文件）；撤回编排显式清缓存强制全量重建 | U6a |
| `services/plugin-service/api/session-api.ts` | `readEntries` handler（plugin 族读面的 runtime 投影点：pi get_entries → `filterEntriesToActivePath` 活跃路径过滤 → 五字段投影，parentId 不出 runtime） | 随树 | 插件镜像的折叠输入 = 本投影回包——过滤在投影前使被撤子树 op 构造性不达任何插件（scheduler-manager 面板残留缺陷的 runtime 数据面落点，U7）；防御语义与 extensions 裁剪同构但有意异源：leafId 缺失/悬空 → **不过滤**（增量批不丢数据优先，extensions 侧按文件尾回退是全量语义），环状 parentId `!activeIds.has` 防环 | U7（撤回信号广播同批） |

> **§4.1 防御语义异源登记（R2 审查采纳，防后续审查误报）**：extensions 侧的活跃路径防御已收编为单一共享实现 `extensions/shared/session-path`（todo/plan/goal/scheduler 四包原同构副本收编——收编前四包回退取值口径已分叉：plan/todo 取数组尾条目 vs goal/scheduler 取最后一条带 string id 条目，统一为后者；真实 pi SessionEntry 恒有 id，生产行为不变），与 pi `buildSessionPath` 同构——leafId 缺失/失效**回退文件尾**（全量语义，宁全勿漏）；runtime 重建链（entry-tree-builder 族）同构同源、不经共享库（extension 不能 import runtime 包，跨面异源为有意设计）。与两者有意异源的是 §4.1 末行 plugin 投影点（leafId 悬空**不过滤**——增量批部分数据，不丢数据优先）与 runtime 侧「降级 warn + 原样返回」的 SSOT 形态（对话流宁多显 vs 注入面宁裁勿漏——G2 二分准则在各面的落地形态差异，均为有意设计非漂移）。

### 4.2 派生提取器族（随树）

| 模块 | 读取点 | 归类 | 判定理由 | 接入单元 |
|------|--------|------|----------|----------|
| `services/session/plan-state-extractor.ts` | `scanPlanStateEntries` / `extractPlanStateFromSessionFile`（SessionRecords 增量 + `getPlanState` 冷启，三处同批） | 随树 | plan 状态 = 当前状态（面板派生；「唯一派生函数」注释的作用域即此双路径，extension 侧 U6b 并行同构） | U6d |
| `services/session/session-records.ts` | 增量拉取编排 + 失效契约 | 随树（plan 腿）/ 照实（subagent/workflow 腿） | 撤回失效 = 丢 cursor 强制全量重建；全量重建时 plan 扫描接 leafId 裁剪、subagent/workflow 扫描不裁（照实构造性保持）、三水位字段同批处置 | U6d |
| `infra/pi/session-file-utils.ts` | `extractLatestModelFromJsonl`（model binding） | 随树 | 模型绑定 = 当前生效值（未来状态）；取数改活跃路径逆读——分支下命中被撤子树 `model_change` 即与 pi 真实生效值漂移 | U6d |

### 4.3 照实豁免族（U6 领地内判定）

| 模块 | 读取点 | 归类 | 判定理由 | 接入单元 |
|------|--------|------|----------|----------|
| `services/session/subagent-extractor.ts`（经 `session-file-extraction.ts` 共享骨架） | `scanSubagentEntries` / `extractSubagentsFromSessionFile` | 照实 | run 真实执行过，与工具副作用残留同口径 | — |
| `services/session/workflow-extractor.ts`（同上骨架） | `scanWorkflowEntries` / `extractWorkflowsFromSessionFile` | 照实 | 同上 | — |
| `services/session/journal-projection.ts` | journal 投影的 session entry 冷启动腿（`scanSubagentEntries` / `scanWorkflowEntries` 喂入 v1 源——import :59-60、消费 :742-743） | 照实（随消费方） | 与 subagent/workflow-extractor 同概念域同口径——run 真实执行过，v1 源按文件事实恢复进投影（与 journal tail 增量合并为同一投影源表） | — |
| `services/session/session-file-extraction.ts` | `extractRecordsFromSessionFile` 读取骨架 | 随消费方 | subagent/workflow 照实；plan（U6d）随树——骨架自身不判语义 | — |
| `services/usage/usage-stats-service.ts` | `createReadStream` + readline 逐行扫描 sessions 目录（R3 读者） | 照实 | token 真实消耗过；usage 页照计被撤子树消耗（A14 验收锚） | — |
| `infra/pi/session-file-utils.ts` | `extractSessionName`（侧栏名 fallback） | 照实 + 已知边界 | 名字是已发生事实，残影可接受（见 §7 边界 ②） | U6d（注释登记） |
| `infra/pi/session-file-utils.ts` | `extractSessionOutcome`（JSONL fallback） | 照实 + 已知边界 | 结局为已发生事实（同上） | U6d（注释登记） |
| `infra/pi/session-file-utils.ts` | `scanSessionMeta` / `scanPiSessions`（侧栏扫描汇总） | 照实 + 已知边界 | 侧栏元信息汇总按文件事实（同上） | U6d（注释登记） |

### 4.4 领地外照实/非投影族（§6 新发现）

| 模块 | 读取点 | 归类建议 | 判定理由 |
|------|--------|----------|----------|
| `services/session/trace-sync.ts` | trace 台账读取（RPC 权威 + `parseSessionHeader`/文件补读，`parseSessionTraceJsonl` 解析） | 照实 | trace / system-prompt 留痕 = 审计台账 |
| `services/session/session-fork.ts` | 读源 JSONL 按 entryId 树回溯截断（`parseJsonl`） | 照实 + 已知边界 | fork = 用户显式选历史点复制（见 §7 边界 ③） |
| `services/session/subagent-engine-history.ts` + `session-records.ts` `getSubagentHistory` | `record.sessionFile` 直读（非 pi 引擎历史三级降级链） | 照实 | subagent 会话历史已发生；subagent session 文件独立于主 session 树 |
| `services/session/btw-service.ts` + `btw-fork-exec.ts` | btw 线目录扫描（`readdirSync` + `readSessionHeader`） | 照实 | btw 旁路对话记录 = 独立文件、已发生事实 |
| `services/session/restore-seeding.ts` + `infra/pi/session-file-streaming.ts` | 归一化管线（session_end 识别 / cwd 修复，分块正序逐行变换原子替换） | 非投影读者 | 逐行透传格式修复，不派生投影、不丢行 |
| `services/session/import-source-external-file.ts` / `import-source-zcode.ts` / `import-service.ts` + `infra/pi/session-file-external-scan.ts` | 外部 session 导入扫描（`scanPiSessions` 去重双检 / `scanExternalSessions` 轻量提取） | 照实（非投影） | 读外部目录非活跃 session；导入 = 复制事实，撤回机制不触及 |

### 4.5 消费面委托（锚点命中、自身不读文件）

`infra/pi/session-store.ts`（session-file-utils 聚合 port）、`services/session/session-internal.ts` / `session-service.ts` / `session-lifecycle.ts` / `session-scanner.ts` / `session-model-control.ts` / `event-interpreter.ts` / `import-*` 编排、`services/session-history.ts` 之外的 `session-entry-mapper` re-export 链、`transport/session-message-handler.ts`、`services/preset-service.ts`、`services/ports/session.ts`、`interfaces.ts` / `types.ts` / `index.ts`、`utils/history-reverse-read.ts`（共享工具，随消费方归类）、`session-binding-fields.ts` / `session-binding-sidecar-io.ts`（sidecar 读写，非 jsonl 读者）、`session-residue-cleanup.ts` / `session-scan-degraded.ts`（扫描辅助）、`services/session/workflow-step-merge.ts`（纯函数合并模块——头部注释提及 `extractWorkflowsFromSessionFile` 致 R2 锚点命中，自身不读文件，输入为内存投影数组）、`utils/jsonl.ts`（jsonl 解析原语，§1 普查通道本体——R2 命中为注释提及 `extractSessionName`）——读取语义全部落在上表已登记的实现模块。

## 5. 非文件读者（session_tree 事件消费者，知悉登记）

| 包 | 消费点 | 说明 |
|----|--------|------|
| permission | `index.ts` `pi.on("session_tree")` → statusline/footer 重绘 | 重绘时读新分支 config，不读 session 文件 |
| subagent-workflow | `session_tree` → `terminateRunningRuns` | 撤回编排以 workflow-running 前置检查阻止该副作用触发（撤回遇活跃 run 不放行） |
| scheduler（extensions/universal） | `backend.ts` `pi.on("session_tree")` → 重折叠任务集 | 纯重建体（loadTasks 换 Map），零 dispatch 零 append；被撤任务到点不触发（A14） |

**runtime 侧插件读者（readEntries 通道，非 session_tree）**：`resources/plugins/scheduler-manager`——per-session 任务镜像（累计 task op 折叠 + sinceEntryId 增量），随树语义经两通道兑现：①runtime readEntries 投影点活跃路径过滤（§4.1 末行，被撤 op 构造性不达插件）；②撤回信号 `'taiji:revoked'`（revoke-orchestrator 失效点广播 → pluginService.notifyEntryInvalidation）驱动插件丢弃累计镜像全量重建（U7）。插件不能 import runtime/extensions 包，filterActivePath 语义在插件消费面由 runtime 投影层代偿——同构实现的有意分层，非漏接。

`session_tree` / `session_before_tree` 不经 RPC 事件流（extension 进程内专属）；runtime 侧完成确认走 reply + get_entries 校验（该读者归类登记见 §6 N13）。

## 6. 设计判定清单之外的新发现读者（已裁决）

以下读者由机器锚点命中、不在 message-revoke 设计 §5 U6 的逐项判定清单内。裁决（2026-09-24 流水线主 agent，依据 = G2 二分准则「未来状态随树 / 已发生事实照实」+ 注入面判定）：**N1-N12 全部维持照实 / 非投影归类，零追加单元**——run / 通知 / bash 执行 / 压缩计数 / trace / fork / btw / 导入均为已发生事实（重建即伪造事实），无一注入模型上下文。附核实项：smart-context 压缩组装的文件重注入（compact-handler `readFileForReinject`）读的是项目源码文件而非 session 数据、且输入 branchEntries 来自活跃路径——撤回后新压缩输入天然不含被撤内容，与撤回零冲突。N13/N14 为分支审查补登（2026-10-01，理由见行内）：两者读取走 getEntries RPC 通道，不在 runtime 侧锚点命令族（E1/R1/R2/R3 重跑均不命中）——登记缺口不被机器锚点拦截，按 C-proc-28 登记义务归类；§2 已补 R4 检索锚（runtime 侧 client.getEntries 通道），该通道后续读者可被检索、不再漏网。

| # | 读者 | 归类（已裁决） | 判定理由 |
|---|------|----------|------|
| N1 | subagent-workflow `jsonl-run-store.loadAll` | 照实 | 与 runtime workflow-extractor 同概念域，直接归入既有豁免口径 |
| N2 | subagent-workflow notify ledger 恢复 | 照实 | 通知账本对账幂等依赖全量事实 |
| N3 | pending-notifications 每 turn 全量扫描 | 照实 | 后台任务活跃性事实；与撤回编排 workflow-running 检查互斥不冲突 |
| N4 | base-tool-enhance `reconcilePendingEntries` | 照实 | bash 后台 pending 对账事实 |
| N5 | rename-session 起名输入（`countUserMessages` / `extractUserPromptText`） | 照实 | 历史事实分析；残影可接受（见 §7 边界 1） |
| N6 | smart-context `countCompactions` | 照实 | 压缩已发生、消耗已产生（usage 同口径） |
| N7 | runtime `trace-sync` | 照实 | 审计台账 |
| N8 | runtime `session-fork` 截断复制 | 照实 + 边界 ③ | 用户显式选点复制 |
| N9 | runtime `subagent-engine-history` / `getSubagentHistory` | 照实 | subagent 独立文件不随主树 |
| N10 | runtime `btw-service` / `btw-fork-exec` | 照实 | 独立旁路文件 |
| N11 | runtime `restore-seeding` + `session-file-streaming` | 非投影 | 逐行透传无投影可裁（文件维护管线，裁剪反而丢数据） |
| N12 | runtime 导入族（import-source / external-scan） | 照实（非投影） | 外部目录，撤回机制不触及 |
| N13 | runtime `revoke-orchestrator` `readTreeSnapshot`（get_entries 快照——③ 定位 / ⑤ 信令前校验共用一次拉取，⑥ 回退后校验复用同款读点；非投影构建） | 照实 | 树回退定位与活跃路径校验读者，非投影构建：校验对象是树回退定位所需的活跃路径状态（与 §4.1 U6a 重建链同语义域），但读 get_entries 全文件快照、不派生展示投影、不注入模型上下文——⑤ 幂等判定「目标不在活跃路径但全文件存在 → 已撤」正需全文件事实，按活跃路径裁剪反而使读者失效。归类照实（已发生文件事实），零追加单元；机制裁决见 ADR-0076（decisions.md:295「完成确认 = reply 后 get_entries 校验」） |
| N14 | runtime `session-delivery-registry` `readTranscriptUserTexts`（getEntries 全文读，`resync/rebuild/在途宽限扫描` 三调用点共用读点——判 delivered / 判重；非投影构建） | 照实 | 投递对账读者，判据 = 「投递已发生」事实：user 文本集合按裸标记扫描，命中 transcript → 判 delivered 抑制重建/重投（被撤条目已进文件恒判 delivered，不重建重投、无复活破坏）；未命中才重投（必达优先于去重，读取失败保守判未送达）。读 getEntries 全文件 user 文本、不派生展示投影、不注入模型上下文。与 N13 同走 getEntries RPC 通道（E1/R1-R3 锚点族外，2026-10-01 分支审查补登，按 C-proc-28 登记义务归类；通道检索锚 = §2 R4） | — |

## 7. 已知边界登记

1. **rename-session 起名视野**：撤回后被撤消息仍进入起名输入（照实口径）；起名为低频后台任务，输出是展示性标签，残影可接受。
2. **侧栏元信息残影**：session 名 / outcome / scanMeta 汇总按文件事实提取，撤回不回滚（被撤子树若含 rename / session_end 侧影，侧栏照实显示）。
3. **fork 源指向被撤分支**：fork 入口从活跃路径（对话流 UI）选择时被撤消息不可见、不可选；按 entryId 直接调 fork 指向被撤分支 entry 时照实复制（append-only 审计面同口径）。
4. **32MB oversize 降级**（撤回密集 session）：字段提取器族走 oversize 空态或逆序分块尾窗；对话流历史链 = 双预算窗口 + truncated 标记——撤回的可见代价 = 对话流可翻阅深度更早触顶（G2 已接受代价，恢复通道 = 删除会话或手动挪出 sessions 目录）。
