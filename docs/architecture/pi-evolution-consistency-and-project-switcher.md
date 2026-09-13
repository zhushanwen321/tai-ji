# 三项优化的终态架构：pi 演进一致性与项目切换

> **一句话结论**：三个问题中，问题 1（pi 升级）与问题 2（模型列表）暴露的是**同一个架构缺口的两个投影**——「pi 快速演进 vs xyz-agent 派生视图无一致性保障」，需要两个针对性收口（构建期版本锚点守卫 + 运行期模型目录单真相），且本次升级已产生两处可实证的漏同步（CI 混装配置 + 失守的测试基线）需立即修复；问题 3（侧边栏项目切换）无架构病灶，按已选型 3A 方案补一个排序数据模型决策即可实施。**不需要大重构。**

**层声明**：本文档是架构方向层设计——当前层 = 三问题实施后的现状与暴露的架构模式；下一层 = 各收口方向的可实施技术方案。不设计到接口签名与代码级细节。

---

## 1. 背景目标

### SCQA

- **情境**（S）：xyz-agent 桌面工作台的核心执行引擎是外部依赖 pi（npm `@earendil-works/pi-*` + bundled binary），pi 以周级频率发版演进；xyz-agent 在构建期与运行期都从 pi 派生了大量视图（版本锚点、provider 快照、模型目录）。2026-08-29 完成 pi 0.84.1→0.84.4 升级（问题 1）、远程模型目录 overlay 接入展示层（问题 2），侧边栏项目切换已选型待实施（问题 3）。
- **冲突**（C）：三件事的收尾审计发现——升级流程漏同步了两处派生点（CI 仍配 0.84.1 binary、快照指纹测试基线失守）；overlay 只接入了展示层，默认模型校验层仍只认编译期快照，会静默改写用户配置。
- **问题**（Q）：这三个问题是孤立的收尾工作，还是暴露了需要架构优化的共性问题？长期合理的终态是什么？
- **答案**（A）：问题 1+2 同根——「pi 演进的派生视图一致性」无机器保障，需两个收口；问题 3 独立，是纯交互升级 + 一个数据模型决策。本文档给出终态定义、方案对比与拆分路径。

### 系统是什么

xyz-agent = Electron 主进程 + Vue 3 渲染层 + Node.js runtime（WebSocket RPC）三层桌面应用。**pi 负责真正执行 AI 会话**：runtime 以 `--mode rpc` spawn pi binary 子进程，模型解析、provider 认证全部在 pi 侧完成。xyz-agent 围绕 pi 建立了自己的 provider/模型管理体系（models.json / auth.json / settings.json，经 `PI_CODING_AGENT_DIR` 重定向到 `~/.xyz-agent/pi/agent/` 与用户全局 `~/.pi/agent/` 隔离）。

两个本文档反复使用的核心概念（术语锚定）：

- **派生产物（derived artifacts）**：从 pi 上游推导、随 pi 版本演进必须同步的数据。例：编译期快照 `builtin-providers.json`、bundled binary 版本、CI 下载版本号。派生产物的特征是「上游变了它必须跟着变，但没人提醒」。
- **模型目录（model catalog）**：provider + 模型清单的统称。pi 上游是双层机制：**内置 catalog**（随 pi-ai 包发布，有数据构建时刻 `generatedAt`）⊕ **pi.dev 远程 overlay**（ETag 协商、4h 刷新窗，按 provider 逐个拉取）。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者体验表述 |
|---|------|--------------|
| G1 | 构建期派生一致性 | 开发者升级 pi 时改一处版本号，**守卫矩阵覆盖的**派生点漏同步被 CI/提交阶段机器拦截，而不是以「混装安装包」或「红测试」形式在下游暴露（A6 类纯文档锚点做一次性清理，不入常驻矩阵——其漂移仅为文档误导，无运行时影响） |
| G2 | 运行期目录单真相 | 用户在 UI 看到并选择的任何模型（含 overlay 新模型），在默认模型校验、会话创建、pi 执行三个环节被同等认可；用户显式设置不被静默改写——**唯一例外**是远程目录明确声明该条目过时/不存在（D5 态 2）时的 auto-fix 重选（伴随 console.warn） |
| G3 | 项目切换体验 | 项目切换 1 步点击完成；排序反映用户拖拽意图且跨重启稳定；徽章数字与点击后实际显示的会话数一致 |

### Scope

**In-scope**：
- pi 派生产物一致性守卫的设计（含修复本次已漏同步的两处）
- 模型目录「有效模型」视图在 xyz runtime 内部的统一（校验层接入 overlay）
- ProjectSwitcher 3A 方案的数据模型与排序语义设计

**Out-of-scope**（显式排除，防 scope creep）：
- pi 升级自动化（renovate 类 bot、自动 PR）——守卫「拦截漏同步」即可，升级动作仍人工发起
- overlay 浮出「快照外全新 provider」（理由见 D6）
- 问题 2 的真机验收（Settings → Provider 页确认 glm-5.3 可见）——属于已实施 commit `2bcdfb756` 的收尾验证，非本文档设计范围
- 模型列表 UI / Provider 页交互改动

---

## 2. 现状与问题分析

### 2.1 问题 1 现状：pi 派生产物的多点锚点，零一致性守卫

**派生产物全景**（全部经代码核实）：

| # | 派生点 | 位置 | 产生方式 | 漏同步症状 |
|---|--------|------|---------|-----------|
| A1 | npm 依赖版本（根 deps + pnpm.overrides 4 包 + packages/core + 24 个 extensions peerDeps） | `package.json:31-51` 等 | 手工编辑 | overrides 漏 `pi-agent-core` → lockfile 新旧双版本共存 |
| A2 | provider 快照 `builtin-providers.json`（含 `piAiVersion` / `catalogGeneratedAt` 头） | `packages/runtime/src/generated/` | `gen-builtin-providers.mjs` 从 node_modules pi-ai 提取；prebuild 或手动跑 | `--filter` 构建绕过 prebuild，静默用旧 JSON |
| A3 | bundled pi binary（6 件产物：binary/assets/wasm/theme…） | `apps/electron/resources/pi/`（gitignore，dev 为 symlink → workspace 级 `.pi-binary-cache`） | `prepare-pi-resources.sh`，`PI_VERSION` 默认值手工写（`:14`） | binary 与 npm 包错配 → RPC 协议漂移 |
| A4 | **CI 下载版本 env** | `.github/workflows/build.yml:47` `PI_VERSION: '0.84.1'` | 手工编辑 | CI 打「JS 0.84.4 + binary 0.84.1」混装包 |
| A5 | **快照指纹测试基线** | `packages/runtime/scripts/__tests__/gen-builtin-providers.test.ts:104-125`（t10：写死 1220 模型 / deepseek 精确 2 模型） | 手工维护 | 测试红（守卫自身成为派生锚点） |
| A6 | 手工镜像常量与文档锚点 | `packages/shared/src/constants.ts:58` `KNOWN_PI_API_TYPES`（注释自认「升级时人工 diff」）；`docs/troubleshooting.md:296` 等 | 手工维护 | 类型漂移无检测 |

