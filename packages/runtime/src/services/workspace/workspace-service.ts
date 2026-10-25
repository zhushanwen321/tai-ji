/**
 * WorkspaceService — 写入时机编排 + INV-1 主检查
 *
 * 最近工作区的业务入口。封装 record（写入时机）和 list（查询），
 * 在 service 层做 INV-1 主检查（空串/undefined 静默跳过），透传到 RecentWorkspacesStore。
 *
 * AC-2.4: 本文件零 setTimeout/setInterval（timer 仅在 store 层）
 * AC-2.5: 本文件无 session 域依赖（零耦合 session 子系统）
 */

import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import type { RecentWorkspaceRecord } from '@taiji/shared'
import type { RecentWorkspacesStore } from './recent-workspaces-store.js'

export class WorkspaceService {
  /**
   * @param defaultSessionDirProvider 默认会话目录路径推导（组合根注入——T2.7 守卫本文件
   *   零 session 词汇 import，路径函数名由组合根持有；缺省 = ''，入口隐藏）
   */
  constructor(
    private readonly store: RecentWorkspacesStore,
    private readonly defaultSessionDirProvider: () => string = () => '',
  ) {}

  /**
   * 记录一次工作区使用。INV-1 主检查：空串/undefined/whitespace 静默跳过。
   * homedir 检查（方案A）：homedir 是失效 cwd 的兜底目标，作为「最近工作区」无记录价值
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
   * 返回最近工作区列表：pinned 置前（≤5）+ 其余按 lastUsedAt 倒序（≤6）。
   */
  list(): RecentWorkspaceRecord[] {
    return this.store.list()
  }

  /**
   * pin/unpin 条目（INV-6）：透传 store。返回是否生效（false = 超 pin 上限被拒，列表不变；
   * 调用方据此 degraded 标记，RPC 契约恒 resolve）。
   */
  setPinned(cwd: string, pinned: boolean): boolean {
    if (!cwd || cwd.trim() === '') return false
    const applied = this.store.setPinned(cwd, pinned)
    if (!applied) {
      console.warn(`[workspace-service] setPinned rejected (pin limit reached): cwd=${cwd}`)
    }
    return applied
  }

  /**
   * 默认会话目录（<dataDir>/defaultSession/）：幂等 ensureDir 后返回绝对路径。
   * 启动序列已 ensure 一次（用户裁决 2026-10-22），此处再 ensure 是自愈兜底（启动失败
   * 残留 / --data-dir 切换后的新目录场景）；ensure 失败返回空串（前端隐藏「默认会话」
   * 入口——返回不可用路径会让 create 落错目录，比缺入口更糟）。
   */
  defaultSessionDir(): string {
    const dir = this.defaultSessionDirProvider()
    if (!dir) return ''
    try {
      mkdirSync(dir, { recursive: true })
      return dir
    } catch (err) {
      console.error('[workspace-service] ensure defaultSession dir failed:', err)
      return ''
    }
  }
}
