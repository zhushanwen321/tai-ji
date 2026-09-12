# subagent-core 能力收口 · xyz-agent 侧施工设计（W1-W5）

**一句话结论**：把散落在 pi-sw 插件层的「平台无关共享面」——10 个内置 agent 模板、注入渲染纯函数、workflow 脚本创作管线——收口进 `@zhushanwen/subagent-core`（下称 core），并补齐 core 发现链的三个既有缺口（realpath 去重、project host 槽、同标签多根语义），使 zsw（zcode 侧插件，另一仓施工）能以 vendored 副本消费同一能力面；pi-sw 自身改为消费 core 新面，行为保持向后兼容（注入快照除内置角色 location 前缀外逐字节等价）。

**层声明**：当前层 = 本仓（xyz-agent）五个实施单元的落位设计（接口/资产/行为变更层）；下一层 = W1-W5 实施单元（本文 §5，可直接进 dev-flow 派发）。不跨层到函数级实现。

**决策权威源声明**：六项收口决策（D-1~D-6）已在上游设计定稿——`zcode-plugin-workspace/feat-app-server-refactor/docs/design/subagent-core-convergence-design.md`（四轮对抗审查收敛至 0 must-fix，2026-08-30）。**本文档不重新决策**，职责是把已定决策落位到本仓代码现实（§2 全部 file:line 证据取自本仓 HEAD 并逐一核实）、给出本仓的验收场景与单元拆分。读者无需回读上游文档即可施工；决策谱系与被否方案见附录 A。

**状态**：Approved（本仓文档两轮对抗审查收敛：R1 4 MF/4 S/1 DE 全修 → R2 复审 4 MF 全部成立 + 0 MF，余 3 S/1 DE（修订同步残留）当轮修完，终态 0 must-fix / 0 遗留。审查记录见 subagent-core-convergence.review.md（已删除，git 可追溯））

---

## 1 背景目标

### 1.1 SCQA

- **S（情境）**：xyz-agent 仓维护着一套双宿主编排体系——pi 侧插件 `@zhushanwen/pi-subagent-workflow`（下称 **pi-sw**，`extensions/universal/subagent-workflow/`）与共享内核 core（`packages/subagent-core/`）。zcode 侧插件 zsw（另一仓）自 2026-08 起以构建期 vendored 副本（`lib/vendor/subagent-core/`，sha256 校验）消费 core。workflow 引擎、脚本契约、5 个内置 workflow 资产已同源。
- **C（冲突）**：「该两侧共用的能力」从未显式划入 core 收口边界——10 个内置 agent 模板、注入渲染纯函数、脚本创作校验管线留在 pi-sw 插件层；core 发现链存在三个缺口（无 realpath 去重、无 project host 槽、hostRoots 同标签单目录覆盖）。结果：zcode 用户零内置角色可用（zsw 被迫自写发现与渲染，双实现漂移），pi 侧渲染函数对字段缺席直接抛错。
- **Q（问题）**：本仓要下沉哪些面、补哪些缺口，才能让两插件消费同一能力面且 pi 侧行为不回退？
- **A（答案）**：五单元收口——W1 资产迁移（去 tools 化）、W2 发现链扩面、W3 渲染下沉（含守卫与参数化）、W4 创作管线下沉（目录参数化）、W5 pi-sw 改接。判据与决策见 §3。

### 1.2 系统是什么（受众认知补足）

core 是「平台无关的 subagent 执行与 workflow 编排内核」，双形态 npm 包（workspace 内 TS 源直引 / npm dist ESM+CJS），现版本 0.2.0，另有待发布的 0.3.0 changeset（host-surface 扩面，`88d7eadc6`）。两个插件宿主的差异（本设计必须尊重的约束，节选自上游设计 §1.2）：

| 差异点 | pi 宿主（本仓 pi-sw） | zcode 宿主（zsw，另一仓） |
|---|---|---|
| 插件形态 | 进程内 extension API | MCP server（stdio）+ hook |
| 注入时机 | 每 turn `before_agent_start` 链式叠加 | 仅 SessionStart hook 一次性 |
| 模型数据源 | `ctx.modelRegistry`（内存快照） | `~/.zcode/v2/config.json`（每次重读） |
| 工具白名单 flag | `--tools a,b,c` allowlist 存在 | 无 allowlist 通道，仅 denylist |
| agent 参数缺省 | 加载 `general-purpose` 内置角色 | 现为无角色裸跑（随契约统一对齐为前者） |

**收口判据**（上游 §3.0）：一个能力进 core，当且仅当「平台无关 + 两侧语义相同 + 是资产或纯算法」。平台机制绑定（事件接线、模型数据源读取、完成通知通道）留在插件层。

### 1.3 设计目标（G1-G6，引自上游，本仓负责前半段落地）

