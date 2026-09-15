/**
 * sidecar 家族公共 IO 骨架 + 扫描缓存治理状态（叶子模块）。
 *
 * 为什么存在：session-model-sidecar.ts（model 家族）自 session-file-utils.ts 拆出后
 * 反向复用 persistBindingSidecar / readBindingSidecar 骨架，曾构成两模块的函数级循环
 * 引用（ESM function 声明实例化期绑定，运行时无 TDZ 风险，但 PR fallow audit 按硬
 * 规则拦截循环依赖）。骨架与其私有闭包（sessionMetaCache / scanDirCache 家族）下沉
 * 为本叶子模块，依赖收敛为单向：session-file-utils → 本模块、session-model-sidecar →
 * 本模块（前者另依赖后者，两后继互不依赖）。
 *
 * [type-only 反向引用登记] import type { ScannedSessionMeta } from
 * './session-file-utils.js'：缓存容器条目持有上层聚合类型，编译后引用消失、运行时
 * 严格单向（fallow 循环检测与 check_services_infra_import.py 同理豁免 import type）。
 *
 * 单例语义：sessionMetaCache / scanDirCache 全仓唯一实例（ESM 模块只加载一次），
 * 迁移不是复制；file-utils 经 re-export 维持原导出路径，消费方 import 无感。
 */
import { existsSync, readFileSync } from 'node:fs'
import { atomicWrite } from '../../utils/fs-utils.js'
import type { ScannedSessionMeta } from './session-file-utils.js'

// ── W3 文件级 mtime+size 缓存（随骨架迁入：persistBindingSidecar 写后失效依赖它）──

/**
 * W3 文件级 mtime+size 缓存（INVAR-cache-1 模块级跨两阶段共享）。
 *
 * scanPiSessions（header+name+outcome 三读合一）与 scannedToSummary（取 outcome）共享此缓存。
 * 缓存键含 (path, mtimeMs, size)（INVAR-cache-2 SR4）——同 ms 内并发 append mtimeMs 不变但
 * size 变 → miss，消除竞态。无上限（INVAR-cache-6，每条~几百字节，10k session≈数 MB）。
 * 不跨进程（runtime 重启清空，首次 scan 冷读）。
 *
 * [KNOWN-LIMIT 无界增长] 缓存以 filePath 为键，删除 session 不会主动清条目（deleteSession
 * 走 trash 不回调此模块）。长时间运行的 runtime + 频繁创建/删除 session 时条目累积，
 * 但单条 ~几百字节、且 filePath 含 sessionId 不会重复，实测量级可控（数千条 ≈ 1MB）。
 * 若未来 session 生命周期变长/创建频繁导致内存压力，可在此加 LRU 上限或定期 sweep
 * （按 lastModified 淘汰 stale 条目）。当前 runtime 进程为 session 级常驻，生命周期内
 * session 总数有限，暂不引入淘汰逻辑。
 */
interface CachedSessionMeta {
  mtimeMs: number
  size: number
  meta: ScannedSessionMeta
}
// 导出供 file-utils 侧缓存治理调用点使用（persistSessionEnd / persistProjectBinding /
// persistHandoffSidecar / scanSessionMeta 等，均为 .get/.set/.delete 方法调用，绑定只读
// 无碍）；对外语义维持原状——file-utils 不再转出，消费方仍经 _resetSessionMetaCacheForTest
// / invalidateSessionMetaCache 治理函数触达。
// 2026-09-14 内存审计复核：量级维持可控，维持不治裁决（docs/design/memory-leak-remediation.md §2.5）
export const sessionMetaCache = new Map<string, CachedSessionMeta>()

// ── sidecar 家族公共骨架（原 session-file-utils.ts，函数体逐字节不变迁入）────────

/**
 * persistBindingSidecar 的可选行为开关。
 *
 * skipJsonlExistsGuard（V9-④ 根修，2026-09-09）：跳过「JSONL 未落盘即跳过」守卫。
 * 仅限 create 路径使用——调用方以「本 session 刚由本进程创建」这一事实替代文件存在性
 * 判据（getState 成功 + registerSession 成功后 session 必然真实，.jsonl 未 flush 只是
 * pi 延迟写入窗口）。规则 #6 禁止的是创建/触碰 pi session .jsonl 本体（openSync('wx')
 * EEXIST 卡死），sidecar 是 xyz 自有文件且经 atomicWrite 落盘、不触碰 .jsonl，放行
 * 不违反规则 #6。非 create 路径（fork/restore/setProject 等）禁用——文件不存在仍应
 * 跳过（防为已清理/创建失败的 session 留孤儿 sidecar），守卫默认语义保持不变。
 */
