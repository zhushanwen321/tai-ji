/**
 * git status --porcelain 解析纯函数（ADR-0027 D-013 范式）。
 *
 * 纯函数、无 IO，归 shared（与 ignore-parser.ts 同范式：纯计算放 shared，IO 走 port）。
 * GitService 调 IGitExecutor.exec('status') 拿 raw stdout 后，经此函数解析——
 * IO 边界在 IGitExecutor port 处闭合，解析逻辑独立可测。
 *
 * 迁移自 runtime/src/infra/git-status-parser.ts（原靠「§5.1 豁免」自我豁免 infra→services 直连）。
 * 现作为纯函数归 shared，services 经 @taiji/shared 引用，不构成分层违规。
 *
 * 输入约定：`git status --porcelain=v1 -z -b` 的 stdout（NUL 分隔，首条为 branch 头）。
 * 不用换行分隔：带空格/特殊字符的路径在 -z 模式下以 NUL 安全分隔，换行模式会被路径中的换行击穿。
 *
 * 输出：GitFileStatus[]（status 枚举含 untracked/unmerged，比 file-change-reconciler 的
 * FileChangeStatus 更细，服务于 GitZone 四态 + 冲突判定）。
 */
import type { GitFileStatus } from '@taiji/shared'

/** branch 头前缀 `## ` 的长度。 */
const BRANCH_HEADER_PREFIX_LEN = 3
/** porcelain 行：XY 双列码占前 2 字符。 */
const XY_CODE_LEN = 2
/** porcelain 行：XY 码后跟一个空格，路径从第 4 字符（index 3）起。 */
const PORCELAIN_PATH_START = 3

/** 解析结果：branch（detached 时 undefined）+ 文件列表。 */
interface ParsedGitStatus {
  branch?: string
  files: GitFileStatus[]
}

/**
 * 从 `## <branch>` 头解析当前分支名。
 * - `## main...origin/main [ahead 2]` → 'main'
 * - `## main` → 'main'
 * - `## HEAD (no branch)` → undefined（detached HEAD）
 */
function parseBranchHeader(header: string): string | undefined {
  // 去掉 '## ' 前缀
  const rest = header.slice(BRANCH_HEADER_PREFIX_LEN)
  if (rest.startsWith('HEAD (no branch)') || rest.startsWith('No commits yet')) return undefined
  // 分支名截止于 ' ...'（upstream 跟踪）或行尾
  const dotIdx = rest.indexOf('...')
  const branch = (dotIdx >= 0 ? rest.slice(0, dotIdx) : rest).trim()
  return branch || undefined
}

/** 冲突判定：任一列为 U，或双方都 D（both deleted）/ 都 A（both added）。 */
function isUnmergedPair(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A')
}

/** 未跟踪判定：XY 双列均为 '?'。 */
function isUntrackedPair(x: string, y: string): boolean {
  return x === '?' && y === '?'
}

/** 指定列（X 或 Y 任一）携带给定 porcelain 码。 */
function eitherColumnIs(x: string, y: string, code: string): boolean {
  return x === code || y === code
}

/**
 * XY 双列码 → GitFileStatus['status']（比 file-change-reconciler.xyToStatus 更细）。
 * X=staged，Y=working tree。判定按序短路，顺序与返回值语义固定：
 *
 * - U* / DD / AA → unmerged（冲突）
 * - ?? → untracked
 * - A → added（staged 新增）
 * - D → deleted
 * - R / C → renamed（目标路径）
 * - M（含 T 类型变更）/ 兜底 → modified
 */
export function xyToGitStatus(xy: string): GitFileStatus['status'] {
  const x = xy[0] ?? ' '
  const y = xy[1] ?? ' '
  if (isUnmergedPair(x, y)) return 'unmerged'
  if (isUntrackedPair(x, y)) return 'untracked'
  if (x === 'A') return 'added'
  if (eitherColumnIs(x, y, 'D')) return 'deleted'
  if (x === 'R' || x === 'C') return 'renamed'
  // T 类型变更（file type changed，如 regular file → symlink）
  if (eitherColumnIs(x, y, 'T')) return 'modified'
  return 'modified'
}

/**
 * 解析 `git status --porcelain=v1 -z -b` stdout。
 *
 * -z 模式：记录以 NUL 分隔。首条 `## ...` 为 branch 头；其后每条为 `XY <path>`。
 * 重命名/拷贝（X=R/C）：`XY <dst>\0<src>`，dst 为目标路径，src 紧随其后作为独立 NUL 记录。
 */
