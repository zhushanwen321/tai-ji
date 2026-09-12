# session-reader 扩展:支持读取 subagent / workflow 执行记录(含任意深度嵌套)

> 功能分级：P2（依据见 [docs/feature-priorities.md](../../../docs/feature-priorities.md) §6——通知链 session_read 指针解析依赖，挂了通知退化但主链路完整）。
>
> **一句话结论**:扩展 `session_read` 工具,让 LLM 能用现有的渐进式读取流程(outline→expand→detail)直接消费 subagent 对话、workflow 编排记录、以及**任意深度嵌套的执行树**(subagent/workflow 相互嵌套)。核心 gap 是**读取入口未接通**(引擎已通用、jsonl 已同构),分四层补齐——M0 打通入口、M1 富化导航、M2 workflow 概览渲染、M3 嵌套执行树。**pi-subagent-workflow 仅补 2 行**(manifest 落盘时带上运行时已有的 `parentRecordId`,直接父关系本就存在、只是落盘漏了);嵌套建树靠 `parentRecordId` 精确父子链 + workflow 指针递归。不做衍生工具。

---

## 开篇(SCQA)

- **S（情境）**:session-reader 是 pi 的 session 读取工具,提供 `find → outline → expand → detail` 渐进式读取;pi-subagent-workflow 产生的 subagent 对话、workflow 编排记录、以及它们任意深度相互嵌套的执行树,物理上都在 `agentDir` 下,且 subagent 对话 jsonl 与 main 同构。
- **C（冲突）**:但 session-reader 的读取入口(`resolveSessionId` → `findSessions`)只扫 `sessions/` 目录,subagent 对话文件读不进来;workflow 概览无渲染入口;嵌套执行树(sub-subagent、workflow 套 workflow、subagent 套 workflow)更是完全不可见。
- **Q（问题）**:如何让 LLM 用一套统一的渐进式读取流程,快速消费 subagent 对话 + workflow 编排记录 + 任意深度嵌套执行树?
- **A（答案）**:分四层扩展 session-reader 自身——M0 打通读取入口(认 subagent/workflow call session 文件);M1 富化导航(record manifest + find 扩扫);M2 workflow 概览渲染(复用现有发现链路);M3 嵌套执行树(parentRecordId 精确父子链 + workflow 指针递归,pi-subagent-workflow 仅补 2 行 manifest 落盘)。

---

## 1. 背景:被设计的系统是什么

**本章结论**:session-reader 是 pi 的 jsonl session 读取器,本设计聚焦让它能读 pi-subagent-workflow 产生的"非 main"记录,含任意深度嵌套。

session-reader 是一个 pi extension,对外暴露 `session_read` 工具,支持 8 个 action:`find / family / outline / expand / detail / search / export / extract`。它的核心是一条**通用读取引擎**——`parser`(解析 jsonl)→ `tree`(重建 leaf 路径视图)→ `turns`(按 turn 分段)→ `render`(三级渲染)。这条引擎**不区分输入来源**,任何符合 pi jsonl 格式的文件都能喂进去。

pi-subagent-workflow 产生的记录物理上都在 `agentDir`(动态推导,默认 `~/.pi/agent`,xyz-agent 下为 `~/.xyz-agent/pi/agent`)下:

| 记录类型 | 物理路径 | 格式 | 现状 |
|---|---|---|---|
| **subagent 对话** | `<agentDir>/subagents/<encodeCwd>/sessions/<ts>_<selfId>.jsonl` | pi jsonl(与 main 同构) | ❌ 入口未接通 |
| **subagent manifest** | `<agentDir>/subagents/<encodeCwd>/records/sa-<uuid>.json` | 单行 JSON(元数据) | ⚠️ 仅 family 用尾行 identity |
| **workflow 编排快照** | `<agentDir>/sessions/<encodeCwd>/workflow-state/<runId>.jsonl` | 单行 rewrite JSON(RunSnapshot) | ⚠️ family 已读 call 指针,概览无渲染 |