**已发生的失败模式（本次 0.84.4 升级实证，非想象）**：

1. **A4 漏同步**：`build.yml:47` 仍是 `0.84.1`（注释还写着「与 prepare-pi-resources.sh 默认值对齐（0.84.1）」，而脚本默认值已是 0.84.4）。若此时打 tag 发版，CI 产物 = JS 层 0.84.4 + binary 0.84.1 混装包，无任何守卫拦截。
2. **A5 失守**：t10 基线写死 pi-ai 0.84.1 的指纹（1220 模型），0.84.4 快照实际 1290、deepseek 多出 `deepseek-v4-flash-vision-exp`。本机实跑确认红：`expected 1290 to be 1220`。该测试在 `ci.yml` test-runtime 全量路径内，**当前 CI 测试应处于红态**。

**根因**：pi 版本声明分散在 ≥4 类手工锚点上（A1/A3/A4/A5），其中 A1 类（npm 四包实装一致性）已由 main 合入的 `check-pi-semantics.mjs` 四包版本门禁覆盖（C-proc-08——且 2026-08-29 merge origin/main 时实际抓到 runtime pin 0.84.1 残留，守卫有效性的新鲜实证），**A2-A6 类构建期派生锚点仍是零守卫**。两守卫分工（防重复建设）：**实装内部一致 + pi 语义漂移归 check-pi-semantics；构建期派生锚点的跟随归本设计的 check-pi-sync**——其矩阵分两类基准：声明基准项（build.yml env / 脚本默认值 / extensions peerDeps）对根 package.json 声明比对；实装基准项（快照 piAiVersion / 快照新鲜度 / KNOWN_PI_API_TYPES / pi-tui）对 node_modules 实装比对（实装经四包门禁与声明锁定）。AGENTS.md 已记载升级 runbook（三件套），但两个漏同步都发生在有 runbook 的前提下——**文档挡不住多点手工同步，这是结构性失败模式，不是偶发失误**。

### 2.2 问题 2 现状：模型目录在 xyz-agent 内部有两套真相，与 pi 执行侧的第三套分叉

先澄清一个事实：问题 2 的表面症状（「导入 zai 供应商后看不到 glm-5.3」）的直接诱因是 **pi 0.84.1 快照滞后**；升级 0.84.4 后快照已含 glm-5.3 全家族（`zai` 7 模型，实查确认）。已实施的 overlay 机制（commit `2bcdfb756`）解决的是结构性缺口：**编译期快照恒滞后于上游，pi.dev overlay 是官方新鲜度通道**。该实施本身是正确的方向，本文档不推翻它，而是补齐它未覆盖的下游。

**模型目录物理数据流（现状）**：

```
【构建期】 node_modules pi-ai ──gen 脚本──▶ builtin-providers.json 快照（打进 runtime bundle）

【运行期数据源】
  ① 快照（编译期固定）
  ② 自刷缓存 <getDataDir>/provider-catalog-overlay.json（进 Provider 页时 fetch pi.dev）
  ③ pi 已刷 <getPiAgentDir>/models-store.json（pi binary 每次 RPC 启动后台自刷）
  ④ 用户配置：models.json override / auth.json 凭据 / settings.json defaultModel

【消费视图】
  展示视图  listProviders（provider-config-helper.ts）
            = ① ⊕ ②③（newer-wins + staleness 过滤）⊕ ④     ← ②③ 已接入 ✅
  校验视图  pi-provider-store（defaultModel 有效性判定）
            = ① ⊕ ④                                       ← 看不见 ②③ ❌
  执行视图  pi 子进程自身 registry
            = pi-ai 内置 catalog ⊕ ③ ⊕ ④                   ← 恒最新 ✅
```

**失败模式 A（用户配置被静默改写——机制推演，代码证据充分）**：

1. pi.dev 上线一个快照外新模型（例：假设 9 月上线 `glm-5.4`；当前窗口内任何「overlay 有、快照无」的模型同理）。
2. 用户进 Provider 页 → overlay 刷新 → 展示视图出现 `glm-5.4` → 用户点「设为默认」→ `setDefaultModel` 写 settings.json 成功。
3. 用户重启应用或创建会话 → `session-lifecycle.ts:296` gate / `rpc-client.ts:191` 组装 `--model` 均经 `getDefaultModel()` → `findValidDefaultModel`（`pi-provider-store.ts:304-380`）：zai 凭据在 auth.json、无 models.json override → 走 auth-only catalog 分支（`:326-341`，源码注释称 D3 修复——与本设计决策编号无关）→ 在 **快照** `builtinModelsById` 里找 `glm-5.4` → 找不到 → 返回快照首模型 + `wasFixed:true`。
4. `getDefaultModel`（`:385-394`）见 `wasFixed:true` → **`updateSettingsFields` 把用户配置改写为快照首模型并落盘**，仅 console.log 一行。
5. 结果：用户设置的默认模型被静默吞掉。展示视图（下一步 listProviders）仍会显示 glm-5.4 存在——三层给出互相矛盾的答案。

**失败模式 B（overlay 新 provider 鸡生蛋）**：`isCatalogProvider` 判定基于快照（`provider-catalog.ts:13-20`），`listProviders` catalog 分支对快照外 id 直接 `continue`（`provider-config-helper.ts:316-317`），刷新范围又锁定 `listProviders()` 的已知集合（`config-service.ts:162-167`）——pi.dev 若新增快照外 provider，三重闸门使其永远不可见。

**缓解因素（诚实评估，避免过度设计）**：pi binary 每次 RPC session 启动都后台自刷 ③（pi `main.js:741-747`，实装核实），所以「触发面窄」（overlay 主动刷新只在 Provider 页 mount 时发起）实际影响有限——只要开过会话，新数据通常已在盘上，任何一次 `config.providers` 广播/重连即带出。真正的实质缺口是**校验视图掉队**（失败模式 A），而非触发面。

**根因**：「什么是有效模型」没有单一权威。overlay 合并逻辑写在展示视图内部（listProviders 内联），校验视图（pi-provider-store）基于另一份独立索引（快照 builtinModelsById），执行视图归 pi。三个视图对同一问题给出不同答案——G2 要求三者对齐（xyz 侧能控制前两者）。

### 2.3 问题 3 现状：切换 2 步 + 自动重排，数据模型干净

**现状交互**：ProjectSwitcher 为 inline 手风琴（`ProjectSwitcher.vue`）——折叠态显示当前项目，点击展开列表，再点项目才切换（2 步）；列表按「active 置顶 + lastUsedAt 降序」自动重排（`stores/project.ts:78-90` recentProjects）。