- **G1 资产同源**：内置 agent 模板与内置 workflow 一样一处维护，随 core 包分发，两插件同版本消费。
- **G2 契约统一**：agent 参数 = .md 绝对路径；workflow 引用 = 内置名或 .js 绝对路径（含 `~/` 前缀展开）。本仓负责 pi 半边（workflow run 放开内置名）。
- **G3 注入对齐**：三段 XML（subagents/workflows/models）渲染函数进 core，字段口径统一（location / contextWindow / 能力标记）。
- **G4 创作闭环**：generate→lint→save→delete 管线 core 化，落盘目录按宿主注入。
- **G5 双实现收敛**：agent 发现只剩 core 一套（本仓补 core 缺口，zsw 侧退役自写 resolver）。
- **G6 维护成本**：新增角色/调整注入格式只改 core 一处 + 发版。

### 1.4 In / Out of scope

**In scope（本仓）**：core 包新增资产（`agents/`）与导出面（发现/渲染/创作管线）；core 发现链三缺口修复；pi-sw 改消费 core 新面（资产迁出、渲染改接、管线改接、run 放开内置名、依赖下限、CHANGELOG）。

**Out of scope**：
- zsw 侧施工（W6-W9：四根映射接入、目录 symlink 宿主层展开、契约收紧报错面、hook 注入改调 core、zflow 创作面）——另一会话负责，本仓只对其负「完成定义」接口契约（§4.3）；
- core 引擎/编排内核行为变更（不动引擎）；平台固有差异强行对齐（triggerTurn vs mailbox、每 turn vs 一次性注入）；
- pi-sw 的 fork/conversation/idleTimeout 等会话级参数向 zsw 移植（未来独立设计）；
- app-server 常驻化（用户单独处理，见 `docs/design/zcode-engine-appserver-resident.md`，与本设计正交）。

---

## 2 现状与问题分析

> 本章全部 file:line 取自本仓 HEAD（基线 `88d7eadc6`，领地内无后续提交、无未提交变更，2026-08-30 核实；基线后本分支有其他任务线提交 26 个且持续增长，领地文件交集为 0——每波开工前复核，见 §5.3）。

### 2.1 收口缺口盘点（六项，N1-N6）

已收口 core 的能力（workflow 引擎/脚本契约/内置 5 workflow/zcode 引擎/FileRunStore/agent-opts-resolver）不在本设计范围。未收口的六项：

| # | 能力 | 本仓现状（已核实） | 双实现/缺失 |
|---|---|---|---|
| N1 | 内置 agent 模板（10 个 .md） | 在 pi-sw `agents/`（analyst/coder/debugger/doc-reviewer/explorer/general-purpose/orchestrator/planner/researcher/reviewer），经 `package.json` 的 `pi.agents: ["./agents"]` + `files` 白名单随包分发 | zcode 侧零资产 |
| N2 | agent .md 发现 | core `src/shared/resource-discovery.ts` 七源扫描，但有三缺口：① async 合并层无 realpath 去重（L629-667，靠 stem 部分兜底，多链同文件防不住）；② `buildScanTargets` 的 hostRoots 消费是 `Map(source→dir)`（L531-533）——同标签多条目靠后者**整体覆盖**前者，无多根语义；③ 无 project host 槽（zsw 的项目级 `.zcode/agents` 无槽可注入） | zsw 自写四根 resolver 完全绕开 core，双实现漂移 |
| N3 | 注入渲染 | 三个 format 纯函数在 pi-sw 插件层（`subagent-list-injector.ts:171` / `workflow-list-injector.ts:153` / `model-list-injector.ts:86`）；core 的 `xml-injection.ts`（escapeXml/renderXmlSection）**未出 barrel**（`src/index.ts` 无此导出，已核实） | zsw 自写单块渲染，格式两套 |
| N4 | workflow 脚本创作闭环 | generate 校验管线（ESM 拒绝/meta 必需/agent() 必需/round-trip，`tool-workflow-script.ts:254-307`）+ tmp 写盘在**插件层**（`.pi/workflows/.tmp` 硬编码）；core `workflow-files.ts` 有 saveWorkflow/deleteWorkflow 但 **未出 barrel**，`getTmpDir/getSavedDir`（L17-23）模块私有且 `.pi` 硬编码，不可注入 | zcode 侧无 generate 面；core 面不可达 |
| N5 | frontmatter `tools` 字段 | 10 个模板中 9 个含 `tools:` 字段（仅 general-purpose 无），值为 pi 平台工具名（如 orchestrator 的 `todo, goal_control, workflow, subagent, ask_user`）；orchestrator.md:28 body 写「你只有以下 5 个工具，其余全部不可用」 | core 引擎路径（zcode）无 allowlist 通道静默丢弃；body 宣称的工具集与 zcode 实际工具面错乱 |
| N6 | 模型条目口径 | pi-sw `ModelEntry`（`model-list-injector.ts:43-50`）全字段必填：`reasoning: boolean`、`input: string[]`、`contextWindow: number`；`formatCaps` 对 `entry.input.includes("image")` 直调（L73），`contextWindow` 直渲染（L101） | zsw 侧数据是 `reasoning.variants` 档位数组、无 `input[]`——字段集不同构，且 undefined 消费点会抛 TypeError / 渲染 "undefined" |

### 2.2 真实失败模式（使用者视角，节选自上游 §2.2）

