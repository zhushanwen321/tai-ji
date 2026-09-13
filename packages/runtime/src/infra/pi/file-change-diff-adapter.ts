/**
 * FileChangeDiffAdapter — IFileChangeDiff port 的 infra 实现。
 *
 * W18（perf 03 D4-5）采集收编：snapshotGitStatus / numstat 委托注入的 IGitStateService
 * （异步 execFile + in-flight 单飞 + 非仓库负缓存，W16 基础设施），本 adapter 不再 spawn
 * 任何子进程；diffSnapshots / computeLineCounts 转发 file-change-reconciler 的纯函数。
 * 组合根注入 EventInterpreter，使 service 层不直接 import infra（[runtime-layering.md] 铁律）。
 */
import type { FileChange } from '@xyz-agent/shared'
import type { IFileChangeDiff, FileChangeSnapshot, NumstatMap } from '../../services/ports/file-change-diff.js'
import type { IGitStateService } from '../../services/ports/git-state.js'
import {
  diffSnapshots,
  computeLineCounts,
} from './file-change-reconciler.js'
import type { StatusSnapshot } from './file-change-reconciler.js'

export class FileChangeDiffAdapter implements IFileChangeDiff {
  constructor(private readonly gitState: IGitStateService) {}

  async snapshotGitStatus(cwd: string): Promise<FileChangeSnapshot> {
    // IGitStateService.snapshotStatus 返回 StatusSnapshot（具体 Map|null），port 侧以
    // 不透明 unknown 透传给 interpreter（其只持有/透传，不解构）。
    return this.gitState.snapshotStatus(cwd)
  }

  async numstat(cwd: string): Promise<NumstatMap> {
    return this.gitState.numstat(cwd)
  }

  diffSnapshots(current: FileChangeSnapshot): FileChange[] {
    return diffSnapshots(current as StatusSnapshot)
  }

  computeLineCounts(changes: FileChange[], numstatMap: NumstatMap, writeContents?: Map<string, string>): void {
    computeLineCounts(changes, numstatMap, writeContents)
  }
}
