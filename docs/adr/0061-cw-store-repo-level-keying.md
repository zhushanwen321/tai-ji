# ADR-0061: cw store 键控基准改为 repo 级（git common dir）

> **⚠️ Superseded** —— 本 ADR 的「调用层先行」方案（cw-tool 探测 common-dir + dirname + `--workspace` 透传）已被**引擎层方案 A**取代：
> - 引擎层 SSOT：`coding-workflow` 仓库 `fix-cw-cwd-worktree/docs/cw-store-workspace-decoupling.md`（commit `aa4949b`，含自身对抗审查）
> - 本仓差异文档：已删除（2026-09 docs 清理；git 历史可追溯，原路径 `docs/architecture/cw-store-workspace-decoupling.md`）
>
> **继承成立的核心洞察**：store 应 repo 级共享（所有 worktree 一份）、用 `git-common-dir` 做 repo 标识——本 ADR 方向正确。
>
> **修正的实现错误**：① 多余的 `dirname`（common-dir 本身即标识；bare repo 下 `dirname(.bare)` = workspace 容器非任何 worktree，separate-git-dir 下到非 repo 根）；② 单一 `--workspace` 兼任 repo 标识 + 工作树两角色（bare repo 结构性不可能）；③ 归一化放 cw-tool 调用层而非 cw-cli 引擎层（导致 bash/cw-tool 割裂无法消除——bash 不经 cw-tool，永远 per-cwd）。
>
> 本 ADR 的「本分支调用层先行」临时方案随引擎层 S1（`getCwJsonPath` 归一化）+ S2（cw-tool 删 `detectRepoWorkspace`、退回纯封装）落地而拆除。下文为历史原文，保留作决策追溯。

**状态**: Superseded（by 引擎层方案 A）
**日期**: 2026-08-06（Accepted）→ 2026-09 Superseded
**关联**: v4 递归编排方案（`/tmp/cw-recursive-orchestration-design-v4.md`）、feat-rethink-recursive-split 分支

## 背景

v4 递归编排中 wave 层以 `worktree: true` 派出（各 wave 独立工作目录并行开发）。聚合审查（review-fix-loop MF-1，critical）发现：**cw 1.3.0 的 store 按绝对 cwd 键控**（`getCwJsonPath(cwd) = ~/.cw/<encodeCwd(cwd)>/store.json`，无 repo 归一化），wave 子进程 cwd = worktree 路径 → cw 读空 store → `unit not found` → **wave 层第一个 cw 调用即失败**。

根源是**键控基准选型错误**：cwd（进程执行位置）不是任务归属。同一 repo 的 worktree、子目录调用都会导致 store 分叉——任务树"消失"。

### 键控基准候选对比

| 基准 | worktree 间 | 子目录调用 | 语义 |
|---|---|---|---|
| cwd（现状） | 分叉（MF-1 根源） | 分叉 | 执行位置 |
| `--show-toplevel`（worktree 根） | 各 worktree 不同 | 统一 | worktree 根 |
| **`--git-common-dir`（共享 .git）** | **统一** | **统一** | **repo 本体** |

`git rev-parse --git-common-dir` 在同一 repo 的所有 worktree 返回**同一绝对路径**（worktree 的 `.git` 是指向共享 `.git` 的 gitdir 文件，git 自行解析）——这是"同一仓库"的稳定标识。`dirname(commonDir)` = repo 主工作目录：固定、是真实目录（git 操作安全）、所有 worktree 相同。

## 决策

**cw 的 store 键控基准从 per-cwd 改为 repo 级（git common dir）**。分两层落地：

1. **本分支（调用层先行）**：cw-tool 每次 spawn cw 前探测 `git -C <cwd> rev-parse --path-format=absolute --git-common-dir`，成功则附加 `--workspace <dirname(commonDir)>`（cw 已支持 `--workspace <path>` 指定 store 目录）；非 git 目录 fallback 不加（保持现状 cwd 键控）。
2. **v5 引擎（根治，用户侧）**：`getCwJsonPath` 的键控基准改为 repo 级（common dir），并处理旧 store 迁移（`~/.cw/` 旧 per-cwd 路径的历史树）。届时调用层的 `--workspace` 传同一值（幂等无害）或移除。

### 为什么是 repo 级而不是"主 cwd 透传"

- **主 cwd 不稳定**：用户可能从任意子目录启动 app，主 cwd 不是稳定基准；repo 主目录恒定。
- **不需要跨进程传参**：不依赖 subagent-workflow 注入 env、不改模板——cw-tool 是唯一适配点（符合项目"pi 适配层单一"惯例），每个 cw 调用自动统一。
- **顺带修复子目录调用**：repo 内任意目录跑 cw 都共享 store（现状是分叉的）。

## 边界与安全性（审查确认）

- **跨 repo 隔离**：common dir 是绝对路径，不同 repo 必然不同 → store 文件不同 → 零冲突（slug 相同都不会撞）。
- **同 repo 多 worktree 并发**：store 共享是期望语义（任务树属于 repo，worktree 只是执行容器，分支切换后树不丢）。并发写由 cw 引擎的跨进程文件锁串行化（`cw-store.js`：lockfile + O_EXCL 原子创建 + stale 检测）。unitId 含 slug（`<scope>:<slug>[:<父路径>]`），slug 不同的树完全独立，不会识别错。
- **同 slug 冲突**：同一 repo 两个 worktree 同时建同名 epic → unitId 撞——操作语义问题（不该开两个同名任务），现状 cwd 键控下反而能"伪隔离"建出，合并时更乱。
- **嵌套 repo**：git 从 cwd 向上找最近 `.git`，子 repo 归子 repo ✓。
- **非 git 目录**：fallback cwd（现状行为不变）。
- **bare repo + 多 worktree（本项目模式）**：common dir = `.bare`，所有分支 worktree 共享一个 store（同一 repo 一个任务空间）。

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| per-cwd（维持现状） | MF-1 根源，worktree/子目录 store 分叉 |
| `--workspace 主 cwd` 透传 | 主 cwd 非稳定基准（子目录启动场景漂移）；需跨进程传参 |
| 模板 worktree:false（wave 回主 cwd） | 丢并行写码隔离；dev 在 worktree 调 cw execute 同样断——问题下移不解决 |
| `--show-toplevel` 基准 | 各 worktree 返回各自根，worktree 间仍分叉 |

## 影响

- cw-tool（本分支）：spawn 参数附加 `--workspace`（约 10 行 + 测试）。
- cw 引擎（v5 清单新增项）：`getCwJsonPath` 键控基准改造 + 旧 store 迁移策略。
- 用户感知：repo 内 cw 任务树不再随调用目录变化而"消失"；worktree 模式编排可用（MF-1 解除）。
