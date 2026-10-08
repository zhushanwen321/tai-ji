---
name: dev-merge
description: >-
  Use when 将当前 feature worktree 的分支合并到兄弟 dev-x.x.x 集成 worktree 并清理源
  worktree。触发词："dev-merge"、"/dev-merge"、"合并到 dev"、"合并 worktree"。
  不用于 合并到 main 并发布（用 merge skill）、创建/管理 worktree（用 worktree-manipulate）。
---

# dev-merge

把**当前 feat worktree** 的分支合并到 `../dev-x.x.x` 集成 worktree（bare repo + 兄弟 worktree 布局），合并完成后清理源 worktree 与分支。

**输入**：一个参数 = 目标 dev 分支名（同时是 worktree 目录名），如 `dev-0.9.11`。无参数时列出 `../dev-*` 让用户选择，不要猜。

**边界**：
- 只做本地集成合并，**不 push**（push 必须用户明确授权）
- 合并到 main 并走发布流程 → `merge` skill
- worktree 的创建/其他管理 → `worktree-manipulate` skill

## 流程

**并发约束**：同一目标 dev worktree 同一时刻只允许一个 dev-merge 会话/workflow 在跑（含 cherry-pick 重放等长占工作区的合并形态）——两个合并并发操作同一工作区会互相破坏暂存区与冲突解决现场（历史事故：并行会话 `git restore` 清掉对方的 staged 文件）。发起前先确认目标 worktree 无进行中的合并（`git status` 有冲突标记 / CHERRY_PICK_HEAD / MERGE_HEAD 即占用中），占用则等其收尾或换目标线。

**调用约束**：cwd 必须在待合并 feat worktree 根目录（脚本靠 `git rev-parse --show-toplevel` 定位源 worktree）。脚本路径用 `"$(git rev-parse --show-toplevel)/.agents/skills/dev-merge/dev-merge.sh"` 动态拼**当前 worktree 内的副本**——禁止写死某个 worktree 目录的绝对路径（会随该 worktree cleanup 过期），也禁止 `.agents/skills/...` 相对路径写法（bash cwd 不跨调用持久）。skill 实体在 workspace 根共享（ADR-0074），任意 worktree 经 symlink 同路径可达，不存在「分支不含 skill 文件」情形。

### 第 1 步：处理未提交改动（AI 决策，脚本不代劳）

第 1 步处理范围 = **tracked + untracked 全量**。脚本预检发现未提交的 **tracked** 改动会以 exit 1 停下（merge 预检不查 untracked，该缺口由本步判定与 dev-merge-gates workflow 预检覆盖；cleanup 门禁用 `status --short` 把 tracked + untracked 一并预检——删除动作是显式 `rm -rf`，无 git worktree remove 的内建拒删兜底，脏检查必须前置。[HISTORICAL] 旧版把 untracked 检查留给 git worktree remove 内建兜底，2026-09 半删态事故后前移）。任何一类都**不要**用 `git add -A && git commit` 盲提交：

- 本次会话产生的 tracked 改动 → 按全局提交策略正常 commit（完成即提交）
- 非本次会话产生的 tracked 改动 → **不提交、不修改、不丢弃**，先询问用户
- untracked 文件（merge 预检不查、脚本不拦，由本步补位判定）→ 同样逐项判定去留：本次会话产物按需纳入跟踪或删除；来源不明先问用户

**发起 dev-merge-gates workflow 前工作区必须全干净**（tracked + untracked 均零残留）——workflow 开头有预检，脏则 fail-fast。处理完再进第 2 步。

### 第 1.5 步：commit 粒度整理（条件执行）

合并前看一眼 `git log --oneline $(git merge-base github/main HEAD)..HEAD`：分支上存在 wip/fixup/typo/流程自动生成小笔/跟进修复散笔等过细 commit 时，**先在源 worktree 内整理再合并**——此时 commit 记忆最新鲜、单分支无跨分支交织，整理成本远低于发布期集中整理（[HISTORICAL] 2026-09-23 v0.10.3 发布期 62 → 35 commit 三轮 subagent 整理，instance-guard 类 hunk 交织笔无法合并的根因就是粒度债攒到了历史改写窗口最窄的时点）。粒度判定清单、两条执行路线（reset --soft / rebase）与硬约束**直接复用 merge skill 阶段 0.5**，不在此重复。

