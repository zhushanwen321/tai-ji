# 同族 workflow 内容配套类 commit 拦截缺口（review-fix-loop / pr-lifecycle 双胞胎）

状态：已实施 + 验证通过（2026-10-12 收尾）。路线 B 按设计包 commit-content-self-heal（T2 审查 converged：must-fix 轨迹 3→2→0）落齐三份脚本：补修子循环（上限 2 次/报错原文权威源/快照对账/显式路径 add/同命令重跑/终态信息全集）+ 补修 agent 契约（CommitRepairReport 三版字段级同构）+ pr-lifecycle zcode 孪生 PATH 前缀注入（随批裁决）+ attempt throw 文案来源中性更新。验证：真机构造场景 review-fix-loop 批 4/4 PASS（补修成功/不可修终态/env 不可传播进补修/env 恢复成功零补修派发/正常成功零介入）、pr-lifecycle zcode 孪生场景 1 全链 PASS（真实维度审查→修复→拦截→补修→对账披露→重跑成功）+ attempt 自动重跑与来源中性 throw 文案实证；语义走查 pass（16 环节三版一致、0 must-fix）；pi 版降级为走查承接（全链真机单轮 ≥1400 万 token 且 pi `--args` 不支持数组无法 skipSteps——备份 `.bak-20261011` 保留，待首次真实使用观察后删）。实施期范围外必要改动 2 批（呈用户追认）：①孪生 cr-fix 维度裁剪 files.glob 不追 `.agents` symlink 致 reviewers 逃生舱恒空（存量缺陷）→ 改 fs.readdirSync 经 nodeAbs；②孪生 6 处裸 `world.run("node")` 在 PATH 无 node 引擎环境 spawn ENOENT 炸 fix 阶段、U4 不可达 → 全部改走 runNode。验证记录全文为 dev-flow 过程产物（已随 .tmp 清理，不入 git；git 可追溯 = 本 commit message）。原方案细节（三处现状/数据流/路线取舍）保留于下方各节备查。

## 三处现状实装（2026-10-11 逐行核实；行号以当日文件为准）

### 参照实装：dev-merge-gates 三分类契约与 content 补修循环（本方案不改它）

`.agents/workflows/dev-merge-gates.dwf.ts`（.agents 共享实体，经 worktree symlink 生效）：

- 提交 agent 结构化契约 `CommitReport`（L238-251）：committed=false 时 errorKind 必填 env|content|blocked 之一 + errorDetail 必填报错原文（≤4000 字符）。三分类判据在 committer prompt（L567-570）：env = 报错写明的恢复动作是环境命令；content = 恢复需改仓库内文件且报错写明具体动作；blocked = 其余一切（需改检查器本体 / 报错不可读 / 处置后仍失败）。
- 统一提交入口 `runUnifiedCommit`（L531-799）：committer agent（`dmg-committer-<tag>-r<轮>`，L548）按多组计划逐组 git add + commit；结构化返回校验失败回注失败原因重试一次（L550-598），仍败 TerminalError fix-failure。
- env 类：committer 自行执行恢复命令后重试，恢复动作逐条记 envActions 披露（prompt L568、披露 L599-601）。
- content 类补修循环（L629-790）：失败组进 contentQueue；每次补修派独立补修 fixer（`dmg-commit-fix-r<轮>-<组>-a<序号>`，L648-693），prompt 注入报错原文（untrusted 包裹 L666；恢复动作以报错原文为权威源，报错没写明可改文件的恢复动作时不臆测、返回空数组说明，L672-673）；repairedFiles 申报与 git status 前后快照差集交叉验证（L711-723，未申报文件以实际为准并入并披露）；补修文件并入组提交清单后重试 commit（L771）；重试仍 content 留队列（L782-785）、转其他类走 blocked（L786-788）；每组每轮上限 MAX_COMMIT_REPAIRS=2（常量 L100，超限分支 L697-707）；queueGuard = 组数×4+4 总迭代上限，防补修文件归属互指成环（L637）。
- blocked 类：组转提交待办 deferredCommits 不终止 run（branch-review 调用点 L1835）；committed=false 且非 content 的组走防御路由直接按 blocked 兜底（违约 env 申报同款，L617-628）。
- 组级编排机制（单次 commit 场景没有对应场景，取舍见下）：组间文件不相交校验、补修文件与其他组提交计划相交时并入该组清单（相交归属 L736-756）、与待办组登记文件相交归待办（L748-753）。

