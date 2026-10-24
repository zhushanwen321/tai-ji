/**
 * Session 文件定位（`session.getState` 冷读的文件定位三支，会话架构四层分离 W2）。
 *
 * 从 `./session-file-utils.ts` 拆出（该文件已顶 max-lines 软上限；本模块只做「按 id 找
 * 文件路径」一类事，与 sidecar IO / 扫描实现各自单文件一概念）。原导出路径经
 * session-file-utils 的 re-export 维持不变（消费方 import 路径零改动）。
 *
 * 三支定位（设计 §3.1「冷会话的文件定位有两条分叉路径」表 + §3.3.3 spawn 风险点 3）：
 * 1. **主会话段 1**：`sessionMetaCache` 全表遍历按 `meta.id` 匹配——缓存是
 *    `Map<filePath, CachedSessionMeta>`（键是文件路径、不是会话 id，不存在 id → filePath
 *    反查索引），遍历省掉目录枚举与 stat/解析（成本主体，实测口径见设计 §3.1 四要素
 *    登记），但仍是 O(n) 内存遍历；缓存不跨进程持久，故只对同一进程内第二次及以后的
 *    冷开有效。
 * 2. **主会话段 2**：`scanPiSessions({ force: true })` 全扫按 id 匹配（force 旁路目录
 *    TTL，与 `SessionService.findScannedSession` / `getPlanState` / `getMessageCount`
 *    同一口径——`ISessionStore.scanSessions` 是 `scanPiPessions` 的薄包装，本函数与经
 *    端口调用行为等价）。
 * 3. **btw 线支**：`BtwLineRecord.sessionFilePath`（注册表记录，经 `lifecycle.get(sessionId)`
 *    读——btw 线注册时该值由 registerSession 镜像进注册表记录）优先；未命中（**重启后**
 *    的线：`BtwService.rebuildFromDisk()` 只重建 BtwService.registry，不注册进
 *    lifecycle.sessions）走存储树布局公式定位。
 *
 * spawn 风险点 3 的实现约定：三支全部只读文件系统，**不 spawn 任何 pi 进程**——禁
 * `withEphemeralPi`（它会 spawn 短命 pi）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（shared/src/index.ts 注释），
// Node 端从子路径 import（btw-service 同款用法）。
import { getSessionStoreDir } from '@taiji/shared/paths'
import { sessionMetaCache } from './session-binding-sidecar-io.js'
import { scanPiSessions } from './session-file-utils.js'

/**
 * 段 1：sessionMetaCache 全表遍历按 `meta.id` 匹配（零 IO）。
 *
 * @returns 文件绝对路径；未命中 = undefined（调用方走段 2 全扫）
 */
export function findCachedSessionFileById(sessionId: string): string | undefined {
  for (const { meta } of sessionMetaCache.values()) {
    if (meta.id === sessionId) return meta.filePath
  }
  return undefined
}

/**
 * 段 2：`scanPiSessions({ force: true })` 全扫按 id 匹配（目录枚举 + stat + 解析）。
 *
 * 本轮枚举的 cwd 分组目录数同步进 `sessionScanDirCount`（冷路径埋点的取数来源）。
 *
 * @returns 文件绝对路径；未命中（会话不存在 / 文件未落盘 / 已被清理）= undefined
 */
export function findScannedSessionFileById(sessionId: string): string | undefined {
  return scanPiSessions({ force: true }).find((s) => s.id === sessionId)?.filePath
}

/**
 * btw 线支的兜底定位：按存储树布局公式找线的会话文件
 * （`<sessionStoreRoot>/<mainSid>/btw/<piSessionId>.jsonl`）。
 *
 * 为何需要兜底（而不是只用 `BtwService.getLine(sessionId)`）：设计 §3.1 指定的 btw 定位源是
 * `BtwLineRecord.sessionFilePath`，而 BtwService 实例由组合根创建、经 Facade 私有域持有，
 * 对 transport / 本模块均不可达（Façade 的 session-service.ts 属并行单元领地，本单元
 * 禁触）。重启后 `rebuildFromDisk()` 只重建 BtwService.registry、不注册进
 * lifecycle.sessions，故注册表记录一路对重启后的线结构性缺席——布局公式定位读的是
 * **同一个文件**（rebuildFromDisk 的 sessionFilePath 就由本公式产出），只是换成不经
 * 内存注册表的寻址方式。
 *
 * 遍历规约对齐 `BtwService.rebuildFromDisk`（设计 D7）：一级目录名须过
 * `isPiSessionId`（结构性拦截外部 junk 目录），线文件名 = `<piSessionId>.jsonl`
 * （pi 落盘命名，header.id 即文件名主干——rebuildFromDisk 的 session id 派生同源）。
 * 不枚举时（存储树根不存在/不可读）返回 undefined，不抛。
 */
export function findBtwLineFileByPiSessionId(piSessionId: string): string | undefined {
  const root = getSessionStoreDir()
  if (!existsSync(root)) return undefined
  let sidDirs: string[]
  try {
    sidDirs = readdirSync(root)
  } catch {
    return undefined
  }
  for (const mainSid of sidDirs) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(mainSid)) continue // isPiSessionId 同款正则（避免 import 环）
    let isDir = false
    try {
      isDir = statSync(join(root, mainSid)).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    const candidate = join(root, mainSid, 'btw', `${piSessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
