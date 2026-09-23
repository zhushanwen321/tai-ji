/**
 * btw 启动孤儿补账（btw-question D5 + BU5 扫描降级闸）——清理「主会话已不存在」的线目录。
 *
 * 内聚段抽自 btw-service.ts（max-lines 同目录内聚拆分，2026-09-22，纯移动零行为变更）：
 * 判据/降级闸/幂等语义随 doc 整段迁入；BtwService.reconcileOrphanThreadDirs 保留为
 * 组合根调用面（一行委托），消费方 import 路径零改动。isInsideBtwRoot 路径安全谓词
 *（删除面必须位于 btw 根内）随本模块迁入——补账是其主消费方，关线/级联经 btw-service
 * import 复用（原为该类私有方法，非导出面成员）。
 * 依赖 = 窄结构接口（OrphanReconcileDeps），不反向 import btw-service（保持无环）。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { getBtwSessionsRoot, isPiSessionId } from '../../infra/pi/pi-paths.js'
import { toErrorMessage } from '../../utils/errors.js'

/**
 * 补账判据依赖（BtwServiceDeps 结构性满足——resolve 主会话文件 + 扫描降级旗标；
 * 结构化窄接口而非 import BtwServiceDeps，避免 sibling → btw-service 反向依赖成环）。
 */
export interface OrphanReconcileDeps {
  /** 主会话文件解析（活跃 ?? 扫盘）；undefined = 主不可解析（疑似已删）。 */
  resolveMainSessionFile(mainSid: string): string | undefined
  /** 本轮 sessions 扫描是否降级不可信（BU5 闸；缺省 = 恒可信，维持原判据）。 */
  isSessionScanDegraded?(): boolean
}

/**
 * 路径安全：删除面必须位于 btw 根内（closeLine/reconcile 防误删守卫形态）。
 * 原为 BtwService 私有方法，随补账段迁出（closeLine / closeAllForMain 同 import 复用）。
 */
export function isInsideBtwRoot(target: string): boolean {
  const root = getBtwSessionsRoot()
  return target.startsWith(root + sep)
}

/**
 * 启动孤儿补账（D5：清理「主会话已不存在」的线目录——崩溃恢复对齐「主删即删」；
 * **非全量 GC**：主会话在场（活跃 ?? 扫盘可解析）的线一律保留——退出不删、闲置回收不删、
 * 进程亡不删，关闭 drawer 不删）。
 *
 * 调用序（组合根）：**先本函数、后 rebuildFromDisk**——先清孤儿目录，重建只登记在场主线。
 * 判据 = deps.resolveMainSessionFile(mainSid) 不可解析（主文件已 trash / 从未落盘——
 * 分支线首 flush 前主会话无文件的形态重启后主/线同归于此，判定正确），**且本轮扫描可信**：
 * 扫描腿降级（readdir EACCES/IO）会显式返回空列表、与「权威空」不可区分，冷主会话将全部
 * 落空 ⇒ 若不设闸会把全部线目录误判「主已删」清空（BU5：rm -rf 不可逆，摧毁裁决⑧持久化）。
 * 故 resolve 落空后先过 deps.isSessionScanDegraded 闸——降级即跳过整轮补账，warn 留痕、
 * 改下次启动重试（[HISTORICAL] 原注释「扫描腿 best-effort 返回列表而非抛错 ⇒ 触发面 =
 * 主确已删」论证不成立：返回空列表正是降级形态之一，与主确已删不可区分，故须旗标透出）。
 * 非 pi 形态目录名跳过（junk 归 rebuild 的 warn 面，不代删）。
 * 幂等 + best-effort：无根零动作；单目录 rm 失败 warn 不阻断启动（P2 降级隔离），
 * 残留下次启动重试。
 *
 * @returns 本次清除的孤儿线目录数（启动日志/测试断言用）
 */
export function reconcileOrphanThreadDirs(deps: OrphanReconcileDeps): number {
  const root = getBtwSessionsRoot()
  if (!existsSync(root)) return 0
  let removed = 0
  let cwdDirs: string[]
  try {
    cwdDirs = readdirSync(root).filter(name => {
      try { return statSync(join(root, name)).isDirectory() } catch { return false }
    })
  } catch (e) {
    console.warn(`[btw] orphan reconcile: cannot read btw root (${root}): ${toErrorMessage(e)}`)
    return 0
  }
  for (const enc of cwdDirs) {
    const encDir = join(root, enc)
    let sidDirs: string[]
    try {
      sidDirs = readdirSync(encDir).filter(name => {
        try { return statSync(join(encDir, name)).isDirectory() } catch { return false }
      })
    } catch { continue }
    for (const mainSid of sidDirs) {
      if (!isPiSessionId(mainSid)) continue // junk 目录名归 rebuild warn 面，不代删
      if (deps.resolveMainSessionFile(mainSid)) continue // 主在场 → 线保留
      // BU5 扫描降级闸：主解析落空且本轮 sessions 扫描不可信（readdir 降级空列表）→
      // 判定「主已删」不成立，跳过整轮补账改下次启动重试（首个不可解析候选即触发——
      // 可解析候选只会 continue 不产生删除，故此处 removed 恒为 0，整轮回退无部分删除）。
      if (deps.isSessionScanDegraded?.()) {
        console.warn(`[btw] orphan reconcile: session scan degraded this round — deferring to next startup (mainSid=${mainSid})`)
        return 0
      }
      const threadDir = join(encDir, mainSid)
      try {
        if (!isInsideBtwRoot(threadDir)) continue
        rmSync(threadDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        removed += 1
        console.warn(`[btw] orphan reconcile: removed thread dir of missing main session (mainSid=${mainSid}, dir=${threadDir})`)
      } catch (e) {
        // best-effort：删孤儿目录失败不阻断启动（P2 降级隔离），残留下次启动重试，留痕可归因
        console.warn(`[btw] orphan reconcile: remove failed (${threadDir}): ${toErrorMessage(e)}`)
      }
    }
  }
  return removed
}
