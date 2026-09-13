# npm 发布面一致性守卫与构建入口显式化设计

> **一句话结论**：npm 发布面「files 白名单承诺 ↔ 构建流程产出」之间的静默缺口（npm pack 对幽灵条目零报警）用两层长期方案闭合——独立发布面守卫（幽灵条目拦截 + 自包含探针）挂发布门与 CI，发布 workflow 构建步骤显式化消除「smoke 副作用 = 唯一构建入口」的隐式依赖。
>
> **层声明**：当前层 = 技术方案层（问题已诊断、方案方向已定——「按长期方案」用户拍板）；下一层 = 可实施单元（守卫脚本 + workflow 接线 + 登记项）。涉及 CI 流程编排与运行时探针，写作准则 5/6/7（数据流图 / 运行时断言附探针 / 真实场景验收）全适用。

## 1. 背景目标

### 1.1 SCQA

- **S（情境）**：本仓 29 个 npm 发布面包（28 workspace 包 + statusline 特例——u4/D6 将 deprecated 的 pi-unified-hooks 加入 changeset ignore 后的终态口径，见 §1.2；2026-09 ext-simplify-01 删包后 ignore 条目已移除；该包删前被 ignore 排除、删后不在磁盘，31 包计数不变）经三条路径发布——正式线（merge skill 阶段 4N 编排版本，推 `npm-*` tag 触发 release-npm.yml）、dev 预发布线（本地 npm-prerelease.sh + changeset pre，推 `dev-npm-*` 分支触发 release-npm-dev.yml）。每个包进 tarball 的内容由 package.json `files` 白名单声明。
- **C（冲突）**：npm 对 `files` 白名单里磁盘上不存在的条目**静默跳过**，白名单承诺与构建产出之间没有任何一致性约束。`@zhushanwen/subagent-core` 的 `dist.bundle/`（自包含 vendoring 产物；vendoring = 消费方把产物文件整体复制进自己目录、没有 node_modules 依赖安装链的消费形态，因此产物必须内联全部运行时依赖——外部 zsw 插件 vendor `--npm` 通道依赖此产物）自 0.4.0 起从未进过 tarball——`files` 声明了它，但发布流程中 subagent-core 唯一的构建入口（smoke-core-dist.mjs）只跑 `build`（常规档）不跑 `build:bundle`（自包含档），CI 全新 checkout 后磁盘上根本没有该目录，tarball 自然缺货且零报警。
- **Q（问题）**：如何让「files 白名单 ↔ 实际产物」的一致性从「靠人记」变成「机器门」，并保证未来新增包/新增产物档不再重演？
- **A（答案）**：新独立守卫 `check-publish-surface.mjs`（幽灵条目拦截 + 自包含探针 + 产物目录反向覆盖，双向闭合「files ↔ 产物」两个漂移方向）挂发布门与 CI PR invariants；发布 workflow 为每个 dist 包显式声明全部构建档；补齐 dev 线同型缺口；约束登记 C-proc-11。

### 1.2 系统是什么（受众补背景）

**npm files 语义最小例子**：包 A 的 `package.json` 声明 `files: ["src/", "dist/"]`。执行 `npm pack` / `npm publish` 时只有匹配白名单的文件进 tarball。关键静默面：若磁盘上 `dist/` 目录不存在（没跑构建），npm **不报错、不警告**，直接打包一个没有 dist 的 tarball——发布者以为承诺了什么和 tarball 里实际有什么，中间隔着一层零反馈的静默。

**发布面全景**（终态发布面 32 包 = pnpm workspace 内非 private 且未被 changeset ignore 的 31 包——u4/D6 将 deprecated 的 pi-unified-hooks 加入 changeset ignore 落地后的口径（此前 29 + statusline = 30；2026-09 ext-simplify-01 删包后 ignore 条目已移除；该包删前被 ignore 排除、删后不在磁盘，31 包计数不变）+ statusline 特例 + W5/W7 引擎三包（subagent-engine-sdk / pi-subagent-cli / zcode-subagent-cli，MF-4 批次接入守卫面），按产物形态分三类）：

| 类别 | 包 | files 声明的产物 | 构建方式 |
|---|---|---|---|
| TS 源直发 | 25 个 `@zhushanwen/pi-*` extension（21 活跃 + shared 组 4 个；deprecated 的 pi-unified-hooks 已 ignore——u4/D6，不占发布面；2026-09 ext-simplify-01 删包后 ignore 条目已移除；该包删前被 ignore 排除、删后不在磁盘，31 包计数不变） | `src/`、`index.ts` 等 git 内源文件 | 无构建（pi 加载器直接吃 TS） |
| dist 发布包 | `@xyz-agent/extension-protocol` | `dist`（无尾斜杠） | tsup，正式/dev 两线均有显式 build 步骤 |
| dist 发布包 | `@xyz-agent/session-delivery` | `dist`（无尾斜杠） | tsup，**仅正式线**有显式 build 步骤 |
| dist 发布包 | `@zhushanwen/subagent-core` | `dist/` + `dist.bundle/`（双档） | tsup 两档（`build` / `build:bundle`），发布流程无显式步骤、由 smoke 副作用承载 |
| dist 发布包 | `@zhushanwen/subagent-engine-sdk` | `src/`（排除 `__tests__`）+ `dist/` | tsup，正式/dev 两线均有显式 build 步骤（MF-4 批次接入） |
| dist 发布包 | `@zhushanwen/pi-subagent-cli` | `bin/` + `dist/`（CLI 包：bin 是唯一 npm 消费面，不带 src/） | tsup，正式/dev 两线均有显式 build 步骤（MF-4 批次接入） |
| dist 发布包 | `@zhushanwen/zcode-subagent-cli` | `bin/` + `dist/`（CLI 包：bin 是唯一 npm 消费面，不带 src/） | tsup，正式/dev 两线均有显式 build 步骤（MF-4 批次接入） |
| 非 workspace 特例 | `statusline`（resources/plugins/，v0.3.14） | 无 files 字段 | 非 pnpm workspace 成员——机制上不经 changeset 发布线（见 D6） |

