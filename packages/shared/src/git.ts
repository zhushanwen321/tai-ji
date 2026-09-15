// ── Git 领域 DTO（#1 git 全栈 / #12 契约地基）──────────────────────
// 迁移自 protocol.ts 第 3 块。依据 code-architecture.md §3.1/§3.6/§3.7/§3.8/§4.1/§4.2
// + spec-w11.md FR-12/G-R2-01。本契约仅定义类型；runtime 实现（git-service /
// IGitExecutor / git-message-handler）属 Wave 1a。

/** git.status 的返回结构（FR-12/G-R2-01）。cwd 非 git 仓库时 isRepo=false，其余字段为默认值。
 *  用 type 别名而非 interface：ServerMessageMapBase 的 payload 需隐式索引签名才能赋给
 *  chat-chunk-processor 的 Record<string, unknown> 读取器（interface 无隐式索引签名，会报 TS2345）。 */
export type GitStatusResult = {
  sessionId: string
  isRepo: boolean
  branch?: string
  stagedCount: number
  unstagedCount: number
  stats: { add: number; del: number }
  hasConflict: boolean
  files: GitFileStatus[]
  /** 本地分支名列表（#6 选分支 popover 数据源，架构 §4.3 GitStatusResult 含分支列表）。
   *  由 getStatus 经 `git branch --list` 填充；unborn HEAD / 列举失败 → []。 */
  branches?: string[]
}

/** 单文件的 git 状态（git --porcelain 的 XY 码解析结果）。
 *  status 由 xyCode 派生：U* → unmerged（冲突），?? → untracked，其余按 added/modified/deleted/renamed。
 *  staged/unstaged 维度由 xyCode 的两列体现（X=staged，Y=unstaged），不进 status 枚举。
 *
 *  additions/deletions：tracked 改动文件的增删行数（来自 git diff --numstat HEAD per-file）。
 *  untracked/unmerged/二进制 文件无 numstat → undefined，前端降级展示（untracked 显文件大小，
 *  二进制显 'binary'）。这是文件树 +N −M 行数角标的数据源。 */
export interface GitFileStatus {
  path: string
  /** 原始 git --porcelain 双列状态码（如 'A ', ' M', 'UU', '??', 'R '）。前端可据 xyCode[0]/xyCode[1] 细分暂存/工作区态。 */
  xyCode: string
  status: 'added' | 'modified' | 'deleted' | 'unmerged' | 'renamed' | 'untracked'
  /** 增加行数（numstat per-file）。tracked 改动文件有值；untracked/二进制/unmerged 为 undefined。 */
  additions?: number
  /** 删除行数（numstat per-file）。tracked 改动文件有值；untracked/二进制/unmerged 为 undefined。 */
  deletions?: number
}

/**
 * 非法分支名正则（前端 UX 校验 + runtime 安全边界共用 SSOT）。
 *
 * 规则（与 git check-ref-format 一致 + 反斜杠防护）：
 * - `^\.`：以点开头（.git）
 * - `^-`：以连字符开头
 * - `\.\.`：连续双点（路径遍历）
 * - `[~^:?*\[\]@{}]`：git refname 禁止字符
 * - `\s`：空白字符
 * - `\\`：反斜杠（Windows 路径遍历防护）
 * - `/$`：以斜杠结尾
 * - `\.lock$`：.lock 后缀（git refname 保留）
 */
export const INVALID_BRANCH_REGEX = /(^\.|^-|\.\.|[~^:?*\[\]@{}]|\s|\\|\/$|\.lock$)/
