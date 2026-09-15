/**
 * WorkspaceService — 写入时机编排 + INV-1 主守卫
 *
 * 最近工作区的业务入口。封装 record（写入时机）和 list（查询），
 * 在 service 层做 INV-1 主守卫（空串/undefined 静默跳过），透传到 RecentWorkspacesStore。
 *
 * AC-2.4: 本文件零 setTimeout/setInterval（timer 仅在 store 层）
 * AC-2.5: 本文件无 session 域依赖（零耦合 session 子系统）
 */

import { homedir } from 'node:os'
import type { RecentWorkspaceRecord } from '@taiji/shared'
import type { RecentWorkspacesStore } from './recent-workspaces-store.js'
import type { WorkspaceDetector, WorkspaceDetectResult } from '../worktree/workspace-detector.js'

export class WorkspaceService {
  constructor(
    private readonly store: RecentWorkspacesStore,
    private readonly detector: WorkspaceDetector,
  ) {}

  /**
   * 记录一次工作区使用。INV-1 主守卫：空串/undefined/whitespace 静默跳过。
   * homedir 守卫（方案A）：homedir 是失效 cwd 的兜底目标，作为「最近工作区」无记录价值
   * （用户不需要从列表点回 homedir，它永远是已知的）。一处堵死全部调用路径：
   * create 降级 / sendPrompt / 前端 RPC 直选 / 列表自繁殖。
   * 实际写入由 store.record 处理（含 INV-1 兜底 + INV-2 淘汰 + INV-3 去重）。
   */
  record(cwd: string): void {
    if (!cwd || cwd.trim() === '') return
    if (cwd === homedir()) return
    this.store.record(cwd)
  }

  /**
   * 返回最近工作区列表，按 lastUsedAt 倒序，≤10 条。
   */
  list(): RecentWorkspaceRecord[] {
    return this.store.list()
  }

  /**
   * 检测 cwd 是否位于 bare repo + worktree 结构（复用 WorkspaceDetector.detect）。
   *
   * 返回 detector 原始结构 `{isBareMode, wsRoot, barePath}`——`isBareMode → isBare` 的字段映射
   * 由 transport handler 负责（handler.reply payload 字段名对齐 workspace.bareDetected 协议）。
   * landing 态由 useNewTaskDirSelect watch pendingCwd 主动调用。
   */
  detectBare(cwd: string): WorkspaceDetectResult {
    return this.detector.detectSync(cwd)
  }
}