分支 commit 已是逻辑批次级（或只有个位数笔）→ 跳过本步直接合并，不为仪式感整理。

### 审查失败分级（第 1.6-1.8 步共用语义）

| 级别 | 判据（任一命中） | 动作 |
|------|----------------|------|
| **打回**（不进第 2 步合并） | quality-gates FAIL 经 3 轮修复子循环仍红；branch-review 终态 needs-human / stuck / max-rounds / review-failure / aggregator-failure / fix-failure（CR 门 fail-fast 语义，见 1.7；fix-failure 判据 = 结构化返回校验失败（重试后仍败）/ per-fixer 任务文档写盘失败；终态清扫失败改判 needs-human，同属打回级）；must-fix 未全修；传播检查红灯 | 停在合并之外，按各步失败输出的恢复指引处置后重跑对应步 |
| **组级提交待办**（仅 zcode dev-merge-gates 主路径；pi 宿主手工编排走 review-fix-loop，无此通道） | 组 commit 撞 pre-commit 拦截经三分类处置（env 类环境恢复就地重试 / content 类补修 fixer 补全后重试、每组每轮 ≤2 次 / blocked 类）后仍失败 → 该组转提交待办随终态 deferredCommits 呈报，不终止 workflow | deferredCommits 非空时终态为 needs-human：主 agent 逐组判定补提交或还原后再进第 2 步；待办组文件不进终态清扫、保持工作区形态 |
| **随分支带走** | branch-review minor（suggestion）残余；metrics/coverage 的 warn 档机器报告 | 不阻塞合并，登记进 commit message 或 TODO，终局 PR 期复核 |
| **呈报后继续** | 传播检查软提示（兄弟线线粒度呈报 + 文件交集）；gates / changeset-check / cross-branch-overlap 脚本缺失的存在性检查披露；changeset WARN（自动分类处置，理由列明）；fixer 未申报的残留改动留工作区并逐文件披露（WARN，不终止——下轮审查两路覆盖可见后处置） | 呈报或披露后继续流程，不静默跳过 |

### 第 1.6 步：质量门与 changeset 前置（gates，恒跑）

机器可判的合入门禁前置到分支边界（审查项唯一主责：质量门与 changeset 归分支边界承担，终局 PR 期只做复核兜底）。cwd = 当前 feat worktree 根，依次跑：

```bash
node scripts/quality-gates.mjs --side dev-merge   # 质量门聚合：typecheck 四处（含 mobile-renderer）+ 增量 coverage（含新增文件机器盲区判定，coverage-file-gate-exempt 可豁免）+ metrics
node scripts/changeset-check.mjs                  # changeset 完整性：diff 触及 extensions/**/src/** 且包缺 .changeset/*.md → WARN 清单
node "$(git rev-parse --show-toplevel)/.agents/skills/dev-merge/scripts/pi-extension-smoke.mjs" --json   # pi extension 启动冒烟：本 worktree 全部 extension 源码入口（extensions/{taiji,universal}/*/package.json 的 main）经 pi 真实加载一遍（--mode rpc + stdin EOF，零 LLM 调用），抓 main 声明指向缺失文件 / 入口加载期即崩——这类问题装进 pi 宿主才暴露，前置到合并边界
```