**例 1（N1，zcode 用户）**：zcode 会话里让主 agent「派 reviewer 审查这段代码」——zsw 查四根一个内置角色都没有，只能无角色裸跑或手工拷 .md。同一 npm 生态的开箱角色库在 zcode 缺席。（本仓修复：W1 资产进 core 随包分发。）

**例 2（N5，资产跨平台断裂）**：把 pi 侧 `orchestrator.md` 拷到 zcode 目录——机制层 frontmatter tools 静默丢弃无报错；prompt 层 body 宣称的工具集与 zcode 实际工具面完全错乱，角色被引导去用不存在的工具。（本仓修复：W1 去 tools 化。）

**例 3（N3+N6，注入口径分裂）**：同一个 GLM-5.3 模型，pi 会话看到带 contextWindow 与 caps 的模型段；zcode 会话的单块注入无窗口数据——模型做长上下文委派决策时两平台信息量不等。（本仓修复：W3 渲染函数下沉 + ModelEntry 并集守卫。）

**例 4（N2，双实现行为漂移）**：用户在 `~/.agents/agents/` 用 symlink 指向个人技能库——zsw 自写 resolver 有 realpath 递归去重防环，core 扫描不做 realpath 去重。两套实现各自修 bug 互不可见。（本仓修复：W2 async 链 realpath 去重 + 多根语义。）

**例 5（N4，创作能力单侧）**：pi 用户说「写个三路审查 workflow」→ generate → lint → save 落盘即用；zcode 用户没有 generate 面，只能手写 .js、自己放对目录、自己保证 @pi-meta 格式正确。（本仓修复：W4 管线下沉 + 目录参数化。）

### 2.3 根因分析

同一根因的两次显形：**core 的定位被隐含为「编排内核」，「平台无关的共享面」（资产分发、资源发现、清单渲染、创作管线）从未被显式划入收口范围**。每次两侧需要同一能力时，实现者就地写了平台版本（zsw 的 resolver/hook-inject），或留在了先出现的插件层（pi-sw 的 injector 渲染、generate 管线、agents 资产）。双实现不是一次性成本，是持续漂移源（例 4）。

次级根因（契约分裂）：agent/workflow 引用形态两侧独立决策——pi 侧刻意收紧为「路径唯一」（防遮蔽歧义），zsw 侧沿用早期「名字或路径」宽松契约，注入段格式随之分叉。

### 2.4 物理数据流（pi 注入链现状 → 收口后）

```
现状（pi 会话，每 turn）:
  before_agent_start → 三个 setup*Injector（pi-sw 插件层）
    → core discoverResources（深路径 import，非 barrel）
    → [插件层 format*List + guide 文案内嵌] → core renderXmlSection
    → systemPrompt 链式叠加：<available_subagents>/<available_workflows>/<available_provider_models>

收口后:
  before_agent_start → 三个 setup*Injector（pi-sw 保留事件接线壳）
    → core discoverResources（barrel 导出）
    → [core format*List（守卫 + 预算参数 + 码点序）+ guide 由 pi-sw 注入] → core renderXmlSection（barrel 导出）
    → 同上三段 XML——除 10 个内置角色 location 路径前缀外逐字节等价（A2 快照验收）
```

数据获取（modelRegistry / discoveryRoots）与事件接线保持 pi-sw 端口不动——收口的是中段「解析/渲染/校验」纯算法层。

---

## 3 解决方案

### 3.1 终态（使用者视角）

**pi 用户**（改造后行为不变 + 两处新增）：

```
1. 会话注入：三段 XML 与现在逐字节等价，豁免仅两处——①内置角色 <location> 从
   <pi-sw 安装目录>/agents/*.md 变为 <core 包>/agents/*.md（豁免仅限这 10 个
   角色的路径前缀，用户/项目资源 location 不豁免）；②subagents 段 guide 末句
   修正（旧文案指引的 systemPrompt 参数在 pi 现版 tool schema 已移除，保留旧
   文案会主动误导模型——C5 实施期发现并重写为 location 路径 + 缺省
   general-purpose 指引，见 impl-plan 偏差表）。
2. workflow run 新增内置名引用：run {"name":"review-fix-loop"} 直接可跑
   （现状仅认 .js 绝对路径，报错文案已要求 location——W5 放开内置名是
   严格超集，不破坏现有用法）。
3. 创作闭环行为不变（generate→lint→save→delete），实现换成 core 管线，
   落盘目录仍 .pi/workflows/（pi-sw 注入宿主参数）。
4. orchestrator 等模板不再带 --tools 白名单（D-5）：子进程工具面放开到
   默认；想要白名单的用户在 <ws>/.agents/agents/ 放同名 .md 覆写
   （project 级是唯一稳定高于内置源的逃生门，见红线 1）。
```

**zcode 用户**（本仓产物经 zsw vendored 消费后的效果，验收在 zsw 侧）：开箱 10 个内置角色、三段同构 XML、generate 创作面——详见上游设计 §3.1，本仓只保证产物面就绪（§4.3 完成定义）。

**失败路径**：pi 侧无新增失败路径（超集变更）；若 vendored core 根注入序位错误导致遮蔽翻向，A2 快照的 location 豁免收窄口径会捕获（用户/项目资源 location 变化即 fail）。