> **encodeCwd**(关键术语)= `"--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--"`。源码 `path-encoding.ts:15`。
>
> **双类编码目录**:subagent 落盘目录存在 ROOT cwd 编码(`--Users-...--`)与 worktree/临时 checkout 编码(`--private-var-folders-...--`)两类并存(本机 98 + 23 个,均含 `sessions/`+`records/`)。**读取必须递归全扫 `subagents/`,不可按单一 mainCwd 定位**(`listSubagentSessions`/`listRecordManifests` 已递归全扫,满足此约束)。

## 2. 设计目标

**本章结论**:从"LLM 作为使用者"的体验倒推四个目标,M3 让嵌套执行树可视化与可深读。

1. **读任意 subagent 对话(含嵌套后代)**:LLM 拿到 subagent 标识(sa-id / sessionFile / 主 session 派生),能用 `outline/expand/detail` 渐进读取。**任意深度嵌套(sub-subagent、孙代)都支持**——M3 用 parentRecordId(运行时已有、补 manifest 落盘)精确建父子链 + workflow 指针递归实现,不关心 pi 的运行时 fork 上限(MAX_FORK_DEPTH=10,解析层递归到数据自然结束)。
2. **读 workflow 编排总览**:LLM 能看到 workflow run 的状态、各 step 的 agent/耗时/结果、预算。
3. **从 workflow step 跳转对话**:LLM 从 workflow 概览的 call 跳到对应 subagent 对话深读。
4. **路径零硬编码**:所有路径从 `agentDir` 动态推导。

**In-scope**:`session_read` 的 action 扩展与数据源接通(subagent 对话 + workflow 概览 + 嵌套执行树 + 导航富化)。
**Out-of-scope**:TUI 可视化;workflow JS 脚本逻辑解析;写入/修改记录;**改变 pi-subagent-workflow 的数据写入**(本设计纯读,M3 用现有数据即可,不改数据层)。

---

## 3. 现状:使用者眼里是什么样的

**本章结论**:LLM 想读 subagent/workflow/嵌套树,卡在三个断点——入口未接通、概览无渲染、嵌套树不可见。

### 3.1 现状的真实样子

`session_read` 当前 8 action:

| action | 现状 | 数据源 |
|---|---|---|
| `find` | 找 session | **只扫 `sessions/`**(find.ts:177) |
| `family` | fork 链 + 直接 subagent + workflow call 指针(已读 RunSnapshot) | 扫 `subagents/` 尾行 identity;workflow 经 `resolveWorkflows`(subagents.ts:392) |
| `outline/expand/detail/search/extract/export` | 渐进读取 | 前置 `resolveSessionId` → `findSessions` → **只扫 `sessions/`** |

> `family` 对 workflow 非零感知:`resolveWorkflows` 已读 RunSnapshot 提取 `calls[].sessionFile`,但**只给指针不渲染概览**,call 对话也因入口阻塞 detail 不了。M2 补渲染。

### 3.2 嵌套的数据基础(关键,M3 依据)

**核实结论(全部实测)**:

| 事实 | 实测证据 | 对方案的意义 |
|---|---|---|
| 父 session jsonl **不记录**子 subagent 标识 | 1411-entry 的 main session,含 `subagents/`/sa-id 的 entry=**0**;249 个 subagent toolCall 的 toolResult 带子标识=**0** | "自顶向下从父 session 文件拉子"**走不通** |
| 新机制 `rootSessionId` = **顶层 main 共享** | 019ff075 树:depth 0/1/2/3/4 共 33 节点的 rootSessionId**全=顶层 main**(session-runner.ts:277 注释"全指向真 ROOT") | 从顶层 main 用 `rootSessionId==mainId` **一次拉整棵树全部后代**(任意深度,扁平) |
| `identity.depth` 表达层级 | depth 分布:0=3451, 1=9, 2=15, 3=16, 4=4(真实存在到 depth=4) | 扁平列表 + depth 即可表达嵌套层级 |
| workflow 链**有真实指针** | RunSnapshot.`calls[].sessionFile` 指向 call session;185/3725 subagent session 含 `workflow-state-link`(嵌套 workflow 实证) | workflow 嵌套自顶向下指针完整,可递归 |
| **旧机制** `rootSessionId` = 直接父(非顶层) | sa-eb767b3f 的 rootSessionId=019fe6a1(是 subagent,非 main);无 depth 字段 | 旧数据语义相反,M3 必须版本探测兼容 |