TS 源直发类不存在本缺口（声明的都是 git 里就有的文件）；风险集中在 dist 发布包。

### 1.3 设计目标

- **G1 发布面一致性机器门（双向）**：发布现场，每个 dist 发布包 `files` 白名单的每个条目必须真实存在于磁盘且非空（幽灵条目拦截，幽灵声明方向）；包内顶层 `dist*` 产物目录必须被 `files` 白名单覆盖（产物目录反向覆盖，漏声明方向）；自包含档（`dist.bundle/`）必须真正自包含（外部依赖探针）。
- **G2 构建入口显式化**：发布 workflow 显式声明每个 dist 包的全部构建档；消除「smoke 脚本副作用 = 唯一构建入口」的隐式依赖——构建产出由显式步骤保证，验证门只负责验证。
- **G3 同型缺口清偿**：dev 预发布线补 session-delivery build 步骤；`resources/plugins/statusline` 加 `"private": true`（非 workspace 目录不经 changeset 发布线，真实尾部风险是手滑 `npm publish` 全目录打包——private 是该形态的唯一机制层拦截，见 D6）；deprecated 的 `pi-unified-hooks` 显式加入 changeset ignore（workspace 内包，ignore 有效，deprecated 包不应再发版）。
- **G4 防复发登记**：constraints.json 新增 C-proc-11（发布面一致性约束，含「新增产物档须同批挂守卫」条款）。

### 1.4 in / out scope

**in**：G1–G4 全部。

**out（显式不做）**：

| 项 | 不做的原因 | 去向 |
|---|---|---|
| 产物契约 manifest（每包声明期望产物清单，tarball 内容双向比对） | 终态方向，当前 6 个 dist 包 + 2 类风险面下无事故支撑，先落地即过度设计 | 登记触发条件（§3.3 D8），满足再立项 |
| subagent-core 0.5.2 发布编排 | 走 merge / prerelease skill 既有流程，不是本设计的实施单元 | 仅在 §4 定义发布后验收场景 |
| extensions 方向守卫改造 | `check-extension-files.mjs` 已覆盖漏声明方向（挂 pre-commit + preflight），现状健康 | 不动 |
| zsw 侧 vendor 通道回归 | 外部仓（zcode-plugin-workspace）事务 | 上游 0.5.2 发布后由对方回归，本设计提供验收口径 |

## 2. 现状与问题分析

### 2.1 三条发布路径的构建矩阵（现状）

subagent-core 在发布流程中**没有显式构建步骤**，其构建全部经由 smoke-core-dist.mjs 内部执行（[smoke-core-dist.mjs:89](../../scripts/smoke-core-dist.mjs) 仅 `pnpm run build` 档 1）；该脚本挂在全部三条路径上：

| 包 | 正式线 release-npm.yml | dev 线 release-npm-dev.yml | 本地 npm-prerelease.sh |
|---|---|---|---|
| extension-protocol | 显式 build（✅） | 显式 build（✅） | 不构建（依赖 CI） |
| session-delivery | 显式 build（✅） | **无 build 步骤（✗ 缺口）** | 不构建（依赖 CI） |
| subagent-core 档 1 `build` | smoke 内部副作用 | smoke 内部副作用 | smoke 阶段 1.5 副作用 |
| subagent-core 档 2 `build:bundle` | **无任何入口（✗ 事故缺口）** | **无任何入口（✗）** | **无任何入口（✗）** |

session-delivery 缺口尚未炸的原因只是它从未走过 dev 线（npm 版本史无 `-dev` 号）；一旦需要预发布，publish 时磁盘无 dist，会发出无 dist 的坏包——与 subagent-core 完全同型的事故剧本。

### 2.2 事故链复盘（0.4.0 / 0.5.1 tarball 缺 dist.bundle）

**实测证据**（2026-09-07 独立核实，非转述外部报告）：

- registry 下载 `@zhushanwen/subagent-core@0.5.1` tarball：`dist.bundle` 相关文件 **0 个**；
- [packages/subagent-core/package.json](../../packages/subagent-core/package.json) `files` 白名单第 148 行声明 `"dist.bundle/"`，[tsup.config.ts](../../packages/subagent-core/tsup.config.ts) 档 2（bundleConfig）就是为该产物存在的（注释：「host-surface D2 的 vendoring 产物，给无 node_modules 解析面的宿主」），并写明「全量构建 = build && build:bundle」；
- 发布管线（两条 workflow + 本地预发布脚本）全部经由 smoke-core-dist.mjs 构建，该脚本只跑档 1。

**根因三层**：

1. **直接根因**：发布流程缺 `build:bundle` 步骤。
2. **结构诱因**：smoke-core-dist.mjs 的职责纠缠——名义上是验证门（D9-② dist 发布回归），事实上是 subagent-core 在发布管线里的**唯一构建入口**。它内部跑哪档 build，tarball 里就有什么；「验证门的构建范围」从未被当作「发布的产出范围」来审视。
3. **零报警的原因**：npm pack 对幽灵条目静默跳过 + 守卫矩阵半覆盖（见 2.3）——发布门（smoke）只断言 `dist/` 完整性，对 `dist.bundle/` 零检查。

**外部影响面**：zsw 插件（zcode-plugin-workspace 仓）的 vendor 脚本 `--npm` 通道设计为「拉 npm tarball 的 dist.bundle 副本」，因 tarball 从未有货而不可用，被迫长期走 `--local` 源仓通道；vendor 副本的自包含探针把 npm 通道副本如实标 `selfContainedIndex=false`（等价废副本）。

### 2.3 问题家族两面（已出两次事故）

「files 白名单 ↔ 实际产物」漂移有两个方向，各出过一次事故，守卫覆盖只有一面：