### review-fix-loop（zcode 全局 saved）

`~/.zcode/workflows/review-fix-loop.dwf.ts`：

- 统一 commit 段（L1117-1190）：fixer 不自行 commit（防并行 index 锁）；affectedFiles 清洗（L1119-1136）后逐路径 git add，existsSync 预过滤、单条失败跳过只 warn 不炸整轮（L1142-1156）。
- commit 失败路径（L1157-1184，缺口本体）：commit 经 commitShScript 执行（PATH 前缀注入钩子工具链，L150-151）；exitCode!=0 → 截报错原文 ≤4000 字符（L1165）→ 派环境恢复执行员 agent `commit-env-fix-r<轮>`（L1167，prompt L1168-1177：只执行报错写明的环境恢复命令；需改仓库文件才能恢复的回复「需人工处置」不动手）→ 脚本重跑同一 commit（L1179；git 命令仍由脚本执行、重跑结果即裁判）→ 仍败 `finish("fix-failure")`（L1180-1182）——content 类拦截在此终止 run。
- 脚本命令自愈机制（safeRun 层，L83-139，2026-10-11 事故加固）：包装全部命令调用；触发条件 = 命令抛 spawn 类异常（如 ENOENT，不是非零退出码）；处置 = 派只读诊断 agent `env-recovery-<序号>`（L114，人设 = 只读探查、绝不修改仓库内文件、绝不 git add/commit/reset）→ 原命令原样重试一次（L129-130，重试参数不变，保 journal 重放确定性）→ 仍败合成 exitCode:-1 失败对象走调用方既有 exitCode 处理链（L131-137）；诊断回复只进日志与失败信息，不参与重试参数。**定性：这是「只读诊断 + 原命令重试」，不是「agent 修复后重跑」**——诊断 agent 不改任何东西，重试的命令与参数与首次完全相同；配套的结构性消除 = 启动解析 node 绝对路径 runNode（L141-144）+ commitShScript PATH 前缀（L146-151）。

### pr-lifecycle zcode 孪生

`.agents/skills/pr-cr-fix/workflows/pr-lifecycle.dwf.ts`：统一 commit 段 L1107-1174，与 review-fix-loop 同构（world.run 直跑 commit，无 PATH 前缀注入）；commit 失败路径 L1143-1168：env 恢复 agent L1151-1161 → 重试 L1163 → 仍败 fix-failure L1164-1165。头部与 pi 版互注「改任一侧须同步另一侧语义」。原登记漏算此文件，2026-10-11 核实补入缺口面。

### pr-lifecycle pi 版

`.agents/workflows/pr-lifecycle.js`：统一 commit 段 L1290-1365 同构；commit 失败路径 L1326-1359：env 恢复 agent 用 pi 对象形态调用 `agent({prompt, description, model, returnMeta})`（L1335-1347；agent 自身失败 try/catch 不炸，L1350-1353）→ 重试 L1354 → 仍败 fix-failure L1355-1356。终态清扫 sweepResidualChanges（L292-306）在收敛出口把全部残留显式路径提交随 push 推出（清扫自身 commit 失败直接 throw，L301-303）——残留不丢，但 content 类拦截本身仍终止 cr-fix 循环。

### dev-consistency-loop（不构成 run 级缺口，不在改动范围）

`~/.zcode/workflows/dev-consistency-loop.dwf.ts` L1655-1656：组 commit 失败仅记 WARN、改动留工作区随复审重修，run 不终止——组 agent 仍在会话中、有写权限，可自行补登记重试。

### subagent-core 内置 review-fix-loop（同款缺口——已实施，2026-10-23）