### 3.3 三个失败模式 + 根因

**A. 读不到 subagent 对话**:`outline(sa-id)` → `findSessions` 只扫 `sessions/` → 抛 F1。
**B. workflow 编排总览看不到**:`family` 只给 call 指针,概览字段(status/budget/trace)无渲染入口。
**C. 嵌套执行树不可见**:`family` 的 `resolveFamily` 只走 fork 链(family.ts:49 chainIds),sub-subagent 的 rootSessionId(新机制=顶层main)虽在 subagentsByRoot 但 family 不递归展开;LLM 无法看到"main → subagent → workflow → call → sub-subagent"的完整派生树。

**根因**:读取引擎通用,但(a)入口焊死 `sessions/` 目录;(b)family 不递归;(c)workflow 概览无渲染。数据层关系完整(rootSessionId + depth + workflow 指针),无需改 pi-subagent-workflow。

> **RunSnapshot**(关键术语)= workflow run 的单行 rewrite JSON 快照(`jsonl-run-store.ts:242 save → :265 writeFile`),字段 `v/runId/spec/state.{status,reason,budget,calls[],trace[],errorLogs[]}/meta`。不是 session jsonl。
>
> **嵌套上限**:pi 运行时 fork 上限 `MAX_FORK_DEPTH=10`(session-context-resolver.ts:38)。**解析层不关心此上限**,递归到数据自然结束(无 rootSessionId 关联的节点=根)。

---

## 4. 终态:使用者眼里将是什么样的

**本章结论**:改造后,LLM 从嵌套执行树概览到任意节点深读一路贯通。

### 4.1 成功路径

**场景 1:从主 session 读 subagent 对话**
```
[LLM] session_read({ action:"family", session:"#019fc731" })
[工具] → subagents: [{ id:"sa-c8c8dfa8", status:"completed", sessionFile:"...", task:"...", depth:0 }]
[LLM] session_read({ action:"outline", session:"019fc77a" })   // M0 入口认 subagent 文件
[工具] → turns: [T000 ... T012]
```

**场景 2:workflow 编排总览(M2)**
```
[LLM] session_read({ action:"workflow", session:"#019fc731", runId:"wf-1786339613616-o5v1i2" })
[工具] → status:done · 13 calls · 1h39m · steps:#0 arch-boundary 7m → session 019fea23 ...
```

**场景 3:任意深度嵌套执行树(M3)**
```
[LLM] session_read({ action:"family", session:"#019ff075", recursive:true })
[工具] → ExecutionTree (33 nodes, depth 0-4):
  main 019ff075
  ├─ [depth0] sa-aaa explorer "recon"           → session 019ff0a1
  ├─ [depth0] workflow wf-X (5 calls)
  │   ├─ call#0 review-arch-boundary            → session 019ff0a3
  │   │   └─ [depth1] sa-bbb worker "fix"       → session 019ff0a5   ← call 内派生 subagent
  │   └─ call#1 review-business-logic           → session 019ff0a4
  │       └─ [depth1] workflow wf-Y (3 calls)   ← call 内嵌套 workflow
  └─ [depth0] sa-ccc researcher "survey"        → session 019ff0a2
[LLM] session_read({ action:"detail", session:"019ff0a5", turns:"T000-T003" })  // 深读任意节点
```

### 4.2 失败路径(带恢复指引)

**subagent record 存在但 sessionFile 缺失**(failed/cancelled)→ isError + manifest 元数据 + 👉 换 completed。
**runId 多匹配** → 返回候选(非抛错)+ 👉 更长片段。
**文件已被 GC** → isError + cleanedUp(family 据 fileStats 缺失推断,manifest 无此字段)+ manifest 元数据 + 👉。
**sa-id 无匹配(可能仍在运行)** → record 是终态元数据(completed/failed 才写),running subagent 无 record → isError:"该 subagent 可能仍在运行(终态 record 未写),用 family 或完整 session uuid 重试。👉 session_read { action:'family' } 看活跃 subagent。"