| 方向 | 事故 | 形态 | 守卫现状 |
|---|---|---|---|
| **漏声明**（产物有、白名单没有） | pi-subagent-workflow@8.8.1（2026-08） | import 闭包新增 `src/session-lifecycle.ts`，逐文件枚举的白名单漏同步 → tarball 缺文件 → 用户端 `pi update` 后加载即崩 | ✅ `check-extension-files.mjs`（import 闭包 ⊆ 白名单 + 资源文件 ⊆ 白名单 + 幽灵条目检查），挂 pre-commit + preflight [10/10]；**但扫描范围硬编码 `extensions/`** |
| **幽灵声明**（白名单有、产物没有） | subagent-core 0.4.0 / 0.5.1（本事故） | `files` 声明 `dist.bundle/`，构建流程不产出 → tarball 缺目录 → 外部 vendor `--npm` 通道废 | ✗ 无任何守卫覆盖 `packages/` 下的 dist 包 |

共同根因：**files 白名单是发布面的声明式承诺，但没有任何机器把它与实际产出对齐**。值得注意的是，治本逻辑（幽灵条目检查）在 check-extension-files.mjs 检查项 3 里已经实现——守卫已经写好了，只是没照到出事的房间。本设计的新守卫**双向覆盖两个方向**：幽灵声明方向（files 有、产物没有）由条目存在性检查拦截；漏声明方向（产物有、files 没有——新增产物档构建了忘加 files，tarball 同样静默缺货）由产物目录反向覆盖检查拦截（见 D5 检查项 3），把 §2.3 两个方向都关进机器门。

### 2.4 现有发布门盘点（证明新守卫职责不重叠）

| 门 | 职责 | 与本设计关系 |
|---|---|---|
| smoke-core-dist.mjs（D9-②） | subagent-core `dist/` 档：构建 + require 加载 + golden 回放 | 正交（它管产物质量，本设计管产物存在性与自包含性） |
| check-subagent-core-closure.mjs（D9-①） | 依赖闭包红线（零 pi SDK / 零宿主专属依赖），静态扫描 | 正交（管依赖图，不管产物文件） |
| check-core-dist-gate.mjs | dist 产物质量（bundle module 重叠扫描 + 子入口符号比对） | 正交（管产物内部结构） |
| check-extension-files.mjs | extensions 方向 files 一致性（漏声明 + 幽灵条目） | 互补（本设计补 packages 方向，复用其幽灵条目语义） |
| **（空缺位）** | **packages 方向 files 一致性 + 自包含档探针** | **本设计填补** |

## 3. 解决方案

### 3.1 终态（发布者视角）

**正常路径**：发布工程师推 `npm-*` tag → CI 按显式步骤构建全部产物档（extension-protocol → session-delivery → subagent-core 两档）→ 既有各门（typecheck / smoke / closure）→ 发布面守卫绿 → `changeset publish` → tarball 实测含全部白名单声明产物。

**失败路径 1——幽灵条目**（新增产物档忘了构建）：

```text
✗ @zhushanwen/subagent-core: files 白名单条目 "dist.worker/" 在磁盘上不存在（幽灵条目）
  修复：在 .github/workflows/ 的 release-npm.yml / release-npm-dev.yml / ci.yml
  三处构建段（ci.yml 段名 Build dist packages）为该档补齐构建命令
  （pnpm --filter @zhushanwen/subagent-core run <script>）后重推 tag
```

指引按条目形态分流：非 dist 前缀的纯文件条目（README.md / LICENSE 等，非构建产物）幽灵按「补文件或从 files 删条目」处置——守卫报错文案同此分流（实施期 extension-protocol README 幽灵即该形态，统一「补构建命令」文案对它失准）。

**失败路径 1b——产物目录反向覆盖**（构建了新产物档、忘了加 files，漏声明方向）：

```text
✗ @zhushanwen/subagent-core: 产物目录 "dist.worker/" 存在但未被 files 白名单覆盖
  ——未声明的产物不进 tarball（npm pack 静默跳过），消费方拿到的包缺该产物
  修复：发布产物则在 package.json files 补条目；非发布用途的构建目录改名（不得用 dist 前缀，见 C-proc-11）
```


**失败路径 2——自包含漂移**（tsup 配置漂移，noExternal 被误删）：

```text
✗ @zhushanwen/subagent-core: 自包含档 dist.bundle/index.cjs 含外部依赖 require("ajv")
  ——自包含档必须内联全部运行时依赖（vendoring 宿主无 node_modules 解析面）
  修复：核对 packages/subagent-core/tsup.config.ts bundleConfig.noExternal 后重新构建
```

**失败路径 3——PR 阶段拦截**：ci.yml PR invariants 段同源跑守卫（构建 + 校验），files 声明漂移在 PR 拦截，不必等到发布现场。

### 3.2 方案对比

| 维度 | A. 最小修补 | B. 守卫独立 + 构建显式化（推荐） | C. 产物契约 manifest |
|---|---|---|---|
| 做法 | smoke-core-dist.mjs 扩为两档构建 + 内嵌 dist.bundle 探针；dev 线补 session-delivery build | 新独立守卫 check-publish-surface.mjs（幽灵条目 + 自包含探针 + 产物目录反向覆盖，双向）挂发布门 + CI；workflow 显式构建全部档；dev 线补齐；statusline private + unified-hooks ignore；C-proc-11 登记 | 每包声明期望产物清单（manifest），npm pack --dry-run 双向比对 tarball 实际内容 vs 契约（多余文件也抓） |
| 长期架构合理性 | 中——守卫逻辑埋在 subagent-core 专属 smoke 里，extension-protocol / session-delivery 的幽灵条目仍无守卫；构建入口依旧隐式（smoke 副作用），事故结构诱因（职责纠缠）未除 | 高——「files↔产出」契约机器化，覆盖全部 dist 包与未来新档；构建入口显式，职责矩阵清晰 | 最高——声明即契约，双向校验 |
| 短期实现成本 | 最低（单文件改动） | 中（新脚本约 150 行 + 3 处 CI 接线 + 登记） | 高（契约格式设计 + 29 包发布面接入 + 维护负担） |
| 风险 | 下一个包或新增产物档重演同型事故；smoke 越长越难审计 | CI PR 段新增构建（秒级）；守卫 fail-closed 取向，误报需有明确修复口径 | 过度设计——「多余文件」方向无事故支撑；契约文件本身成为新的漂移面 |

