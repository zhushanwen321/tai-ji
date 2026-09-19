# Session Import Sources：多 coding-agent 会话导入架构与扩展指南

> **定位**：session 导入统一入口的架构 SSOT + 新增导入源的操作指南。目标读者：要为一个新的 coding-agent（如 Claude Code / Codex / …）接入「导入会话」功能的开发者。读完本文即可动手，不需要先通读实现源码。
>
> 来源设计：`.tmp/tech-design/session-import-unified.md`（tech-design 过程产物，4 轮对抗审查收敛；实施后本文件与实现代码为现行权威，设计文档过期即弃）。

## 1. 一句话架构

**所有导入源（coding-agent）统一转换为合法 pi session JSONL，落太极 sessions 目录（`<dataDir>/agent/sessions/<encodeCwd(cwd)>/`），此后完全复用太极现有会话消费链**——列表扫描、对话流渲染、续聊（pi 引擎附着文件继续 append）、搜索、project sidecar、rename、fork、fresh 徽标，全部零改动继承。

```
┌─ renderer ──────────────────────────────────────────────────────┐
│ ImportSessionDialog（两阶段视图：①来源选择 ②候选列表，界面两源同构）│
└──────────────┬───────────────────────────────────────────────────┘
               │ WS: session.importCandidates / session.import（带 source 字段）
┌─ runtime ────▼───────────────────────────────────────────────────┐
│ session-message-handler（payload 整体透传，对源零分支）──►        │
│ ImportService（公共编排层，源无关；内持 source 注册表，           │
│               按 request.source 分发，缺省 'pi'）                 │
│                                          ├─ ExternalFileImportSource（pi）│
│                                          └─ ZcodeImportSource    │
│                    （SessionImportSource SPI，见 §3）               │
│   互斥链 → prepareImport → 去重双检 → tmp+rename 落盘 →            │
│   sidecar → tombstone 摘碑 → 缓存失效 → reply                     │
│   （reply 帧与导入完成广播由 handler 层承担，广播在 reply 后）    │
└───────────────────────────────────────────────────────────────────┘
```

**分层原则**：源特有知识（去哪找会话、怎么读、怎么转 pi 格式）全部在 source 实现内；源无关流程（原子落盘/去重/sidecar）收在编排层单点，导入完成广播由 handler 层在 reply 后发出。新增一个源 = 新增一个 source 模块 + 注册一行 + GUI 加一个选项卡，编排层不动。

## 2. 关键背景概念

| 概念 | 定义 |
|------|------|
| **pi session JSONL** | pi 引擎的会话持久化格式（= 太极会话的通用格式）：首行 header `{type:'session',version:3,id,timestamp(ISO),cwd}`，其后每行一个 entry `{type,id,parentId,timestamp,message\|...}`。append-only。类型权威：`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` |
| **导入源（ImportSource）** | 一个 coding-agent 的会话读取+转换实现，实现 §3 的 SPI。现役：`pi`（外部 pi JSONL 原样复制）、`zcode`（宿主 sqlite 库 → pi JSONL 转换） |
| **幂等键** | 目标产物的 `header.id`。同一源会话二次导入 → `import_already_imported` 拒绝。编排层用它对 `scanPiSessions()` 全量扫描集判重 |
| **文件名不变量** | **session 文件名剥 `.jsonl` 后，最后一个 `_` 之后的尾段 === header.id**。全仓 4 处消费点依赖它（image-cache 孤儿判定/删除级联、session-reader 文件名提取、parent-session 兜底匹配、短名展示，均先剥扩展名再 `lastIndexOf('_')`）。**源 id 含 `_` 时必须先归一化**（见 §5-I2） |

## 3. SessionImportSource SPI 契约

定义位置：`packages/runtime/src/services/session/import-source.ts`。