**数据模型现状（干净，无架构病灶）**：`Project = { id, name, lastUsedAt }`（`shared/project.ts:29-38`）；持久化链路 = renderer pinia store（deep watch 全量 save）→ `project.save` RPC → runtime `WriteBackCache`（500ms debounce）→ `~/.xyz-agent/projects.json`（全量替换、零转换）。**文件内数组顺序天然等于前端发送顺序**（`project-store.ts:118-126`）。

**待补的能力**：无 `userOrder` 字段（全仓 grep 零命中）；无 per-project 会话数（数据已全量在 renderer 内存 `session.groups`，但无现成 computed）；无拖拽基建（全仓无 dnd 库、无 draggable 用法先例）。

**根因定位**：问题 3 不存在架构问题——是交互升级（2 步→1 步）+ 一个排序语义决策（用户手动序 vs lastUsedAt 自动序）+ 一个小数据模型扩展。**结论：不需要架构优化，需要一次干净的功能设计。**

### 2.4 合并诊断：是否需要架构优化？

**需要，但范围是两个针对性收口，不是重构**：

| 问题 | 架构判断 | 行动 |
|------|---------|------|
| 问题 1 | 需要收口：派生一致性从「人工纪律」升级为「机器守卫」 | 方向 1（§3.2） |
| 问题 2 | 需要收口：校验视图接入合并目录，消除「有效模型」多真相 | 方向 2（§3.2） |
| 问题 3 | 不需要：数据模型干净，交互升级即可 | 方向 3（§3.2） |

问题 1 与问题 2 的共同本质：**xyz-agent 对 pi 的派生视图（构建期版本锚点、运行期模型目录）在 pi 演进时没有一致性保障机制**——前者是构建期投影（静态数据漂移），后者是运行期投影（动态数据分叉）。两个收口各自独立可交付、可回滚。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**终态 1 —— 升级 pi 的开发者（G1）**：

> 开发者把根 `package.json` 的 pi 依赖升到 0.85.0，跑 `pnpm install`，改了 prepare 脚本默认值，但漏了 build.yml 与快照重生成。提交前跑守卫脚本，输出：
> ```
> pi-sync 守卫：声明基准 @earendil-works/pi-coding-agent=0.85.0，实装基准取 node_modules
>   ✗ S1 build.yml PI_VERSION env = 0.84.4, expected 0.85.0——恢复动作：同步 .github/workflows/build.yml 的 PI_VERSION 后重跑
>   ✓ S2 prepare-pi-resources.sh 默认值 = 0.85.0
>   ✗ S3 快照 piAiVersion = 0.84.4 ≠ node_modules 实装 pi-ai = 0.85.0——恢复动作：仓库根 pnpm gen:builtin-providers
>   ✗ S4 快照过期（providers 内容与实装重生成不一致）——恢复动作：仓库根 pnpm gen:builtin-providers
>   ✓ S5 extensions pi 依赖均满足声明基准（39 条 / 24 包）
>   ……
> ✗ pi-sync 守卫发现 3 处派生锚点不一致（fail 级，exit 1）
> ```
> 按报告逐项修复后守卫绿。CI 在 PR 上跑同一守卫——漏同步的提交无法合入。
> **失败路径**（守卫脚本自身损坏/无法解析某锚点）：报告该锚点的解析错误详情与可执行恢复动作，并以非零退出——宁可误报不可漏报。

**终态 2 —— 设置默认模型的用户（G2）**：

> pi.dev 上线 `glm-5.4` 当天，用户进 Provider 页看到它（overlay 通道），设为默认，重启应用。Composer 的默认模型显示 `glm-5.4`，新会话用它发起，日志无 auto-fix 记录——**用户配置原样生效**。
> **失败路径**（overlay 数据源对某 provider 完全无数据——缓存与 pi store 都无其条目）：默认模型校验对该 provider 采取 pass-through（不判定有效也不改写），`--model` 直传 pi 由执行侧解析；若模型确实不存在，pi 报 model-not-found（错误 surfaced 给用户）而非 xyz 静默改写。该 trade-off 是有意的：错误改写合法配置比让错误显式暴露更糟（详见 D5 态 3）。

**终态 3 —— 切换项目的用户（G3）**：

> 侧边栏项目区是 2 列卡片网格（单行 pill，高 26px），每卡 = 项目名（超长截断 + hover 全名）+ 会话数徽章。点击任意卡 1 步切换；拖拽卡片调整顺序，重启后顺序保持；新建项目落自动序段首位（位于所有手动排序项目之后；无手动排序项目时按最近使用置顶，见 D7 声明②）。徽章数字 = 点击该卡后 SessionList 实际显示的会话数。**默认项目**（未命名兜底项，恒存在）显示固定文案（复用既有 i18n key `sidebar.projectSwitcher.defaultName`，现 UI 已用同款 fallback），与命名项目同卡同权——可拖拽、有徽章（无归属/孤儿 session 计入其下）。
> **失败路径**（拖拽中途 ESC/拖出容器）：顺序不变（drop 未发生即不提交重排）。

### 3.2 方案对比

#### 方向 1：pi 派生一致性（G1）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **1A：单一锚点 + 一致性守卫脚本**——根 package.json pi 依赖版本为 SSOT；新增 check 脚本比对全部派生点，挂 CI + pre-commit | 高：与项目既有模式一致（`check_csp_compatibility.py` 等 check 脚本 + pre-commit 体系）；锚点语义显式 | 中：一个脚本 + 挂载，无运行时改动 | 低：只读校验，误报可容忍（漏报不可） | ✅ |
| 1B：全派生——CI env / 脚本默认值运行时从 package.json 动态读取 | 中：消除部分锚点，但 prepare-pi-resources.sh 需引入 node/jq 依赖解析 JSON，shell 变重；快照新鲜度无法「派生」只能「比对」 | 中 | 中：动态解析自身出错时静默用错值 | ❌（局部采纳：build.yml env 可在 CI 步骤内动态读 package.json，作为 1A 的补充） |
| 1C：纯文档 runbook 强化 | 低：**已被本次实证否决**——两个漏同步都发生在有 runbook 的前提下 | 低 | 高：同样的失败模式会再次发生 | ❌ |

守卫覆盖矩阵（1A 的比对项，全部为只读检查；与 check-pi-semantics 四包门禁**逐项零重叠**——后者管「实装内部一致」，本矩阵管「构建期派生锚点的跟随」，基准分声明/实装两类，见 §2.1 分工声明）：