---

## 5. 关键决策与权衡

**本章结论**:五个决策。前四个解决入口/导航/概览,第五个决定嵌套方案形态(扁平 vs 加字段,选扁平)。

### 5.1 决策一:扩展 vs 衍生工具 → **扩展**(理由同 v2,引擎通用)
### 5.2 决策二:subagent 入口 → **扩 scan 范围 + 加 source 过滤参数**

M0 `findSessions` 合并 `listMainSessions`+`listSubagentSessions`,`resolveSessionId` 接受 sessionId/sa-id/绝对路径。**审查二建议**:`find`/`resolveSessionId` 加 `source: "main"|"subagent"` 过滤参数(M0 就做,不拖后),避免每次深读都全量扫描(本机 subagent record 已 1200+)。

### 5.3 决策三:family 数据源 → **改用 record manifest**(富信息 task/slug/model/status)
### 5.4 决策四:workflow 形态 → **单 workflow action + 合并 trace**(复用 resolveWorkflows 发现链路 + 新增渲染器)

### 5.5 决策五:嵌套执行树的父子关系来源(本版核心)

**核实发现**:直接父关系**运行时早已存在**——subagent-service.ts:716 `const parentRecordId = parentCtx?.recordId;`(注释:"B 内创建 C → C.parentRecordId=B.id, C.depth=B.depth+1"),且 identity 已写入(session-runner.ts:994)。**只是 manifest 落盘漏了**(ManifestRecord 无此字段,finalize-record.ts:144 没带)+ session-reader 没读。本质是补漏,不是新增设计。

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 复用 parentRecordId(补 manifest 落盘 + reader 读取)** | 高:用运行时已有的精确直接父,任意深度精确建树;本质补漏非新增;任意节点子树可切 | 极低:pi-subagent-workflow 2 行(manifest 字段 + finalize 赋值)+ session-reader 读现有字段 | 接近零:纯加可选字段,向后兼容 | ✅ |
| B. 仅 rootSessionId 扁平(不改 pi-subagent-workflow) | 中:顶层全树可拉,但中间节点专属子树永久切不出 | 低:只改 reader | 中:中间节点子树局限永久存在 | ❌ |
| C. 新增 parentSessionId 字段(改 pi-subagent-workflow) | 低:重复造字段(parentRecordId 已有同样信息);需 env 贯穿 | 高:跨 extension + 数据迁移 | 中:概念冗余 | ❌ |

**选 A**:parentRecordId 运行时已有精确值 + identity 已写,补 manifest 落盘(2 行)+ reader 读取即可。成本与 B 几乎相同(都要做 reader 建树),但 A 多得"任意节点精确子树"能力。C 重复造字段,否决。准则 8 减法不适用——这不是"加 clever 机制",是"补上本该有的落盘"。

**parentRecordId 语义**:depth=0 subagent 的 parentRecordId=undefined(父是 main,main 无 record);depth≥1 的 = 直接父 subagent 的 record id。任意节点 B 的子树 = 所有 `parentRecordId==B.id` 的 record(递归)。旧 manifest 无此字段=undefined,reader 兼容(回退 rootSessionId 扁平)。

---

## 6. 实现机制

**本章结论**:四层,渲染引擎(parser/tree/turns/render)全层零改动。

### 6.1 M0 — 打通读取入口

- `find.ts` `findSessions`:合并 `listMainSessions`+`listSubagentSessions` 候选 + `source` 标记/过滤参数。
- `tool-handler.ts` `resolveSessionId`:接受 sessionId / sa-id / 绝对路径;sa-id 反查需 `listRecordManifests`(**从 subagents.ts 导出**,当前 :267 未导出)。
- 错误契约:沿用 F1/F2;新增"文件不存在/GC"(manifest 回退 + 👉)、"sa-id 无匹配/仍在运行"(👉 family)。