`packages/subagent-core/workflows/review-fix-loop.js`（pi 内置版）：统一 commit 失败分支与三份改动对象同款 env-only → fix-failure 缺口。**已修复（2026-10-23）**：补修子循环经双版本单源化落地——`contentRepairLoop`（路线 B 数据流的 ctx 注入版）实装在 `packages/subagent-core/workflows/src/review-fix-loop.shared.ts`，zcode 版（`~/.zcode/workflows/review-fix-loop.dwf.ts`，经仓内 `workflows/review-fix-loop.dwf.ts` 构建同步）与 pi 内置版共用同一实现，经 `pnpm build:workflows`（`scripts/build-review-fix-loop.mjs`）拼装生成；pi 壳 ctx 装配 = execFileSync 包 CmdResult + ajv schema 补修 agent + 失败信封转 undefined 统一进校验路径。同批吸收 zcode 版优点：聚合失败重试回注失败原因（对齐 REVIEWER_RETRY_SUFFIX 形态）。随批顺带把 `inheritCarryoverFields`/`applyCarryoverRegression` 从 utils.cjs 迁出（前者单源化，后者随 pi 模板——CJS 模块作用域无法引用脚本顶层单源段）。产物一致性由 `src/__tests__/review-fix-loop-build.test.ts`（--check 等价）+ `contentRepairLoop` mock ctx 单测守护。发版：随 `@zhushanwen/subagent-core` 版本 bump + npm publish 生效（files 排除 workflows/src，单源源文件不入包）。

## 确定方案：路线 B——env agent 骨架扩展 content 补修分支

### 适配前提：两组场景的结构差异

dev-merge-gates 是组级 commit 编排（committer agent 按多组计划逐组提交，组有独立文件清单，存在组间文件相交的归属问题）；review-fix-loop / pr-lifecycle 是**单次统一 commit**（脚本直接执行一条 git commit，本轮全部 staged 路径一笔提交，无分组）。因此 dev-merge-gates 的组级编排机制（errorKind 组级申报 / 相交归属 / contentQueue / deferredCommits 转待办 / queueGuard）在单次场景没有对应场景；单次场景缺的只是「content 类恢复动作的执行者」。

### 数据流（三份脚本同构）

```
统一 commit（脚本执行）
  成功 → 本轮正常继续
  失败（exitCode != 0）
    ├─ 截报错原文 firstErr ≤4000 字符（现行已有）
    ├─ env 恢复 agent（现行逻辑保留）：只执行报错写明的环境恢复命令；
    │   需改仓库文件才能恢复的回复「需人工处置」、不动手
    ├─ 脚本重跑同一 commit（现行逻辑保留；重跑结果即裁判）
    │   成功 → 继续
    │   仍败 → 进入 content 补修子循环（新增，每轮 ≤ MAX_COMMIT_REPAIRS=2 次）：
    │     1. 派补修 agent，注入最新报错原文（untrusted 包裹；恢复动作以报错
    │        原文为权威源；报错没写明可改文件的恢复动作时不臆测，返回空
    │        repairedFiles 并说明）。红线：只改报错点名的登记/配套文件，不碰
    │        其他文件与检查器本体，不 commit（脚本统一执行），绝不
    │        --no-verify 与 SKIP_*
    │     2. 结构化返回 { repairedFiles, note }；repairedFiles 与
    │        git status --porcelain 前后快照差集交叉验证（差集 = 补修期间
    │        新增脏文件；未申报文件以实际为准并入并披露）
    │     3. git add -- <对账后全部补修文件>（补修文件必须进 staged：
    │        e2e-map 等登记门禁按 --staged 模式只查暂存内容，不进 staged
    │        则门禁原样再拦，补修白做）
    │     4. 脚本重跑同一 commit
    │          成功 → 跳出，log 补修摘要（补修文件 + 报错首行 + note）
    │          仍败 → 次数 +1，最新报错进下一轮补修 prompt（≤2 次）
    │     5. 补修 agent 返回不可修（repairedFiles 空）或超限 →
    │        fix-failure（现行终态不变；信息带末次报错首行 + 补修尝试次数 +
    │        补修涉及文件 + note 末段——人工 git status 盘点后显式路径处置）
```

设计要点：

