/**
 * session-list-query —— `session.list` 通用查询的条目合成（会话架构四层分离 W4b，
 * 设计 §3.3.1 / §5-W4b）。
 *
 * 为什么独立于 SessionScanner：scanner 的 `listAll` 以 `!s.hidden` 过滤 btw 线
 * （W3 双写期线的 active 腿防线，`config.sessions` 全量广播必须保持该口径——28 处
 * 广播调用点零改动），故侧栏分组结构性不含线条目；`session.list` 的调用方（抽屉 /
 * 搜索 / 抑制类成员判别）要的恰是含线的视图。本模块在同一查询入口上按
 * surface / mainSessionId 两参数派生，不改 scanner、不改广播语义。
 *
 * 取数来源（注册表即权威，无第二事实源）：
 * - 侧栏口径 = `scanner.listPersistedSessions()`（活跃非 hidden + 磁盘扫描合并分组，
 *   与 `config.sessions` 广播同源——同 owner 派生保证两口径不会各自演化）；
 * - 线口径 = `BtwService.listAllLines()`（registry 内存投影；启动时 rebuildFromDisk
 *   从 `<root>/<mainSid>/btw/*.jsonl` 重建，冷线不 spawn 即在线）。
 *
 * 条目合成规则（设计 §5-W4b「必填字段派生规则」）：
 * - id = 线 pi 真实会话 id（W4a 键统一后 runtime/前端唯一键）；
 * - label = `btw-<序号>`（§3.4.3 重定义：同一主会话名下按创建次序编号，替代旧
 *   `basename(cwd)` 全部同名的形态；序号按 createdAt 升序，rebuildFromDisk 的
 *   createdAt = 文件 mtime，重启后次序稳定）；
 * - cwd = 线 cwd（= 所属主会话 cwd，`BtwLineRecord.cwd`）；
 * - status = 线进程活跃（lifecycle 记录 isGenerating）时 'active'，否则 'idle'
 *   （线是惰性 spawn——未附着的线没有进程，'idle' 是诚实静态值，不伪造）；
 * - lastActiveAt = 线 createdAt（无语义时钟可派生的更优值）；
 * - surface = 'btw'（展示归属恒为抽屉；W3 双写期同记录的 hidden 字段随 W5 退役，
 *   本合成不写它——判别以 surface 为唯一口径）。
 *
 * 分组与排序：reply 与 `config.sessions` 同形（`SessionGroup[]`，按 cwd 分组）。
 * `{surface:'sidebar'}` 查询结果 = 侧栏分组原样（线条目被过滤、空组下落）——
 * 与广播集合逐条一致（验收项 12②，同一 owner 派生不允许两个口径）；线条目按
 * createdAt 升序追加进所属 cwd 组（抽屉 flatten 后「最新线在末位」的 autoSelect
 * 语义与旧 btw.list 的 createdAt 升序一致）。
 */
import type { SessionGroup, SessionStatus, SessionSummary, SessionSurface } from '@taiji/shared'
import type { BtwLineRecord } from './btw-service.js'

/** `session.list` 请求的过滤参数（协议 SSOT = shared protocol.ts ClientMessageMap）。 */
export type SessionListQuery = {
  /** 展示归属过滤：'sidebar' = 侧栏口径（主会话）/ 'btw' = 抽屉线口径；缺省 = 不过滤（全量）。 */
  surface?: SessionSurface
  /** btw 线归属主会话过滤（只对 surface='btw' 条目有意义——侧栏条目无归属主会话）；缺省 = 不过滤。 */
  mainSessionId?: string
}

export interface SessionListQueryDeps { // oe-exempt:20261024:framework:DI 装配缝（窄注入 deps，与 SessionStateProjectionDeps 同款契约层单实现形态）
  /** 侧栏口径全量分组（scanner.listPersistedSessions——与 config.sessions 广播同源）。 */
  listSidebarGroups(): SessionGroup[]
  /** 全部 btw 线记录（btwService.listAllLines——registry 内存投影）。 */
  listBtwLines(): BtwLineRecord[]
  /** 线进程活跃判定（lifecycle 记录 isGenerating；未注册的冷线返回 undefined）。 */
  isLineGenerating?(sessionId: string): boolean | undefined
}

/** btw 线条目在 SessionSummary 上的 surface 值（合成侧写死，与注册表双写一致）。 */
const BTW_SURFACE: SessionSurface = 'btw'

