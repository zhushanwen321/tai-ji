# 打包态内置 subagent/workflow 资产发现失效 — 修复设计

状态：对抗式审查 3/3 已回收并并入（rev-regression / rev-mechanism / rev-audit）；关键条目均由主会话独立复核。
**范围（已扩）**：主修复（第一部分）+ 同族三项修复（第二部分：d8-compat / 降级可见性 / 滤镜收紧）——用户裁定"三项都做"。
作者：主会话调查产出（审查意见已标注来源，关键条目由主会话独立复核）
影响面：TaiJi 打包形态（electron-builder 产物）下 `@zhushanwen/pi-subagent-workflow` 扩展的内置资产发现
关联症状：`subagents` 批量工具调用即抛 `Built-in workflow 'fan-out' is not available`

---

# 第一部分：主修复（S0–S2 + 收口 S6）

## 1. 背景与实证（全部为运行时/产物级证据，非源码推断）

### 1.1 症状

打包版 TaiJi（0.10.2 正式版与各 dev 构建均复现）中调用 `subagents` 批量工具：

```
Built-in workflow 'fan-out' is not available — the subagents tool runs it as its batch body.
Recovery: verify the @zhushanwen/subagent-core package ships workflows/fan-out.js ...
Workflows currently available:
  - pr-lifecycle: ...（仅项目级一条，无任何内置项）
```

### 1.2 运行时日志实锤

`~/.taiji/agent/logs/pi-host-2026-10-03.log`（当天文件 202 行**全部**是这一条 warn，随会话启动持续累加）：

```
[warn] [pi-host] core 包 agents/ 注入根解析失败——10 内置角色可能不可发现
{"reason":"ResolveMessage: Cannot find module '@zhushanwen/subagent-core/workflows/README.md'
 from '<app>/Contents/Resources/extensions/@zhushanwen/pi-subagent-workflow/index.js'"}
```

### 1.3 因果链（每一环均有证据）

1. `subagents` 工具执行体 = 内置模板 `fan-out`，按固定名 `registry.get(FAN_OUT_SCRIPT_NAME)` 解析
   （`extensions/universal/subagent-workflow/src/interface/tool/tool-subagents.ts`）。
2. workflow/agent registry 的内置扫描根由 pi 壳 `createPiHostServices().discoveryRoots()` 提供，
   其中内置资产根 = `corePackageNpmRoot()` = 对 `@zhushanwen/subagent-core/workflows/README.md`
   的 `require.resolve`（锚定扩展 bundle 自身，`src/host/pi-host.ts:68-85`）。解析失败仅 warn 降级
   （"绝不因资产接线失败阻断发现主链"）。
3. 打包态该 resolve **必败**，原因是**两条独立的必要条件同时不成立**：
   - **条件甲（解析面无 node_modules）**：`scripts/bundle-extensions.mjs` 用 esbuild 打自包含
     `index.js`，`@zhushanwen/subagent-core` 被 inline，staged 布局无 node_modules，无从解析；
     且随包拷贝的 `workflows/` 不在任何发现根上（agentDir 三根 `~/.taiji/agent/workflows`、
     `~/.taiji/extensions`、`~/.taiji/npm` 实测均不存在；`TAIJI_EXTENSION_PATHS` 为空；
     staged package.json 按设计不带 `pi.workflows` manifest）→ 孤儿资产。
   - **条件乙（锚点被产物滤镜剪枝）**：`electron-builder.yml` extensions 段 `!**/README.md`
     把锚点文件 `workflows/README.md` 从产物中删除（产物目录实测无此文件）。
   *最小充分条件 = "锚点在打包产物内可解析"。只修条件甲（加骨架、保留 README 锚）产物仍坏
   （rev-audit 于 /tmp 复刻实测：pre-filter resolve 绿、post-filter 红）——条件乙不可省。*
4. 竞争解释已排除：全仓 `configureCore` 仅 pi 壳一处调用（`index.ts:113`），无其他宿主实现覆盖根集；
   `<available_workflows>` 注入无 invalid 行（injector 会把 parse 失败/损坏条目具名渲染）→
   fan-out 是"未被扫描"而非"扫描到但损坏"。
5. 形态分叉：dev workspace（pnpm workspace，core 为真实包）与 npm 发布形态（core 为传递依赖）
   resolve 均命中 → 发现正常。**仅 staged 打包形态失效。**

### 1.4 实测边界（打包态 app 内直接执行）

| 探针 | 结果 | 含义 |
|---|---|---|
| `subagents` 批量工具（1 任务） | ✗ 报 "Built-in workflow 'fan-out' is not available" | 批量入口失效（本问题） |
| `subagent` 单工具（省略 agent） | ✓ 正常完成（输出 `OK-<cwd basename>`，1 轮） | 单派发**不**依赖该发现链（见 §1.5） |
| `workflow run <staged fan-out.js 绝对路径>` + 1 任务 | ✓ 脚本与 worker 执行成功（成员 `fan-out-0` 已派发） | `registry.get` 失败但 `getWorkflowByPath` 命中 → 按路径 run 是可用变通；该轮被自设 2000 token 预算掐断（budget_limited） |

结论：失效面精确限定在"**按名**发现内置 workflow（registry 扫描根）"这一条通道；按路径执行通道完好。

### 1.5 连带实害（同根）

- **内置 workflows×6**（chain / fan-out / map-reduce / parallel / scatter-gather / review-fix-loop；
  另有 `_shared/` 支持目录与 `review-fix-loop-utils.cjs` 辅助件——`isTargetFile` 只收 `.js/.mjs` 且跳过 `_` 前缀）
  打包态整体不可发现 → `subagents` 批量入口失效；
- **内置 agents×10**（subagent-core/agents）打包态不可发现，实害有二：
  ① `<available_subagents>` 注入缺 10 角色（本会话实测只剩用户级 4 个），模型无法按 `<location>` 选角；
  ② 显式点名内置角色会 **loud 报错**（`Invalid agent ref` / agent 文件找不到，含恢复指引）。
  **默认形态（省略 agent）不受影响** [rev-audit A-AUD-5 修正]：`run-orchestration.ts:258-262` 的
  `const agentConfig = opts.agent ? getRequiredAgentConfig(opts.agent) : undefined` 表明省略 agent 时
  本就**不加载** general-purpose.md（刻意合法缺省，走 override→主 agent model）；`model-config-service.ts`
  注释里"systemPrompt/工具白名单全丢且零反馈"描述的是**历史上显式 ref 解析失败的静默形态**，
  现已由 `getRequiredAgentConfig(require=true)` 改为 loud throw。§1.4"单工具正常"与本节原先的
  "被连带"表述自相矛盾，已按此修正；
- 引导脱节：`<available_workflows>` 的 guide 静态文案仍写"2+ 独立任务优先用 subagents 工具"，
  而该工具在打包态必失败——模型被系统性误导。

### 1.6 为什么能静默上船（流程根因）

**技术根因（一句话）**：ESM bundle 内的代码假设"包相对资产解析"（`import.meta.url` / `require.resolve`）
可用，而 staged 布局既无 node_modules、产物滤镜又会剪枝资产；本次触发只是"锚点恰为被剪枝文件"。

**同类残留（证明这是系统性机理，不是单点写错）** [rev-audit A-AUD-1/A-AUD-4 新增，主会话已复核]：

| 位置 | 打包态行为 | 现状兜底 |
|---|---|---|
| `pi-host.ts:74 corePackageNpmRoot()` | resolve 失败，**warn** 落 pi-host 日志（162 条/天） | 无（本 bug） |
| `pi-host.ts:166 hostPackageNodeModulesRoot()` | **无 warn 无异常**，静默返回不存在的 `.../Resources/extensions/node_modules`（实测推演） | `TAIJI_AGENT_ENGINE_ROOTS` env |
| `subagent-core/src/execution/engine/d8-compat.ts:115-126 corePackageDir()` | 上溯越界（返回 `.../Resources`），vendor 引擎定位恒失败，**warn** 落 subagents 日志（今日 13 条 / 历史 39 条，主会话已实测） | `TAIJI_AGENT_ENGINE_ROOTS` 覆盖 descriptor（`[engine-discovery] descriptor overwritten`） |