```ts
export interface ImportArtifact {
  /** 目标 pi header —— id 即幂等键；cwd 决定落地子目录（encodeCwd(cwd)） */
  header: { id: string; timestamp: string; cwd: string }
  /** 目标文件名，必须满足：剥 .jsonl 后尾段 === header.id（§5-I2） */
  fileName: string
  /** 把产物写到 tmpPath。编排层负责 mkdir/校验/rename/失败清理——源只管产出内容 */
  write(tmpPath: string): Promise<void>
  /** 保真度降级明细（如「artifact 丢弃 ×2」）。非空 → reply 带 warning conversion_degraded */
  degradations: string[]
}

export interface SessionImportSource {
  readonly kind: ImportSourceKind
  /** 候选列表。reply 结构统一（ImportCandidatesReply）；query 匹配字段集是源行为（契约注释声明） */
  listCandidates(request: ImportCandidatesRequest): Promise<ImportCandidatesReply>
  /** 校验源可达 + 产出落地产物。不做去重判定（那是编排层职责） */
  prepareImport(request: ImportRequest): Promise<ImportArtifact>
}
```

**源的义务 / 编排层的义务边界**：

| 源负责 | 编排层负责（源不要自己做） |
|--------|--------------------------|
| 定位源数据（目录/数据库/…） | 全局单条导入互斥（Promise 链） |
| 候选列表 + query 匹配 + alreadyImported 打标 | header.id 去重双检（force 扫描集 + target 路径） |
| 校验源会话合法（自己的格式规则） | projectId 存在性校验 |
| 转换为合法 pi JSONL（§5 不变量） | mkdir + tmp 写入 + rename 原子落盘 + 失败清理 |
| 归一化幂等键（§5-I2） | project sidecar 写入 + readback |
| 降级明细收集（degradations） | tombstone 摘碑 / 扫描缓存失效 / reply 结果组装（reply 帧发送与广播归 handler 层） |

**RPC 契约**（`packages/shared/src/import-session.ts`）：`ImportCandidatesRequest.source?` / `ImportRequest.source?`（缺省 `'pi'`，存量调用行为不变）+ `ImportRequest.sessionId?`（zcode 等以 id 定位会话的源必填）+ `dbPath?`（源数据路径注入：缺省动态推导宿主路径；**也是测试 fixture 注入通道**——单测传 fixture 库路径，不覆写 HOME 不 mock import）。

## 4. 新增一个导入源的步骤清单

以新增 `foo` 引擎为例，按依赖顺序：

1. **探明源格式**（前置调研，产出事实清单）：会话存哪（文件/库）、单会话与消息的层级结构、消息内的内容块类型全集（正文/思考/工具调用/工具结果/压缩记录）、时间戳与用量字段。**全部实测核实（读真实数据样本），禁止推断**——zcode 的 part 类型直方图、`state` 内嵌对象形态都是这样探明的（§6 可参考速查表格式）。
2. **契约扩展**（`packages/shared/src/import-session.ts`）：`ImportSourceKind` 联合加 `'foo'`；若源需要新 request 字段（如 `fooPath?`）在此加；错误码**优先复用**现有清单（见 §5-I5），确需新增必须同步登记 ImportErrorCode 联合与 renderer 文案映射。
3. **实现 source 模块**（`packages/runtime/src/services/session/import-foo/`）：
   - `normalize.ts`（若源 id 含 `_` 或其他非法字符）：归一化幂等键 + 后置条件校验（§5-I2 完整规格）。
   - `converter.ts`：**纯函数**（输入源行集，输出 pi JSONL 行流）——不碰 IO，测试可用 fixture 直接喂。
   - `sqlite-access.ts` / `file-access.ts`（按源形态）：只读访问层。sqlite 用 `node:sqlite` 只读 + 动态 import 经变量间接（esbuild CJS 会把字面量 `import("node:sqlite")` 规约成裸名 → ERR_MODULE_NOT_FOUND，参考 `packages/zcode-subagent-cli/src/reader.ts` 的 [HISTORICAL] 注释）。
   - `index.ts`：组装 `SessionImportSource` 实现。