| 比对项 | 判定 |
|--------|------|
| `build.yml` PI_VERSION env == package.json pi 依赖版本 | 不等 → fail |
| `prepare-pi-resources.sh` PI_VERSION 默认值 == 同上 | 不等 → fail |
| 快照 `piAiVersion` == node_modules 实装 pi-ai 版本 | 不等 → fail（快照过期） |
| 快照新鲜度：重跑 gen 脚本 → diff 已提交快照 | 有 diff → fail（node_modules 升了快照没重生成） |
| extensions/ 全部 package.json（实测 24，含 deprecated unified-hooks 与 shared 3 包）pi 依赖满足各自对应包的根声明版本（如 `^0.84.4` satisfies 0.84.4） | 不满足 → fail |
| `KNOWN_PI_API_TYPES`（shared 常量）== pi-ai KnownApi 源码提取值 | 不等 → fail（复用 gen 脚本既有的源码提取手法） |
| pi-tui 实装 == 锚点（check-pi-semantics 的 PI_PKGS 只含三包，pi-tui 有真实消费者却不在门禁内——补位） | 不等 → fail |
| （dev 环境，可选）resources/pi 内 binary 自带 package.json 版本 == 锚点 | 不等 → warn（symlink 缓存可能故意多版本共存，降级为警告） |

#### 方向 2：模型目录单真相（G2）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **2A：xyz 内部统一「合并目录视图」单点**——把「快照 ⊕ overlay」合并逻辑从 listProviders 内联抽为单一模块；listProviders 与 pi-provider-store 的有效性判定都消费它 | 高：消除多真相的构造性方案——「有效模型」只在一处定义；改动面收敛在 runtime 两个消费点 | 中：抽取 + 接入 + 回退语义，约 3 个文件 | 中：defaultModel 校验接入后需保证「overlay 不可用时不误杀合法 default」——用保守回退语义控制（见 D5） | ✅ |
| 2B：放弃 xyz 快照，直接消费 pi 落盘数据（models-store.json + 从 binary 提取内置 catalog） | 低：pi binary 内置 catalog 无稳定的机器可读导出承诺；models-store.json 初始不存在（首启空窗）；快照是离线兜底（pi.dev 不可达时唯一基线） | 高 | 高：依赖 pi 内部格式的隐性契约 | ❌ |
| 2C：xyz 不做校验，`--model` 直传，错了让 pi 报错 | 低：xyz 需要默认模型做 Landing 展示与 session gate（`session-lifecycle.ts:296`）；pi RPC 报错路径对桌面用户不友好且错误语义不可控 | 中 | 高：错误处理外包给不可控的外部系统 | ❌ |
| 2D：runtime 直读 `@earendil-works/pi-ai/providers/all`（`getBuiltinProviders()` / `getBuiltinModels()` / `getBuiltinModelDataGeneratedAt()` 均为公开导出，快照数据运行期直接可得）——**main 合入的 C-pi-12 格局反转（runtime 可 import pi-ai，`model-capability.ts` 首次反转声明）后此选项才进入方案空间** | 中：能构造性消灭快照锚点（A2/A5）+ gen 脚本整链 + u1 单元，「快照恒滞后」消失（pnpm install 即同步） | 高：7 个消费文件改造 + bundle 体积（全 provider 工厂代码进 runtime bundle，需实测） | **高：compat 时间炸弹移入运行期**——PS-15（pi-semantics.json，observe）登记 pi-ai/compat 是上游自声明的临时入口（ModelManager 迁移后删除）；快照方案下删除只崩 gen 脚本（构建期、守卫拦截、可控），直读方案下崩 runtime bundle（运行期、全应用瘫痪）。失败模式不对称是裁决的决定性理由；另快照的 `BuiltinModelSummary` 形态是 pi-ai 内部 Model 形态的稳定缓冲层，直读让 7 个消费者直接耦合上游数据形态 | ❌（登记为演进触发条件：① pi-ai 对 compat/目录 API 作出稳定承诺（PS-15 解除）② 或快照守卫再次失守——满足其一时重开本方案对比） |

若用被否方案 2B：§3.1 终态 2 在「首启 + 离线」场景退化为无任何模型列表（数据源都不存在），且 pi 升级改变内部格式时无守卫拦截——不可接受。若用 2C：失败模式 A 变成「会话启动时 pi 报 model not found」，用户配置仍未被尊重，只是失败位置后移。

#### 方向 3：项目切换数据模型（G3）

**排序语义**（userOrder 落层）：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **3A-字段：`Project` 加可选 `userOrder?: number`**——排序 = 有 userOrder 的段在前按 userOrder 升序，无 userOrder 的段在后按 lastUsedAt 降序 | 高：意图显式（字段即语义），与既有 lastUsedAt 并列；normalize/add/remove 各写点语义清晰 | 低：shared 类型 + recentProjects 排序逻辑，全链路（WriteBackCache/持久化零转换）自动兼容 | 低 | ✅ |
| 3B-数组序：以 projects 数组顺序隐式承载用户序 | 低：数组序被多个写点隐式破坏——`normalizeLoadedProjects` 头插默认项、`addProject` 尾部 push、init 整体替换；「顺序」语义藏在代码行为里，三个月后无人敢动 | 低 | 高：隐式契约脆弱 | ❌ |

若用 3B：拖拽实现的 reorder 语义与 normalize 头插、legacy 迁移顺序互相纠缠——§3.1 终态 3 的「重启后顺序保持」在默认项目补插场景（`normalizeLoadedProjects` unshift）下不成立。

**拖拽实现**：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **原生 HTML5 DnD**（demo 已验证的 `draggable` + dragover/drop 模式） | 中：零新依赖；6-10 项目的小网格场景够用；键盘可达性需自行补一小段（方向键调用同一 reorder） | 低 | 低 | ✅ |
| 引入拖拽库 | 低-中：**@dnd-kit 是 React 库，Vue 生态需换 pragmatic-drag-and-drop / vue-draggable-plus**——为 2 列小网格引入整库依赖，收益不成比例 | 中：新依赖 + 学习成本 | 中：依赖维护 | ❌（demo 注释建议 @dnd-kit 系对 Vue 项目的误植） |

**badge 会话数**：不新增 RPC。renderer 侧 computed 消费 `session.groups`（数据已全量在内存），按 `projectId` 分组计数；**默认项目计数复用 SessionList 的同款规则**（`!s.projectId || !knownIds.has(s.projectId)`，`SessionList.vue:175-177`）——保证徽章数字与点击后列表实际显示数恒一致（同一规则两处消费，实现时提取为共享函数防漂移）。

### 3.3 关键决策与权衡