export function parseGitStatus(output: string): ParsedGitStatus {
  if (!output) return { files: [] }
  const records = output.split('\0')
  let branch: string | undefined
  let i = 0

  // 首条 branch 头（## ...）
  if (records[0]?.startsWith('## ')) {
    branch = parseBranchHeader(records[0])
    i = 1
  }

  const files: GitFileStatus[] = []
  for (; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    // XY 码占前 2 字符，第 3 字符是空格，其后是路径
    const xy = rec.slice(0, XY_CODE_LEN)
    const pathField = rec.slice(PORCELAIN_PATH_START)
    // 重命名/拷贝：下一条 NUL 记录是源路径，目标路径已在本条 → 跳过源路径记录
    if (xy[0] === 'R' || xy[0] === 'C') {
      i++
    }
    const path = pathField.trim()
    if (path) {
      files.push({ path, xyCode: xy, status: xyToGitStatus(xy) })
    }
  }

  return { branch, files }
}

/**
 * 从文件列表派生 staged/unstaged 计数 + 冲突标记（GitStatusResult 字段）。
 *
 * 计数规则（xyCode 双列：X=staged，Y=working tree）：
 * - stagedCount：X 列有变化（非 ' ' 且非 '?'）的文件数
 * - unstagedCount：Y 列有变化（非 ' ' 且非 '?'）的文件数；未跟踪 '??' 计入 unstaged
 * - hasConflict：任一文件为 unmerged
 */
export function deriveCounts(files: GitFileStatus[]): {
  stagedCount: number
  unstagedCount: number
  hasConflict: boolean
} {
  let staged = 0
  let unstaged = 0
  let hasConflict = false
  for (const f of files) {
    const x = f.xyCode[0] ?? ' '
    const y = f.xyCode[1] ?? ' '
    if (f.status === 'unmerged') hasConflict = true
    if (x !== ' ' && x !== '?') staged++
    if (y !== ' ' && y !== '?') {
      unstaged++
    } else if (x === '?' && y === '?') {
      // 未跟踪文件（??）Y 列是 '?'，单独计入 unstaged，不与上一分支重复
      unstaged++
    }
  }
  return { stagedCount: staged, unstagedCount: unstaged, hasConflict }
}

/** numstat 行最少列数：added + deleted + path = 3 列（tab 分隔）。 */
const NUMSTAT_MIN_PARTS = 3
/** numstat 前两列为 added/deleted 计数，path 从第 3 列（index 2）起。 */
const NUMSTAT_PATH_START = 2

/**
 * numstat 单行解析结果（lossless SSOT）。
 * - add/del 为 `number | undefined`：二进制文件 git 报告 `-`，解析为 undefined（信息无损，调用方可区分二进制）。
 * - path 用 `parts.slice(NUMSTAT_PATH_START).join('\t')` 还原（路径可含 tab，numstat 用 tab 分隔列，第 3 列起全为路径）。
 */
export interface NumstatEntry {
  add: number | undefined
  del: number | undefined
  path: string
}

/**
 * 解析 `git diff --numstat [...]` stdout → NumstatEntry[]（per-file，lossless SSOT）。
 *
 * 每行格式：`<added>\t<deleted>\t<path>`；二进制文件计数为 `-` → add/del 解析为 undefined。
 * path 取第 3 列起 join('\t')（路径可含 tab/空格，numstat 用 tab 分隔前 2 列故安全）。
 *
 * numstat 解析的唯一真值源。原薄包装 parseNumstat（聚合）与 parseNumstatByFile（per-file Map）
 * 自 W17 单趟收编后无生产消费方，已删除（W17 审查 Fix-5）；聚合与 per-file 语义由消费方
 * git-state-service.runGetStatus 基于本函数单趟遍历承担，等价覆盖见 git-state-service.test.ts。
 *
 * 调用方负责选择 diff 范围（HEAD / --cached / 无参 working tree）。
 */
export function parseNumstatEntries(output: string): NumstatEntry[] {
  if (!output) return []
  const entries: NumstatEntry[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < NUMSTAT_MIN_PARTS) continue
    const addRaw = parts[0]
    const delRaw = parts[1]
    // 路径取第 3 列起 join('\t')（路径可含 tab）
    const path = parts.slice(NUMSTAT_PATH_START).join('\t')
    const add = addRaw === '-' ? undefined : Number(addRaw)
    const del = delRaw === '-' ? undefined : Number(delRaw)
    entries.push({
      add: add === undefined || Number.isNaN(add) ? undefined : add,
      del: del === undefined || Number.isNaN(del) ? undefined : del,
      path,
    })
  }
  return entries
}