### 3.2 六决策落位（D-1~D-6，已定稿，本仓落点）

每条：**选择**（一句话）→ **被否**（一句话 + 击穿反例）→ **本仓落点**（文件/资产）。完整对比表与被否谱系见上游设计 §3.2/附录。

**D-1 内置 agent 模板下沉 core `agents/` 约定目录**
- 选择：与 `workflows/` 资产同模式，一处维护双侧分发（W1）。
- 被否：zsw 复制一份（双份维护必漂移，例 4 模式重演）；core 导出 `getBuiltinAgents()` 显式注册（同包两种资产两种消费模式，无收益）。
- 落点：`packages/subagent-core/agents/`（新，10 个 .md）；core `package.json` files 加 `agents/`；pi-sw `package.json` 删 `pi.agents` 与 files 白名单 `agents/` 条目、整目录删除。

**D-2 agent 发现统一（core 补三缺口，zsw 接入在另一仓）**
- 选择：zsw 接 core `discoverResources`，根经 hostRoots 注入；core 先补齐自身缺口（W2）。
- 被否：维持双实现（漂移持续）；把 zsw 四根语义搬进 core 默认布局（core 默认布局是 pi 生态约定，混入 zcode 布局污染中性）。
- 落点（W2，`src/shared/resource-discovery.ts`）：
  - ① **async** 链扫描/合并层补 realpath 去重——生产消费走 async（core 内唯一非测试调用方 = `config-loader.ts:224`，已 grep 证实；sync 链 `scanDirectorySync`/`discoverResourcesSync` 等无非测试调用方，勿修错面），顺带修 L671 docstring 的漂移注释（声称「供 agent-registry 的 mtime 缓存模式使用」，但 agent-registry 实际只 import `getCachedFile`，不消费 sync 扫描——措辞精确到消费关系，防施工者误删 agent-registry 本身）；
  - ② hostRoots 加 project 级槽位（插在 project-agents 之下）；
  - ③ barrel 导出发现面（`discoverResources` 及类型——现 barrel 完全无 resource-discovery 导出，pi-sw 走深路径 import，npm/vendored 形态不可达）；
  - ④ **同标签多根语义**：`buildScanTargets` 的 hostRoots 消费从 `Map(source→dir)` 扩为列表（同标签多 dir 依注入序同序位扫描）+ 硬编码槽（user-agents/project-agents）与 hostRoots 同标签注入合并——zsw「目录 symlink 展开预处理」（宿主层，另一仓）的 core 侧配套，端口形态不变。
- **回归红线**：pi 现单条目形态下改前后 `discoverResources` 输出（含每条 source 标签与胜出路径）逐项一致——Map→列表是行为敏感改动，防标签内扫描序漂移（对照探针跑 pi 真实 agentDir）。

**D-3 注入渲染收口（三 format 函数 + xml-injection 下沉 core）**
- 选择：三个纯函数下沉 core 并出 barrel，pi-sw injector 改调 core（W3/W5）。
- 被否：格式各写各的只统一字段口径（N3 不解决）；zsw 单块格式反向推广给 pi（破坏 pi 多 injector 链式叠加的结构基础）。
- 落点（W3，`src/shared/` 新渲染模块 + barrel）：
  - Entry 接口（AgentEntry/WorkflowEntry）随函数下沉；**ModelEntry 口径并集**：`{ id, name, provider?, label?, contextWindow?, reasoning?: { variants?, defaultVariant? } | boolean, input?[] }`——`id`/`name` 为条目最小必填（缺则该条目无渲染意义），其余字段 optional，两侧投影各自适配，数据面零改动。**本仓补充（上游 D-3 增强，上游口径未含 provider，在本仓代码现实击穿）**：pi 现实现 `provider` 必填且两处硬消费——排序按 `(provider, id)` 码点序（L88-92）、`<id>` 段渲染为 `provider/id` 拼接（L98）；并集口径下 `provider?` 缺席时 id 渲染为裸 id、排序退化为 id 码点序（zsw 投影形态）。pi 投影必填 provider，保证 A2 逐字节等价；
  - **全字段 optional 守卫是显式工作项**（上游审查击穿点：原以为自然降级，实际 `formatCaps` 对 undefined input 抛 TypeError、contextWindow 直渲出 "undefined" 垃圾——本仓 L73/L101 已核实）；
  - **分段条目预算参数**（subagents/workflows 各自条目预算 + 码点序排 + 截尾 + 截断兜底指引，models 段完整永不截）——zsw 的 token 成本约束不能沿用 45 行总预算（三段 XML 每条目多行块，开箱必爆）；`sortByCodepoint` 排序函数随下沉（防不排序时截尾系统性裁掉高优先级条目）；**内置条目无截断豁免**（开箱场景不触发，两段式豁免不做）；
  - **guide 文案参数化**：`formatAgentList` 现内嵌 pi 专属文案「pass systemPrompt alongside the agent name」（L194，且该文案在 pi 侧也已过期）——渲染函数不带平台文案，宿主注入各自 guide。