**流程原因（有效，但只解释"为什么没拦住"，不构成修复充分性）**：

1. pi 壳对解析失败**只 warn 降级不 fail-fast**（设计意图容忍缺失），失败痕迹只在日志；
2. 验证形态不对称：D1 双形态探针只验 **worker 执行路径**（scriptPath 锚定），npm 形态发现有注释论证，
   **打包产物态的 registry 发现路径零覆盖**——且这一不对称同样漏掉了 d8-compat（同类失败的另一实例）；
3. `verify-staged-extensions.mjs` 的 dry-run import 不调用扩展工厂 → 永不触发 `corePackageNpmRoot`；
   且它默认跑 **dev staged**（README 仍在），对"产物滤镜剪枝"这一幕天然失明；
4. `workflows/` 确实被拷进了包 → "文件在包里"的完整性错觉。

---

## 2. 修复方案

### 2.1 方案 A（推荐）：把 staged 布局补成真实嵌套安装

核心思路：不改发现机制，让打包布局满足既有发现机制的前提——在 staged 扩展目录内放
最小的 `node_modules/@zhushanwen/subagent-core` 安装骨架，使既有 `require.resolve` 锚点自然命中。

**改动清单：**

1. `scripts/bundle-extensions.mjs`（build 侧）：
   - **骨架落点（钉死，含一条硬约束）** [rev-mechanism F2 实测]：
     `apps/electron/resources/extensions/@zhushanwen/pi-subagent-workflow/node_modules/@zhushanwen/subagent-core/`
     （`<pkg>/node_modules/...` 形态；等价的另一合法落点是 `<staged>/@zhushanwen/node_modules/...`）。
     **禁止放在 `resources/extensions/node_modules/`**——`app-builder-lib/out/util/filter.js:43` 硬编码
     `if (relative === "node_modules") return false;`（只放行子级 `*/node_modules`），审查员用真实
     matcher 实测：该落点的 node_modules **整目录被丢光**；且 `prepare-builtin-extensions.sh:51` 只清理
     `extensions/@zhushanwen`，错放还会**跨构建残留**。这不是本仓 yml 的规则，是 electron-builder 内建行为
     ——原文档"extensions 段无 node_modules 排除规则，实测确认"的表述**已纠正**。
     选 `<pkg>/node_modules/...` 的额外理由：STAGED_ROOT 顶层保持纯 `pi-*`；且避免把
     `hostPackageNodeModulesRoot()` 静默计算出的错误路径"坐实"成真实目录（后者会让 `engineRoots()`
     多扫一个语义漂移的目录）。
   - 骨架 `package.json`：**从真实 `packages/subagent-core/package.json` 程序化派生**
     `{name, version, type}` 三个字段，**不带 `exports`/`main`** [rev-mechanism F6 修正]。
     理由：`createRequire().resolve("@zhushanwen/subagent-core/workflows/fan-out.js")` 在**无 exports** 时
     走裸子路径解析即可命中（Node 与 Bun 实测均通过）；而任何 `exports` 白名单都会把未来锚点
     限死——例如将来若把锚点换到 `agents/`，真实 core `exports` 并无 `./agents/*` 子入口，
     会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。程序化派生（而非手写）保证 name/version 单源、零漂移。
     （原文档写"整份拷贝真实 package.json"，已被此方案取代。）
   - （目录内容仅 `package.json` + `workflows/` + `agents/` 三件，均从 `packages/subagent-core/` 拷贝）
   - **顶层 `workflows/` 拷贝：分两阶段**（修 F1/F4 的取舍）[F8(c) + rev-mechanism F4]：
     - **本修复批次保留**：零测试/探针/文档连锁改动（TC8 `builtin-ext-bundle.test.mjs:152-171` 与
       `bundle-extensions.mjs` V1-④ 双形态探针路径全不变），且**规避 resume 断链**（见下）；
       代价是产物多 ~250KB 重复资产；
     - **后续批次删除**（单一事实源收口）：删除时必须同批改 TC8（改指骨架路径 + 一条负向断言
       "顶层 `workflows/` 必须不存在"防布局回潮）、更新 V1-④ 探针路径与注释、按 C-proc-10 回写
       `docs/architecture/subagent-core-package-extraction.md` 的 D1/V1-④ 段；否则 CI 必红。
     **删除的真实障碍（新登记，rev-mechanism F4）**：升级前中断的 run 在 record 里持久化的是旧
     scriptPath（`resume-run.ts:863` 从 run-created 帧恢复 → `worker-host.ts:55` 注入 workerData）；
     `fan-out.js:78-79` 与 `review-fix-loop.js` 用 `dirname(workerData.scriptPath)` 拼绝对路径加载
     `_shared/`/`-utils.cjs`。删掉顶层目录 → 这类**跨升级 resume** 在 worker 启动期抛
     `core_module_load_failed`（响亮失败，非静默）。故删除宜留一个发布周期后再做。
2. `extensions/universal/subagent-workflow/src/host/pi-host.ts`（运行时，1 行 + 注释）：
   解析锚点 `workflows/README.md` → `workflows/fan-out.js`。
   **骨架与换锚是合取对（conjunctive），缺一不可** [rev-mechanism F3]：审查员用真实 electron-builder
   matcher 实测，**骨架自带的 `workflows/README.md` 同样被 `!**/README.md` 删除**——只加骨架、保留
   README 锚，打包态依旧失败。换锚理由：`.js` 不受该滤镜影响；dev/npm 两形态下 fan-out.js 亦必在
   （core `files` + `./workflows/*` exports 双保证，npm tarball 已实测含之）。
   连带改头注释 `:50-63`（含"README.md 是两形态都必在的资产文件"）。
   *（备选：保留 README 锚点并把滤镜改为 `!*/*/README.md`——见 §5 第 2 条；但改滤镜要重打产物，
   且 `!*/*/...` 语义依赖 `resources/extensions` 下的两段布局，稳健性不如换锚。）*
3. `scripts/verify-staged-extensions.mjs` + `scripts/lib/staged-asset-dirs.mjs`（验证门，见 §4）：
   - 断言必须放 `verifyPackage(pkgDirName, pkgDir)` **per-package 条件位**，不得无条件放 `main()`
     [F2]——否则 4 个 mirror fixture（自造最小 SSOT，staged 内根本没有 pi-subagent-workflow）转红；
   - 骨架登记进 `scripts/lib/staged-asset-dirs.mjs` 共享登记表（MF-1-17 单源纪律：bundle 拷贝与
     verify 校验共读同一登记，禁止两侧各持字面量表），并把新键名纳入该表的结构守卫 grep 反证；
   - 断言内容：骨架三件存在、workflows 文件集合与源目录**逐文件一致**（不写死数量）、agents 10 个 .md、
     **以 staged `index.js` 为锚 `createRequire().resolve(锚点)` 成功且 `resolved.startsWith(STAGED)`**
     [F11 防 symlink realpath 逃逸假绿]。
4. **electron-builder.yml 不改**，但建议加一行反向禁令注释 [F12]：相邻 `plugins` 段有
   `!**/node_modules/**`，后人"统一风格"会静默抹掉骨架 → 复现本事故。**注意两条真实约束**：
   ① electron-builder 内建丢弃相对路径恰为 `node_modules` 的目录（`filter.js:43`，见 §2.1-1）；
   ② 骨架**含** `workflows/README.md`（会被滤镜删，不影响修复，因锚点已换 `.js`）与
   `review-fix-loop-utils.d.cts`（`!**/*.d.ts` 不匹配 `.d.cts`，产物实测保留）——原文档
   "骨架无 README/d.ts/map"的前提不准 [F8(a)/F11 修正]。