- 分类判定不引入 committer errorKind 结构化申报——content 可行性由补修 agent 首轮自判（报错原文没有可改文件的恢复动作 → 如实返回空 → 直接终态）；blocked 类（需改检查器本体 / 报错不可读）自然落进「补修 agent 判不可修 → fix-failure」，无需独立通道——单次 commit 场景没有「转待办继续跑」的语义空间，fix-failure 本就是诚实终态。其上的重跑成本按宿主分层如实登记（细化与实装行号见设计文档 §3.1「与 pr-lifecycle attempt 重试层的交互」，R2 评审同步修正）：review-fix-loop 上 fix-failure 即 run 终态；pr-lifecycle 两版上 attempt 层自动重跑一次（run 级补修上限 2×2 + 一轮额外 review/聚合/修复 agent 用量），attempt 2 的 review 重新覆盖未提交工作区改动、已修复问题可能重报重修——「已修复问题不再报出」只在改动已 commit 的常规收敛场景成立，content 拦截场景（改动留 staged 未提交）不成立。
- env 恢复只在首次失败跑一次；补修循环内若暴露 env 形态新报错，由补修 agent 如实申报不可修走终态（报错原文保留在终态信息里）——env 恢复命令通常是确定性动作、首次已执行过，为低概率形态加循环分支属投机复杂度。
- env agent 空跑一次（content 类拦截时它回复「需人工处置」后重跑注定再拦）是现行行为，保持不变——不为省一次重跑引入「已执行 / 需人工处置」回复前缀的文本解析分支（脆弱），重跑结果即裁判的哲学不变。
- 终态不降级：fix-failure 语义、显式路径纪律（add 恒显式路径）、journal 重放确定性（重试恒同一 commit 命令）全部保持。

### 两条路线取舍

- **路线 A（完整移植 dev-merge-gates 形态，不采用）**：把「脚本直跑 commit」改为「派 committer agent 执行 + CommitReport errorKind 结构化申报」+ 补修循环全套。理由：① 三份脚本统一 commit 段全部重写为 agent 执行形态，改动范围与回归测试范围大（当初不同步改三处的理由同样成立）；② 与现行设计边界冲突——review-fix-loop 系「git 命令由脚本执行、重跑结果即裁判」（journal 重放确定性 + 显式路径纪律都在脚本侧），把 commit 移交 agent 弱化该边界；③ 场景不匹配——单次 commit 无分组，errorKind 组级申报、相交归属、contentQueue、deferredCommits、queueGuard 全部没有对应场景。
- **路线 B（采用）**：保留脚本直跑 commit，把 env 恢复 agent 已验证的「agent 执行恢复动作 → 脚本重跑」骨架扩展出 content 分支（执行者从环境命令换成文件补全）；dev-merge-gates 补修循环的精华（报错原文权威源 / repairedFiles 对账 / 每轮 ≤2 上限 / 不臆测红线 / 越权披露）全部保留，组级编排部分按场景裁掉。
- **脚本自愈 agent() 兜底模式评估结论**（2026-10-11 用户点名核实）：safeRun 的「只读诊断 + 原命令重试」形态**不适用** content 类——content 类失败重跑原命令必然原样再拦（恢复必须改文件，诊断不解决任何问题）；commit-env-fix 的「agent 执行恢复动作 → 脚本重跑」形态**适用**且正是路线 B 的骨架；dev-merge-gates 补修循环 = 该形态在 content 类上的完整实装（agent 改文件 + 结构化对账 + 上限），路线 B 是它在单次 commit 场景的最小化移植。

### 补修 agent 契约

- zcode 两份：`agent(name, persona).ask<CommitRepairReport>()`；`CommitRepairReport = { repairedFiles: string[]（补修涉及全部文件，不只报错点名文件，供披露核对越权）, note: string（一句补修说明）}`，与 dev-merge-gates L253-259 同构；actor 名 `commit-content-fix-r<轮>-a<序号>`（带尝试序号，防同轮多次补修撞 actor 名——dev-merge-gates L649-650 同款教训）。
- pi 一份：`agent({prompt, description, model, returnMeta})` + 手写 JSON Schema（ajv 校验，与 pr-lifecycle.js 现有 fixer 契约同款形态）。
- persona 红线：只按报错原文写明的恢复动作修改登记/配套文件，不碰其他文件与检查器本体，不 commit（脚本统一执行），绝不 --no-verify 与 SKIP_* 变量，无法修复时如实返回空列表。