**D1：pi 版本唯一锚点 = 根 package.json 的 pi-coding-agent 依赖版本（选定）**
- **采用**：守卫脚本以它为 expected 比对矩阵的声明基准项（build.yml env / 脚本默认值 / extensions peerDeps——后者实现为各 pi 包满足**各自对应包的根声明版本**，比「统一满足 pi-coding-agent 版本」更严：能抓 extensions range 已改新而对应根声明漏改的分裂）；矩阵的实装基准项（快照 piAiVersion / 快照新鲜度 / KNOWN_PI_API_TYPES / pi-tui）对 node_modules 实装比对。两级基准不冲突——四包门禁（check-pi-semantics）只锁「实装内部一致」（不读根声明）；声明与实装的缝隙由 CI `--frozen-lockfile` 安装失败与守卫 S1/S2 报不一致兜底，全绿漏报窗口仅剩「声明与全部锚点已同步但未 install」的本地视角（CI 上 install 会红）。
- **被否**：锚点放 shared/constants.ts（renderer 也加载，runtime 版本概念泄漏到渲染层）；锚点放 prepare-pi-resources.sh（shell 非结构化数据源，且它是被校验方之一，不能既当裁判又当运动员）。
- **证据**：`package.json:31-51` 是 pnpm overrides 与 deps 的汇聚点，lockfile 由它驱动。与 check-pi-semantics 四包门禁的关系是**互补非重复**：门禁以 node_modules 实装为基准查「实装内部一致」（`check-pi-semantics.mjs:157-165`），本守卫查「派生锚点的跟随」（声明基准项对声明、实装基准项对实装）。
- **效果**：G1 的「改一处」成立。

**D2：守卫形态 = 独立 check 脚本 + CI（ci.yml invariants job）+ pre-commit 双挂载（选定）**
- **采用**：`scripts/check-pi-sync.mjs`（node，能复用 gen 脚本的 pi-ai 源码提取手法）；CI 挂 **ci.yml 的 invariants job**（与 check-pi-semantics 同 job 同模式，`ci.yml:433` 同区块——单一快失败入口；build.yml 不适用：它是 reusable workflow（`on: workflow_call`）且在 3 平台 matrix 中每平台各跑一遍）；pre-commit 只对「触碰派生锚点文件」的提交触发（性能考虑，仿 `.githooks/` 既有按路径触发模式）。挂载实体已探明：pre-commit 生成逻辑在 tracked 的 `.githooks/install-hooks.sh`（check-pi-semantics 的 G1 区块在 `:1058-1077`，照同区块模式追加）。
- **被否**：只挂 CI 不挂 pre-commit（本地红到 CI 才发现，反馈慢）；vitest 测试承载（混入测试套件语义不清，且 pre-commit 无法选择性触发）；**并入 check-pi-semantics**（职责正交——语义漂移 vs 派生锚点；C-proc-08 已限定其 scope，并入膨胀约束边界；且 check-pi-semantics 刻意零第三方依赖单一职责，本守卫需要 yaml/git 工具面；check-* 家族并列是项目既有模式）。
- **证据**：`.githooks/check_spawn_env_boundary.py` 先例（按路径触发的守卫 hook）；`.githooks/install-hooks.sh:1058-1077` + `.github/workflows/ci.yml:433`（check-pi-semantics 的 pre-commit + CI 双挂载先例）。
- **效果**：G1 的「提交/CI 阶段拦截」成立。

**D3：t10 指纹基线自包含化——指纹写入快照 header，测试只断言自洽（选定）**
- **采用**：gen 脚本生成快照时一并写入指纹（provider 总数 / models 总和）到 JSON header；t10 改为断言「快照内容 == 快照 header 指纹」+「快照 piAiVersion == node_modules 实装版本」+「磁盘快照 == gen 脚本当前输出」（第三断言为实施期补强：前两断言在「gen 提取逻辑变更但 pi 版本未变」时双失灵，仅此断言可检，且不引入手写数字）。内容漂移提醒职责转移给守卫脚本的快照新鲜度 diff（升级 PR 的快照 diff 本来就要人审）。
- **被否**：继续手工维护基线数字——**守卫自身的基线成为需要人工同步的第三份数据**（本次失守的直接原因），每次 pi 升级必红一次再人工改数字，守卫退化成仪式。
- **证据**：`gen-builtin-providers.test.ts:104-125` 基线 1220 vs 实际 1290（实跑红）。
- **效果**：t10 从「每次升级必红」变为「结构自洽恒绿 + 漂移由守卫报告」；G1 的「守卫自身不产生新锚点」成立。与守卫矩阵第 3 项（快照 piAiVersion == 实装）构成刻意双通道：t10 在测试期跑（CI test 路径）、守卫在提交期跑（pre-commit + CI invariants），覆盖不同拦截时点。

**D4：「有效模型」合并视图抽为 runtime 单点模块（选定）**
- **采用**：把 listProviders 内联的「快照 ⊕ overlay」合并（`provider-config-helper.ts:337-343`）与 `getCatalogOverlayModels` 的读取逻辑收拢到一个模块（扩展 `provider-catalog.ts` 或新 `merged-catalog.ts`，实施层定）；对外暴露「provider X 的有效模型集（BuiltinModelSummary 形）」单一函数；listProviders 与 pi-provider-store 的 `builtinModelsById` 索引都改从它构建（实施期例外：`sanitizeInvalidProviders` 的空壳修复索引保留快照源——MF-6 `every(baseUrl)` 守卫不能消费 overlay 归一化的空 baseUrl，否则「修复」误判为「删除」；默认模型判定路径全部走合并视图单点）。
- **被否**：在 pi-provider-store 里单独再写一份 overlay 合并（两处合并逻辑必然漂移——本次多真相正是这么产生的）；把校验搬到 listProviders（聚合层持 settings 写权，职责倒挂）。
- **证据**：`provider-config-helper.ts:340`（展示已接）vs `pi-provider-store.ts:326-341`（校验未接，auth-only catalog 分支只查快照）。
- **效果**：失败模式 A 构造性消除——校验与展示同源。

**D5：defaultModel 校验接入 overlay 的三态语义（选定）**
- **采用**：`findValidDefaultModel` 的有效集合改为合并视图，并按 overlay 对该 provider 的**数据状态**区分行为（三态，取代旧方案「一刀切回退快照」的模糊表述）：

  | overlay 对该 provider 的状态 | 判定依据 | defaultModel 校验行为 |
  |---------------------------|---------|---------------------|
  | 态 1：有数据且新鲜（lastModified > 快照 catalogGeneratedAt，未被 staleness 过滤） | 合并视图非空且条目未被 `getCatalogOverlayState` 的 fresh 判定排除（staleness 过滤） | 用**合并视图**判定——overlay-only 模型合法，不触发 auto-fix |
  | 态 2：有数据但过期/被声明为空（staleness 过滤掉，或 404/501 语义写入的 lastModified:0） | 条目存在但 `getCatalogOverlayModels` 返回被过滤 | 用**快照**裁定，允许 auto-fix——「见过但远程声明已过时」是明确信号（404 = 远程说无此目录），快照是更权威的基线 |
  | 态 3：从未见过（own 缓存与 pi store 均无该 provider 条目，或文件损坏） | 两份落盘均无条目 | **pass-through**：不判定有效性、不触发 auto-fix、不改写 settings.json，`--model` 直传 pi 由执行侧解析 |

  态 3 的显式 trade-off：手滑输入的垃圾模型名从「今天被 auto-fix 救回」变为「直传 pi，由 pi 报 model-not-found」。可接受的理由：错误显式暴露（用户可改）优于静默改写合法配置（失败模式 A）；且态 3 的常态是「该 provider 从未经过 overlay 通道」而非「用户配置有误」，对后者误伤才是真风险——pi 报错至少把决策还给用户。

  生效范围（实施期确认）：三态在 **auth-only catalog 分支与 override 主路径两通路同样生效**——主路径存在同族失败模式 A（default=快照内模型 + override-only 条目 → 重启被静默改写为 override 首项）；主路径态 2 的 auto-fix fallback 目标仍为 override 首项（沿用旧语义）。