**沙箱已验证的机制**（/tmp 复刻 staged 布局实测）：骨架就位 → `createRequire(staged/index.js)`
命中骨架文件 → `corePackageNpmRoot()` 返回 `node_modules/@zhushanwen`（scope 目录，npm 槽语义
"子项=包目录"成立）→ `agents/`、`workflows/` 均可被约定目录扫描命中（agents 10 / workflows 6）。
去掉 README.md → 锚点失败（复现条件乙）；换 `fan-out.js` 锚 → 成功。

**三形态矩阵（修复后）：**

| 形态 | core 根来源 | 状态 |
|---|---|---|
| dev workspace | workspace node_modules（pnpm symlink）resolve | 不变，正常 |
| npm 安装 | 依赖树内真实包 resolve | 不变，正常 |
| staged 打包 | 骨架 `<pkg>/node_modules/@zhushanwen/subagent-core` resolve | **修复** |

### 2.2 方案 B（修正版 B′）/ 否决理由已重审

**修正版 B′**（rev-mechanism F8 提出，主会话采纳为真实备选）：`corePackageNpmRoot()` 在 resolve 失败时
**回退到 bundle 同目录的父目录**（= staged 根 `apps/electron/resources/extensions/@zhushanwen`）作为
`npm` 槽根，同时给 staged 扩展包补一份 `agents/` 拷贝。审查员实测该根的子项正是 `pi-*` 包目录，
天然满足"子项=包目录"语义；且当前没有任何 staged 包含 `agents/`（`workflows/` 只有 subagent-workflow 有）
→ 不会引入意外发现面。

- **B′ 的优点**：不需要假 node_modules、不需要派生 package.json、无 F2 滤镜陷阱；顶层 `workflows/` 原位不动
  → **worker scriptPath 不变 → resume 断链（F4）不存在**；TC8/V1-④ 原样保留 → **F1 不存在**。
- **B′ 的代价**：把"staged 布局探测"写进运行时热路径（仅在 resolve 失败时的回退分支，与 pi-host 既有的
  `isTaijiHostInjected` 分支风格一致）；发现面从"本包依赖安装位"扩到"整个 staged 根"（语义略宽，
  未来新增包若带 `agents/` 会被扫到——与 npm 形态的约定目录语义实际一致）。
- **原文档对 B 的否决理由（"回退根不满足 npm 槽语义"）已被证伪**，本节按 B′ 重述。
- **A vs B′ 取舍**：A 让既有契约自然成立、无运行时改动、且可走向"删顶层拷贝"的单一事实源终态；
  B′ 改动更小但永久保留重复拷贝与运行时布局知识。**本设计仍取 A**，B′ 作为审查确认过的备选留档
  （若实施中发现骨架路径在任一端仍被滤镜/清理逻辑吃掉，可平滑切到 B′）。

### 2.3 方案 C（否决）：env 注入发现根

经 `TAIJI_EXTENSION_PATHS` 注入 staged 目录。否决理由：该 env 是 dev-link 专用通道
（resource-discovery 注释明确认定"非 agent 自救面"）；staged 包无 `pi.workflows` manifest，
约定扫描只能捞到 workflows 捞不到 agents；语义滥用。

### 2.4 明确不做

- 不给 staged package.json 补 `pi.workflows` manifest（会让 standalone pi 用户经 manifest 模式命中
  "声明路径不存在 → 整包失败占位"）；
- 不改 `WORKFLOW_TOOL_NAMES`/工具注册面；不改 workflow tool 的裸名拒收设计（`tool-workflow.ts:337`，刻意行为）；
- 不改 pi 壳的 warn-降级策略（属 §5 治理项，另立项）。

---

## 3. 兼容性与风险

| 风险点 | 评估 |
|---|---|
| dev/npm 形态回归 | 锚点 fan-out.js 在两形态同径（exports `./workflows/*` + files 保证）；骨架只在 staged 生成，dev/npm 无感知。审查员实测 dev 形态 `require.resolve` 跟随 symlink 命中仓库 `packages/subagent-core`（realpath），dev 无重复发现、无遮蔽顺序变化 |
| worker scriptPath | 发现路径变为 `<pkg>/node_modules/@zhushanwen/subagent-core/workflows/*.js`，`_shared/` 随行，D1 锚定模式不变；顶层拷贝保留则 V1-④ 探针路径不变 |
| CA2 注入快照 | 无影响——快照族为 fixture 输入驱动（location 用字面量），不消费运行时路径（审查员已核） |
| 单测/门禁同步（**修正** [F6/F7]） | 五处字面引用（`pi-host.test.ts:116/144`、`prompt-quality.test.ts:32`、`tool-prompt-contract.test.ts:235`、`agent-registry.test.ts:220`）**换锚后都不会红**（均取 `dirname(锚)`，且跑在 dev 形态）——按 C-proc-10 顺手对齐即可，勿按"必须改"处理；**唯一会红的是 `builtin-ext-bundle.test.mjs` TC8，且仅在选择删除顶层拷贝时**（本设计分批：本批保留 → TC8 不动） |
| **resume 断链（新登记）** [rev-mechanism F4] | 升级前中断的 run 持久化的是旧 scriptPath（顶层拷贝路径）；**删除顶层拷贝后**跨升级 resume 在 worker 启动期抛 `core_module_load_failed`（响亮失败，非静默）。对策：本批保留顶层拷贝（断链不发生）；后续删除批次须在 release notes 说明该一次性影响 |
| 双宿主（**修正** [A-AUD-1/8]） | 原表述"zcode 不走此发现链，无回归面"不准确：`d8-compat.corePackageDir()` 正是走同类 `import.meta.url` 上溯并在打包态失败（今日 13 条 warn），只是被 `TAIJI_AGENT_ENGINE_ROOTS` 兜住。zcode 引擎进程**结构上不需要** core 发现面（只依赖 `subagent-engine-sdk`，SDK 明令禁止 import core；agent/systemPrompt/tools 由宿主在 pi 进程解析后经 wire task 下发），故本修复对 zcode 无回归，但 d8-compat 应另行立项 |
| 缓存 | `getWorkflow` 60s TTL 按 workspaceRoot 分桶，产物路径变化在重启后自然生效，无跨形态污染 |
| 骨架 symlink 化风险 | verify 断言 `startsWith(STAGED)` 拦截（F11） |

## 4. 验证计划

### 4.1 门禁（形态必须区分——这是本次失效的关键盲点 [A-AUD-6/A-AUD-7]）

- `verify-staged-extensions.mjs` 新断言（§2.1-3）跑在**两形态**：
  - **dev staged**：经 `builtin-ext-bundle.test.mjs` 在 CI 间接执行；
  - **打包产物**：`scripts/postbuild-validate.sh` 的 `BUILTIN_EXT_DIR` 段（已有 `--staged-dir` 钩子）。
  **只有打包产物形态能拦住本次这类"滤镜剪枝"缺陷**（dev staged 的 README 仍在，恒绿）。
- 增补命令级断言（可直接并入 postbuild-validate / verify 脚本）：
  1. **post-package 锚点 resolve 冒烟**（含越界防护）：
     ```bash
     node --input-type=module -e '
     import { createRequire } from "node:module"; import { join } from "node:path";
     const root = process.argv[1];
     const req = createRequire(join(root, "pi-subagent-workflow", "index.js"));
     const p = req.resolve("@zhushanwen/subagent-core/workflows/fan-out.js");
     if (!p.startsWith(root)) { console.error("[anchor] escaped staged root:", p); process.exit(1); }
     console.log("[anchor] ok:", p);' "$BUILTIN_EXT_DIR"
     ```
  2. **滤镜静态对账**（让 CI 也能拦"锚点被排除模式删掉"，无需真打包）：
     用 `minimatch` 对 `electron-builder.yml` extensions 段排除模式逐条比对锚点相对路径，
     任一模式会删锚点即 fail；
  3. **资产清单对账**（bundle 时写源目录清单到骨架 `.taiji-asset-manifest.json`，postbuild 逐文件比对）
     ——落实"不写死数量"（F5 的教训）；
  4. **产物资产存活 diff**（通用护栏）：pre-package `resources/extensions` 与 post-package
     `Contents/Resources/extensions` 文件集 `comm -23`，删除集必须落在显式白名单内
     （`*.map` / 包根 `README.md`/`ARCHITECTURE.md` / `__tests__` / `*.test.*` / `*.d.ts` /
     tree-sitter src/debug），其余任何删除即红。