export interface PersistBindingSidecarOpts {
  /** 写后是否失效目录列举 TTL 缓存（默认 true，opt-out 语义见 persistBindingSidecar docstring）。 */
  invalidateScanDir?: boolean
  /** create 路径专用：JSONL 未 flush（existsSync=false）时仍落盘 sidecar（默认 false）。 */
  skipJsonlExistsGuard?: boolean
}

/**
 * sidecar 家族公共写入（preset/project/agent binding 共用骨架）：
 * 空路径守卫 + JSONL 未落盘守卫（规则 #6：绝不创建 sidecar；create 路径可经
 * skipJsonlExistsGuard 放行，见 PersistBindingSidecarOpts）+ 原子写 + 双层缓存失效
 * （sessionMetaCache 必失效；scanDirCache 默认失效，见 invalidateScanDir 说明）。
 * 差异点参数化：sidecar 路径 helper、tmpfile 前缀、目录级扫描缓存的豁免开关。
 *
 * invalidateScanDir 默认 true（sidecar-binding-sync 设计文档决策 2）：binding 写点的唯一
 * 列表消费方是扫描侧，写后不失效无正当场景——不失效则紧跟的列表广播命中 1s TTL 窗口内的
 * pre-write 快照返回 stale 数据；此前逐调用方 opt-in 已产出多个漏改实例（设计文档缺陷 B），
 * 故收敛为默认开。确需跳过时必须显式传 { invalidateScanDir: false } 并附注释说明理由。
 *
 * [消费方登记] preset/project/agent 家族在 session-file-utils.ts 消费（骨架原属该文件，
 * 经其 re-export 保持原 import 路径）；model 家族在 session-model-sidecar.ts 直接消费
 * 本模块。骨架随循环消除下沉至此，仅限 sidecar 家族模块消费，不作为公共 API。
 */
/**
 * sidecar 持久化形状（S12 序列化边界最小约束）：各家族 binding 的公共底座——
 * JSON.stringify 产出的对象（preset/project/agent/model 家族字段各异，由各自
 * 调用方类型进一步收窄；读侧经 readBindingSidecar 的 decode 守卫回调校验）。
 */
export type PersistedSidecarBinding = Readonly<Record<string, unknown>>

export function persistBindingSidecar(
  filePath: string,
  sidecarPathOf: (fp: string) => string,
  binding: PersistedSidecarBinding,
  tmpPrefix: string,
  opts?: PersistBindingSidecarOpts,
): void {
  if (!filePath) return
  if (!opts?.skipJsonlExistsGuard && !existsSync(filePath)) {
    // 文件不存在（pi 延迟写入窗口 / 首 turn 前崩溃）：绝不创建文件，直接跳过（规则 #6 / ES-RL-1）。
    // create 路径例外见 PersistBindingSidecarOpts.skipJsonlExistsGuard。
    return
  }
  try {
    // 原子写（tmpfile + rename）：与 persistSessionEnd 一致，防止并发读读到半写的 sidecar。
    atomicWrite(sidecarPathOf(filePath), JSON.stringify(binding), `${tmpPrefix}-${Date.now()}`)
    // sidecar 写入后主动失效 sessionMetaCache：缓存键只含 JSONL 的 (mtimeMs, size)，
    // sidecar 变更不变 JSONL stat → 命中缓存返回旧值。
    sessionMetaCache.delete(filePath)
    // 默认失效，显式 false 才跳过（opt-out 语义与理由要求见函数 docstring）。
    if (opts?.invalidateScanDir !== false) {
      invalidateScanDirCache()
    }
  // eslint-disable-next-line taste/no-silent-catch -- file write: failure must not crash caller
  } catch (e) {
    console.error(`[session-file-utils] ${tmpPrefix} binding persist failed: ${filePath}`, e)
  }
}