- **被否**：无脑接入（overlay 短暂缺失时把合法 default 判死改写——把失败模式 A 反向变成「网络故障吞配置」）；「不可用一律回退快照 + 不改写」（对态 2 丢失 404 语义；对态 1 的 overlay-only 模型变成直传，砍掉本设计的主要收益）。
- **证据**：`getCatalogOverlayModels` 现把「无条目 / 损坏 / staleness 过滤 / 空 models」四种状态全折叠成 `[]`（`provider-catalog-refresh.ts:143-153`）——三态语义正是要把这个歧义拆开；404/501 → `lastModified:0` 的既有语义（`:202-206`）是态 2 的判定材料。
- **效果**：§3.1 终态 2 的成功与失败路径都成立；失败模式 A 构造性消除且不引入「网络故障吞配置」反向缺陷。

**D6：overlay 浮出快照外新 provider —— out-of-scope（选定）**
- **采用**：维持三重快照闸门现状（isCatalogProvider / listProviders catalog 分支 / 刷新范围均以快照为界）。
- **被否**：放开新 provider 浮出——需同动三处闸门 + catalog provider 的 oauth/env 配置本身也在快照（新 provider 缺 oauth 配置等于半个残废）+ pi-ai 升级周期（数周）自然把新 provider 带回快照。价值窗口短、改动面大。
- **证据**：`provider-catalog.ts:13-20`、`provider-config-helper.ts:316-317`、`config-service.ts:162-167` 三重闸门；pi-ai 0.84.1→0.84.4 快照新增 70 模型（1220→1290）证明快照通道活跃。
- **效果**：scope 收敛；**重新评估触发条件**：出现「pi.dev 新 provider 在两次 pi-ai 发版间被高频使用」的真实案例时重开。

**D7：userOrder 排序语义 = 用户序 > 自动序，drop 位置密集重排（选定）**
- **采用**：
  - **排序**：`recentProjects` 改为两段式——有 `userOrder` 的项目按 userOrder 升序在前，无 `userOrder` 的按现状规则（active 置顶 + lastUsedAt 降序）在后。`setActiveProject` 更新 lastUsedAt 但不重排有 userOrder 的项目（切换 ≠ 排序意图）。
  - **赋号语义**：drop 发生时按**落点位置**重排——对有序段（含新落点）**密集重编号 0..n-1** 后整体提交（deep watch 持久化）。从无序段首次拖起时，该卡插入落点、有序段连同它一起密集编号。不做 midpoint 稀疏编号，删除项目后也无需清理空洞（下次任何 drop 自然重编）。
  - **默认项目**：与命名项目同卡同权——可拖拽、参与 userOrder、徽章计入无归属/孤儿 session（渲染规格见 §3.1 终态 3）。
  - **显式行为变化声明**：① 全员进入有序段后「active 置顶」自然消失（现状行为变更，属用户意图的胜利）；② 新建项目落自动序段首位（创建时刻置 active + 最新 lastUsedAt；无手动排序项目时即网格首位——早期「出现在尾部」是对「不插队到已排序项目之前」的粗糙叙述，以本条为准），后续其他无序项目的 lastUsedAt 更新可能排到它前面（符合「自动序只管未被手动排序的项目」语义）。
- **被否**：首次拖拽即赋 max+1（用户把项目拖到首位却落地尾部——首拖即可见错误）；全量 userOrder 无 fallback（旧数据被迫赋假顺序）；lastUsedAt 继续主导（拖拽意图被切换冲掉，持久化名存实亡）。
- **证据**：`stores/project.ts:78-90` 现排序逻辑；deep watch 持久化对新字段零改动兼容（`project-store.ts:118-126` 零转换）；demo 的 reorder 已是纯数组 splice（`project-switcher-demo.html:367-375`），密集重排是其自然延伸。
- **效果**：§3.1 终态 3 的「排序反映用户意图且跨重启稳定」成立，且拖到任意位置（含首位/中间）语义正确。

**D8：拖拽用原生 HTML5 DnD，键盘可达性同一 reorder 入口（选定）**
- **采用**：demo 已验证的 draggable/dragover/drop 模式（`project-switcher-demo.html:331-375`）；卡片 focus 态监听方向键（←→↑↓）调用与 drop 相同的 reorder 提交函数——一次实现两个输入通道。
- **被否**：引入 Vue 拖拽库（§3.2 已否）；键盘可达性标记不做（可访问性缺口留给未来 = 推测性债务）。
- **证据**：全仓零 dnd 依赖；demo 的 reorder 已是纯函数（splice 重排）。
- **效果**：零新依赖交付 G3；键盘用户可达。

**D9：overlay 主动刷新触发点增补「导入供应商成功后」（选定，低优先级）**
- **采用**：在 `applyImportProviders` 成功路径后追加一次 `refreshProviderCatalogs`（fire-and-forget：不阻塞导入 reply、失败仅 console.warn；refresh 完成后 `broadcastProviderList` 二次广播——否则 renderer 常驻订阅收不到刷新后列表，A8 在 UI 上不可达）。
- **被否**：启动期全局刷（与 pi binary 每次 RPC 启动自刷重复，唯一缺口窗口是「首启且从未跑过会话」，此时用户尚未配任何凭据，模型列表新鲜度无消费者）；扩大到定时轮询（4h 窗口语义已在 pi 侧承载）。
- **证据**：导入供应商正是问题 2 的原始触发场景（handoff：「导入供应商后模型列表不新鲜」）；`settings-message-handler.ts` 的 `config.refreshProviderCatalogs` case 已有 refresh 完成后 broadcast 先例（`config.applyImportProviders` case 内亦有同步 broadcast）。
- **效果**：命中用户真实路径，成本一次可失败的 fetch。

---

## 4. 验收