> **SubagentRef.fileName(已确认)**:alive=绝对路径(subagents.ts:50 `fileName: meta.path`),cleanedUp 孤儿=空串(family.ts:160 占位)。M0 处理 alive,cleanedUp 走 GC 失败路径。

### 6.2 M1 — 导航富化

- `subagents.ts` `buildFamilyFromFs`:读 record manifest,透 `task/slug/model/status/sessionFile` 到 `SubagentRef`(`family.ts` 接口扩字段);manifest 缺失回退尾行 identity。
- `find.ts`:支持按 task/slug/agentName 匹配 subagent。

### 6.3 M2 — workflow action

- `discovery/workflows.ts`(从 subagents.ts 迁移 `resolveWorkflows` 发现链路)+ `core/workflow.ts`(`parseRunSnapshot` + `renderWorkflowOverview`)。
- `tool-handler.ts` `doWorkflow` + `index.ts` 加 `"workflow"` action。
- 复用 `extractCallSessionFiles`(subagents.ts:302,已兼容 wf-run-v1/OLD callCache)。
  > 勘误(2026-08-17):本文为设计时点快照。现状:pi-subagent-workflow 快照格式已 bump 到 wf-run-v2,session-reader 读取侧(workflows.ts/core/workflow.ts)已兼容 v1||v2,详见 `.changeset/session-reader-wf-run-v2.md`。

### 6.4 M3 — 嵌套执行树(pi-subagent-workflow 仅补 2 行 manifest 落盘)

**目标**:让 LLM 看到任意深度嵌套的完整派生树 + 深读任意节点。

新增 `core/execution-tree.ts`:`buildExecutionTree(rootSessionId, agentDir, mainSessionFile?)` 递归构建:

```
1. subagent 后代:扫所有 record manifest,filter rootSessionId == 给定 root(顶层全树,任意深度)
2. 精确父子链:用 parentRecordId 建父子关系
   - parentRecordId==undefined → 挂顶层 main(depth=0)
   - parentRecordId==B.id → 挂 B 下(B=某 subagent record)
   - 任意节点 B 的子树 = parentRecordId==B.id 的 record(递归,任意深度精确切分)
3. workflow 子树(指针递归):对每个 subagent node 的 sessionFile,读其 workflow-state-link
   → RunSnapshot → calls[].sessionFile(call 作为子 node)
   → 对每个 call session 再读它的 workflow-state-link(嵌套 workflow),递归
4. 返回 ExecutionTree { root: ExecutionTreeNode, totalNodes, maxDepth, truncated, sourceMode }
   (单根对象 + 元数据;ExecutionTreeNode { type, sessionId/runId, sessionFile/stateFile, depth,
   rootSessionId, parentRecordId, children })
```

- **parentRecordId 数据来源优先级**:① manifest 的 parentRecordId(M3a 落盘后);② identity 的 parentRecordId(session 文件未被 GC 时);③ 两者都缺(旧 manifest + 已 GC)→ 回退 rootSessionId 扁平 + depth 启发式。
- `tool-handler.ts`:`family` 加 `recursive: boolean` 参数(默认 false 保持现状;true 返回 ExecutionTree)。**不新增 action**(减法,复用 family)。
- M0 打通后,树里任意节点 id 直接走 `outline/detail` 深读。

**M3a(pi-subagent-workflow 侧,核心 2 行 + lint 合规,前置)**:ManifestRecord 加 `parentRecordId?: string`(manifest-store.ts:7);finalize-record.ts:144 writeManifest 补 `parentRecordId: record.parentRecordId`。另含 `MANIFEST_INDENT_SPACES` 常量重构(no-magic-numbers 合规,功能等价)。identity 已写(session-runner.ts:994),不动。纯加可选字段,向后兼容,无运行时副作用。

### 6.5 探针清单(准则 7)