**D-4 引用契约统一（agent 路径唯一；workflow 内置名或路径）**
- 选择：对齐 pi 既有「路径唯一」设计；本仓 pi 半边 = workflow run 放开内置名（W5③）。
- 被否：全放开按名（pi 已论证名字引用在多源遮蔽下有歧义——用户同名 .md 覆盖内置时名字指向取决于扫描序，模型不可见）；维持分歧（G2 落空）。
- 落点：`tool-workflow.ts` 的 `actionRun`（L415-443）run 入口从仅 `registry.getPath` 改为先查内置名——严格超集，现报错文案（L422/L441 已要求 location）与成功路径均不变。zsw 侧收紧（breaking）在另一仓。

**D-5 共享模板去 tools 化**
- 选择：frontmatter 删 `tools` 字段 + body 去平台工具名（W1 同步做）；工具约束回归宿主派发决策。
- 被否：core 补 allowTools 中立字段双引擎映射（zcode 映射面是弱约束，语义不对等且工具名仍是 pi 名）；值域按引擎过滤（静默失效换成带日志的失效）。
- 落点：10 个 .md 迁移时编辑（9 个含 tools 字段；orchestrator.md:28 类「你只有以下 N 个工具」文案改角色职责描述）；**pi 侧行为变化必须进 CHANGELOG**（orchestrator 不再落 `--tools` 白名单，逃生门 = project 级同名 .md 覆写）。

**D-6 workflow 脚本创作闭环收口**
- 选择：generate 校验管线 + tmp 写盘下沉 core；`getTmpDir/getSavedDir` 参数化宿主注入；save/delete/generate 出 barrel（W4）。
- 被否：zsw 自写 generate 管线（校验管线与 lintScript 是同一契约的两个入口，分家后规则漂移只是时间问题）；不做 zcode 创作面（G4 落空）。
- 落点（W4，`src/orchestration/workflow-files.ts` + 新管线模块）：参数化去掉 `.pi` 硬编码（pi-sw 传 `.pi/workflows`，zsw 传 `~/.zsw/workflows`）；校验管线五道闸（ESM 拒绝/meta 必需/agent() 必需/语法/round-trip）从 `tool-workflow-script.ts:254-307` 平移，报错文案（含行列）保持。

### 3.3 设计红线（施工期违反即返工）

1. **遮蔽序不可写反**：core 优先级低→高 = user-pi < user-agents < npm < npm-dev < ext-paths < project-pi < project-agents（`resource-discovery.ts:13` 及 buildScanTargets 实现）。内置模板源（npm 段）**高于 user 两级、低于 project 两级**——内置遮蔽 user 级同名，逃生门在 project 级（`<ws>/.agents/agents/`）。上游审查 R1 曾三处写反，被源码序击穿。
2. **注入/合并序语义**：core 合并 last-writer-wins（靠后者胜）；zsw 现语义同根内靠前者胜（本体胜）→ 多根注入时**原根（硬编码根/本体根）必须排在展开目标之后**。与直觉相反，测试必须覆盖「同 stem 撞名 → 本体胜」。
3. **单层扫描维持**：core 扫描不递归（pi 契约）；目录 symlink 展开是 zsw 宿主层预处理（另一仓）——core 只需提供同标签多根语义（W2④）。
4. **修对生产面**：realpath 去重修在 **async** `discoverResources`；sync 链无非测试调用方（已核实），勿修错面。
5. **渲染守卫是显式工作项**：ModelEntry 并集除 `id`/`name`（条目最小必填）外全字段 optional，undefined 消费点（input.includes / contextWindow 直渲 / provider 空串）必须守卫——不是自然降级。
6. **共享模板去 tools 化**：frontmatter 删字段 + body 去平台工具名；pi 侧行为变化（`--tools` 不再传）必须进 CHANGELOG。
7. **内置条目无截断豁免**：码点序排 + 截尾 + 兜底指引；不做「内置优先保留」两段式。
8. **A2 豁免收窄**：注入快照「除 location 外逐字节等价」的 location 豁免**仅限 10 个内置角色路径前缀**——用户/项目资源 location 不豁免（防遮蔽序翻向被放过）。
9. **新增导出必须进 barrel**：`src/index.ts` 逐名列出（禁 `export *`，既有约定）；exports 面 = semver 契约，新增导出走 minor（0.4.0）。深路径在 vendored/npm 形态不可达——zsw 消费的每一项新面都必须在 barrel（zsw rebind 的既有结论）。

### 3.4 运行时断言与探针状态