> 按改动大小匹配投入：方向 1/2 是行为变更级，多真实场景；方向 3 是新功能，走真机交互回归。全部场景回溯 §1 目标。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|----------------|------|---------|
| A1 | 守卫逐项拦截漏同步（G1） | 对 §3.2 守卫矩阵**每行**各制造一处真实不一致（改 build.yml 版本 / 改脚本默认值 / 回退快照 / 降一个 extension peerDeps / 增删 KNOWN_PI_API_TYPES 一项……），逐项跑 `node scripts/check-pi-sync.mjs`；全部恢复后复跑 | fail 级行每次注入都被报告且非零退出；warn 级行（dev binary 版本）输出警告；干净仓库复跑绿——单项漏判即 G1 失守，故逐项负向探测而非只测一例 |
| A2 | 守卫覆盖当前实证（G1） | 守卫开发完成后、U0 修复前，在**当前仓库**首跑（真实漏同步在场） | 必须报出 build.yml 0.84.1 等不一致项——本次真实漏同步作为守卫的第一次实战验收；U0 修复后复跑转绿（红→绿闭环，与 U0 同 PR 交付） |
| A3 | 默认模型不被静默改写（G2） | 真机 dev 环境。**前置条件**：① 断网（防 Provider 页 mount 触发的 `refreshProviderCatalogs` 从 pi.dev 拉回真实数据整体替换假条目——fetch 失败走 fail-safe 保留缓存）；② 向 `<getDataDir>/provider-catalog-overlay.json` 写入真实形状测试条目（zai + 一个快照外模型 id 如 `glm-test-overlay`），其 lastModified 晚于 pi store 的 zai 条目与快照 catalogGeneratedAt（防 newer-wins 压制与 staleness 过滤）。然后进 Provider 页设其为默认 → 重启应用 → 查看默认模型与 `~/.xyz-agent/pi/agent/settings.json` | Composer 默认模型仍显示 `glm-test-overlay`；settings.json 未被 auto-fix 改写；runtime 日志无 auto-fix 记录 |
| A4 | 态 3 pass-through 不劣化（G2，负面行为） | 真机 dev：默认模型设为快照内模型（glm-5.3）+ 构造态 3（own 缓存 `<getDataDir>/provider-catalog-overlay.json` 与 pi store `~/.xyz-agent/pi/agent/models-store.json` 中该 provider 条目**双双清空**——只删 own 不够，pi store 是第二数据源）→ 重启 | 默认模型原样保留（无 auto-fix 改写，`--model` 直传 pi 解析成功）；再设一个垃圾模型名验证态 3 trade-off：pi 报 model-not-found 且 settings.json 未被静默改写 |
| A5 | 排序持久化（G3） | 真机：拖某项目到**首位**、另一项目到**中间位置**（显式覆盖密集重排语义）→ 重启 → 再切换到另一项目 → 再重启；另以键盘通道复验一次（卡片 focus 后方向键交换位置，D8 同一 reorder 入口） | 顺序始终 = 拖拽落点顺序（拖到首位即首位，非尾部）；切换行为不重排有序项目；新建项目落自动序段首位（手动排序项目之后，见 D7 声明②）；键盘交换与拖拽落点语义一致 |
| A6 | 徽章数 = 列表实际数（G3） | 真机：多项目各含不同数量会话（含 1 个无归属 session） | 每张卡徽章数字 = 点击该卡后 SessionList 顶部的 totalCount；无归属 session 计入默认项目 |
| A7 | 1 步切换（G3） | 真机点击非活跃项目卡 | 视图立即切换到该项目（无中间展开态）；active 卡样式反白 |
| A8 | 导入触发刷新（G2，D9） | 真机联网：导入一份供应商配置 | 导入成功后 `<getDataDir>/provider-catalog-overlay.json` mtime 更新；随后 `listProviders` 结果含 overlay 新模型（与快照 diff 可见） |
| A9 | 态 2 快照裁定 + auto-fix（G2，负面行为的显式验证） | 真机 dev：**断网**（防 pi binary 启动自刷从 pi.dev 回填新鲜目录压过态 2 标记）+ 向 overlay 缓存写入 zai 条目 `lastModified: 0`（404/501 语义——远程声明无此目录），`models` 含一个快照外模型 id + **删除 pi models-store.json 中 zai 条目**（双源处理）→ 设该模型为默认 → 重启 | 快照裁定生效：默认模型被 auto-fix 改回快照首模型 + runtime 日志有 auto-fix 记录（console.warn 可见）——态 2 的降级路径按设计发生，而非静默。已实测的联网变体（终局审查偏差 #16，两次真机）：删 pi store 条目会被 pi binary 联网自刷回填，auto-fix 落合并视图首项（pi store 新鲜目录首模型，真实可用）——联网下态 2 被 newer-wins 数据覆盖属预期，目标始终合法可用模型；态 2 的快照裁定行为由单测 4 用例（含落盘断言）锁定，断网真机实证待专门窗口 |

设计阶段即 testable：A1/A2 纯脚本可跑；A3/A4/A9 用真实数据文件构造（写真实缓存路径，非 mock 组件）；A5-A8 为真机操作断言。

---

## 5. 下一层拆分

### 实施路径（按优先级与依赖排序）

| 单元 | 内容 | justification | 独立验收 | 依赖 |
|------|------|--------------|---------|------|
| **U0（P0，立即）** | 修复本次实证漏同步：`build.yml:47` → 0.84.4；t10 基线核对后更新（1290 / deepseek 3 模型——人工确认 0.84.4 生成物内容合理） | CI 红态 + 混装包风险是现实损害；「完成即提交」纪律要求恢复绿态 | 手跑 t10 绿 + 目视 build.yml | 与 U1 组成红→绿闭环（见下） |
| **U1** | `check-pi-sync.mjs` 守卫脚本（§3.2 矩阵全量，当前 8 项）+ CI 挂载（ci.yml invariants job）+ pre-commit 按路径触发 | G1 主体；优先级高于 U2（混装包风险 > 校验视图缺口）。**与 U0 同 PR 交付**：守卫首跑于 U0 修复前，真实漏同步即首个测试用例（A2）；U0 修复后复跑转绿（A1），既守卫有效性验收天然嵌入，又避免「CI 挂上守卫即红」的中间窗口 | A1 + A2 | 与 U0 同 PR（红→绿闭环） |
| **U2** | 合并目录视图单点（D4）+ pi-provider-store 接入（D5 三态语义）+ t10 自包含化（D3，属 gen 脚本改造，与 U1 的快照新鲜度检查协同） | G2 主体；失败模式 A 是用户配置损坏级缺陷 | A3 + A4 + A9（态 2 快照裁定）+ 既有 16 用例回归（`provider-catalog-refresh.test.ts` 等） | 无硬依赖（建议在 U1 后：守卫先行保护快照锚点） |
| **U3** | 导入成功后触发刷新（D9） | 小增量，复用既有模式 | A8 | U2（同一链路） |
| **U4** | ProjectSwitcher 3A 重写：`userOrder` 字段（shared 类型 + recentProjects 两段式排序）+ 2 列网格组件 + 原生 DnD + 键盘 reorder + badge computed（与 SessionList 规则提取共享） | G3 主体；demo 已定稿参数（26px pill / gap 4px / radius-sm / active `#3f3f46`） | A5 + A6 + A7 | 无 |