| ID | 验证行为 | 探针 | 状态 |
|---|---|---|---|
| P-encode | encodeCwd 只替换 `/ \ :` | path-encoding.ts:15 | ✅ |
| P-dualdir | 双类编码目录递归全扫覆盖 | 98 ROOT + 23 worktree 实测 | ✅ |
| P-samefmt | subagent jsonl 与 main 同构,parser 通用 | parser.ts:157 接受任意路径 | ✅ |
| P-gap1 | resolveSessionId 只扫 sessions/ | find.ts:177 | ✅ |
| P-wfptr | family 已读 RunSnapshot calls 指针 | subagents.ts:125/392/302 | ✅ |
| P-sessionfile | record.sessionFile completed≈95% 有 | 1153/1204 实测 | ✅ |
| P-snapshot | RunSnapshot 单行 rewrite | jsonl-run-store.ts:242/265 | ✅ |
| P-wfreuse | workflow call 复用 subagent session | subprocess-agent-runner.ts:109 | ✅ |
| P-filename | alive SubagentRef.fileName=绝对路径 | subagents.ts:50 | ✅ |
| P-rootid-new | 新机制 rootSessionId=顶层main共享 | 019ff075 树 depth0-4 全=顶层 | ✅ |
| P-rootid-old | 旧机制 rootSessionId=直接父 | sa-eb767b3f root=019fe6a1(subagent) | ✅ |
| P-nosubptr | 父 session jsonl 不记录子标识 | 1411-entry session 含子标识 entry=0 | ✅ |
| P-wfnest | workflow 可在 subagent 内嵌套 | 185/3725 subagent session 含 workflow-state-link | ✅ |
| P-parentid | parentRecordId 运行时已有(identity 已写) | session-runner.ts:994 写入;subagent-service.ts:716 赋值;manifest 落盘漏(manifest-store.ts 无字段) | ✅ |
| P-concurrent | RunSnapshot 读撞 rewrite 中点不崩 | 读 <runId>.jsonl 撞写入,验 parser lastLinePartial | ⛔ M2 |
| P-oldcompat | 旧机制版本探测逐级拉正确 | 取旧 record(depth 缺失)建树,对比新机制 | ⛔ M3 |
| P-fallback | manifest 缺失回退尾行 identity | 旧扁平 records 无 sessionFile | ⛔ M1 |

---

## 7. 验收(真实场景,非单测非 mock)

**本章结论**:用真实场景验证四层 + 嵌套边界(双目录、任意深度、相互嵌套、旧机制)。

| 场景 | 回溯目标 | 真实流程/数据 | 通过标准 |
|---|---|---|---|
| **1. subagent 对话(ROOT 编码)** | 1 | completed subagent → outline → detail | 不报 F1,读出真实对话 |
| **1b. worktree 编码边界** | 1 | `--private-var-folders-...--` 目录下 subagent(本机 23 个) | 递归扫描覆盖,读取成功 |
| **1c. 嵌套后代深读** | 1 | 取 depth>=2 的 subagent,直接 outline(已知 session id) | M0 入口读任意深度节点成功 |
| **2. workflow 概览 + call 跳转** | 2/3 | family→workflow→detail call | 概览含 status/steps;detail 读 call 对话 |
| **3. 嵌套执行树(M3)** | 1(全树) | `family recursive:true` 一个有多层后代的 main(如 019ff075,depth 0-4) | 返回含 subagent + workflow call + 嵌套 workflow 的完整树;depth 正确 |
| **3b. 相互嵌套** | 1 | 取一个 call session 内派生了 subagent 或 workflow 的树 | 树里正确呈现 call→subagent / call→workflow 嵌套 |
| **3c. 旧机制兼容** | 1 | 取旧 record(无 depth,rootSessionId=直接父)建树 | 版本探测生效,逐级拉正确(不把直接父当顶层) |
| **4. 失败路径** | 1 | failed subagent / 模糊 runId / GC 文件 / running sa-id | 各返回带 👉 的错误/候选 |
| **5. 路径动态推导** | 4 | dev 数据目录 `~/.xyz-agent-dev/pi/agent` | 无硬编码 `~/.pi` |
| **6. find 性能** | 1 | find 加 source 过滤,对比全扫 vs 过滤延迟 | source 参数收窄生效,延迟可控 |