- 退出码：quality-gates `0` = 全绿 / `1` = FAIL / `2` = 用法或环境错误；changeset-check `0` = pass/warn/skip（WARN 不阻断）/ `2` = 工具错误；pi-extension-smoke `0` = pass 或 skip（pi 未安装 / 无可加载入口，skip 不阻塞但必须随汇报披露）/ `1` = FAIL / `2` = 用法或环境错误。
- **FAIL（exit 1）**：派 fixer 修复后重跑——quality-gates 与 pi-extension-smoke 的 FAIL 各走同款修复子循环：脚本累计执行各 ≤3 次、fixer 各最多派发 2 次（fixer 只修失败输出直接相关的问题——质量门失败修对应门项，冒烟失败修对应 extension 包的 main 声明或加载期问题；修完自行 commit（显式路径，禁 `git add -A`）、每轮修完重跑对应脚本验证）；预算用尽仍 FAIL 停下呈报人工处置，不进后续步骤。
- **exit 2**：工具/环境错误不进 fixer 循环，按脚本输出的缺失路径与恢复指引处置。
- **changeset WARN**：主 agent 按 Gate-1a.5 同款分类逻辑处置（不弹窗问用户）——实质改动（包有对外语义变化）→ 起草 `.changeset/*.md` 且理由列明；非发布改动（纯注释/文档/无对外语义变化的内部整理）→ 跳过起草并列明理由。skip/pass → 无动作，汇报记一句。
- **base 口径**：`--side dev-merge` = 分支增量（`git merge-base github/main HEAD`，脚本自解析），与第 1.7 步审查对象同口径；禁止传 `--base main`（那是 pr-cr-fix 侧的累积口径，两侧差异有意）。

**存在性检查（zcode/pi 两侧通用）**：跑前 `test -f scripts/quality-gates.mjs` 检查脚本存在——脚本随 git 分支传播，skill 实体经 symlink 即时生效，feature 分支未含新脚本 commit 时必然缺失（介质错速）。缺失 → 显式输出「quality-gates 脚本不存在（该分支未含 U1 commit），本轮跳过 gates 并披露」，继续第 1.7 步；不崩溃、不静默。changeset-check.mjs 缺失同款处置。恢复通道：源 worktree `git merge dev-0.10.5`（或发布后 merge main）主动吸收后重跑。pi-extension-smoke.mjs 不同：它在 skill 实体内（workspace 根 `.agents/skills/dev-merge/scripts/` 共享，不入 git、无介质错速窗口），缺失 = skill 实体损坏（worktree 内 `.agents` symlink 断裂等），按 exit 2 环境错误处置（恢复：检查 workspace 根 skill 目录完整性），不得按介质错速语义静默跳过——那是关掉 gate 的假绿。

**宿主分工**：zcode 宿主 = 发起项目 workflow（CreateWorkflow path 指向 `.agents/workflows/dev-merge-gates.dwf.ts`），一次承载本步 + 第 1.7 步（gates + branch-review 两步前置，存在性检查内建，失败以 failed 终态返回）；pi 宿主无对应 workflow（dev-merge 使用频率低，不维护双宿主镜像），主 agent 按本步与第 1.7 步手工编排——gates 走上述 node 脚本 + changeset WARN 起草指令，branch-review 走 review-fix-loop。

### 第 1.7 步：合入点横切审查（3+3 维，触及源码即跑）

feature 分支的 diff 完整、上下文集中，是横切维度审查的天然边界——dev-flow 阶段 3 只审「实现 vs 设计」，business-logic / arch-boundary / data-governance 等横切关注点不在其审查范围内（PR #20 实证：走了完整 dev-flow 的 btw/ttft 域终局仍暴露 10 条、5 条 major，登记与覆盖问题全部从 dev-flow 眼皮下漏过）。本步把横切关注点前置到合入点，终局 PR 期只收机器兜底与漏网项。

**触发条件**：分支 diff（`git diff $(git merge-base github/main HEAD)..HEAD --stat`）触及任一非测试源码文件即跑——业务逻辑审查必须有分支边界归属，不设文件数门槛；diff 仅含测试路径与 .md 文档（编排按路径判定，不识别注释级改动）时在合并汇报记一句跳过理由。

**执行**（审查对象 = 分支增量 diff，非全 PR）：