export class SessionListQueryService {
  constructor(private readonly deps: SessionListQueryDeps) {}

  /**
   * 按过滤参数派生分组列表。无参 = 全量（侧栏条目 + 全部线条目，与 config.sessions
   * 查询侧同形——供抽屉/调试用）；调用侧按口径显式传参（搜索传 {surface:'sidebar'}、
   * 抽屉传 {surface:'btw', mainSessionId}，不依赖无参默认语义）。
   */
  list(query: SessionListQuery): SessionGroup[] {
    const sidebarEntries = flattenGroups(this.deps.listSidebarGroups())
    const lineEntries = this.synthesizeLines(query)

    // surface 过滤取正向谓词（未知/缺省 surface 的条目按 'sidebar' 归属——registerSession
    // 缺省即 'sidebar'、磁盘扫描条目显式缺省 'sidebar'，两路径恒有值；正向谓词保证
    // 未来新增枚举值不会泄漏进侧栏口径）。
    const wantSidebar = query.surface === undefined || query.surface === 'sidebar'
    const wantBtw = query.surface === undefined || query.surface === BTW_SURFACE

    const byCwd = new Map<string, SessionSummary[]>()
    const groupOrder: string[] = []
    const push = (s: SessionSummary): void => {
      const bucket = byCwd.get(s.cwd)
      if (bucket) bucket.push(s)
      else {
        byCwd.set(s.cwd, [s])
        groupOrder.push(s.cwd)
      }
    }
    // 侧栏条目先行（保持 scanner 分组原序——{surface:'sidebar'} 结果与广播逐条一致）
    if (wantSidebar) for (const s of sidebarEntries) push(s)
    // 线条目按 cwd 归组、组内 createdAt 升序（synthesizeLines 已排序）
    if (wantBtw) for (const s of lineEntries) push(s)

    return groupOrder.map((cwd) => ({ cwd, sessions: byCwd.get(cwd) as SessionSummary[] }))
  }

  /**
   * 线记录 → SessionSummary 合成（mainSessionId 过滤 + 按主会话分组编号 + 排序）。
   * 返回全部命中线的扁平列表（组内相对次序 = 全局 createdAt 升序）。
   */
  private synthesizeLines(query: SessionListQuery): SessionSummary[] {
    const lines = this.deps.listBtwLines()
    const filtered = query.mainSessionId === undefined
      ? lines
      : lines.filter((l) => l.mainSid === query.mainSessionId)
    if (filtered.length === 0) return []

    // 按主会话分组、组内 createdAt 升序 → 序号（同一主会话名下从 1 开始，跨主会话独立编号）
    const byMain = new Map<string, BtwLineRecord[]>()
    for (const line of filtered) {
      const bucket = byMain.get(line.mainSid)
      if (bucket) bucket.push(line)
      else byMain.set(line.mainSid, [line])
    }
    const out: SessionSummary[] = []
    for (const bucket of byMain.values()) {
      bucket.sort((a, b) => a.createdAt - b.createdAt)
      bucket.forEach((line, idx) => out.push(this.toLineSummary(line, idx + 1)))
    }
    // 全局按 createdAt 升序（多主会话共享 cwd 时组内次序稳定；抽屉 flatten 后最新线在末位）
    out.sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    return out
  }

  private toLineSummary(line: BtwLineRecord, seq: number): SessionSummary {
    const generating = this.deps.isLineGenerating?.(line.piSessionId) === true
    const status: SessionStatus = generating ? 'active' : 'idle'
    return {
      id: line.piSessionId,
      // §3.4.3 label 重定义：可区分形态（btw-<序号>）替代 basename(cwd) 全部同名
      label: `btw-${seq}`,
      cwd: line.cwd,
      status,
      lastActiveAt: line.createdAt,
      // 展示归属恒为抽屉（注册表 surface 事实的投影）。不写 hidden——W3 双写期的
      // hidden 字段随 W5 退役，新合成代码以 surface 为唯一判别口径。
      surface: BTW_SURFACE,
      sessionFile: line.sessionFilePath,
    }
  }
}

/** 分组 → 扁平条目（保序：组序 + 组内序原样）。 */
function flattenGroups(groups: SessionGroup[]): SessionSummary[] {
  const out: SessionSummary[] = []
  for (const g of groups) for (const s of g.sessions) out.push(s)
  return out
}