### 文件改动地图（高层）

- U0：`.github/workflows/build.yml`、`packages/runtime/scripts/__tests__/gen-builtin-providers.test.ts`
- U1：新增 `scripts/check-pi-sync.mjs`；`.github/workflows/ci.yml`（invariants job 挂载，见 D2）；`.githooks/`（按路径触发）
- U2：`packages/runtime/src/services/provider-catalog*.ts`（合并视图收拢）、`packages/runtime/src/infra/pi/pi-provider-store.ts`（builtinModelsById 改建索引源）、`packages/runtime/scripts/gen-builtin-providers.mjs`（指纹入 header）、t10 重写
- U3：`packages/runtime/src/transport/settings-message-handler.ts`（导入成功后触发刷新）、`packages/runtime/src/services/config-service.ts`
- U4：`packages/shared/src/project.ts`（userOrder）、`packages/renderer/src/stores/project.ts`（排序）、重写 `packages/renderer/src/components/sidebar/ProjectSwitcher.vue`、badge 计数共享函数（新 composable 或 utils）
- `docs/page-design/project-switcher-demo.html`（当前 untracked）随 U4 一并提交

### 约束登记（落地时）

按仓库规矩，U1/U2 若确立新架构级约束（「pi 派生锚点必须过 check-pi-sync」「有效模型判定必须走合并视图单点」），先登记 `docs/constraints.json` 再写代码，改后跑 `node scripts/render-constraints.mjs`。登记形态：**新增独立条目**（如 C-build-02「构建期 pi 派生锚点一致性」），不扩展 C-proc-08——后者 scope 已限定为 pi-semantics 语义登记体系，两者是并列守卫非包含关系（见 §2.1 分工声明）。

### 待验证检查点（设计阶段无法确定，留给实施期）

1. pi-ai `KnownApi` 的源码提取稳定性（TS type 编译后消失，提取方式需看 0.84.4 源码形态——gen 脚本既有手法是否直接适用）
2. `findValidDefaultModel` 接入合并视图后的性能（该函数在 session create 热路径上，合并视图有 mtime 缓存但需实测无感知劣化）
3. demo 的纯 CSS tooltip（absolute 定位）在 sidebar 滚动容器内的裁剪行为——handoff 已预警，实现时按「portal 或 title 兜底」决策
4. pre-commit 挂载点的性能预算（守卫脚本含 node_modules 解析，需控制在既有 hook 时延容忍内）

---

## 附：遗留事项提醒（非本文档 scope）

- 4 个已提交 commit 均**未 push**（push 需用户授权）；merge origin/main 已完成（75534d044，含 runtime pin 0.84.4 同步 + pi-semantics 探锚/verifiedWith 0.84.4 重验）
- 问题 2 的真机验收（Provider 页确认 glm-5.3 可见——注意 0.84.4 快照本身已含 glm-5.3，双通道都应可见）仍待执行
- `docs/page-design/project-switcher-demo.html` 为 untracked，随 U4 提交

## 变更历史

- 2026-08-29（初版）：三问题终态分析 + 对抗式审查（4 must-fix + 4 suggestion 全部修订）。
- 2026-08-29（merge origin/main 后增量评估修订）：main 合入 pi-semantics 守卫体系与 C-pi-12 格局反转后，经增量对抗评估修订——① §2.1 根因修正（A1 类已有四包门禁 + 两守卫分工声明 + merge 实证）② §3.2 方向 2 补方案 2D（runtime 直读 pi-ai，裁决维持 2A，理由：compat 时间炸弹的构建期/运行期失败模式不对称；2D 登记为演进触发条件）③ 守卫矩阵补 pi-tui 项（check-pi-semantics PI_PKGS 三包缺口补位）④ D1/D2 补与 check-pi-semantics 的互补关系与挂载先例 ⑤ §5 约束登记形态明确独立条目。方向③（ProjectSwitcher）与 D4-D9 经评估确认零影响，未改动。
- 2026-08-29（第 1 轮全量复审修订）：1 must-fix + 10 suggestion 全部修复——CI 挂载点三处矛盾收敛为 ci.yml invariants job（唯一挂载实体，D2/D3/§5 统一）；矩阵基准分声明/实装两类（§2.1/§3.2/D1 三处措辞统一）；G1 收窄至矩阵覆盖面（A6 类文档锚点显式排除）；G2 补态 2 例外限定 + 新增 A9 态 2 验收场景；「D3 分支」撞名改「auth-only catalog 分支」；行号漂移修正（rpc-client :191、troubleshooting :296）；§5 计数改「矩阵全量」。
- 2026-08-29（第 2 轮验证性复审修订）：2 must-fix + 6 suggestion 全部修复——§5 文件改动地图 U1 行挂载点漏网修正（ci.yml）+ U2 独立验收补 A9；A8 回溯目标 G1/G2 → G2；地图补 U3 行；A5 补键盘 reorder 复验（D8 同一入口）。两 must-fix 均为第 1 轮修复的下游漂移，方案本体零新发现。
- 2026-08-29（实施后一致性审查同步修订）：三区对抗审查（runtime 守卫 / 前端）0 must 级 unreasonable 后的文档修正——① 「新建项目出现在网格尾部」（§3.1 终态 3 / A5）与 D7 两段式矛盾，按 D7 语义统一为「自动序段首位」，D7 声明② 精化；② D9 证据行实体位置纠正（broadcast 先例在 settings-message-handler.ts 非 config-service.ts）+ 采用行显式化二次广播；③ D5 态 1 判定依据行号引用改函数名引用 + 补两通路生效范围注记；④ D3 采用行补第三断言（实施期补强）；⑤ D4 采用行补 sanitizeInvalidProviders 快照索引例外注记。
- 2026-08-29（终局对照审查同步修订）：第三轮三区终审（代码终态 vs 文档，含上轮未覆盖的 Gate A 修复批次）4 条 doc_errors 修正——① A9 步骤补双源处理（删 pi models-store 条目，防 newer-wins 使实际态变 fresh）+ 通过标准区分双源过期（快照首模型）与三源变体（合并视图首项，#16 实测）；② D1 断言修正（四包门禁只锁实装内部一致、不读根声明；缝隙由 CI frozen-lockfile + S1/S2 兜底）；③ S5 基准措辞按实现对齐（各 pi 包满足对应包根声明，更严）；④ §3.1 终态 1 输出示例按守卫实跑格式回写（S 编号/恢复动作后缀/失败路径措辞）。连带 unreasonable 8 条（1 medium：守卫未登记 constraints——已补 C-build-07；7 low：S4 死分支/ACMR 删除缝隙/self-test 盲区/注释失真×3/测试锚点×2/mock 形状×2）由 u8/u9 修复批次处理。