1. 约束动态加载：`node scripts/select-constraints.mjs --base $(git merge-base github/main HEAD)` 落 `.review/constraints.md`；脚本失败 = 本步终止不进合并（与 CR 门同语义），不得在无约束清单状态下派审查
2. 派恒派 3 维 reviewer（agent 定义在本 skill `agents/review-<维度>.md`，重语义审查的资产所有权归 dev-merge，pr-cr-fix 侧仅经其显式 reviewers 逃生舱引用同一批文件）：`business-logic`（含降级策略红线，判据本体 = agent 定义内 read 引用的 code-harden）/ `arch-boundary` / `data-governance`——agent 定义结构为三层：编排契约 + 通用判据 read 引用（指向 `~/.agents/skills/` 用户级技能 code-domain-review / code-harden / architecture-decay-audit / code-arch-review，缺失时 dev-merge-gates 的在盘检查 fail-fast，不静默降级为无判据审查）+ 项目特化检查（消费 `.review/constraints.md` 与项目文档）。pi 宿主用 `pi workflow run review-fix-loop --args '{targetType:"git-diff", target:"<merge-base-hash>", batch1:"<选中的 review-<维度>.md 绝对路径（本 skill agents/ 下），逗号分隔>", autoCommit:true, ...}'`（batch1 点名上述 3 维）；zcode 宿主已由 dev-merge-gates.dwf.ts 的 branch-review 步承载（第 1.6 步一并发起），单独补审时用原生 `review-fix-loop` saved workflow（reviewers 传选中的 agent .md 绝对路径子集）
3. 触发式追加 3 维：diff 触及打包/构建配置（tsup/electron-builder/CI）→ 加 `electron-build`；触及包结构/发布线（package.json / pnpm-workspace.yaml / .changeset/ 下任何变更）→ 加 `monorepo-impact`；触及 `extensions/**/src/**` → 加 `extension-api`（tool/command schema、SDK 契约、spec 偏差登记与 data-governance 同属 dev-flow 审不到的横切关注点，且是本仓高频改动范围；SDK 签名核对要对照 node_modules dist、成本中等，故不恒派只触发）；pr-cr-fix 侧回退集对 `extensions/**`（不限 src）宽派是终局兜底定位的保守取向，本侧收窄到 src 是合入点定位的有意差异、非谓词漂移。`electron-build` 本步只挂构建/发布配置面是有意收窄：runtime/electron **源码**改动的 CJS 兼容（`import.meta.url`）与 bundle 完整性由 pre-commit 的 `validate-runtime-bundle.sh` 机器门在每次 commit（含本步之后的 merge commit）拦截，LLM 维度不重审机器门已覆盖项；pr-cr-fix 回退集对 `packages/runtime/**` 宽派是终局兜底定位的保守取向（宁可多派不漏派），与本步收窄是两层定位差异、非谓词漂移
4. 终态处置：must-fix 全修后才进第 2 步合并；minor 残余随分支带走（commit message 或 TODO 登记），不阻塞。收敛出口前 workflow 执行终态清扫——范围两条过滤（排除提交待办组文件 + 逐文件归属对账，无主改动不代提交），通过者一笔 residual sweep commit、清单随终态 sweptFiles 披露；deferredCommits 非空时即使问题清单全部收敛终态也改判 needs-human（逐组判定补提交或还原后再进第 2 步）。reviewer 审查范围两路覆盖（先 `git diff <base>...HEAD` 已提交改动，再 `git status --porcelain` 与 `git diff` 未提交工作区改动），上轮修复或提交拦截的残留对 reviewer 可见。主 agent 对补修披露条目（commit-repair）负核对义务：每条列全部补修文件，明显超出报错点名范围（越权改业务文件）的呈报用户并在合并前处置

**CR 门 fail-fast 语义（2026-09-25 裁决；2026-09-30 补实装对齐）**：第 1.7 步全链强结构化返回——reviewer/fixer/aggregator 校验失败由同一 agent 回注失败原因重试一次（该类失败最常见形态是报告已写好、JSON 尾部字段错），仍败即终止整个 workflow（review-failure / fix-failure / aggregator-failure 终态 + 恢复指引），无降级完成形态（禁止从报告文本解析降级）。提交拦截不属 CR 门 fail-fast 范围：commit 撞 pre-commit 拦截按三分类在 workflow 内处置（env 类环境恢复就地重试 / content 类派补修 fixer 按报错原文补全后重试、每组每轮 ≤2 次 / blocked 类组转待办 deferredCommits），单组失败不终止 run。CR 门读到非 clean/converged 终态 = 环境或模型问题未修，按失败处置（不进合并），恢复动作见 run 返回值 message。