- 另建议 [F10]：`check-publish-surface.mjs` 为 `@zhushanwen/subagent-core` 加"`workflows/` 至少含
  fan-out.js"断言（换锚后 fan-out.js 成为四形态启动键）。
- **门禁运行器 vs 运行时解析器错配（新登记）** [rev-mechanism F9]：verify 门是 **Node** 脚本（`createRequire`），
  而 pi 二进制是 **Bun** 编译（`strings pi-darwin-arm64 | grep ResolveMessage` 命中；`bun -e` 复现的
  失败文案与运行时日志逐字同形）。审查员实测本场景 bun≡node，故 node 门当前可接受；但建议在打包冒烟里
  再加一条"**在 pi 进程内 resolve 一次**"的步骤，避免同类错配长期潜伏。

### 4.2 功能验收（打包 app 内）

a. `<available_workflows>` 注入含内置 6 项；
b. `subagents` 批量调用成功（2 个极小任务）；
c. `workflow run <location>` 按 path 跑 fan-out 成功；
d. `<available_subagents>` 注入含内置 10 角色；
e. `pi-host-*.log` 无"注入根解析失败"新条目（d8-compat 的 warn 属 §5 另一立项，不在本验收面）。

### 4.3 e2e 影响面评估（项目 MANDATORY，原缺 [F7]）

改动文件经 `scripts/select-affected-e2e.mjs` 圈定：

| 改动 | 受影响 e2e | 层级 |
|---|---|---|
| `extensions/universal/subagent-workflow/src/host/pi-host.ts` | `E2E-REAL-01` / `E2E-BATCH-01` / `E2E-BATCH-03` / `E2E-BATCH-04` / `E2E-RESUME-01` | L2/L3/L1 |
| `scripts/bundle-extensions.mjs` | `E2E-PLUGINCONTRACT-01`（scope 含该脚本＝"链变更随契约脚本回归"） | L3 |

处置：L3 项（`E2E-BATCH-01`、`E2E-PLUGINCONTRACT-01`）**不进 PR 门禁**，登记进 dev-flow 验收计划表，
空载串行跑（`TAIJI_PI_LIVE=1` 轨）；L1/L2 由 CI/固定环节覆盖。

### 4.4 三形态回归

dev（`pnpm dev`）与 npm 安装形态各跑一次 §4.2 a–d 抽样。

## 5. 同族审计结论

本节是审计证据与判据的登记处；**三项治理项已由用户裁定纳入本设计范围**，其具体设计见第二部分
（§8 d8-compat / §9 降级可见性 / §10 滤镜收紧），验收与施工顺序见 §7。

- **已设防先例**：plan `templates/`（PACKAGE_ASSET_DIRS + verify 门）。注意 [A-AUD-9]：骨架位于
  `node_modules/` 下，**不在** `PACKAGE_ASSET_DIRS`（其 key 语义是 `<staged>/<pkg>/<dir>`）的语义内，
  需在共享登记表中新增键位/条目（见 F2），不能直接复用 templates 条目；
- **滤镜语义与注释不符（事故直接成因）** [A-AUD-3，主会话已用仓库 minimatch 实测]：
  `!**/README.md` 是递归语义，会删任何嵌套 README（含 `workflows/README.md`）。修正模式实测：
  | 模式 | `@zhushanwen/pi-x/README.md` | `@zhushanwen/pi-x/workflows/README.md` |
  |---|---|---|
  | `!**/README.md`（现状） | EXCLUDED | **EXCLUDED（事故）** |
  | `!/README.md`（原文档建议） | KEPT | KEPT → **inert，等于不改** |
  | `!*/*/README.md`（正确） | EXCLUDED | **KEPT** |
  建议：`!**/README.md`→`!*/*/README.md`、`!**/ARCHITECTURE.md`→`!*/*/ARCHITECTURE.md`
  （`*/*` = `@zhushanwen/<pkg>` 包根层），并同步 yml 注释；切勿用 `!/README.md`；
- **第三处同根静默失效（新登记）** [A-AUD-1]：`subagent-core/src/execution/engine/d8-compat.ts:115-126`
  的 `corePackageDir()` 在 staged bundle 下上溯越界（→ `.../Resources`），vendor 引擎定位恒失败、
  每次扩展加载 warn 一条（今日 13 / 历史 39 条，主会话实测）；当前由 `TAIJI_AGENT_ENGINE_ROOTS`
  L1 通道兜住（descriptor overwritten），env 缺失即退化为 `engine_not_found`。修复方向与本文同源
  （布局感知或显式注入），**应一并立项**；
- **降级可见性治理（两类，机制不同）** [A-AUD-4 修正]：
  - `corePackageNpmRoot()`：catch 内 **warn** → 落 pi-host 日志（162 条/天无人读）；
  - `hostPackageNodeModulesRoot()`：**无 warn 无异常**，staged 下静默返回不存在的
    `<extensions>/node_modules`（`pi-host.ts:166` 实测推演）；
  建议：能力级降级提升为会话可见（启动提示或注入段空态注明"内置项缺失及恢复路径"）；
- **已排查无实害（修正表述）** [A-AUD-2]：打包态 `resolveStructuredOutputPeer` **不会被调用**——
  主进程 argv 白名单段已命中 staged `pi-structured-output`（`pi-spawn-markers.json` 实证），
  `resolveGrandchildExtensionPaths` 在 `whitelisted.length > 0` 时短路（`pi-host.ts:268`）；
  peer 解析只是独立 pi 形态回退源。即便回退为空集，schema 任务也由 engine 侧
  `assertSchemaEnforcementArmed` 断言② fail-fast，不会静默完成。（原文档"失败回退空集属设计内"
  描述的是未发生的事件，证据链不成立——已修正）；
- **zcode 存疑项已判定** [A-AUD-8]：zcode 引擎进程**结构上不需要** core 发现面（`zcode-subagent-cli`
  只依赖 `subagent-engine-sdk`，SDK 契约禁止 import core；emulated schema 引擎无孙进程扩展依赖），
  agent/systemPrompt/tools 由宿主在 pi 进程解析后经 wire task 下发。原"存疑待验"问错了对象——
  真正要跟踪的是 d8-compat（上条）。[UNVERIFIED：建议补一次打包态 `engine: zcode` + 显式内置角色
  路径的派发，断言 wire task 携带完整 systemPrompt/工具白名单]。
- **同类面全景（每处 `import.meta.url`/`require.resolve` 资产解析的打包态裁决）** [A-AUD-10]：
  permission wasm ✅（bundle-dir 优先，产物在）、plan templates ✅、**pi-host:74 ❌（本 bug）**、
  **pi-host:166 ⚠️（静默错路径）**、pi-host:311 ➖（打包态不执行）、**d8-compat:118 ❌（同根 warn）**、
  runtime plugin-host ✅（CJS `__dirname` 分支优先）。非 index.js 产物资产逐个裁决后结论：
  **除 README 锚点外，没有第二处"产物在但无人能消费"的运行时资产**。

---

## 6. 对抗式审查结论（三路并发）

### 6.1 rev-regression（回归面 / 影响半径 / 替代设计）— 已回收，关键条目主会话已独立核实

**裁决**：机制方向可接受（方案 A 结构性优于 B/C/D；审查员明确回答"没有比 A 更单源的替代"），
但按原文档形态施工不安全；**回归面本体无回退风险**（三平台 extraResources、dev/npm/独立三形态、
扩展加载扫描、引擎发现、CA2 快照族全部代码级核查通过）。

**must-fix（均已并入正文）**：