- ✅（已测，本仓核实）core async 扫描显式 follow symlink→文件、`stat().catch` 吞 ELOOP（`resource-discovery.ts:354-357`）；npm 槽注入语义（一级子项 = 包目录 + 无 manifest 扫约定目录）对 zsw `lib/vendor/` 布局成立（上游探针 + 复审双核实）。
- ✅（已测）三个 format 函数零 pi 依赖、入参纯数据（唯一 pi 依赖是 injector 的事件接线层，函数体只消费普通数据结构）。
- ✅（已测，本仓核实）`formatCaps` 对 `entry.input.includes` 直调、`contextWindow` 直渲染（`model-list-injector.ts:73/101`）——守卫必要性坐实。
- ⛔（实施期门）core hostRoots 加 project 槽 + 多根语义后：① pi 单条目形态改前后 `discoverResources` 输出逐项一致（对照探针）；② 对照探针目录集须含「子目录布局」「含 node_modules 的根」「同 stem 撞名（本体 vs 库内同名 → 本体胜）」三维度。
- ⛔（实施期门）pi 侧去 tools 化后 `--tools` flag 不再传——抓子进程 argv 探针确认（行为可接受性另见 A9）。
- ⛔（实施期门）pi-sw `agents/` 迁走后，core 包 `agents/` 经约定目录扫描在 dev 工作区拓扑下命中（§5.4 检查点 2，不命中走 hostRoots 注入 core 包根降级）。

---

## 4 验收

实施完成后的真实场景验证（真实依赖、真实平台、非单测非 mock）。zsw 侧场景（A1/A4/A5/A7/A8）由另一会话在其仓验收，此处只列本仓负责的锚点。

### 4.1 真实场景验收

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| A2 | pi 侧回归 | ① **W5 动工前**在 dev 链接环境落改造前三段注入快照（对比基线，落盘保存）；② W5 完成后正常会话 + `/subagents` 面板 + 跑一个 `workflow run`（内置名）；③ 升级路径模拟（本设计不发版，用 pack 产物构造）：临时副本（core 副本全目录 copy 自已完成 §4.3-1 构建的包目录，含 dist/dist.bundle——最小化副本会产出缺 dist 的残包）中 bump core 版本至 0.4.0、pi-sw 依赖改 `^0.4.0`（模拟发布面 manifest——`workspace:*` 直接 pack 会替换成现版本 0.2.0，验证不了下限），两包分别 `npm pack`；干净临时 agent 目录先装已发布的 pi-sw 8.7.0（自带精确 core 0.2.0），再**同批**安装两个本地 tarball（registry 无 0.4.0，单装 pi-sw tarball 必 404 失败——同批安装是刻意设计非绕过），验收后丢弃临时副本、不污染工作区 | 注入三段格式与改造前逐字节等价，豁免仅两处（10 内置角色 location 前缀 + subagents 段 guide 末句的 systemPrompt 过期文案修正，见 §3.1；红线 8 的 location 豁免收窄口径不变）；内置 workflow 按名可跑（D-4 pi 半边）；10 个角色仍可发现（来源变 core 包）；升级路径下 npm 因已装精确版本 `0.2.0` 不满足 `^0.4.0` 下限而强制拉入本地 core 0.4.0 tarball，10 角色随依赖到达 | G1/G2/G6 |
| A3-pi | 契约统一（pi 半边） | pi 侧跑：agent 传路径（应成，现有行为不回退）；agent 传名字（应拒——报错产自 core `agent-registry`/`agent-ref`，改造不动它）；agent 缺省（应走 general-purpose）；workflow 传内置名（应成——新行为）；workflow 传自定义脚本路径（应成——现有行为）；核对 `skills/workflow-script-format` 的 meta 格式描述与 W4 平移后 core 管线校验规则一致 | 成功路径行为与改造前一致；新增内置名路径可用；agent 名字拒绝报错与改造前逐字节一致（core 单实现未被触碰）；缺省角色不变 | G2 |
| A9 | pi 侧 D-5 行为验收 | pi 侧真实派发一次 orchestrator 委派（去 tools 化后），观察子进程完成情况与产出；抓子进程 argv 确认 `--tools` 未传 | 子进程正常完成、产出质量无肉眼劣化、无异常工具调用行为（argv 探针只证 flag 未传，行为可接受性需真实场景确认） | G1/G6 |

### 4.2 单元级测试门（每单元完成的判据，vitest）