**推荐 B**。被否方案反演（§2.2 的例子在 A / C 下会怎样）：

- **A 下**：本次事故能修（subagent-core 两档会构建），但 §2.1 的 session-delivery dev 线缺口只补了一半（build 步骤补了，幽灵条目守卫仍无）——未来 session-delivery 的 files 加新档忘构建，同样零报警重演；且「构建入口 = smoke 副作用」的结构诱因原样保留，只是把纠缠的脚本从一档扩成两档。
- **C 下**：问题家族两面都能双向抓，但引入第三个人工维护的声明面（manifest）——它自身与 files 字段、与构建脚本都构成新的对齐债；当前 3 个 dist 包的规模撑不起这个架构成本。B 已覆盖两个已出事故的方向。C 的精神（声明契约）由 B 复用 files 字段承载——files 本身就是声明，B 让声明可被执行。

### 3.3 关键决策与权衡

**D1 守卫独立脚本，不并入 smoke-core-dist.mjs**

- 选择：新 `scripts/check-publish-surface.mjs`，扫描全部 dist 发布包。
- 被否：并入 smoke。理由：smoke 是 subagent-core 专属质量门（D9-②），发布面一致性是横切关注（覆盖 3 个包、未来自动覆盖新包）——并入即把横切约束钉死在单包的门上，extension-protocol / session-delivery 永远拿不到守卫。这正是 A 方案被否的核心。
- 证据：§2.4 职责矩阵的空缺位是「packages 方向」，不是「subagent-core 的 dist.bundle」。

**D2 挂载点：发布门 + CI PR invariants；刻意不挂 pre-commit**

- 发布门（release-npm.yml / release-npm-dev.yml，publish 前、build 步骤后）：权威拦截点——dist 类产物只有构建后才在磁盘上，这是唯一能校验「产出」语义的位置。
- CI PR invariants 段（ci.yml）：构建 3 个 dist 包后跑同源守卫。依据仓库既有通则（D7：pre-commit 之外的 CI 面同源拦截，ci.yml 中 G4 / D9-① 均此模式），漂移在 PR 拦截而非发布现场。
- 刻意不挂 pre-commit：dist 产物目录被 .gitignore（`dist/` pattern），干净 checkout 上守卫必红——**这是与 extensions 方向（源文件 git 内有，可挂 pre-commit）的刻意不对称**，由产物形态决定，不是疏漏。
- **拦截等级两级，如实登记**：发布门 = 硬拦截（release workflow job 失败则 `changeset publish` 不执行，机器强制）；CI PR 段 = 软拦截（main 分支当前无 branch protection、invariants 非 required check，红灯技术上不阻塞 merge，拦截力来自 merge 流程纪律）。若要 PR 段硬化，另立 branch protection 配置单元，不在本设计 scope。
- **dev 线挂载条件（与正式线不对称，刻意声明）**：release-npm-dev.yml 是条件化结构——`check_pre` 检查 `.changeset/pre.json` 存在性，Smoke / Publish 挂 `should_publish == 'true'` 条件，workflow 注释明文维护「未准备 pre.json 的分支不发布也不跑 smoke（job 整体绿跳过）」语义。本设计在 dev 线新增的三个 build step 与守卫 step **全部与 Smoke / Publish 同条件挂载**：skip 分支不发布，发布面校验无对象，空跑构建反而破坏「skip 整体绿」既有语义（且 npm-prerelease.sh 阶段 4 轮询 CI conclusion，会把误红当发布失败）。**既有 `Build extension-protocol` step 保持无条件不动**——历史挂载，skip 分支白跑成本秒级可忽略；刻意不为它加条件，避免本次改动触碰既有 step（统一与否不在本设计改动面）。
- 成本：PR 段新增 3 包构建（tsup 秒级 × 3，旁证：npm-prerelease.sh 注释实测 smoke 全程含 build+require+golden 约 5s）+ 守卫毫秒级，invariants job 增量预估 < 1 分钟——S5 实施时实测回填此数字。前提已核实（原待验证检查点关闭）：ci.yml invariants job 已有 `pnpm install --frozen-lockfile`（Install dependencies step），三包 tsup 均在 devDeps。

**D3 自包含探针 = 产物文件静态扫描 require 说明符（裸名判定 + 子路径豁免清单）**

- 选择：对自包含档入口（`dist.bundle/index.cjs`）做静态扫描 require 说明符，**判定顺序显式钉死**（顺序即防呆——内建子路径形态如 `fs/promises` 必须先于含 `/` 分流被 PASS，否则会误入豁免检查）：
  - **第一步**：`isBuiltin`（node:module 的 API）判定——覆盖裸名、`node:` 前缀、内建子路径（`fs/promises` / `node:fs/promises`）三形态，命中即 PASS；
  - **第二步**：相对路径（`./` / `../` 开头）PASS；
  - **第三步**：剩余说明符按是否含 `/` 分流——**裸包名形态**（不含 `/`，如 `require("ajv")`）即红（tsup external 残留的真实形态，external 保留源码 import 原样，源码 import 均为裸名）；**子路径形态**（含 `/`，如 `require("ajv/dist/runtime/validation_error")`）须命中**已知字面量豁免清单**才 PASS，未命中即红（fail-closed）。