## 改动文件清单与实施步骤

| 文件 | 改动 |
|------|------|
| `~/.zcode/workflows/review-fix-loop.dwf.ts` | L1160-1184 commit 失败分支接入 content 补修子循环；新增 CommitRepairReport 类型 + MAX_COMMIT_REPAIRS=2 常量 |
| `<workspace>/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.dwf.ts`（zcode 孪生，经 worktree symlink 生效） | L1144-1168 同款改造 |
| `<workspace>/.agents/workflows/pr-lifecycle.js`（pi 版，同上） | L1327-1359 同款改造（pi agent 形态 + ajv schema） |

参照实装不改：`.agents/workflows/dev-merge-gates.dwf.ts`。三份脚本均为 .agents 共享实体 / 全局目录文件，不入 git 跟踪、无 CI 防线，改动前各备份一份（`.bak-<日期>` 同目录形态，验证通过后删）。

实施步骤：① review-fix-loop 先改先验（脚本最短、循环独立，验证最快）；② pr-lifecycle 双胞胎按 zcode → pi 顺序同步（头部互注要求两侧语义一致）；③ 每份改完即跑下方验证，全部通过后删备份。

建议随批顺带（改动极小，实施时裁决）：pr-lifecycle zcode 孪生的统一 commit 补 PATH 前缀注入（commitShScript 同款形态）——review-fix-loop 2026-10-11 事故实证 zcode 引擎环境 PATH 无 nvm node 时钩子子进程 `npx: command not found`，该形态在 zcode 孪生上会以 env 类失败呈现且 env agent 修不了（非恢复命令可解）；pi 版经用户 shell 起 pi 进程、PATH 通常完整，不强制。

## 实施后验证

1. 语义走查：三份 diff 对照上方数据流逐环节核对（报错捕获 → env 分支 → 补修 agent 自判 → 对账 → add → 重跑 → 上限 → 终态信息完整），三版语义一致、仅平台 API 形态差异。
2. 真机构造验证（每份脚本一次）：测试仓库装临时 pre-commit hook（如「docs/x.md 必须含某标记否则 exit 1」）→ 制造缺登记的 staged 改动 → 跑 workflow 触发统一 commit → 观察补修 agent 产出 → 对账 → git add → 重跑成功路径；再构造补修必然失败的场景（标记要求自相矛盾）观察 ≤2 次上限后 fix-failure 终态与信息完整 → 移除临时 hook，验证记录落 `.tmp/`（易失工作产物目录，不入库）。
3. 现行回归点：env 类恢复路径行为不变（content 分支只接在其后）；commit 成功路径零变化；显式路径纪律不变。

## 核实附记（2026-10-11）

- 原登记行号 `review-fix-loop.dwf.ts:1094` 已漂移：该文件 2026-10-11 当日加固 safeRun 层（命令执行兜底层），commit 失败路径现为 L1157-1184。
- 缺口面原登记两处（review-fix-loop + pr-lifecycle pi 版），核实为三处：pr-lifecycle 的 zcode 孪生版同款 env-only → fix-failure（L1143-1168），已并入改动清单。
- 缺口面三处枚举经设计评审 R1（2026-10-11）复核仍有遗漏：`packages/subagent-core/workflows/review-fix-loop.js`（pi 内置版）同款缺口同日补入上方排除登记（不在本批，理由见该节）——「逐行核实三处现状」的原边界声明以该补正为准。
- 用户转述的「脚本命令自愈 = agent() 兜底修复并重新执行脚本」与实装有出入：实装为「spawn 异常 → 只读诊断 agent → 原命令原样重试一次」，agent 不修复任何东西；真正「agent 执行恢复动作后脚本重跑」的形态是 commit-env-fix agent（env 类），dev-merge-gates 补修循环是其 content 类完整实装。取舍结论见「两条路线取舍」。
