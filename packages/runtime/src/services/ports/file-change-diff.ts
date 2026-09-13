/**
 * FileChange baseline diff 能力 port（ADR-0024 D5：git 作为唯一真值源）。
 *
 * service 层（EventInterpreter）需在 turn 内做 file_changes diff，但
 * [runtime-layering.md] 铁律：services 不直接 import infra。故抽出此 port，
 * 由组合根注入 infra 实现（infra/pi/file-change-diff-adapter.ts，内部委托
 * services/git/git-state-service.ts 经 IGitStateService port——W18 采集收编）。
 *
 * 接口签名只用 shared 类型（FileChange）与同层 git-state port 类型（NumstatEntry），
 * 不出现 infra 内部类型。
 */
import type { FileChange, FileChangeStatus } from '@xyz-agent/shared'
import type { NumstatEntry } from './git-state.js'

/** git status 快照的不透明句柄。interpreter 只持有/透传，不解构。 */
export type FileChangeSnapshot = unknown

/** numstat 行数注入类型：path → 条目 Map（null = 采集失败，行数靠 writeContents 回退）。 */
export type NumstatMap = Map<string, NumstatEntry> | null

/**
 * file_changes diff 引擎（组合根注入 infra 实现）。
 *
 * 四项能力（采集两项为异步——W18 R-10 签名异步化；计算两项为纯函数）：
 * - snapshotGitStatus：采集 cwd 的 git status 快照（委托 IGitStateService.snapshotStatus：
 *   in-flight 单飞 + 非仓库负缓存，D4-2/D4-3）
 * - numstat：采集 `git diff --numstat HEAD` 行数 Map（委托 IGitStateService.numstat）
 * - diffSnapshots：快照 → 变更清单（纯函数）
 * - computeLineCounts：行数填充（纯函数，numstat 结果注入 + content 回退 untracked）
 */
export interface IFileChangeDiff {
  /** 采集 cwd 的 git status 快照（异步）。非 git 仓库 / 不可用 → null（调用方跳过 diff）。 */
  snapshotGitStatus(cwd: string): Promise<FileChangeSnapshot>
  /** 采集 numstat 行数 Map（异步）。失败 / 非仓库 → null（行数靠 writeContents 回退）。 */
  numstat(cwd: string): Promise<NumstatMap>
  /** 快照 → 变更清单（纯函数）。 */
  diffSnapshots(current: FileChangeSnapshot): FileChange[]
  /** 为 FileChange[] 填充行数（原地修改，纯函数）。writeContents 供 untracked 回退。 */
  computeLineCounts(changes: FileChange[], numstatMap: NumstatMap, writeContents?: Map<string, string>): void
}

/** 重新导出 FileChangeStatus 便于 port 消费者（避免到处从 shared 取）。 */
export type { FileChangeStatus }