- 豁免清单当前一条：`ajv/dist/runtime/*`。成因登记：ajv 被 vendor 进 bundle 后，其 codegen 生成验证函数源码时写入的**字符串字面量**（scopeValue 的 code 属性，进程内执行走 ref 注入、不发生真实 require——运行时自包含成立），产物实测 4 处（行 4489 / 5503 / 6359 / 6578，形态统一为 `require("ajv/dist/runtime/<x>").default`）。**豁免条目登记预期计数与形态锚点**：该条目预期命中 4 次、统一后缀 `.default` 形态——守卫断言命中数 ≤ 预期且形态匹配，超出即红（堵住前缀过宽被滥用为漏报通道的理论空间：同前缀的真实 require 调用会让计数超预期）；命中数**少于**预期时不红，输出 notice 提示复核登记（字面量减少通常为 vendor 版本变化的良性漂移，但登记漂移无信号会让锚点逐渐失真）。
- **✅已测**（2026-09-07 实测，非推理）：本地 `pnpm run build:bundle` 产物 1,363,923 bytes（约 1.36MB），require 说明符实测分布 = node 内建（fs×34 / path×33 / os×8 / child_process×6 / fs/promises×5 等）+ `ajv/dist/runtime/*` 字面量 ×4 + **零裸名外部说明符**——按上述判定规则基线（未漂移）绿可证；反向推演，tsup bundleConfig 的 `noExternal` 若漂移删除 `'ajv'`，产物将出现裸名 `require("ajv")`（esbuild 对 external 依赖保留 import 原样），探针必抓。
- 被否：运行时 require 探针（加载产物看是否 MODULE_NOT_FOUND）。理由：CI 环境有 node_modules 解析面（pnpm install 后 ajv 可解析），require 成功 ≠ 自包含——探针会被解析面污染出假绿。静态扫描零依赖且判定精确。
- 边界与误报处置：扫描正则兼容单/双引号（`require("x")` / `require('x')`）；新的子路径字面量形态命中（fail-closed 红）时处置为「先分析形态——真实外部残留则修 tsup `noExternal`，确认是 vendor codegen 字面量且进程内不真实 require 则进豁免清单并注明成因」——不是静默放过，也不要求修改 vendor 输出（vendor 产物文本不可操作）。

**D4 smoke 内部 build 保留，workflow 显式构建为产出权威**

- 选择：workflow 新增显式步骤 `pnpm --filter @zhushanwen/subagent-core run build && pnpm --filter @zhushanwen/subagent-core run build:bundle`；smoke 内部的档 1 build 保留不动。
- 被否：从 smoke 里删掉 build（纯验证化）。理由：smoke 的语义包含「发布门自证可重复构建」——删掉后单独本地跑 smoke 需先手动 build，可用性下降；重复构建成本 tsup 幒等重建 ~秒级（clean:true），可忽略。
- 效果：构建产出由显式步骤保证（G2），smoke 保留验证自含性——两条路径互不依赖，任一缺失守卫都能红。

**D5 守卫覆盖面 = files 含 `dist` 前缀目录条目的全部发布包，检查双向**

- 选择：守卫动态发现覆盖对象（扫 packages/ 下非 private 包，files 含 `dist*` 目录条目即纳入），非硬编码 3 包名单。未来新 dist 包自动进守卫面（隐含边界：扫描范围限 packages/，resources/ 等目录下未来若出现 dist 包不在面内——与当前发布面一致）。
- **检查项 1 幽灵条目（幽灵声明方向）**：files 每个条目磁盘存在且非空——**判定信号以磁盘 stat 为准而非字符串尾斜杠**（条目在磁盘是目录即按目录形态处理：须至少含 1 文件；是文件即按文件形态：须存在。extension-protocol / session-delivery 的 files 条目是 `"dist"` 无尾斜杠，字符串形态判定会错走精确文件分支漏掉非空断言——tsup 漂移产出空 dist 目录时将守卫绿，而 npm pack 对空目录同样静默跳过）。glob 条目须至少命中 1 文件。语义与 check-extension-files.mjs 检查项 3 对齐。
- **检查项 2 自包含探针（仅有自包含档的包）**：自包含档的识别约定 = 目录名 `dist.bundle`（tsup.config.ts 注释已确立该语义，「自包含 vendoring 产物」）。未来新增自包含档遵循同命名约定，探针自动覆盖。**不**对常规 `dist/` 档做自包含要求——常规档刻意保留外部依赖（宿主有 node_modules 解析面），这是双档设计的本意。
- **检查项 3 产物目录反向覆盖（漏声明方向）**：包目录下磁盘存在的顶层 `dist*` 目录，必须被 files 白名单至少一个条目覆盖（目录条目或同名的精确条目）——新增产物档（如 `dist.worker/`）构建了但忘加 files 时，tarball 同样静默缺货零报警（与 0.4.0 事故严格对偶的形态），此检查项在构建后拦截。配套命名约定（写入 C-proc-11）：`dist` 前缀目录 = 发布产物意图，非发布用途的构建目录不得用 `dist` 前缀（否则反向检查误红——fail-closed 取向，改名即可）。

**D6 statusline 加 `private: true`；pi-unified-hooks 进 changeset ignore**