> 单测仅回归辅助。验收前确保本机有:completed subagent(ROOT+worktree 各一)+ workflow run + 多层嵌套树(019ff075 系)+ sub-subagent + 旧机制 record。

---

## 8. 实施

| 阶段 | 内容 | 交付 | 验收 |
|---|---|---|---|
| **M0** | 打通入口 + 导出 listRecordManifests + source 过滤 + 错误契约 | 场景 1/1b/1c/4/5/6 | |
| **M1** | family record manifest 富化 + find task/slug 匹配 | 场景(选得准) | |
| **M2** | 复用 resolveWorkflows + workflow 渲染 action | 场景 2 | |
| **M3a** | pi-subagent-workflow: manifest-store 加 `parentRecordId?` + finalize 补赋值(2 行) | 精确父子关系落盘(GC 后可重建) |
| **M3b** | session-reader: buildExecutionTree(parentRecordId 精确链 + workflow 指针递归) + family recursive | 场景 3/3b/3c |

M0 解锁后续。M1/M2/M3 可并行或按需。**M3 不依赖改 pi-subagent-workflow**,纯 session-reader 侧。

---

## 9. 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| U1 | findSessions 合并候选 + source 过滤 | M0 入口 |
| U2 | resolveSessionId 多形态(sessionId/sa-id/路径) | M0 核心 |
| U3 | 错误契约(GC/running sa-id) | M0 体验 |
| U4 | SubagentRef 富化 + manifest 读取 | M1 |
| U5 | find task/slug 匹配 | M1,依赖 U1 |
| U6 | workflow action(迁移 resolveWorkflows + 渲染) | M2 |
| **U7** | `core/execution-tree.ts` buildExecutionTree(扁平 rootSessionId + workflow 指针递归) | M3 核心,纯读不改数据层 |
| **U8** | family `recursive` 参数 + 旧机制版本探测 | M3 接口 + 兼容 |

### 文件改动地图

```
extensions/session-reader/src/
├── discovery/
│   ├── roots.ts          (现成:listMainSessions/listSubagentSessions)
│   ├── find.ts           [改 U1/U5] 合并候选 + source 过滤 + task/slug 匹配
│   ├── subagents.ts      [改 U4 + 导出] manifest 读取 + 导出 listRecordManifests
│   └── workflows.ts      [新 U6] 迁移 resolveWorkflows 发现链路
├── core/
│   ├── family.ts         [改 U4/U8] SubagentRef 扩字段 + recursive 支持
│   ├── workflow.ts       [新 U6] parseRunSnapshot + renderWorkflowOverview
│   ├── execution-tree.ts [新 U7] buildExecutionTree 递归 + 版本探测
│   └── (parser/tree/turns/render 不动)
├── tool-handler.ts       [改 U2/U3/U6/U8] resolveSessionId + doWorkflow + family recursive
└── index.ts              [改 U6/U8] workflow action + family.recursive schema
extensions/subagent-workflow/src/   [M3a 补 2 行,前置]
├── manifest-store.ts     [改] ManifestRecord 加 `parentRecordId?: string`
└── finalize-record.ts    [改] writeManifest 补 `parentRecordId: record.parentRecordId`
   (identity 已写 session-runner.ts:994,不动;运行时 parentRecordId 已有,不动)
```

---

## 10. 待验证检查点

- **P-concurrent**:RunSnapshot 读撞 rewrite 中点(parser lastLinePartial 能否处理半行 JSON),M2 实施期验证。
- **P-oldcompat**:旧机制版本探测,取真实旧 record(depth 缺失)建树对比,M3 实施期验证。
- **P-fallback**:旧扁平 records 无 sessionFile,M1 回退尾行 identity 验证。
- **RunSnapshot budget 子字段**:M2 实施时从真实快照确认 token 维度字段。
- **agentDir 注入**:确认 xyz-agent runtime 调 session_read 传入 agentDir 正确指向 `~/.xyz-agent/pi/agent`。
- **中间节点子树(M3 已解决)**:复用 parentRecordId(M3a 补 manifest 落盘),任意节点子树可精确切分(递归 parentRecordId)。旧 manifest 无 parentRecordId 时回退 rootSessionId 扁平(无法切中间节点,但顶层全树可用)。