| # | 问题 | 主会话复核结果 | 落入本文位置 |
|---|---|---|---|
| F1 | 删顶层 `workflows/` 会使 CI 固定环节 TC8 变红（原文档漏登记）；TC8 = `builtin-ext-bundle.test.mjs:152-171`，`.github/workflows/ci.yml:300` 固定跑 | ✅ 已核实 | §2.1-1（改为"保留顶层拷贝"以规避；若删则三项同步改动必须同批） |
| F2 | 新 verify 断言须 per-package 条件化 + 进 `staged-asset-dirs.mjs` 共享登记表（否则 mirror fixture 转红 + 违反 MF-1-17 单源纪律、结构守卫 grep 不到会静默漏检） | ✅ 已核实（fixture 为自造最小 SSOT） | §2.1-3、§5 首条 |
| F3 | 骨架 `package.json` exports 条件形态未指定 → 写成 `import`-only 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，修复静默失效 | ✅ 采纳（沙箱复现过 CJS 解析语义） | §2.1-1（改为整份拷贝真实文件，结构性消除） |
| F4 | 骨架落点歧义必须钉死 | ✅ 采纳 | §2.1-1、§3 |
| F5 | "workflows×7"实为 **6** | ✅ 主会话实测 6 | §1.5、§2.1-3、§4.2 |

**should-fix/nit（已择要并入）**：F6 单测清单修正（§3）、F7 e2e 影响面（§4.3）、F8 三处事实错误
（§1.6/§2.1-1/§2.2 已改）、F9 整份拷贝 package.json（§2.1-1）、F10 publish-surface 锚点断言（§4.1）、
F11 `startsWith(STAGED)`（§2.1-3/§3）、F12 yml 反向禁令注释（§2.1-4）。
**F13**（构建链/清理/eslint/postbuild 入口/扩展加载/引擎发现/CA2 快照）审查员逐项核查**无问题**。

**审查员声明待实测**：[UNVERIFIED-R1] 真机 `build:dir` 后核对嵌套 `node_modules` 是否随 `extraResources`
入包（代码级已确定）；[UNVERIFIED-R2] `npm pack --dry-run` 确认 npm tarball 含 `workflows/fan-out.js`。
**R2 已由主会话关闭**：`npm pack --dry-run`（`packages/subagent-core`）实测 tarball 含 `workflows/fan-out.js`
（13.0kB，另含其余 5 脚本 + `README.md` + `review-fix-loop-utils.{cjs,d.cts}`）与 `agents/*.md` × 10
（含 `agents/general-purpose.md`）——换锚与骨架内容在 npm 发布形态同径成立。**R1 待实施首日跑一次**（低成本、可一次性关闭）。

### 6.2 rev-mechanism（机制正确性 / 三形态成立性）— 已回收，关键条目主会话已独立核实

**裁决**：**有条件成立**。核心机理经真机复现成立（骨架就位 → `corePackageNpmRoot()` 返回 scope 目录 →
npm 槽扫描命中 agents 10 / workflows 6、invalids 0；换锚 `fan-out.js` 在 Node 与 Bun 下均 resolve 成功）；
但作为实施依据需修两处 must-fix。

**审查员逐题结论**（问题 → 结果）：

| # | 题目 | 结论 |
|---|---|---|
| 1 | 骨架 resolve 语义与 npm 槽语义是否成立 | ✅ 成立（实测 agents 10 / workflows 6，无 invalid） |
| 2 | 真实引擎加载器的解析基准是否与 node 复现一致 | ✅ 一致；且确认**运行时解析器是 Bun**（`ResolveMessage` 为 Bun 错误类，`bun -e` 复现文案与运行时日志逐字同形） |
| 3 | 锚点换 `fan-out.js` 是否三形态成立 | ✅ 均成立（tarball / workspace symlink / 骨架） |
| 4 | 移除顶层 `workflows/` 的机制影响 | ⚠️ 发现两处漏网：TC8 必红；**resume 旧 scriptPath 断链**（本修新引入） |
| 5 | 滤镜杀伤面 | `!**/*.d.ts` **不**误删 `.d.cts`（原猜测相反）；`!**/README.md` 连骨架内 README 一起删（F3 关键）；skills 幸存 |
| 6 | 竞争解释是否穷尽 | ✅ 站得住（但原文档对方案 B 的否决理由错，见 F8） |

**must-fix / 重要项（均已并入正文）**：