/**
 * sidecar 家族公共读取：读文件 + JSON.parse + 调用方字段守卫回调。
 * sidecar 不存在/损坏/守卫不过 → undefined（降级不抛错）。
 *
 * [消费方登记] 同 persistBindingSidecar——preset/project/agent 家族经
 * session-file-utils.ts re-export 消费，model 家族（'./session-model-sidecar.ts'）
 * 直接消费本模块，仅限 sidecar 家族模块消费。
 */
export function readBindingSidecar<T>(sidecarPath: string, decode: (binding: unknown) => T | undefined): T | undefined {
  try {
    const raw = readFileSync(sidecarPath, 'utf-8')
    return decode(JSON.parse(raw))
  } catch {
    return undefined
  }
}

// ── wave:perf-w26 目录列举层 TTL 缓存（随骨架迁入：骨架写后失效依赖它）──────────

/** 目录列举缓存条目。dir 不匹配（XYZ_AGENT_DATA_DIR 切换 / 测试隔离）即整体失效。 */
interface ScanDirCacheEntry {
  dir: string
  entries: ScannedSessionMeta[]
  expiresAt: number
}
let scanDirCache: ScanDirCacheEntry | null = null
/**
 * 上次 scanPiSessions 观测的 Date.now()（时钟回拨检测，终审 suggestion）。
 * now < lastNow = 系统时钟后跳（NTP 校时 / 手动改时）→ TTL 判定基于的墙钟不可信，
 * 缓存视为过期强制重扫，否则 now < expiresAt 在回拨窗口内恒真（列表视图冻结）。
 */
let scanDirLastNow = 0

/**
 * 显式失效目录列举 TTL 缓存（wave:perf-w26 D9-1）。
 *
 * session delete / fork / rename（runtime 自写文件的操作）后调用——这些写不经 pi 延迟
 * 落盘，显式失效让下一次列表构建立即可见。create 走 pi 延迟落盘，靠 TTL 自然过期，
 * 不调此函数。亦供测试重置（测试间目录隔离）。
 */
export function invalidateScanDirCache(): void {
  scanDirCache = null
  // 回拨检测基准一并重置：缓存条目与观测基准同生命周期重建（测试间/显式失效后无跨窗口泄漏）
  scanDirLastNow = 0
}

/**
 * scanPiSessions 专用：目录列举层 TTL 缓存的命中读取（含时钟回拨防护）。
 *
 * 为什么经函数而非导出变量：scanDirCache / scanDirLastNow 是 let 可变绑定，跨模块
 * 赋值不可行（ESM 导出绑定对导入方只读），缓存状态随 persistBindingSidecar 骨架迁入
 * 本模块后，file-utils 侧 scanPiSessions 的读写统一收口到 lookup/refresh 函数对。
 *
 * 时钟回拨防护：now 落到上次观测之前 → 墙钟被回拨，expiresAt 的单调性假设失效 →
 * 缓存不可信，强制重扫并以回拨后的时钟重建基准（几行代码的轻量防护）。观测基准
 * （scanDirLastNow）在命中判断前无条件更新，与原内联实现时序一致。
 *
 * @returns 命中返回缓存 entries（内部引用，调用方负责浅拷贝后再暴露给消费者——
 *          消费者可安全 sort/splice 不污染缓存本体）；miss（无缓存 / dir 不匹配 /
 *          TTL 过期 / 回拨 / force）返回 null（与「hit 但空快照」的 [] 区分）。
 */
export function lookupScanDirCache(dir: string, now: number, force: boolean): ScannedSessionMeta[] | null {
  const clockWentBackwards = now < scanDirLastNow
  scanDirLastNow = now
  if (!force && !clockWentBackwards && scanDirCache && scanDirCache.dir === dir && now < scanDirCache.expiresAt) {
    return scanDirCache.entries
  }
  return null
}

/**
 * scanPiSessions 专用：重扫结果写回目录列举层 TTL 缓存（force 刷新同样写缓存：
 * 随后 1s 内的列表构建消费方零 IO 读到最新视图）。
 */
export function refreshScanDirCache(dir: string, now: number, ttlMs: number, entries: ScannedSessionMeta[]): void {
  scanDirCache = { dir, entries, expiresAt: now + ttlMs }
}