---

## 附录:术语速查

| 术语 | 定义 | 位置 |
|---|---|---|
| agentDir | pi agent 数据根目录,路径推导基准 | 调用方注入,默认 `~/.pi/agent` |
| encodeCwd | cwd→目录段编码 | path-encoding.ts:15 |
| 双类编码目录 | ROOT cwd + worktree checkout 两类并存,读取递归全扫 | 本机 98+23 |
| main session | 用户主对话 | `<agentDir>/sessions/<enc>/` |
| subagent session | subagent 对话,与 main 同构 | `<agentDir>/subagents/<enc>/sessions/` |
| record manifest | subagent 终态元数据(含 sessionFile);无 cleanedUp(由 family 推断) | `records/sa-<uuid>.json` |
| RunSnapshot | workflow 单行 rewrite 编排快照 | `workflow-state/<runId>.jsonl` |
| rootSessionId(新) | 顶层 main,全树共享 | session-runner.ts:277 |
| rootSessionId(旧) | 直接父(发起方) | 历史数据 |
| depth | 嵌套层级(0=顶层) | identity.data.depth |
| 嵌套上限 | MAX_FORK_DEPTH=10(运行时);解析层不关心 | session-context-resolver.ts:38 |

## 附录:变更历史

- v1:初稿(五段骨架 + 四决策 + M0/M1/M2)。
- v2:tech-design-review 修复(workflow 现状失真、encodeCwd 双目录、嵌套 family 局限声明、行号、验收边界)。
- v3:加入任意深度嵌套支持(M3)。经数据核实确认父 session jsonl 不记录子标识、record rootSessionId(新机制=顶层main)+ workflow 指针足够递归重建全树。纳入审查二 5 点。声明中间节点子树为已知局限。
- v4:经源码核实升级 M3 方案——发现 `parentRecordId`(直接父)**运行时早已存在**(subagent-service.ts:716)、identity 已写(session-runner.ts:994),**只是 manifest 落盘漏了**。故决策五从"rootSessionId 扁平"升级为"复用 parentRecordId 精确建树":pi-subagent-workflow 仅补 2 行(manifest 字段 + finalize 赋值),session-reader 读现有字段建精确父子链,任意节点子树可切。中间节点子树从"已知局限"变为"已解决"。这不是加 clever 机制,是补上本该有的落盘。
- v5:review-fix-loop 对抗式审查(代码 vs 文档一致性)。修复 2 个 major:MF-1(workflow-call session 双重挂载,parentRecordId 链与 workflow 指针两套去重集合键空间不同 → 跨集合去重)、MF-2(buildExecutionTree 支持 subagent root 切子树,§5.5 兑现)。处理 suggestion:S-4 删 resolveParentRecordId 的 identityPresent 死代码;S-1/S-3/S-5 文档对齐(workflow 场景补 session 参数、M3a 注明含 MANIFEST_INDENT_SPACES lint 重构、返回类型 ExecutionNode[]→ExecutionTree 单根对象)。S-2/S-6 经核实为 reviewer 误报(v4 文档无 identity.depth 版本探测表述 / workflow.test.ts 已有半截 JSON 测试 TC-w5-read-tail-fallback)。
- v6:修复引擎 leafId 选取 bug(tree.ts buildTreeView)。M0 打通 subagent 入口后暴露:subagent session 尾行是 pi 写的 subagent-identity custom entry(顶层无 id、parentId=null),旧逻辑 leafId=文件尾 entry 导致 leafPath 第一步断链、对话内容全丢(outline 返 1 turn 1 entry)。修复:leafId 改为末尾往前第一个 parentId!==null 的 entry(跳过尾部元数据 custom),全空 session fallback entries[0]。subagent session 的 outline/expand/detail/search/export 现可正确读取完整对话(实测 71-entry session:leafPath 1→69、turns 1→2);workflow step 深读(calls 指向 subagent session)一并修复。main session 尾行是 message(parentId 非空)→ leafId 不变,零回归。