| # | 结论 | 主会话复核 | 落入本文位置 |
|---|---|---|---|
| F1 | TC8 必红（与 rev-regression F1 重合） | ✅ 已核 | §2.1-1（分批保留 → TC8 不动）、§3 |
| F2 | **骨架放 `<extensions>/node_modules` 会被 electron-builder 整目录丢光**（`app-builder-lib/out/util/filter.js:43` 硬编码 `relative === "node_modules" → false`）；且错放会跨构建残留 | ✅ 已核代码 + 实测（主会话读源确认） | §2.1-1（硬约束）、§2.1-4 |
| F3 | 骨架与换锚是**合取对**：骨架自带的 README 也被删，只加骨架仍失败 | ✅ 采纳 | §2.1-2、§1.3 |
| F4 | resume 断链（升级前中断 run） | ✅ 代码链已核（resume-run:863 → worker-host:55 → fan-out:78-79） | §2.1-1（分批理由）、§3 |
| F5 | 计数 6 非 7 | ✅ 一致 | §1.5、§4.2 |
| F6 | 骨架 `package.json` **不需要 exports**，白名单反成未来锚点陷阱（如锚点到 `agents/` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`） | ✅ 采纳（改为程序化派生 `{name,version,type}`） | §2.1-1 |
| F7 | `pi-host.test.ts` 仅 2 处（非 4 处） | ✅ 一致 | §3 |
| F8 | 原对方案 B 的否决理由**错**；提出更省的修正版 B′（回退到 staged 根 + 补 agents 拷贝） | ✅ 采纳为真实备选 | §2.2（重写） |
| F9 | 门禁跑 Node、运行时是 Bun（本次事故同类错配） | ✅ 采纳（加"在 pi 进程内 resolve"冒烟步） | §4.1 |
| F10/F11 | 两处事实/计数错误：日志 162 实为 **202**（当天文件全部是该 warn）；yml 注释"7 个 SKILL.md"实际 **10** 个；"骨架无 README/d.ts/map"前提不准 | ✅ 主会话重测确认（202 / 10） | §1.2、§2.1-4（yml 注释纠错另记） |

**可直接采纳的实测方法**（审查员附）：用真实 `app-builder-lib` matcher 跑 yml 的 extensions filter 验证骨架各落点；
用 `bun -e` + 真实 core 源跑 `discoverResources` 验证发现结果——两者都能直接接进 §4.1 的门禁断言。

### 6.3 rev-audit（根因完备性 / 静默降级面 / 验证计划）— 已回收，关键条目主会话已独立核实

**裁决**："没有别的问题了"**不成立**（部分成立）：本 bug 的技术机制定位正确，但原 §5 作为收口
不完备且含两处机制性事实错误。

| # | 结论 | 主会话复核 | 落入本文位置 |
|---|---|---|---|
| A-AUD-1 | **漏了第三处同根静默失效**：`d8-compat.corePackageDir()` 打包态上溯越界、warn 恒发（今日 13 / 历史 39 条） | ✅ 代码 + 日志计数实测 | §1.6 表、§3 双宿主行、§5 第三项 |
| A-AUD-2 | §5"resolveStructuredOutputPeer 失败"描述的是**未发生的事件**（打包态该分支不执行，whitelist 短路） | ✅ 代码逻辑 + markers 实证 | §5 已排查项（改写） |
| A-AUD-3 | §5 滤镜补救建议 `!/README.md` **实测 inert**；正确模式 `!*/*/README.md` | ✅ 仓库 minimatch 实测三模式 | §5 第二项（含对照表） |
| A-AUD-4 | `hostPackageNodeModulesRoot` **不失败不打日志**，静默返回不存在路径——与 `corePackageNpmRoot`(warn) 机制不同 | ✅ 路径推演实测 | §1.6 表、§5 治理项 |
| A-AUD-5 | §1.5"默认单派发被连带"结论错误：省略 agent 时**不加载** agentConfig，与发现链无关；显式点名失败是 loud throw | ✅ 代码三处（run-orchestration/record-access/agent-registry） | §1.5（已改写） |
| A-AUD-6 | §4 验证计划对"滤镜剪枝"结构性失明：resolve 冒烟须区分 **pre/post-package**；附 4 条命令级断言 | ✅ /tmp 复刻（pre 绿 / post 红） | §4.1（新增 4 条断言） |
| A-AUD-7 | "verify 在 CI 生效"措辞不准（CI 经 builtin-ext-bundle 间接跑 dev staged） | ✅ 已核 | §4.1 |
| A-AUD-8 | zcode 存疑项**问错对象**：zcode 结构上不需要 core 发现面；要跟踪的是 d8-compat | 采纳（附 [UNVERIFIED] 实验建议） | §5 末两项 |
| A-AUD-9 | §5 首条"复用 templates 机制"不成立（骨架在 node_modules 下，不在 PACKAGE_ASSET_DIRS 语义内） | 采纳 | §5 首条 |
| A-AUD-10 | 同类面全景清单（每处资产解析的打包态裁决）+ 非 index.js 资产逐个裁决 | 采纳 | §5 末条 |

**根因表述修正（A-AUD-10/Q5）**：三锁**不是等价三把**——条件乙（锚点被剪枝）是**必要条件不可省**
（只修甲后产物仍坏，已实证）；条件甲是解析面；"孤儿资产"不是独立锁，是条件甲在发现面的投影。
最小充分条件 = "锚点在打包产物内可解析"。§1.6 已按此重写并显式登记同类残留（d8-compat /
hostPackageNodeModulesRoot），说明本类问题是**系统性机理**而非单点写错。

---

## 7. 统一施工计划（四工作流）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| S0 前置 | 闭合 [UNVERIFIED-R1]（`build:dir` 核对嵌套 node_modules 入包且未被 `filter.js:43` 误伤） | — |
| S1 主修复 | §2.1：bundle 骨架拷贝（钉死 `<pkg>/node_modules` + 派生 package.json）+ 锚点换 `.js` + verify per-package 断言 + 共享登记表条目；**本批保留顶层 `workflows/` 拷贝**（避开 TC8 与 resume 断链） | S0 |
| S2 门禁 | §4.1 五条命令级断言（post-package resolve / 滤镜静态对账 / 资产清单对账 / 产物资产存活 diff / pi 进程内 resolve）+ e2e 登记 | S1 |
| S3 滤镜收紧 | §10：yml 模式收紧 + `check_asset_survival()` 护栏（**建议与 S1 同批**，与主修复共用存活 diff） | S0 |
| S4 降级可见性 | §9：tier1 契约+渲染+运行期自检（与 S1 同批，直接防复发）→ tier2 用户可见 → tier3 约束登记+检查脚本 | S1（骨架在位才好做故障注入验收） |
| S5 d8-compat | §8：`corePackageDir()` 形态校验 + warn 语义/时机纠偏 + 终局对账回执（复用 §9 回执通道） | S4 回执通道 |
| S6 收口 | 删顶层 `workflows/` 拷贝（同批改 TC8/V1-④/架构文档，release notes 说明跨升级 resume 一次性影响） | S1–S5 全绿 + 一个发布周期 |

**e2e 纪律**：S3–S5 各自落地时按项目规则跑 `node scripts/select-affected-e2e.mjs --base <ref>` 重新圈定
（本文 §4.3 的表仅覆盖 S1 的 pi-host/bundle-extensions 两项）；L3 轨登记进 dev-flow 验收计划表，不进 PR 门禁。

---

# 第二部分：同族三项修复（同批交付）

## 8. d8-compat 同根修复（S5）

### 8.1 问题（同根、不同果）

`packages/subagent-core/src/execution/engine/d8-compat.ts:115-126`：

```ts
function corePackageDir(): string | undefined {
  moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", "..", "..");   // 假设 <pkg>/src|dist/execution/engine/
}
```

注释预设两种形态："src 与 dist 同构 ⇒ 上 3 级是包根"、"不可得（bundle 进宿主无文件位置语义）⇒ undefined"。
但打包态 `import.meta.url` **存在**（esbuild ESM 保留），只是语义错：模块变成
`<Resources>/extensions/@zhushanwen/pi-subagent-workflow/index.js`，上 3 级 = `.../Contents/Resources`
⇒ vendored 定位指向 `.../Contents/zcode-subagent-cli`（不存在），途经三重校验后失败并打 warn：

> `[d8-compat] engine 'zcode' vendored package not located … left unregistered — dispatch will fail with engine_not_found + recovery guidance`

**两个独立缺陷**：① 拿到"看似合法实则错位"的目录（而非注释预设的 undefined）；② warn 的断言是假的
（紧随其后 `TAIJI_AGENT_ENGINE_ROOTS` 会发现器注册真 descriptor 并 overwrite：
`[engine-discovery] descriptor overwritten`）。真实风险 = 通道①在打包态永久失效、全靠通道②兜。
调用点：`extensions/universal/subagent-workflow/src/index.ts:125`（`syncEnginesFile()` 之前）。

### 8.2 改动

1. **`corePackageDir()` 加形态校验**（core）：上溯 3 级后校验锚点——`<coreDir>/package.json` 可读且
   `name === "@zhushanwen/subagent-core"`（或 `<coreDir>/workflows/README.md` 存在）；不成立 ⇒ 返回
   `undefined`（回到注释已声明的"不可得"语义）。
2. **与主修复共用布局判断**（单源）：把"staged/bundle 形态 + core 资产根"抽为一个 core 内函数（如
   `engine/layout.ts`），`pi-host.corePackageNpmRoot()` 与 `d8-compat.corePackageDir()` 共同消费——
   避免两处各写一套布局猜测（这正是本类问题的成因机理）。
3. **warn 语义与时机纠偏**：删掉"dispatch will fail"这一错误断言；改为装配末尾
   （`syncEnginesFile(getAgentDir())` 之后）做**终局对账**：期望引擎集 vs registry 已注册集，缺失者经
   §9 的回执通道上报（带恢复指引），而不是在通道①失败时就下结论。
4. **测试**：`packages/runtime/src/services/session/__tests__/d8-compat.test.ts` 增用例——
   "模块位于无 package.json 的目录（bundle 形态）⇒ `corePackageDir()` 返回 undefined 且不产生 warn"；
   保留 dev/npm 布局的 vendored 命中用例。

### 8.3 验收

- 打包态 `subagents-*.log` 不再出现该 warn；`engines.json`/descriptor 的 source 为 `TAIJI_AGENT_ENGINE_ROOTS`；
- **故障注入**：unset `TAIJI_AGENT_ENGINE_ROOTS` 起打包 app → 派发 zcode 得 `engine_not_found` + 恢复指引；
- dev/npm 形态 vendored 定位仍命中（既有单测族）。

### 8.4 风险

校验只在"上溯结果不是 core 包根"时触发，dev/npm 布局天然通过；改动集中在 core 引擎层，不涉协议面。

---

## 9. 能力级降级 → 会话可见（S4）

### 9.1 问题与判别标准

| 降级点 | 现状可见性 | 后果 |
|---|---|---|
| `pi-host.corePackageNpmRoot()` | warn → 文件日志（今天该文件 202 行全是它） | 内置 workflow/agent 全灭（本次事故静默一个版本） |
| `pi-host.hostPackageNodeModulesRoot()` | **连 warn 都没有**（静默返回不存在的路径） | env 兜住时无害；env 缺失即引擎不可发现 |
| `d8-compat.registerZcodeEngine()` | warn，但文案与实际后果不符 | 通道①失效、通道②兜住 |

**判别标准（先立标准，否则会退化成噪声）**：降级导致**用户可感知能力消失** ⇒ 能力级，必须可达；
降级属**设计内形态差异**（如独立 pi 形态未装 optional peerDep） ⇒ debug 即可。按此，
corePackageNpmRoot / d8-compat 终局缺失是能力级；hostPackageNodeModulesRoot 取决于 env 是否注入。

### 9.2 改动（三层，同批做 tier1，tier2/3 紧随）

**tier1 —— 模型可见（必做，最省，复用现成渲染）**

1. **契约**（`packages/subagent-core/src/core/host-services.ts`）：`discoveryRoots()` 返回值增可选字段
   `degradations?: ResourceDegradation[]`（additive，不破坏现有宿主实现）；
   ```ts
   export interface ResourceDegradation {
     kind: "agents" | "skills" | "workflows" | "engines";
     subject: string;    // 如 "@zhushanwen/subagent-core"
     reason: string;     // 如 "core root resolve failed: Cannot find module …"
     recovery: string;   // 如 "确认 staged 骨架存在；重跑 bundle-extensions.mjs"
   }
   ```
2. **生产点**（pi 壳/引擎层）：`corePackageNpmRoot()`、`hostPackageNodeModulesRoot()`、d8-compat 终局对账
   失败时 push 记录（不再只是一行 log）。
3. **消费点**（`src/injectors/resource-list-injector.ts`）：把 degradations 映射为已有
   `InvalidResource { path, reason }`（`path = subject`，`reason = \`${reason}；恢复：${recovery}\``）并入
   `invalids` —— 直接复用 `injection-render.ts` 的 `invalidResourceLines()`：条目段（`formatWorkflowList`）
   与空态段（`formatEmptyResourceList`）都会渲染。**效果**：agent 每轮都能看到"内置能力缺失 + 原因 + 恢复命令"。
4. **运行期自检**（扩展装配末尾，`extensions/universal/subagent-workflow/src/index.ts`）：断言"本包声称
   内置的 workflow/agent 至少发现到 1 个"，为零则产生同样回执——把"文件在包里但扫不到"变成运行期可观测。

**tier2 —— 用户可见（建议）**：每 session 首条 `pi.appendEntry("taiji:capability-degradation", {...})`
留痕（`appendEntry` 已在扩展 API 面；`pi-system-prompt-trace` 是同款留痕范式），并在 session-trace 域
新增行类型——挂载点已存在：`packages/core/src/domain/session-trace/trace-rows.ts`（`SYSTEM_PROMPT_CUSTOM_TYPE` 同处）
+ renderer 行渲染 + 按项目规范加 testid 断言。若本批不做 renderer，tier1 已消除"agent 侧不可见"这一半。

**tier3 —— 机器可见（结构收口）**：`docs/constraints.json` 登记"**能力级降级必须产生回执，禁止 warn-only**"
（与 C-pi-12/13 同族），并入库一张"能力级降级点清单"（单源）；检查脚本
`scripts/check-capability-degradations.mjs` 扫清单是否都接了回执通道，pre-commit/CI 挂载
（范式参照 `scripts/check-vitest-guard.mjs`）。新增降级点漏接清单同样红。

### 9.3 验收

- 故障注入（临时删骨架/改锚点）+ 打包 app → injector 输出出现具名 invalids 行（含原因与恢复）；tier2 落地后 GUI 可见；
- 正常态**零新增噪声**：对比 baseline 的日志条数与注入段字节（KV-cache 敏感面）；
- tier3：清单内每点都能被脚本定位到回执调用（脚本自测含反向用例）。

### 9.4 风险

主风险=回执噪声；靠"判别标准分级 + 每 session 一次（tier2）+ 只对能力级回执"收敛。
契约变更是 additive 可选字段，不破坏 zsw 壳/测试宿主。

---

## 10. electron-builder 滤镜语义收紧 + 存活护栏（S3）

### 10.1 问题

`apps/electron/electron-builder.yml` extensions 段注释声称"**包根级**文档"，但模式 `!**/README.md` /
`!**/ARCHITECTURE.md` 是**递归**语义——实测（仓库 minimatch）：`@zhushanwen/pi-x/workflows/README.md`
被删。本次恰好删掉解析锚点（条件乙）。同类风险：任何未来把嵌套 README/ARCHITECTURE 当运行时资产的包
都会被静默剪枝。附：同一注释里"7 个 SKILL.md"已陈旧（实测 **10** 个）。

### 10.2 改动

1. **模式收紧**：`!**/README.md` → `!*/*/README.md`；`!**/ARCHITECTURE.md` → `!*/*/ARCHITECTURE.md`
   （`*/*` = `@zhushanwen/<pkg>` 包根两层）。对照表（已实测）：

   | 模式 | `@zhushanwen/pi-x/README.md` | `@zhushanwen/pi-x/workflows/README.md` |
   |---|---|---|
   | `!**/README.md`（现状） | 删 | **删（事故）** |
   | `!/README.md` | 留 | 留 → **inert，等于不改** |
   | `!*/*/README.md`（本设计） | 删 | **留** |

   **失败方向安全**：模式比现状窄，布局若变化后果是"文档未被删掉"（多几 KB），而非"运行时资产被删"。
2. **注释纠偏**：把"包根级"改为实际表达，修正 SKILL.md 计数（7→10）；保留 `!**/*.md` 禁令。
3. **存活护栏**（比模式本身更重要）：`scripts/postbuild-validate.sh` 增 `check_asset_survival()`
   （与既有 `check_staged_engines()` 并列）：pre-package `resources/extensions` vs post-package
   `Contents/Resources/extensions` 文件集 diff，**任何删除必须落在显式白名单**：
   `*.map` / 包根 `README.md`+`ARCHITECTURE.md` / `__tests__/**` / `*.test.*` / `*.d.ts` /
   tree-sitter `src/**`+`grammar.js` / `web-tree-sitter/debug/**`。白名单为单源常量（脚本内导出，供测试消费）。
4. **反向禁令注释**（yml）：extensions 段禁加 `!**/node_modules/**`（相邻 plugins 段有之，后人"统一风格"
   会静默抹掉骨架），并注明 electron-builder 内建丢弃相对路径恰为 `node_modules` 的目录（`filter.js:43`）。
5. 打包子系统核对清单（`dev-merge/agents/review-electron-build.md`）补一行：滤镜排除模式变更 ⇒ 必须同步白名单。

### 10.3 验收

- `build:dir` 后 `find Contents/Resources/extensions -name README.md`：`pi-subagent-workflow/workflows/README.md`
  **应重新出现**；
- `check_asset_survival()` 正常构建 exit 0；人为把 `workflows/fan-out.js` 加进排除模式 → **必须红**（反向用例）；
- 骨架落点（`<pkg>/node_modules/...`）在存活 diff 中不出现删除记录。

### 10.4 风险

`*/*` 绑定当前两级布局（`@zhushanwen/<pkg>`）：布局若增层，后果是漏删文档（安全方向）；
白名单过宽会削弱护栏 → 白名单本身要有反向测试（确保任一白名单项被误加为排除时红）。

---

## 11. 四工作流验收矩阵

| 工作流 | 构建期门禁 | 运行期自检/回执 | 人工验收 | 单测 |
|---|---|---|---|---|
| S1 主修复 | verify per-package 断言 + post-package resolve + 资产清单对账 | （由 S4 自检覆盖） | §4.2 a–e | pi-host 换锚 + 骨架 resolve |
| S3 滤镜收紧 | `check_asset_survival()`（post-validate） | — | build:dir README 存活 | 白名单反向用例 |
| S4 降级可见性 | tier3 检查脚本（清单↔回执） | tier1 invalids 渲染 + 装配末尾自检 | 故障注入回执可见 | 契约 additive + 渲染快照 |
| S5 d8-compat | — | 终局引擎对账回执 | 故障注入 `engine_not_found` | bundle 形态 → undefined |

**共性验收材料**：一份"故障注入矩阵"（删骨架 / 改锚点 / unset 引擎 env / 把资产加进排除模式）——
四工作流的运行期与构建期防线都被这四个注入项覆盖，建议作为本批交付的固定验收脚本（可进 e2e 或
postbuild 冒烟）。

---

# 第三部分：实施记录（2026-10-03）

## 12. 已落地：档 2 / 方案 B′（用户裁定）

**范围裁定**：只做"最小修复 + 1 条防复发门禁"；三项同族（§8 d8-compat / §9 降级可见性 / §10 滤镜收紧）**本批不做**，设计留在本文第二部分备查。

**主方案从 A 切换为 B′**（理由，见 §2.1/§2.2 与本次成本复核）：A 需要造伪安装包（假 package.json + 假 node_modules），由此**自带**一串约束——`filter.js:43` 落点陷阱、TC8/resume 连锁、5 条门禁断言、两阶段保留/删除拷贝。B′ 把约束本身去掉：

> **B′ = `corePackageNpmRoot()` resolve 失败时回退到 staged scope 根**（`<Resources>/extensions/@zhushanwen`，其一级子项正是各 `pi-*` 包目录，天然满足 npm 槽语义）+ **把 core 的 `agents/` 也拷进 staged 扩展目录**（`workflows/` 本来就在）。

不造伪包、不换锚点、不动顶层 `workflows/` 拷贝 ⇒ TC8/V1-④/resume/锚点字面量**全部不受影响**。

### 12.1 落地清单（3 改 + 1 新测试）

| 文件 | 改动 |
|---|---|
| `extensions/universal/subagent-workflow/src/host/pi-host.ts` | `corePackageNpmRoot(moduleUrl?)` 增回退分支 + 导出纯函数 `stagedScopeRootFromModuleUrl`（形态判据 = 父目录名以 `@` 开头；dev/npm 形态先走 resolve 成功分支，回退不可达） |
| `scripts/bundle-extensions.mjs` | 新增 `SUBAGENT_CORE_AGENTS_DIR` / `AGENTS_DIR_PACKAGES` / `copyAgentsDir()`，为 subagent-workflow 拷 `packages/subagent-core/agents/` → staged 包目录（fail-fast；与 `copyWorkflowDir` 同构） |
| `scripts/postbuild-validate.sh` | 新增 `check_builtin_ext_assets()`（三平台接线）：① `{workflows,agents}` 存在；② 数量与 `packages/subagent-core` 同量（**不写死数字**）；③ **存活 diff**——pre-package vs post-package 文件集差，任何删除须落在精确白名单（包根文档严格一级 `./<pkg>/README.md`，非递归） |
| `extensions/.../src/host/__tests__/staged-discovery.test.ts`（新） | **产出级门禁**：合成 staged 布局（tempdir，无向上 node_modules）→ 断言回退公式 + 真实 `discoverResources` 结果与源目录**逐文件一致**（workflows 6 / agents 10）+ 负向空态 |

合计 ~176 行（含注释）。**未改动**：`workflows/` 顶层拷贝、锚点字面量、TC8、V1-④ 探针、任何既有测试。

### 12.2 验证结果

| 项 | 结果 |
|---|---|
| `extensions` typecheck（`npx tsc --noEmit`） | ✅ 无错误 |
| eslint（改动三文件） | ✅ 0 error |
| 扩展全量测试（`extensions/universal/subagent-workflow`） | ✅ **1034 passed / 1 skipped（84 文件）** |
| `scripts/__tests__/builtin-ext-bundle.test.mjs`（含 TC8） | ✅ 16 passed |
| `scripts/verify-staged-extensions.mjs` | ✅ 全部通过（18 import + 2 降级 / 20 包） |
| `scripts/check-extension-files.mjs` | ✅ 白名单一致（29 包） |
| 新门禁 `staged-discovery.test.ts` | ✅ 7 passed |
| `check_builtin_ext_assets()` 演练（4 例） | ✅ 正向过；负例全部拦下并点名文件（删 `workflows/README.md` = 历史事故形态 / 删 `fan-out.js` / 删整个 `agents/`） |
| 真机 `build:dir` + 产物侧发现断言 | ✅ 26s 构建通过；产物 `.../pi-subagent-workflow/{workflows(6),agents(10)}` 均在；`postbuild-validate.sh --dir-only` 三项资产断言全绿（含存活 diff） |
| postbuild 其余失败项 | ⚠ 仅 `Resources/pi 存在 symlink: pi-darwin-arm64`（**既存环境问题**：`resources/pi/*` 是指向 workspace 级 `.pi-binary-cache` 的 symlink，本地构建必触发，与本次改动无关，CI 真二进制不受影响）与未签名警告 |

**过程中被门禁自己抓到的两个 bug**（说明护栏有效）：① 白名单模式写成两级，而传入根已是 scope 目录（相对路径只有一级）→ 正向假红；② 中文文案里 `$wf_src（` 紧跟全角括号，bash 贪婪解析把多字节首字节并入变量名，`set -u` 下报"未绑定变量" → 失败路径真 bug。两处均修（`${}` 显式界定）。

### 12.3 额外落地的一行（原属 §10，因门禁要求提前）

**`electron-builder.yml`**：`!**/README.md` → `!*/*/README.md`；`!**/ARCHITECTURE.md` → `!*/*/ARCHITECTURE.md`（附语义注释与事故记录；顺带修正陈旧计数 7→10）。

**为何提前**：本批新增的存活 diff 护栏要求“任何非白名单删除即红”，而旧递归模式恰好会删
`pi-subagent-workflow/workflows/README.md`（非包根文档）——两者**无法同时成立**：要么放宽白名单（等于
容忍事故形态），要么收紧滤镜。选后者（1 行、语义已逐模式实测；收紧后产物实测：`workflows/README.md`
保留、包根 `README.md` 仍删）。§10 的其余部分（打包核对清单补行等）仍延后。

### 12.4 真机验收（本机执行，A/B 对照，2026-10-03）

无需 CI：直接用**产物内的 pi 引擎 + 产物内的扩展**跑同一条命令，对比「修复前/后」两个打包产物。
命令形态（`-ne` 关自动发现，只显式加载被测扩展；agent dir 用临时种子目录，不污染真实数据目录）：

```
PI_CODING_AGENT_DIR=/tmp/pi-accept-agent <app>/Contents/Resources/pi/pi-darwin-arm64 \
  -p -ne -a --session-dir /tmp/... --model <model> \
  -e <app>/Contents/Resources/extensions/@zhushanwen/pi-subagent-workflow \
  "列出 <available_workflows> / <available_subagents> 段内容"
```

| 产物 | workflows | subagents |
|---|---|---|
| **旧**（未修复，`feat-remote-use-taiji` 的 builder-output） | 仅用户级 3 个，**无内置** | 仅用户级 4 个，**无内置** |
| **新**（修复后，本 worktree 的 builder-output） | 用户级 3 + **内置 6**（chain/fan-out/map-reduce/parallel/review-fix-loop/scatter-gather） | 用户级 4 + **内置 10**（analyst/coder/…/general-purpose） |

工具路径亦已实测：新产物内调用 `subagents` 批量工具 → **成功派发**（`fan-out-musk0nkr`，1 subagent，无报错）；
修复前同一调用即报 `Built-in workflow 'fan-out' is not available`。

### 12.5 待闭合

- **真机产物级验证**（[UNVERIFIED-R1]）：`build:dir` 后确认 ① `Contents/Resources/extensions/@zhushanwen/pi-subagent-workflow/{workflows,agents}` 均在且与源同量（`check_builtin_ext_assets` 在 postbuild 里即此断言）；② 打包 app 内 `<available_workflows>` 列出 6 个内置模板、`subagents` 批量工具调用成功。
- **未做（按裁定）**：§8 d8-compat、§9 降级可见性；§10 仅落地了滤镜模式一行（见 §12.3），其余部分
  （注释/核对清单）延后；S6 删顶层拷贝收口延后。
- **一个待裁决的交付问题**：本次改动落在 `feat-drawer-visualization-refactor` worktree（与抽屉可视化特性
  无关）；按 DEV-WORKFLOW 建议独立 `fix-*` 分支/ worktree 交付，待用户裁定后再提交。