| Unit | 测试门 |
|---|---|
| W1 | core `agents/` 10 个 .md，frontmatter 无 `tools` 字段、body 无平台工具名硬编码（grep 验证）；pi-sw `agents/` 目录不存在；两 package.json 无残留引用；core vitest 绿 |
| W2 | vitest 绿（含多链同文件去重、同标签多根、同 stem 撞名本体胜、子目录/node_modules 三维度对照）；pi 单条目形态改前后 `discoverResources` 输出逐项一致（对照探针，证据落盘）；`scanDirectorySync` L671 漂移注释已修 |
| W3 | 渲染单测绿：undefined input/contextWindow 不抛不渲垃圾、provider 存在时 `<id>` 输出 `provider/id` 拼接 + (provider, id) 两段排序（A2 等价面）、provider 缺席/空串时裸 id + id 码点序（zsw 投影形态）、码点序 + 截尾、预算边界、guide 由宿主注入；barrel 导出探针（node require 逐名检查） |
| W4 | 管线单测绿：ESM 样本拒（报错含行列）、无 meta 拒、无 agent() 拒、合法样本落 tmp；参数化目录注入生效（非 .pi 硬编码）；barrel 探针 |
| W5 | pi-sw vitest 全绿；注入快照对比（红线 8 口径 + guide 末句豁免）；workflow run 传内置名可跑；core 包根接线实测（§5.4 检查点 2，不命中走降级并记录）；grep 断言**收口面**（`src/injectors/` 三文件 + `src/interface/tool-workflow-script.ts`）无 `@zhushanwen/subagent-core` 深路径 import（职责⑦按收口面解读——收口两文件 tool-workflow.ts + tool-workflow-script.ts 改造前 pre-existing 源码深路径 9 处（execution/*、orchestration/*，其中 type-only import 4 处）不属本设计收口范围；interface 层其余深路径（含 shared/agent-ref、shared/model-ref 等）一律不属收口范围，pi-sw workspace 形态经 `./*` 通配可达。host-services 豁免：getHostServices 为 core 服务定位器、barrel 刻意不导出（导出仅 configureCore/类型面），src/injectors/ 的壳侧深路径消费属豁免面） |

### 4.3 完成定义（对 zsw 会话的接口契约）

W1-W5 全部 committed（本分支 `feat-subagent-core-host-surface`）后，还需同时满足——这是另一会话启动 W6a 的前置信号：

1. `packages/subagent-core` 的 `pnpm build:bundle` 产出 `dist.bundle/index.cjs` 自包含 bundle，包含全部新增导出面（agents 资产随 files 白名单随包分发）；
2. core 与 pi-sw 的 vitest 全量绿；
3. **§4.1 三场景（A2 / A3-pi / A9）全部通过且证据落盘**（注入快照 diff 输出、argv 探针日志）——单测绿不是最终验收，A2 是行为回退的最后防线（红线 8 载体）、A9 是 D-5 行为可接受性的唯一确认途径；
4. 向用户报告完成——zsw 会话将执行 `node scripts/vendor-subagent-core.js --local <本 worktree 路径>` 刷新 vendored 副本后开工。

---

## 5 下一层拆分

### 5.1 实施单元（W1-W5）

| Unit | 职责 | 领地（精确路径） | 依赖 | 验收挂钩 |
|---|---|---|---|---|
| W1-core-assets | 10 个 .md 迁入 core + D-5 去 tools 化 + 双 package.json 清理 | `packages/subagent-core/agents/`（新）；`packages/subagent-core/package.json`（files）；`packages/subagent-core/workflows/README.md`（顺手修复 §5.5）；`extensions/universal/subagent-workflow/agents/`（整目录删）；`extensions/universal/subagent-workflow/package.json`（pi.agents + files） | — | §4.2 W1（单元门即可判；A2/A9 需待 W5 接线后一并执行） |
| W2-core-discovery | async 链 realpath 去重 + project host 槽 + hostRoots 同标签多根（Map→列表 + 硬编码槽合并，原根后置）+ 漂移注释修 + barrel 发现面 | `packages/subagent-core/src/shared/resource-discovery.ts`；`src/index.ts`；`src/__tests__/` | —（与 W1 领地互斥，可并行） | §4.2 W2 / A2 探针 |
| W3-core-render | 三 format 函数 + Entry 接口下沉；ModelEntry 并集 + 全字段守卫；分段条目预算；sortByCodepoint；guide 参数化；xml-injection 出 barrel | `packages/subagent-core/src/shared/`（新渲染模块，命名执行期定）；`src/index.ts`；`src/__tests__/` | W2（barrel 同文件，保守串行） | §4.2 W3 / A3-pi |
| W4-core-script-pipeline | getTmpDir/getSavedDir 参数化；generate 校验管线 + tmp 写盘下沉；save/delete/generate 出 barrel | `packages/subagent-core/src/orchestration/workflow-files.ts`；`src/orchestration/`（新管线模块）；`src/index.ts`；`src/__tests__/` | W3（barrel 同文件，保守串行） | §4.2 W4 / A2 |
| W5-pi-rebind | pi-sw 改消费 core 新面，七项：① injector 调 core format（guide 传 pi 版新文案）② workflow-script 调 core 管线 ③ run 放开内置名 ④ 依赖下限 ⑤ CHANGELOG（tools 行为变化 + project 级逃生门）⑥ **core 包 `agents/` 进 pi 发现面接线**（约定目录扫描命中实测；不命中走 hostRoots 注入 core 包根降级，防 10 角色静默消失）⑦ **发现/渲染 import 统一改 barrel**（现状深路径 `@zhushanwen/subagent-core/shared/resource-discovery.ts`——收口后统一走 barrel 消费面，W2③/W3 的导出由此单元接线消费） | `extensions/universal/subagent-workflow/src/injectors/`（3 文件）；`src/interface/tool-workflow.ts`；`src/interface/tool-workflow-script.ts`；`package.json`；`CHANGELOG.md`；`README.md`（顺手修复 §5.5） | W1（资产）、W3（渲染）、W4（管线） | §4.2 W5 / A2 / A3-pi / A9 |

依赖序：W1 ∥ W2 → W3 → W4（barrel 同文件保守串行）→ W5。W1/W2 领地互斥可并行；W2→W3→W4 仅为 `src/index.ts` 同文件共改的保守串行（产物互不依赖）。

**过渡态声明**：W1 完成（pi-sw `agents/` 删）到 W5 接线完成之间，pi 侧 10 个内置角色处于消失窗口——本分支不发布、不 push（§5.2），窗口无外部影响；A2/A9 的真实场景验收在 W5 完成后执行。

W5 依赖下限实施细节：pi-sw 现依赖 `@zhushanwen/subagent-core: workspace:*`（workspace 形态）；「≥0.4.0」指**发布面** manifest——实施时核对 changeset 版本替换策略保证发布产物依赖不低于 0.4.0（不能是 `*` 或更宽 range）。

### 5.2 版本与发布节奏

- core 待发布 **0.3.0**（host-surface 扩面 changeset 已存在）——**先发**，不与本设计混版；
- 本设计全部收口落 **core 0.4.0**（minor：新增资产/导出/参数化，无破坏性导出变更，符合既有 exports 面 semver 契约「新增走 minor」）；
- pi-sw 随 core 0.4.0 同步发版，CHANGELOG 记 tools 行为变化 + project 级覆写逃生门指引；
- **不 push、不合并 main、不发版**——一切推送类操作需用户明确授权。

### 5.3 分支纪律（认知外变更零容忍）

本分支基线 `88d7eadc6` 后有其他任务线提交（steer/followUp 气泡、更新网络韧性等；2026-08-30 核实时为 26 个，数量随分支推进增长），已核实与 W1-W5 领地文件交集为 0。规则：认知外提交不碰、不修改、不 revert、提交时不裹挟（精确路径 add）；每波开工前复核 `git log --oneline <基线>..HEAD --name-only` 与 `git status`，确认领地内无认知外新增变更。

### 5.4 待验证检查点（设计阶段无法确定，诚实标注）

1. hostRoots project 槽的 API 形态（新增显式槽位 key vs 复用现有槽语义扩展）——W2 实施时定，倾向新增显式槽位（`project-host`）避免借位语义污染（上游 §5.3.1）。
2. pi-sw `agents/` 迁走后，core 包 `agents/` 在 pi dev 工作区拓扑下经约定目录扫描是否命中（core 包无 pi manifest，无 manifest 时扫 `{kind}/` 约定目录——机制已证实，实际布局待 A2 实测；不命中则 W5 走 hostRoots 注入 core 包根降级，防 10 角色静默消失）（上游 §5.3.4）。
3. 分段条目预算（subagents 15 / workflows 10）的量级估算已按开箱场景给出（上游 D-3a：开箱 ≈ 100 行，pi 每 turn 注入同量级），具体值由 zsw 侧 W7 实测微调——本仓只提供参数化能力，不硬编码默认预算值。

### 5.5 顺手修复清单（文档漂移，随对应单元带上）

| 漂移 | 现状（已核实） | 随单元 |
|---|---|---|
| core `workflows/README.md:67` | 「agent 项支持：AgentRegistry 名（如 reviewer）」与代码（仅认路径）不符 | W1（动 core 包文档时） |
| pi-sw README:7 | 「9 个角色零重叠」实际 10 个 .md | W5（动 pi-sw 时） |
| pi-sw `subagent-list-injector.ts:194` guide 文案 | 「pass systemPrompt alongside the agent name」pi 侧也已过期 | W3 参数化（渲染函数去掉内嵌文案）+ **W5 落 pi 版新文案**（文案落点在 injector 文件，属 W5 领地，W3 改不到） |

---

## 附录 A：上游审查循环摘要与被否谱系

上游设计经四轮对抗审查收敛：R1（4 must-fix/7 suggestion/3 doc_error：遮蔽方向三处写反、遍历语义缺口、预算互斥、formatCaps 假阳性）→ R2（目录 symlink 平铺迁移对整库一链形态不可执行，被击穿）→ R3（「core 不动」声明被 hostRoots Map 单目录消费击穿）→ R4（0 must-fix + 2 suggestion 当轮修完）→ 终态设计就绪。关键被否谱系（终局形态，完整版见上游附录）：

| 被否方案 | 击穿反例 | 终局方案 |
|---|---|---|
| vendored core agents 注入最低优先级槽（用户全级可遮蔽） | core 源码序 npm 槽并非最低；「全级可遮蔽」与 pi 内置语义不一致 | 内置注入 npm 槽序位：user 级 < 内置 < project 级 |
| formatCaps 对 input 缺席自然降级 | `entry.input.includes` 对 undefined 抛 TypeError；contextWindow 直渲 "undefined" | W3 显式守卫（全字段 optional 消费点） |
| 注入预算沿用 45 行总预算 | 三段 XML 每条目多行块，开箱 10 内置 ≈ 42 行 + workflows ≈ 18 行，45 行必爆 | 分段条目预算 + 码点序截尾 + 兜底指引 |
| core 扫描改递归兼容 zsw 子目录布局 | 动 pi 已验收行为，且需引入 node_modules/.git 排除 | core 维持单层；宿主层展开预处理（另一仓） |
| hostRoots「core 不动」声明 | `Map(source→dir)` 同标签靠后者整体覆盖——本体 + 库链接 = 本体 .md 整体消失 | W2④ 同标签多根语义（Map→列表 + 硬编码槽合并） |