成本随 diff 规模浮动：小分支（≤5 非测试源文件）预计 10-20 分钟，大分支 30-50 分钟审查 + 15-30 分钟修复（diff 为单分支增量，远小于终局全量）。

### 第 1.8 步：传播检查前置（目标线 ⊇ main + 兄弟线未传播呈报）

进入合并（第 2 步）前对**目标集成线**跑传播检查（纪律与约束 SSOT：ADR-0076 / C-proc-30）。硬检查语义 = **目标线 ⊇ main**（合并产物的落点线不得落后 main），**不以源 feature 线为检查对象**——源线落后而目标线不落后时合并产物仍 ⊇ main，拦截即过度；源线开发基线新旧是 ADR-0076 纪律①的治理面，不是本检查语义。

```bash
# 目标集成 worktree 已存在（常态）——命令自包含 cd：
cd <workspace>/<dev-branch> && node scripts/check-line-propagation.mjs --target HEAD
# 目标 worktree 不存在但分支已存在（.bare 共享 refs 可见）——在源 worktree 内以分支名变量跑：
node scripts/check-line-propagation.mjs --target <dev-branch>
# 分支也不存在：跳过检查，在合并汇报记一句理由（第 2 步将基于 main 新建该分支，构造性 ⊇ main）
```

- `--target` **禁止写死为 `main` 等分支名字面量**（任何 worktree 跑都恒绿，接线即空转）；worktree 内一律 `--target HEAD`。
- **硬检查红灯 = block**：按第 1.8 步恢复指引在目标线 worktree 内 `git merge main` 后重跑；确有正当理由才可 `--allow-diverged` 一次性越过（打印警示、软提示照常执行），越过决定须呈报用户。
- **仅分支存在形态红灯的处置**：目标 worktree 不存在时上述恢复指引不可直接执行——block 挡的是第 2 步合并，不挡恢复前置。先经 `worktree-manipulate` 创建目标 worktree（检出既有分支，等价于第 2 步的自动创建）→ 在其中 `git merge main` → 重跑检查消除红灯后再进第 2 步。
- **软提示头条摘要呈报用户后才进第 2 步**（流程一等步骤，不是可选日志）：每条兄弟线的 commit 总量 + 最老停留天数；裁决粒度 = **线粒度**（对每条兄弟线回答「吸收 / 暂缓」），不逐条裁决。兄弟线长周期 WIP 每次全量呈报数十条属无状态恒常呈报的稳态，不是异常。
- **兄弟线修改文件交集呈报**：软提示摘要附带交集列——`node scripts/cross-branch-overlap.mjs`（目标 worktree 存在 → cd 目标 worktree 直跑，默认 `--branch HEAD`；目标仅分支存在 → 源 worktree 内 `--branch <dev-branch>`），输出当前线 diff 与各未合并兄弟线 diff 的修改文件交集（确定性计算、恒不阻塞、空交集也是有效结论）。脚本缺失按存在性检查同款跳过并披露；exit 2 工具错误披露后不阻塞。交集只给线粒度裁决提供重叠证据，不改变「吸收 / 暂缓」的裁决粒度。

### 第 2 步：合并

```bash
bash "$(git rev-parse --show-toplevel)/.agents/skills/dev-merge/dev-merge.sh" merge <dev-branch>
```

脚本自动完成：目标 worktree 缺失时**自动创建**（复用全局 `worktree-manipulate` 的 create-worktree.sh：分支已存在则检出、不存在则基于 main 新建 dev 分支，并经项目 setup hook 完成 pnpm 依赖安装 + Electron/pi 缓存链接——耗时数分钟属正常，merge commit 的 pre-commit 检查依赖它们）→ 两侧干净预检 → 已合并短路 → `git merge --no-ff`（保留 feature 分支历史，与项目 PR 合并策略一致）。

