/**
 * # FileChange baseline diff 引擎（ADR-0024 D5 重构：git 作为唯一真值源）
 *
 * 核心机制：turn 内写操作后采集 git status，diff 得「当前工作区变更」。git 是唯一真值源，
 * 不再从工具参数硬解析行数。
 *
 * W18（perf 03 D4-5）采集异步化后本模块只保留**纯函数**：
 * 1. parseGitStatusPorcelain / xyToStatus — porcelain 输出解析（GitStateService 复用）
 * 2. diffSnapshots — 快照 → 变更清单
 * 3. computeLineCounts — 行数填充（numstat 结果注入 + content 回退），零子进程
 *
 * 采集（git status / git diff --numstat）已收进 GitStateService（services/git/，W16 基础设施），
 * 经 IFileChangeDiff port 的 FileChangeDiffAdapter 注入 EventInterpreter。
 * 本模块不再 spawn 任何进程（主线程零同步 git）。
 */
import type { FileChange, FileChangeStatus } from '@taiji/shared'
import { xyToGitStatus } from '../git/git-status-parser.js'
import type { NumstatEntry } from '../git/git-status-parser.js'

/** git status --porcelain 的单行解析结果（XY 码 + 路径） */
interface GitStatusEntry {
  /** XY 码两字符（X=staged，Y=working tree），如 ' M'/'??'/'A '/'D ' */
  xy: string
  /** 目标文件路径（重命名取 `->` 后的目标） */
  path: string
}

// git status --porcelain 行格式固定偏移：`XY <path>`（XY 码 2 字符 + 1 空格 + 路径）。
// git numstat 解析已统一到 shared 的 parseNumstatEntries（lossless SSOT，含二进制 - 处理）。
const PORCELAIN_XY_LEN = 2
const PORCELAIN_PATH_START = 3
const RENAME_ARROW = ' -> '
const RENAME_ARROW_LEN = RENAME_ARROW.length

/**
 * 解析 `git status --porcelain` 输出为条目数组。
 * 每行格式：`XY <path>` 或 `XY <src> -> <dst>`（重命名/拷贝）。
 */
export function parseGitStatusPorcelain(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    // 前 2 字符是 XY 码，第 3 字符是空格，其后是路径
    const xy = line.slice(0, PORCELAIN_XY_LEN)
    const rest = line.slice(PORCELAIN_PATH_START)
    // 重命名/拷贝格式：`R  src -> dst`，取目标路径 dst
    const arrowIdx = rest.indexOf(RENAME_ARROW)
    const path = arrowIdx >= 0 ? rest.slice(arrowIdx + RENAME_ARROW_LEN).trim() : rest.trim()
    if (path) entries.push({ xy, path })
  }
  return entries
}

/**
 * XY 码 → FileChangeStatus 映射（ADR-0024 D5）。
 *
 * 基于 shared 的 6 态 xyToGitStatus 做降级映射（4 态 FileChangeStatus），
 * 避免与 xyToGitStatus 重复 XY 字符判定逻辑。降级规则集中在 SIX_TO_FOUR 映射表：
 * - untracked → added（未跟踪视为新增）
 * - added → added
 * - deleted → deleted
 * - renamed → modified（目标路径记 modified，src 删除细节留 diff 层）
 * - unmerged → modified（冲突文件视为已修改）
 * - modified → modified
 *
 * 与原手写分支的语义差异：冲突态（DD/AA/U*）原分支因 if 顺序分别落 deleted/added/modified，
 * 现统一降级为 modified。baseline diff 机制不依赖冲突态细分，无影响。
 */
const SIX_TO_FOUR: Record<string, FileChangeStatus> = {
  untracked: 'added',
  added: 'added',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'modified',
  unmerged: 'modified',
}

export function xyToStatus(xy: string): FileChangeStatus {
  return SIX_TO_FOUR[xyToGitStatus(xy)]
}

/** git status 快照：filePath → status（A/M/D）。null 表示非 git 仓库或采集失败。 */
export type StatusSnapshot = Map<string, FileChangeStatus> | null

/**
 * 快照 → 变更清单（W18 R-09 简化：单参数）。
 *
 * [HISTORICAL] 原签名 diffSnapshots(baseline, current) 双参数，但 baseline 对输出零影响——
 * 「baseline 有 current 无 → 不报告（已 commit/revert）」的差集语义早在 dirty 文件漏报修复
 * （见下）时被移除，两个分支（baseline null / 非 null）实际都输出 current 全集。baseline
 * 参数是死参数。W18 按 R-09 裁决直接删除：turn-start 的 baseline 采集（execSync）一并移除
 * （每次 turn 白跑一次 git status 的纯浪费），不引入「异步不 await 的 baseline 采集」。
 *
 * current 全集即变更清单的原因：turn 开始前工作区已有 dirty 文件时（开发场景极常见：
 * worktree 普遍有未提交改动），pi 改了这些文件后 git status 仍是 modified，若按差集只报
 * 「status 变化的文件」会漏报 → fileChanges 为空 → 变更集卡不显示（"全程几乎看不到"事故）。
 * 代价是 turn 开始前已 dirty 但 turn 内未碰的文件会误报，但误报（多列几个文件）的危害
 * 远低于漏报（整个变更集卡消失）。误报文件在各帧一致报告，不产生状态跳变。
 *
 * @param current 当前快照（null = 非仓库 / 采集失败 → 空数组，调用方跳过推帧）
 */
export function diffSnapshots(current: StatusSnapshot): FileChange[] {
  if (!current) return []
  return Array.from(current.entries()).map(([filePath, status]) => ({ filePath, status }))
}

/**
 * 为 FileChange[] 填充行数（addLines/delLines）——纯函数（W18 D4-5：numstat 结果注入，零子进程）。
 *
 * 两路行数来源（ADR-0024 重构）：
 * 1. 已跟踪文件：numstat（git 真值，含 staged + unstaged）—— 由调用方经 GitStateService.numstat
 *    异步采集后注入（numstatMap）；null / 缺项 → 跳过该路
 * 2. untracked 文件（numstat 不报告）：从 writeContents 回退（write 工具的 content 分行计）
 *
 * numstat 不报告 untracked 文件是已知限制。bash 创建的 untracked 文件无行数来源——
 * 卡片显示文件名但不显示 +N（与现状一致，接受此限制）。
 *
 * @param changes 待填充行数的 FileChange[]（原地修改）
 * @param numstatMap `git diff --numstat HEAD` 的解析结果（null = 采集失败，行数靠 writeContents 回退）
 * @param writeContents 本 turn write 工具写入的 content（filePath → content），untracked 行数回退
 */
export function computeLineCounts(
  changes: FileChange[],
  numstatMap: Map<string, NumstatEntry> | null,
  writeContents?: Map<string, string>,
): void {
  if (changes.length === 0) return

  for (const change of changes) {
    const ns = numstatMap?.get(change.filePath)
    if (ns) {
      if (ns.add !== undefined) change.addLines = ns.add
      if (ns.del !== undefined) change.delLines = ns.del
    } else if (writeContents) {
      // untracked 文件：numstat 不报告，从 write content 回退
      const content = writeContents.get(change.filePath)
      if (typeof content === 'string' && content !== '') {
        change.addLines = content.split('\n').length
      }
    }
  }
}