4. **组合根注册**（`packages/runtime/src/index.ts`）：source 表加一项。
5. **GUI**（`ImportSessionDialog.vue` + `useImportSession.ts`）：来源选择视图加一个选项卡（i18n zh/en 同步 `locales/*/importSession.ts`）；阶段二界面零改动（ImportCandidate 两源同构）。若源不支持换根，隐藏「选择其他目录」按钮。
6. **mock 扩展**（`packages/core/src/transport/mock/index.ts`）：foo 分支（VITE_MOCK 开发模式可用）。
7. **测试**（见 §7 测试要求，applyEntry 重放是正确性锚）。
8. **文档同步**：本文 §6 加源速查小节；`docs/CONTEXT.md` 若引入新术语同 commit 登记。

## 5. 必须遵守的不变量（防错核心）

| # | 不变量 | 违反后果 |
|---|--------|---------|
| I1 | **产物必须是合法 pi session**：首行 header（version=3）、entry 链 parentId 连续、message 形态可被 `replayEntries(applyEntry)`（`packages/core/src/domain/chat/apply-entry.ts`）无错重放。**可证伪定义：applyEntry 重放断言是产物合法性的机器锚**（§7） | 打开会话渲染异常 / pi 拒绝附着续聊 |
| I2 | **幂等键归一化**：`header.id` 与文件名尾段（剥 `.jsonl` 后 `lastIndexOf('_')+1` 起）必须相等且不含 `_`、非空、字符集 `字母数字/-` 首尾字母数字。zcode 归一化函数规格：①`sess_` 前缀剥**一次** ②对结果串全部 `_`→`-` ③后置条件校验，不满足 → `import_invalid_session` fail-fast（防源 id 形态漂移静默破不变量）。归一化函数**单点落源模块内**，候选打标与转换两处 import 同源 | 4 处 `lastIndexOf('_')` 消费点派生出错误 id：图片缓存误判孤儿（30 天误清）/删除级联 no-op 残留/session-reader 给 agent 建议不存在的 id |
| I3 | **toolCall↔toolResult 配对完整**：assistant content 里的每个 toolCall part，其后必须有同 `toolCallId` 的 toolResult message entry。无结果的进行中工具调用**整对丢弃**并记 degradations（dangling toolCall 会破坏续聊时 pi 发给 LLM 的请求形态） | 续聊首请求可能被 API 拒绝 |
| I4 | **工具名小写映射**：taiji 渲染判定层按全小写匹配工具名（`packages/ui/src/features/chat/block-icon.ts` 的 TOOL_ICON_MAP；`packages/core/src/domain/chat/apply-entry-convert.ts` 的 EDIT/WRITE_TOOL_NAMES）。源侧首字母大写名（zcode `Edit`/`Bash`）必须硬映射到小写；**未映射名保底原样输出**（走通用工具块渲染，不计降级） | edit/write 的 diff 卡片与文件变更列表失效、图标退化为通用 |
| I5 | **错误码复用优先**：现有清单（`import_source_missing/invalid_session/marker_filename/dir_unreadable/already_imported/target_conflict/copy_failed/project_invalid`）覆盖「源缺失/会话无效/不可读/重复/写失败」语义时不得新增；错误信息必须携带恢复指引所需的上下文（如 schema 版本）。知情降级走 `ImportReply.warning: 'conversion_degraded'` 通道，不走 error | 错误码膨胀、renderer 文案映射失同步 |
| I6 | **只读源数据**：对源系统（zcode 宿主库等）严格只读连接（sqlite `readOnly: true`；WAL 模式下只读不阻塞源运行）。taiji 自有写入只落在 sessions 目录与 sidecar | 破坏宿主 coding-agent 运行 |
| I7 | **无法保真的内容显式降级**：源有而 pi 格式无对应的内容（二进制 artifact 引用、UI 事件等）——丢弃 + degradations 登记 + warning，**禁止伪造**（如为无摘要文本的源压缩记录伪造 pi compaction summary 会污染 LLM 上下文） | 导入产物携带伪造内容误导续聊 |

## 6. zcode 源格式速查（探明事实沉淀）

