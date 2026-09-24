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

**调用约束**：cwd 必须在待合并 feat worktree 根目录（脚本靠 `git rev-parse --show-toplevel` 定位源 worktree）。脚本路径用 `"$(git rev-parse --show-toplevel)/.agents/skills/dev-merge/dev-merge.sh"` 动态拼**当前 worktree 内的副本**——禁止写死某个 worktree 目录的绝对路径（会随该 worktree cleanup 过期），也禁止 `.agents/skills/...` 相对路径写法（bash cwd 不跨调用持久）。当前分支不含本 skill 文件时（极旧 base），从任意含该文件的 worktree 复制脚本后调用。

### 第 1 步：处理未提交改动（AI 决策，脚本不代劳）

脚本预检发现未提交的 **tracked** 改动会以 exit 1 停下（merge 预检不查 untracked；cleanup 闸门用 `status --short` 把 tracked + untracked 一并预检——删除动作是显式 `rm -rf`，无 git worktree remove 的内建拒删兜底，脏检查必须前置。[HISTORICAL] 旧版把 untracked 检查留给 git worktree remove 内建兜底，2026-09 半删态事故后前移）。此时**不要**用 `git add -A && git commit` 盲提交：

- 本次会话产生的改动 → 按全局提交策略正常 commit（完成即提交）
- 非本次会话产生的改动 → **不提交、不修改、不丢弃**，先询问用户

处理完再进第 2 步。

### 第 1.5 步：commit 粒度整理（条件执行）

合并前看一眼 `git log --oneline $(git merge-base github/main HEAD)..HEAD`：分支上存在 wip/fixup/typo/流程自动生成小笔/跟进修复散笔等过细 commit 时，**先在源 worktree 内整理再合并**——此时 commit 记忆最新鲜、单分支无跨分支交织，整理成本远低于发布期集中整理（[HISTORICAL] 2026-09-23 v0.10.3 发布期 62 → 35 commit 三轮 subagent 整理，instance-guard 类 hunk 交织笔无法合并的根因就是粒度债攒到了历史改写窗口最窄的时点）。粒度判定清单、两条执行路线（reset --soft / rebase）与硬约束**直接复用 merge skill 阶段 0.5**，不在此重复。

分支 commit 已是逻辑批次级（或只有个位数笔）→ 跳过本步直接合并，不为仪式感整理。

### 第 1.7 步：合入点横切审查（4+3 维，条件触发）

feature 分支的 diff 完整、上下文集中，是横切维度审查的天然边界——dev-flow 阶段 3 只审「实现 vs 设计」，data-governance / test-coverage / arch-boundary / type-safety 四个横切面不在其审查面内（PR #20 实证：走了完整 dev-flow 的 btw/ttft 域终局仍暴露 10 条、5 条 major，登记与覆盖问题全部从 dev-flow 眼皮下漏过）。本步把横切面前置到合入点，终局 PR 期 8 维 loop 只收跨域交互与漏网项（「前置消化 vs 终局兜底」并存关系）。

**触发条件（满足其一才跑，小分支不为仪式感审查）**：分支 diff（`git diff $(git merge-base github/main HEAD)..HEAD --stat`）触及 ≥15 个非测试源文件，或触及任一横切敏感面（新 WS 消息/RPC 命令/数据写入点/新顶层目录）。不触发时在合并汇报中记一句跳过理由。

**执行**（审查对象 = 分支增量 diff，非全 PR）：