三种结果：

| 输出 | 含义 | 下一步 |
|---|---|---|
| `OK:` | 合并成功 | 直接进第 4 步 cleanup（默认自动清理） |
| `SKIP:` | 已是祖先，无需重复合并 | 直接进第 4 步 |
| exit 2 + `CONFLICT:` | 冲突，dev worktree 停在 merge 中间态 | 进第 3 步 |

### 第 3 步：解决冲突（exit 2 后）

冲突清单已在脚本输出中。在 **dev worktree**（`../<dev-branch>`）内处理，每条命令自包含 cd（bash cwd 不跨调用持久）：

```bash
cd <workspace>/<dev-branch> && git status --short   # 全量冲突态（<workspace> = workspace root，按本机实际路径替换）
# 逐个解决冲突文件后：
cd <workspace>/<dev-branch> && git add <files> && git commit
```

解决原则：按改动意图合并而非机械取一侧；冲突两侧都看不懂时**停下来问用户**，不要猜。merge commit 会走 dev worktree 的 pre-commit hooks，检出的问题按全局规则全部当场直接修复。

**测试文件冲突解完先跑增量测试再 commit**：机械合并可能同时保留两侧同名用例、或让用例与（自动合并的）实现错位，vitest 对重复/错位的 `it` 不报错——旧标题带新断言会绿着通过。冲突涉及测试文件时，先跑该文件相关测试，绿了再 commit。

**已知故障签名（hook 报行号错位的语法错误）**：commit 进行中 hook 报行号与文件内容对不上的语法错误 = hook 文件在执行途中被替换（bash 按字节偏移续读被换过的文件；疑似并发流程复制/更新 `.githooks/`，成因尚未完全定位——当前实装 hook 是 create-worktree 时从主 worktree 复制的 per-worktree 文件，无常驻重生成路径）。处置：`bash -n` 校验 + `md5` 两次采样确认文件稳定后**原样重试 commit 一次**（已验证可过），不要手工改 hook，禁止 `--no-verify`。

### 第 4 步：清理源 worktree（默认自动清理）

合并成功后**自动执行清理**（删除 worktree + 分支）。用户不特别说明时默认清理，无需逐次确认。仅当用户明确说「不清理」时才跳过。

```bash
bash "$(git rev-parse --show-toplevel)/.agents/skills/dev-merge/dev-merge.sh" cleanup <dev-branch> [--kill-occupants]
```

脚本内置安全闸：分支未合并进 dev 拒绝清理（`is_merged` 门禁通过后脚本直接 `git branch -D`，不依赖 `git branch -d`——`-D` 避免依赖 upstream/HEAD 校验的不确定性，已合并与否由 `is_merged` 门禁保证）；源 worktree 有未提交/未跟踪文件时**删除前预检拒绝**（`status --short` 在 git 完好时采集）——**不要擅自 clean**，先看那些文件是什么（来源不明的问用户），确认后由用户/显式决策强删。

**占用预检闸（rm 之前）**：扫描持有**写模式句柄**的进程（`lsof +D` 的 fd 列过滤，cwd/txt/只读句柄不阻断 unlink 不入列）——写句柄持有者会让 `rm -rf` 中途失败（删除期间文件被持续写入重建 → `Directory not empty`，典型 = 扎根该 worktree 的 dev 实例 Vite/runtime/日志写入）。命中时默认拒绝并列恢复路径：① 主 agent 逐个核实为扎根本 worktree 的 dev 实例 / background 任务后精确 `kill <pid>`（禁 pkill 宽杀）再重跑；② `--kill-occupants` 授权脚本代为终止（TERM → 3s → KILL）后删除。**宿主链永不自动终止**：命令名 `zcode-cli` / `ZCode*` / `Claude*` 前缀或命令行含 `~/.zcode/` 路径的 MCP 子进程一律只 WARN 不杀——它们的句柄多为 cwd 继承（不阻断删除），且杀宿主 = 杀死发起本脚本的会话自身（2026-10-04 二次事故实证：按命令名宽匹配把 ZCode 宿主列入 kill 清单，会话当场断开）。甄别手段：`ps -p <pid> -o command=` 看完整命令行，宿主子进程（MCP server / node repl）与 dev 实例（vite/runtime/项目 electron）由此区分。lsof 大目录扫描 10-30s 属正常。