存储：单 SQLite 库（WAL），宿主路径由 `ZCODE_HOST_DB_SUFFIX` 常量推导（`~/.zcode/cli/db/db.sqlite` 形态）；schema 版本看 `schema_migration` 表（探明时点 0.16.5，24 表）。三级表：

```
session(id sess_<uuid>, directory, title NOT NULL, task_type, time_created/time_updated ms, ...)
  └─< message(id, session_id, sequence 全序, data JSON)
        └─< part(id, message_id, session_id, sequence 消息内局部序, data JSON)
```

- `message.data`：`role`（user/assistant）+ `time{created,completed}`（ms）+ assistant 侧 `modelId/providerId/finish/tokens/cost`
- `part.data` 按 `type`：`text`/`reasoning`（→pi text/thinking）、`tool`（`{callID, tool, state:{status, input, output, error}}`——**state 是内嵌对象**；error 态 `output` 恒空、错误文本在 `state.error`）、`step-start`/`step-finish`（段边界，finish 带 per-step tokens/cost）、`compaction`（**无摘要文本**，仅元信息 → I7 降级为 custom entry）、`timeline`（UI 事件，丢弃）、`file`（`zcode-artifact://` 引用，丢弃+降级）
- 消息语义：一条 assistant message = 完整多步执行段（多个 step 循环）；转换按 `step-finish` 边界切分为多条 pi assistant entry
- 候选范围：`task_type` 取 `interactive/fork/selection_side_chat`，排除 `subagent_child`（内部子任务噪音）
- 索引齐备：`message_session_sequence_idx`、`part_session_idx`、`session_task_type_idx`——按会话取数、按类型筛会话毫秒级
- 已知坑：①`packages/zcode-subagent-cli/src/reader.ts` 的 `toolFromPart` 兼容 state 双形态——内嵌 JSON 对象为主（0.16.5+ 宿主库全量形态）、旧 JSON 字符串回归兼容、两形态均非法时降级 state=undefined（status 落 `'unknown'`）；新增源的 tool part 解析按此三段优先链处理。②zcode `finish` 有 10 种取值，pi `StopReason` 是封闭枚举——需完备映射表（保底 `stop`，渲染链零消费安全）；③zcode `cost` 是 number，pi `Usage.cost` 是对象（映射到 `cost.total`）

## 7. 测试要求

- **fixture 源数据自建自删**：`mkdtempSync(join(tmpdir(), ...))`（sqlite fixture 建临时库；禁触碰真实宿主库——测试防线纪律见 AGENTS.md 测试节）。`dbPath`/路径参数是注入通道。
- **converter 纯函数直测**：fixture 行集 → 输出行流，断言逐 entry 结构（含 usage/cost 对象形态、工具名映射、error 输出通道）。
- **applyEntry 重放锚**（I1 的机器断言）：产物经 `replayEntries(applyEntry)` 重放无异常、消息序列/toolCall↔toolResult 全配对/usage 聚合符合预期。每个 fixture 会话都跑。
- **不变量断言**（I2）：产物文件名剥 `.jsonl` 后 `lastIndexOf('_')` 尾段 === header.id；归一化函数后置条件边界（空串/含 `_`/非法字符）单独用例。
- **编排层回归**：pi 源现有测试族（import-service / scan-external / session-message-handler-import / dialog）全绿——重构编排层不破坏 pi 行为。
- **真机验收**：按设计文档 §4 场景（V1-V7）由 dev-flow 验收计划承接，开发阶段按改动面执行（`node scripts/select-affected-e2e.mjs --base <ref>` 圈定既有 e2e 子集）。

## 8. 维护

- 本文件与实现同步演进：SPI/不变量变更须同 commit 更新本文与 `docs/CONTEXT.md` 术语。
- 源格式漂移（如 zcode schema 升级）：新探明的事实回填 §6；reader/转换器按结构化错误暴露漂移（`import_invalid_session` + 版本信息），不静默吞。
- 符号删除/改名时跑 `node scripts/check-doc-symbol-drift.mjs`（pre-commit 按 docs/architecture/ 路径触发）。