- statusline（`resources/plugins/statusline`，v0.3.14）**不在 pnpm workspace**（pnpm-workspace.yaml globs 仅 packages/*、apps/*、extensions/{taiji,universal,shared}/*）——机制性结论：非 workspace 包不经 changesets 发布线（changesets 按包管理器 workspace 发现包），「给它写 changeset」「加 changeset ignore」对它都无效。它无 private 字段 + 无 files 字段，真实尾部风险是有人在该目录手滑 `npm publish`（全目录打包）——`"private": true` 是该形态的唯一机制层拦截（npm 拒绝 publish private 包），写入 C-proc-11 登记。
- `pi-unified-hooks`（deprecated，workspace 内、非 private——设计时未 ignore，u4 已落地 ignore）：deprecated 包不应再发版，显式加入 `.changeset/config.json` ignore——workspace 内包 ignore 有效，一行清偿。
- 被否：statusline 进 changeset ignore——机制上无效（死条目），不产生任何防护。

**D7 体积代价量化登记（四要素齐备）**

- **量级**：`dist.bundle/index.cjs` 实测 1,363,923 bytes（约 1.36MB），进 tarball 后 subagent-core 包体积相应增长，每次发布 +1.36MB 且随版本在 registry 单调累积（历史版本不可撤回）。
- **显式判定**：可接受——files 白名单 0.4.0 起已声明该产物，本设计只是让承诺兑现；zsw vendoring 场景（插件目录整体复制、无依赖安装链）是该产物的唯一消费者，体积换自包含是设计内的代价；常规 npm 消费者经 exports 解析仍走 `dist/`，运行时无影响，仅 install 时多下载该体积。
- **恢复路径**：若代价需回收——files 撤 `dist.bundle/` 条目 + zsw vendor 通道回退 `--local`（源仓构建）通道。注意这是破坏性回退（已发布版本不可撤、zsw 侧需配合切通道），恢复通道存在但代价高，登记为「可回退不轻易回退」。
- **重审触发条件**：subagent-core 单版 tarball 总体积 > 5MB，或出现第二个非 vendoring 场景却依赖 dist.bundle 的消费者时，重审双档发布形态（如改 optionalDependencies 子包 / 独立 @zhushanwen/subagent-core-bundle 包）。**机器回显**：守卫对每个覆盖对象按 files 白名单条目求和估算打包体积，超 5MB 输出 warning（不红，提示触发本条重审）——重审触发不靠发布者人眼看 npm pack 输出。

**D8 产物契约 manifest 的触发条件（延后项收口）**

- 登记不实施。触发条件（满足其一再立项）：dist 发布包增至 ≥5 个；或出现「多余文件进 tarball」方向的实际事故；或单包产物档增至 ≥3 档；或 D5 检查项 3（反向覆盖）出现绕过形态的实际事故（如非 dist 前缀的产物目录漏声明——manifest 的 tarball 内容双向比对是该方向的终态覆盖）。

### 3.4 终态发布管线数据流（物理流）

```text
push npm-* tag（正式线）
  └─ release-npm.yml
       ├─ checkout（全新，无本地构建残留）
       ├─ pnpm install --frozen-lockfile
       ├─ Build extension-protocol          ── 显式 ──▶ dist/（files: dist）
       ├─ Build session-delivery            ── 显式 ──▶ dist/（files: dist）
       ├─ Build subagent-core（两档）        ── 显式 ──▶ dist/ + dist.bundle/（files: dist/ + dist.bundle/）
       ├─ Typecheck extensions
       ├─ Smoke subagent-core dist（D9-②，内部幂等重建档 1）
       ├─ Closure guard（D9-①）
       ├─ 【新】Publish surface guard（双向：幽灵条目 × 3 包 + 产物目录反向覆盖 × 3 包 + 自包含探针）
       │     ✗ 红 → job 失败，报错含恢复指引（§3.1 失败路径），无 tarball 产生
       └─ changeset publish ──▶ registry tarball（白名单条目全部有货）
                                 └─ zsw vendor --npm 通道可拉取合规副本
```

dev 线（release-npm-dev.yml）为条件化结构（与正式线不对称，刻意声明，见 D2）：`check_pre` 检查 `.changeset/pre.json` 存在性，现有 Smoke / Publish 挂 `should_publish == 'true'` 条件（未准备 pre.json 的分支不发布、job 整体绿跳过）；本设计新增的 session-delivery build、subagent-core 两档 build、守卫 step **全部与 Smoke / Publish 同条件挂载**——skip 分支不发布即不校验，维持既有 skip 语义。本地 npm-prerelease.sh 无需改动——它不直接 publish，产出由触发的 CI 线保证。

## 4. 验收

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| S1 | 幽灵条目拦截（本地） | 临时在 subagent-core `files` 加 `"dist.worker/"`（不构建）→ 跑 `node scripts/check-publish-surface.mjs` | 红；报错指明幽灵条目 + 恢复指引（补 workflow 构建命令）；撤掉临时条目后绿 | G1 |
| S1b | 产物目录反向覆盖拦截（本地，漏声明方向） | 临时 `mkdir packages/subagent-core/dist.worker`（放一个占位 .cjs，不加 files 条目）→ 跑守卫；然后 files 补 `"dist.worker/"` 再跑 | 先红：报「产物目录存在但未被 files 覆盖」+ 恢复指引（补 files 条目 / 非发布目录改名）；补条目后全绿（占位文件满足幽灵条目的非空断言；真实产物档上线时由 u2 的显式构建步骤保证有货） | G1 |
| S2 | 历史事故重演拦截 | 干净 checkout（`git worktree` 新目录 + install）→ 按 release-npm.yml 步骤序执行构建段 → 跑守卫，但**跳过** build:bundle 步骤（模拟 0.5.1 现状） | 守卫红，报错含 `dist.bundle/` 幽灵条目；补跑 build:bundle 后同链路绿 | G1、G2 |
| S3 | 自包含探针抓漂移（含基线绿前置断言） | 前置：未漂移基线产物跑守卫，探针绿（0 裸名外部说明符，`ajv/dist/runtime/*` 豁免命中 4）；然后临时改 tsup.config.ts bundleConfig `noExternal` 移除 `'ajv'` → `build:bundle` → 跑守卫 | 基线绿成立；漂移态探针红，报裸名 `require("ajv")` + 指向 noExternal；还原配置重建后绿 | G1 |
| S4 | 全链路 tarball 实证 | 按 §3.4 完整步骤序构建 → `cd packages/subagent-core && npm pack --dry-run` | dry-run 清单含 `dist.bundle/index.cjs`；同法验证 extension-protocol / session-delivery 的 `dist` 非空 | G1、G2 |
| S5 | CI 接线生效（真实 Actions run） | 推分支：①正常分支 → invariants 段新 step 绿；②含幽灵条目 `dist.worker/` 或反向覆盖形态（构建了不加 files）的分支 → CI 红 | 两次真实 run 的 job 结论分别绿/红，红 run 的日志含恢复指引；记录 invariants job 实际时长增量回填 D2 | G1、G2 |
| S6 | dev 线缺口闭合（本地等价 + 条件语义） | release-npm-dev.yml diff 审查：session-delivery build + core 两档 + 守卫 step 均挂 `should_publish == 'true'` 条件、既有 `Build extension-protocol` 保持无条件；本地跑各 build 命令验证产出非空 + 守卫绿；未准备 pre.json 的 dev-npm-* 分支 push → job conclusion 仍为 success | 三 step 条件挂载正确、命令产出实证、skip 分支不被新 step 误红 | G3 |
| S6b | 发布面尾部风险清偿（u4 简化验收） | `node -p "require('./resources/plugins/statusline/package.json').private"` 输出 true；`.changeset/config.json` ignore 数组含 `@zhushanwen/pi-unified-hooks` | 两个断言成立（单行改动，简化验收） | G3 |
| S7 | 发布后终验（0.5.2） | 走 merge / prerelease skill 既有编排发布 → registry 下载 tarball → zsw 仓跑 vendor `--npm` 通道；干净目录 `npm install @zhushanwen/subagent-core@0.5.2` → require 主入口 + 4 条子入口（smoke 同口径） | tarball 实测含 `dist.bundle/index.cjs` 且 vendor 副本 `selfContainedIndex=true`；常规消费者升级路径不回归（require 全通） | G1–G3 闭环 |

S7 是外部消费方（zsw）真实回归，作为发布后场景登记——发布编排本身不在本设计拆分内。S1–S4 本地可完整执行，S5 需真实 CI run，S6 的 workflow 生效面在下次 dev 预发布（如近期无 dev 发布计划，以本地等价命令 + diff 审查为验收形态，如实登记）。

## 5. 下一层拆分

| 单元 | 内容 | 文件 | justification |
|---|---|---|---|
| u1 守卫脚本 | check-publish-surface.mjs：动态发现 dist 发布包 → 检查项 1 幽灵条目（磁盘 stat 判定形态：目录须非空 / 文件须存在 / glob 须命中）+ 检查项 2 自包含探针（三步判定顺序 + `ajv/dist/runtime/*` 豁免清单含预期计数 4 与形态锚点，见 D3）+ 检查项 3 产物目录反向覆盖（顶层 `dist*` 目录须被 files 覆盖，见 D5）+ 打包体积估算 warning（files 条目求和超 5MB 提示触发 D7 重审，不红）；配套单测 `scripts/__tests__/check-publish-surface.test.mjs`（按 check-core-dist-gate.test.mjs 惯例：vitest + tmpdir fixture；用例覆盖：幽灵条目三形态 × 无尾斜杠目录条目（`"dist"` 精确条目指向目录时的非空断言）、探针三步顺序（`fs/promises` / `node:fs/promises` 内建子路径第一步直接 PASS 不进豁免检查）、裸名红 / 豁免命中绿 / 子路径未命中红 / 豁免命中数超预期（5 处同前缀）红、反向覆盖命中 / 漏声明红、glob 零命中边界） | `scripts/check-publish-surface.mjs`（新）、`scripts/__tests__/check-publish-surface.test.mjs`（新） | 守卫是 G1 主体；独立单元可单独验收（S1/S1b–S3）；测试惯例与 scripts/__tests__ 现状对齐 |
| u2 发布 workflow 接线 | release-npm.yml：subagent-core 两档显式构建 step + 守卫 step（publish 前）+ Summary step 的 gates 清单文字补 publish surface guard；release-npm-dev.yml：session-delivery build + subagent-core 两档构建 + 守卫 step，**全部挂 `should_publish == 'true'` 条件**（D2 声明的 dev 线不对称结构） | `.github/workflows/release-npm.yml`、`.github/workflows/release-npm-dev.yml` | G2/G3；两条线分别接线，dev 线条件语义单独成项便于 diff 审查（S2/S6） |
| u3 CI PR 接线 | ci.yml invariants 段：3 包构建 + 守卫 step（同源直调，注释标注 D7 通则）；**同批**将 `scripts/__tests__/check-publish-surface.test.mjs` 追加进「Test - scripts guards」step 的显式文件清单（该清单逐名列举非 glob，漏追加 = 护栏测试永不运行） | `.github/workflows/ci.yml` | G1（PR 段软拦截）+ 护栏测试接线；与 u1 同批或紧随（u3 的清单项依赖 u1 产出） |
| u4 发布面尾部风险清偿 | statusline 加 `"private": true`（非 workspace 包的唯一机制层拦截，见 D6）；`pi-unified-hooks` 加入 changeset ignore | `resources/plugins/statusline/package.json`、`.changeset/config.json` | G3；两个单行改动独立成单元（低风险快验） |
| u5 约束登记 | constraints.json 新增 C-proc-11（发布面一致性：files 白名单条目 ↔ 构建产出双向对齐，发布门强制；新增产物档须同批挂构建步骤、files 条目与守卫覆盖；自包含档命名约定 `dist.bundle`、非发布构建目录不得用 `dist` 前缀；非 workspace 包不经 changeset 发布线、防手滑 publish 用 private:true）→ 跑 `node scripts/render-constraints.mjs` 重生成 md | `docs/constraints.json`、`docs/constraints.md`（生成） | G4；与 u1 同批绑定（u1 先落地守卫脚本、u5 紧随登记——render-constraints 实装校验 authority/hook 文件存在性，登记引用的脚本须先存在；「先登记再写代码」纪律由同批交付绑定满足，见变更历史 v5） |

**文件改动地图汇总**：新增 2（守卫 + 测试），修改 5（两条 release workflow、ci.yml、constraints.json/md、statusline package.json + changeset config）。

**待验证检查点**（设计阶段无法确定、实施期验证）：

1. D3 豁免清单的新形态判定——当前清单仅 `ajv/dist/runtime/*`（4 处实测登记）；实施期若探针命中新的子路径形态，按 D3 处置口径分析（真实残留修 noExternal / codegen 字面量进清单注明成因），不预设第三种形态。
2. S5 的 CI run 依赖真实分支推送，实施期安排；invariants job 实际时长增量回填 D2。

**实施顺序**：u1 → u5（登记紧随）→ u3（依赖 u1，护栏测试接线同批）→ u2 → u4；u1 完成即可跑 S1–S3，u2/u3 完成跑 S2/S5/S6，S4 全链路在 u1–u3 齐后执行，S7 随下次发布编排。初版写「u5（登记先行）→ u1」已被实施期实证否决——render-constraints.mjs 实装校验 authority 路径与 machine hook 的文件存在性（validateAuthorityPath / validateHookExists，渲染模式同样先校验后 exit 2），登记先行引用 u1 未来产出的守卫脚本必然 exit 2，机器不可通过；「先登记再写代码」纪律由「u1 与 u5 同批交付绑定」形态满足（见变更历史 v5）。

## 6. 变更历史

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-07 | v1 | 初版（问题诊断源于 subagent-core 0.4.0/0.5.1 tarball 缺 dist.bundle 事故分析，方案方向「按长期方案」用户拍板） |
| 2026-09-07 | v2 | 第 1 轮审查修复（主审 2 must-fix + 4 suggestion / 影响面审 4 must-fix + 4 suggestion，全修）：探针判定重设计为裸名判定 + `ajv/dist/runtime/*` 豁免清单（原「零外部说明符基线绿」与产物实测 4 处 ajv codegen 字面量矛盾）；D5 新增检查项 3 产物目录反向覆盖（机器化 packages/ 漏声明方向）；D6 重写（statusline 不在 workspace、changeset ignore 无效 → private:true + unified-hooks ignore）；D2 补两级拦截等级声明 + dev 线条件挂载；D7 四要素补齐（恢复路径 + 重审触发）+ 体积修正 1.36MB；D5 判定信号改磁盘 stat（无尾斜杠目录条目）；u2 补 Summary 文字同步；u3 补护栏测试进「Test - scripts guards」显式清单；S3 补基线绿前置断言、S6 补条件语义场景、S7 补常规消费者升级断言；发布面计数修正 24→30 |
| 2026-09-07 | v3 | 第 2 轮审查修复（主审 1 must-fix + 3 suggestion / 影响面审 0 must-fix + 3 suggestion + 2 INFO，全修）：检查项 3 链路五处同步（G1 扩双向语义 / §1.1 A / §3.2 B / §3.4 图 / §3.1 失败路径 1b）+ 新增 S1b 反向覆盖验收场景 + S5 补反向覆盖分支；D3 判定顺序钉死三步（isBuiltin 含子路径先行，防 fs/promises 误入豁免）+ 豁免条目登记预期计数 4 与形态锚点（堵前缀过宽漏报面）；§3.2 B 列措辞同步（statusline private + unified-hooks ignore）；D2 补既有 Build extension-protocol 保持无条件声明；D7 重审触发加守卫体积 warning 机器回显（采纳）；S6b 新增（u4 两项清偿的简化验收） |
| 2026-09-07 | v4 | 第 3 轮审查修复（主审 0 must-fix + 2 suggestion，全修；影响面审第 2 轮已达标）：「24 包」残留两处（§1.1 S / §3.2 C）同步为 30 包口径；豁免命中数少于预期时补不红的 notice 复核提示。审查循环收敛：主审 2+1+0 / 影响面 4+0 must-fix，双报告 0 must-fix + suggestion 全修 |
| 2026-09-07 | v5 | 实施期 doc_errors 修订（非审查轮）：§5 实施顺序「u5 登记先行 → u1」反转为「u1 → u5 紧随」，u5 行 justification 同步——u5 执行者实测 render-constraints.mjs 实装对 authority 路径与 machine hook 做 existsSync 校验（validateAuthorityPath 行 56-61 / validateHookExists 行 47-54，渲染模式同样先校验后 exit 2），登记引用 u1 未来产出的守卫脚本必然 exit 2，「登记先行」在机器门前不可通过；「先登记再写代码」纪律改由「u1 与 u5 同批交付绑定」满足（流水线状态表兜底：u1 committed 而 u5 pending 时中断即显式可见） |
| 2026-09-07 | v6 | 阶段 3 一致性审查（三区并行，0 unreasonable）doc_errors 修正：§3.1 失败路径 1 补指引分流说明（非 dist 前缀纯文件条目按补文件/删条目处置，守卫文案同步分流）；D2 行号引用改锚 step 名称（ci.yml 插入致行号漂移）；§5「u3（紧随 u1）」改「u3（依赖 u1）」（v5 修订残留）。README 三处内容缺陷（示例类型错误/包结构漏列/extractGui 参数语义）与守卫文案分流实现走阶段 4 修复批次 |
| 2026-09-07 | v7 | 第 4 轮审查修复（主审 0 must-fix + 3 suggestion，全修）：① 发布面计数更新为终态口径——u4 将 pi-unified-hooks 加入 changeset ignore 后未被 ignore 的 workspace 包为 28，终态发布面 = 28 + statusline = 29（§1.1 S / §1.2 计数句 / §3.2 C 三处 30→29，§1.2 TS 源直发行 26→25 并标注已 ignore，D6「未 ignore」补 u4 落地后状态）；② 幽灵条目恢复指引从仅指 release-npm.yml 扩为三处构建段（release-npm.yml / release-npm-dev.yml / ci.yml Build dist packages——按旧指引修复会漏 dev 线与 CI 面再次红灯），守卫 fixFor 文案与 §3.1 失败路径 1 示例同批同步，单测断言锁定三处文件名；③ 守卫测试 AJV_EXEMPT_OK 注释失实修正（单/双引号混合是覆盖 REQUIRE_RE 双分支的测试设计，真实产物实测 4 处全双引号、单引号 0——fixture 本身不动） |
| 2026-09-11 | v8 | ext-simplify-01 删包移除 ignore 条目，发布面计数不变（`.changeset/config.json` ignore 数组删除 `@zhushanwen/pi-unified-hooks` 末项——unified-hooks 整包删除后不在磁盘，删前被 ignore 排除、删后不在磁盘，31 包计数不变；§1.1 S / §1.2 全景句 / §1.2 分类表三处现行口径句同批补注记） |