1. 约束动态加载：`node scripts/select-constraints.mjs --base $(git merge-base github/main HEAD)` 落 `.review/constraints.md`
2. 派 4 维 reviewer（agent 定义复用 pr-cr-fix 资产，不另建）：`arch-boundary` / `data-governance` / `test-coverage` / `type-safety`——pi 宿主用 `pi workflow run review-fix-loop --args '{targetType:"git-diff", target:"<merge-base-hash>", batch1:"<选中的 review-<维度>.md 绝对路径，逗号分隔>", autoCommit:true, ...}'`；zcode 宿主用原生 `review-fix-loop` saved workflow（reviewers 传选中的 agent .md 绝对路径子集）
3. 触发式追加 3 维：diff 触及打包/构建配置（tsup/electron-builder/CI）→ 加 `electron-build`；触及包结构/发布线（package.json 增删/workspace/changeset 配置）→ 加 `monorepo-impact`；触及 `extensions/**/src/**` → 加 `extension-api`（tool/command schema、SDK 契约、spec 偏差登记与 data-governance 同属 dev-flow 审不到的横切面，且是本仓高频改动面；SDK 签名核对要对照 node_modules dist、成本中等，故不恒派只触发）
4. business-logic 维度**不进本步**（成本最高、发现密度最低）——分支内语义正确性由 dev-flow 场景验收承载
5. 终态处置：must-fix 全修后才进第 2 步合并；minor 残余随分支带走（commit message 或 TODO 登记），不阻塞

成本预期 30-50 分钟审查 + 15-30 分钟修复（diff 为单分支增量，远小于终局全量）。

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
bash "$(git rev-parse --show-toplevel)/.agents/skills/dev-merge/dev-merge.sh" cleanup <dev-branch>
```

脚本内置安全闸：分支未合并进 dev 拒绝清理（`is_merged` 闸门通过后脚本直接 `git branch -D`，不依赖 `git branch -d`——`-D` 避免依赖 upstream/HEAD 校验的不确定性，已合并与否由 `is_merged` 闸门保证）；源 worktree 有未提交/未跟踪文件时**删除前预检拒绝**（`status --short` 在 git 完好时采集）——**不要擅自 clean**，先看那些文件是什么（来源不明的问用户），确认后由用户/显式决策强删。

**删除语义（显式两步）**：`rm -rf <feat 目录>` + `git worktree prune`，先删目录、后清登记。[HISTORICAL] 旧版用 `git worktree remove`，实验复现证实其内部**先删登记、后删目录**——目录删除失败时留下"登记已失、目录内 git 全废"的半删态，且旧脚本吞掉 stderr、硬编码诊断为"被 untracked 阻止"（空清单 + 不可执行的 clean -fd 指引），2026-09 事故后改为显式两步。中途失败面：`rm -rf` 失败 → 登记与分支均未动，状态完好可排查重试；prune 失败/漏跑 → 目录已删、登记残留，prune 幂等可补跑，无破坏性。

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

例外：脚本 exit 非 0 且**没看到工具层报废错误**（bash 正常返回了脚本输出）时，按失败点分两类——**删目录之前** die（闸门失败：未合并 / 脏 worktree / git 状态读取失败）：目录完好，按脚本输出处置后重跑 cleanup；**rm -rf 目录失败**（die 消息含"登记与分支均未动"）：git 登记与分支完好、dev 侧可诊断，但目录可能已部分残缺（`.git` 文件或不存，目录内 git 不可信、重跑 cleanup 未必可行），排查根因并解除后执行 die 消息里的单命令配方。不要把任何一类失败当成删除已完成。

**半删态兜底**（现行脚本结构上不产生该状态；出现即手工操作或旧产物残留）：识别特征 = worktree 目录还在，但目录内一切 git 命令报 `fatal: not a git repository`，且 `.bare/worktrees/<name>/` 登记已消失（成因：`git worktree remove` 内部先删登记、目录删除中途失败）。处置：从**兄弟 worktree**（不是待删除的目录本身）执行单命令 `git -C <dev> merge-base --is-ancestor <feat-branch> <dev-branch> && git -C <dev> branch -D <feat-branch> && git -C <dev> worktree prune && rm -rf <feat 目录>`（is-ancestor 在链首，未合入即中止、不删任何东西；rm -rf 在链尾，失败即停时目录与分支状态可诊断）。agent 会话 cwd 若还在待删除的目录内，该命令执行后本会话 bash 报废——应作为最后一条 bash 命令，剩余收尾用 read/write 类工具。