**删除语义（显式两步）**：`rm -rf <feat 目录>` + `git worktree prune`，先删目录、后清登记。[HISTORICAL] 旧版用 `git worktree remove`，实验复现证实其内部**先删登记、后删目录**——目录删除失败时留下"登记已失、目录内 git 全废"的半删态，且旧脚本吞掉 stderr、硬编码诊断为"被 untracked 阻止"（空清单 + 不可执行的 clean -fd 指引），2026-09 事故后改为显式两步。中途失败情形：`rm -rf` 失败 → 登记与分支均未动，状态完好可排查重试；prune 失败/漏跑 → 目录已删、登记残留，prune 幂等可补跑，无破坏性。

**`OK:` 输出 = 全部完成的权威证明**（worktree 与分支都已删）。此后不要再调用任何 bash——包括 `git worktree list` / `git log` 复核确认。直接输出合并总结收尾。

**[MANDATORY] bash 会话报废信号解码**：cleanup 之后（无论脚本输出 `OK:` 还是 `ERROR:`），若 bash 调用返回以下**工具层错误**（没有任何命令输出）：

```
Working directory does not exist: <feat-worktree 路径>
Cannot execute bash commands.
```

1. **命令没有被执行**——工具在 spawn shell 前就因 cwd 目录不存在而拒绝，`cd <别处> &&` 前缀救不了（拒绝发生在命令文本被解释之前）。重试无意义，立即停止一切 bash 调用
2. 它同时是 **worktree 删除已成功的证明**（目录已从磁盘消失），不是失败信号
3. 这是**会话级永久状态**：本会话后续所有 bash 调用都会得到同样错误。收尾判断——脚本输出过 `OK:` → 全部完成，正常输出总结；脚本在删目录**之后**输出过 `ERROR: worktree 登记 prune 失败` → 唯一残留是登记，待执行命令 `git -C <workspace>/<dev-branch> worktree prune`；输出过 `ERROR: 分支 ... 删除失败` → 唯一残留是分支，待执行命令 `git -C <workspace>/<dev-branch> branch -D <feat-branch>`。两种残留都无破坏性，写进总结交给用户/下次会话

同类陷阱与反模式的完整记录见 merge skill 阶段 7。

例外：脚本 exit 非 0 且**没看到工具层报废错误**（bash 正常返回了脚本输出）时，按失败点分两类——**删目录之前** die（门禁失败：未合并 / 脏 worktree / git 状态读取失败）：目录完好，按脚本输出处置后重跑 cleanup；**rm -rf 目录失败**（die 消息含"登记与分支均未动"）：git 登记与分支完好、dev 侧可诊断，但目录可能已部分残缺（`.git` 文件或不存，目录内 git 不可信、重跑 cleanup 未必可行），排查根因并解除后执行 die 消息里的单命令配方。不要把任何一类失败当成删除已完成。

**半删态兜底**（现行脚本结构上不产生该状态；出现即手工操作或旧产物残留）：识别特征 = worktree 目录还在，但目录内一切 git 命令报 `fatal: not a git repository`，且 `.bare/worktrees/<name>/` 登记已消失（成因：`git worktree remove` 内部先删登记、目录删除中途失败）。处置：从**兄弟 worktree**（不是待删除的目录本身）执行单命令 `git -C <dev> merge-base --is-ancestor <feat-branch> <dev-branch> && git -C <dev> branch -D <feat-branch> && git -C <dev> worktree prune && rm -rf <feat 目录>`（is-ancestor 在链首，未合入即中止、不删任何东西；rm -rf 在链尾，失败即停时目录与分支状态可诊断）。agent 会话 cwd 若还在待删除的目录内，该命令执行后本会话 bash 报废——应作为最后一条 bash 命令，剩余收尾用 read/write 类工具。
