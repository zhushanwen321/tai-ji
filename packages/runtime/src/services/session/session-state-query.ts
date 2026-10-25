/**
 * SessionStateQuery —— 按会话 id 的权威状态查询薄服务（会话架构四层分离 W2，
 * 设计 §3.3.3「W2 新建薄查询服务，不复用 ReplicatedState」）。
 *
 * 定位：`session.getState { sessionId }` RPC 的唯一后端。活/冷会话同一入口（设计 §2.4
 * I6 的准确表述 = modelId / thinkingLevel 两维冷热同入口；冷会话 usage / commands
 * 恒为显式未知，见设计 §3.2 过渡形态声明）。
 *
 * **为什么是薄服务、不塞进 ReplicatedState 实例组**（设计 §3.3.3 三条硬理由）：
 * 1. 双源违反 `fetchSnapshot` 单一权威源不变量（ReplicatedState 的 config 只有一个
 *    fetch 来源；硬塞要在 fetch 里做 `if (client) … else …`，且 fetch 抛错语义会把
 *    「冷会话」误报成「拉取失败」）；
 * 2. 冷会话没有失效事件源（无 pi 进程即无事件，只能靠轮询或永久 dirty）；
 * 3. 实例生命周期绑定 session 注册（registerReplicatedStates 只在 onSessionRegistered
 *    调），冷会话从未注册 → 无 `.get()` 可读。
 *
 * **无定时器 / 无 dirty / 不 spawn**：本服务只读——读活跃实例快照或读会话文件，
 * 不注册 ReplicatedState、不起防抖/退避定时器、不创建 pi 进程。
 *
 * 三个 spawn 风险点的实现约定（设计 §3.3.3，逐条落在 deps 契约上）：
 * - 风险点 1：`getClient` 是唯一活跃判定入口——**禁 `ensureActive`**（它对 btw 线转
 *   `ensureProcess`、对主会话转 `ensureRestored` → `restoreSession` → spawn）。
 * - 风险点 2：live 分支只读实例快照；快照 `undefined` = 未就绪（播种 refetch 异步竞速 /
 *   失败退避窗口内），**不得触发 restore**，字段缺省即缺省返回。
 * - 风险点 3：filePath 只准来自主会话两段扫描（`findCachedSessionFileById` /
 *   `findScannedSessionFileById`）或 btw 线的注册表记录 / 存储树布局定位
 *   （`findBtwLineFileByLayout`）——**禁 `withEphemeralPi`**（它会 spawn 短命 pi）。
 *
 * 冷路径埋点（设计 §3.1「可观测」栏，四要素重审触发的数据来源）：单次耗时 + 扫描目录数，
 * 经 `onColdRead` 回调透出（组合根注入 logger；测试注入 recorder 断言）。
 */
import type { ServerMessageMap } from '@taiji/shared'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { ReplicatedState } from './replicated-state.js'
import type { ModelIdSnapshot, ThinkingLevelSnapshot } from './replicated-states.config.js'
import type { BtwLineLayoutLocateResult, MainSessionScanLocateResult } from '../../infra/pi/session-file-locator.js'
import { extractLatestModelFromJsonl } from '../../infra/pi/session-file-utils.js'
import { SESSION_NOT_FOUND } from '../../utils/errors.js'

/** `session.getState` 的 reply payload（协议 SSOT = shared ServerMessageMapBase）。 */
export type SessionStateReply = ServerMessageMap['session.getState']

/**
 * live 实例快照窄视图：只取 modelId / thinkingLevel 两个标量实例。
 *
 * 窄化（而非直接用 `SessionReplicatedStates`）有两个理由：① getState 的协议面只有这两维
 * （冷会话 usage / commands 恒显式未知，设计 §3.2），窄视图让契约与协议面对齐；② 避开
 * 本模块 → session-state-projection 的类型 import（那边 value import 本模块，构成
 * type-only 环）——`ReplicatedState` 与两个 snapshot 类型所在模块无反向依赖。
 */
export type SessionStateLiveStates = {
  modelId: ReplicatedState<ModelIdSnapshot>
  thinkingLevel: ReplicatedState<ThinkingLevelSnapshot>
}

/**
 * 冷读一次定位的结果来源（埋点 `source` 字段值域）：
 * - `meta-cache`：段 1 命中 sessionMetaCache 全表遍历，未发生磁盘扫描；
 * - `disk-scan`：段 1 未命中，走了 `scanPiSessions({ force: true })` 全扫；
 * - `btw-registry`：btw 线经注册表记录的 sessionFilePath（或存储树布局定位兜底）。
 */
export type SessionStateColdSource = 'meta-cache' | 'disk-scan' | 'btw-registry'

/** 冷路径埋点记录（设计 §3.1 四要素的「量级 / 调用频度」取数来源）。 */
export type SessionStateColdReadTrace = {
  sessionId: string
  /** 定位来源（区分「本次未扫」与「本次扫了 N 个目录」） */
  source: SessionStateColdSource
  /** 单次冷读耗时（毫秒；含定位 + JSONL 解析） */
  durationMs: number
  /** 本次冷读触发的磁盘枚举目录数（0 = 未枚举；= 段 2 全扫的 cwd 分组目录数 + btw 布局兜底枚举的 mainSid 目录数） */
  scannedDirCount: number
  /** 是否定位到会话文件（false = 走 SESSION_NOT_FOUND） */
  found: boolean
}

/** SessionStateQuery 装配依赖（窄注入；全部是只读函数，无状态耦合）。 */
export interface SessionStateQueryDeps { // oe-exempt:20261024:framework:DI 装配缝（窄注入 deps，与 SessionStateProjectionDeps 同款契约层单实现形态）
  /**
   * 活跃 client 读口（spawn 风险点 1：只准 getClient，禁 ensureActive/ensureProcess）。
   * 生产注入 `IProcessManager.getClient`。
   */
  getClient(sessionId: string): IPiEngine | undefined
  /**
   * live 实例快照读口（spawn 风险点 2：undefined = 未就绪，禁触发 restore）。
   * 生产注入 `SessionStateProjection.getReplicatedStates`（其返回的
   * `SessionReplicatedStates` 结构上满足本窄视图）。
   */
  getReplicatedStates(sessionId: string): SessionStateLiveStates | undefined
  /**
   * 主会话冷读段 1：sessionMetaCache 全表遍历按 meta.id 匹配（零 IO）。
   * 生产注入 `findCachedSessionFileById`。
   */
  locateMainSessionFileFromCache(sessionId: string): string | undefined
  /**
   * 主会话冷读段 2：`scanPiSessions({ force: true })` 全扫（目录枚举 + stat + 解析）。
   * 生产注入 `findScannedSessionFileById`。
   *
   * 返回 filePath + 本轮全扫的 cwd 分组目录数——与 `locateBtwLineFileByLayout` 同构：
   * 段 2 枚举是 O(cwd 分组数) 的磁盘成本，计数经返回值进冷读埋点 `scannedDirCount`
   * （services 层不反向探 infra 模块级 `sessionScanDirCount`，只经注入缝单向流动）。
   */
  locateMainSessionFileFromDisk(sessionId: string): MainSessionScanLocateResult
  /**
   * btw 线注册表记录定位（lifecycle 判别，廉价内存读）。生产注入
   * `(sessionId) => getSession(sessionId)?.surface === 'btw' ? rec.sessionFilePath : undefined`
   * （= `BtwLineRecord.sessionFilePath` 在 lifecycle 记录上的镜像）。
   *
   * W4a 后本注入兼作「是否 btw 线」的成员查询判别器（键 = 线 session id = piSessionId；
   * 旧 isBtwVirtualId 前缀判别对 piId 形态恒 false，随键切换同批替换）。
   *
   * 判别顺序（dmg-r1-3）：本注入是冷读的**第一步**（纯内存、无磁盘枚举）——命中即
   * btw 线分叉（E-5：线文件在 ext-sessions 树，scanPiSessions 扫描范围构造性不含）；
   * 未命中（主会话 / 未注册 id）走主会话两段，两段均未命中才由
   * `locateBtwLineFileByLayout` 做存储树布局兜底。布局枚举不在本注入内——否则冷
   * 主会话每次都要先付整棵存储树枚举。
   */
  locateBtwLineFile(sessionId: string): string | undefined
  /**
   * btw 线存储树布局定位兜底（段 1 / 段 2 均未命中后才调）。生产注入
   * `findBtwLineFileByLayout`。
   *
   * btw 线文件在 `<dataDir>/ext-sessions/<mainSid>/btw/`，**构造性不在 scanPiSessions
   * 与 sessionMetaCache 范围**（设计 §1.5 E-5），故不能走段 1/段 2；也正因如此，
   * 把它放在两段之后不改变结果（两段 miss 后兜底寻址与旧「先行判别」顺序等价）。
   * 重启后的线不在 lifecycle.sessions（`BtwService.rebuildFromDisk()` 只重建
   * BtwService.registry，不注册进 lifecycle.sessions），该情形只有本兜底能寻址。
   *
   * 返回 filePath + 本轮枚举的 mainSid 目录数——布局枚举是 O(会话数) 的磁盘成本，
   * 必须进冷读埋点的 `scannedDirCount`（设计 §3.1 四要素重审的判据取数来源）。
   */
  locateBtwLineFileByLayout(sessionId: string): BtwLineLayoutLocateResult
  /** 冷路径埋点回调（生产注入 runtime logger；缺省 = 不埋点）。 */
  onColdRead?(trace: SessionStateColdReadTrace): void
  /** 时钟（测试注入确定性时钟；缺省 Date.now）。 */
  now?(): number
}

/** 结构化「会话不存在」错误（renderer 按 code 分流，不返回空对象伪装成功——设计 §3.2）。 */
export class SessionNotFoundError extends Error {
  readonly code = SESSION_NOT_FOUND
  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

/**
 * 进程内活跃的 SessionStateQuery 实例绑定槽（SessionStateProjection 构造期绑定；
 * transport 的 session-message-handler 经 `getSessionStateQuery()` 读）。
 *
 * 单例语义依据 = 进程内单 SessionService / 单 SessionStateProjection（runtime 组合根
 * 一次装配）。为什么不像其他 service 那样经组合根显式注入：查询服务的构造依赖
 * （pm + replicated states）全在 projection 内部，而投影实例是 Facade 私有域、不对
 * transport 暴露——模块槽是「构造点与消费点隔一层私有域」时的既有解法（先例 =
 * `getCrashJournal` / `setBtwCascadeOps`）。
 */
let activeQuery: SessionStateQuery | undefined

export function bindSessionStateQuery(query: SessionStateQuery): void {
  activeQuery = query
}

export function getSessionStateQuery(): SessionStateQuery | undefined {
  return activeQuery
}

/** 测试隔离：解绑进程实例（与其他 *_ForTest 复位同模式）。 */
export function _resetSessionStateQueryForTest(): void {
  activeQuery = undefined
}

export class SessionStateQuery {
  constructor(private readonly deps: SessionStateQueryDeps) {}

  /**
   * 查询会话状态（活/冷同一入口，设计 §3.3.3 实现形态）：
   * ```
   * if (getClient(id) && getReplicatedStates(id)) return fromSnapshots(...)  // 字段可能缺省
   * const file = locateFile(id)                    // 定位支按下述顺序
   * if (!file) throw SESSION_NOT_FOUND
   * return fromFile(extractLatestModelFromJsonl(file))
   * ```
   *
   * 活会话分支读实例快照（与 `session.state_changed` 同一数据源，设计 §7 验收项 8 的
   * 「三源同一 reducer」前提）；冷会话分支读会话文件（与侧栏扫描同源同函数，设计 §3.3.2）。
   *
   * 冷读定位顺序（dmg-r1-3，判别成本从低到高）：
   * 1. `locateBtwLineFile`——lifecycle `surface==='btw'` 注册表判别（纯内存）；
   * 2. 段 1 `locateMainSessionFileFromCache`——sessionMetaCache 全表遍历（零 IO）；
   * 3. 段 2 `locateMainSessionFileFromDisk`——`scanPiSessions({ force: true })` 全扫；
   * 4. `locateBtwLineFileByLayout`——btw 存储树布局兜底（两段均未命中才枚举）。
   *
   * 为何布局兜底沉到第 4 步：它是对整棵存储树的 O(会话数) 枚举，放在最前会让**每个冷
   * 主会话**都先付这笔成本（而主会话占冷读的绝大多数）；btw 线构造性不在段 1/段 2 的
   * 扫描范围，两段 miss 后兜底寻址结果与旧顺序不变（重启后的线只有本支能寻址）。
   */
  async getState(sessionId: string): Promise<SessionStateReply> {
    // ── live 分支：只读实例快照（风险点 1/2）──
    const liveClient = this.deps.getClient(sessionId)
    if (liveClient !== undefined) {
      const states = this.deps.getReplicatedStates(sessionId)
      if (states !== undefined) {
        return {
          sessionId,
          modelId: states.modelId.get()?.modelId,
          thinkingLevel: states.thinkingLevel.get()?.thinkingLevel,
        }
      }
    }

    // ── 冷分支：注册表判别 → 主会话两段 → btw 布局兜底 + extractLatestModelFromJsonl ──
    const startedAt = (this.deps.now ?? Date.now)()
    let filePath: string | undefined
    let source: SessionStateColdSource
    let scannedDirCount = 0
    // ① btw 注册表判别（lifecycle surface==='btw' 记录的 sessionFilePath；廉价内存读，
    //    无磁盘枚举）。命中即 btw 线分叉（E-5：线文件在 ext-sessions 树，scanPiSessions
    //    扫描范围构造性不含）；未命中（主会话 / 未注册 id）走主会话两段。
    filePath = this.deps.locateBtwLineFile(sessionId)
    if (filePath !== undefined) {
      source = 'btw-registry'
    } else {
      // ② 主会话分叉：段 1 缓存全表遍历（零 IO）→ 段 2 force 全扫
      filePath = this.deps.locateMainSessionFileFromCache(sessionId)
      source = 'meta-cache'
      if (filePath === undefined) {
        const scanned = this.deps.locateMainSessionFileFromDisk(sessionId)
        filePath = scanned.filePath
        source = 'disk-scan'
        scannedDirCount += scanned.scannedDirCount
      }
      // ③ btw 布局兜底：两段均未命中才枚举存储树（btw 线构造性不在两段扫描范围，
      //    此时兜底结果不变；重启后的线只有本支能寻址）。枚举目录数进埋点。
      if (filePath === undefined) {
        const layout = this.deps.locateBtwLineFileByLayout(sessionId)
        scannedDirCount += layout.scannedDirCount
        if (layout.filePath !== undefined) {
          filePath = layout.filePath
          source = 'btw-registry'
        }
      }
    }

    if (filePath === undefined) {
      // 注册表/两段/布局兜底都未命中：会话不存在 / 文件未落盘（pi 延迟写入窗口）/ 已被清理
      this.emitColdRead(sessionId, source, startedAt, false, scannedDirCount)
      throw new SessionNotFoundError(sessionId)
    }
    // 文件在但读不出模型信息（空文件 / 全损坏 / 活跃路径上无 model_change 与 assistant
    // entry）= 显式未知（字段缺省），不猜、不用其他会话的值兜底（ADR-0122）。
    const extracted = extractLatestModelFromJsonl(filePath)
    this.emitColdRead(sessionId, source, startedAt, true, scannedDirCount)
    return extracted === undefined
      ? { sessionId }
      : { sessionId, modelId: extracted.modelId, thinkingLevel: extracted.thinkingLevel }
  }

  /** 冷路径埋点发射（缺省回调 = 不埋点；耗时含定位 + JSONL 解析两段）。 */
  private emitColdRead(
    sessionId: string,
    source: SessionStateColdSource,
    startedAt: number,
    found: boolean,
    scannedDirCount: number,
  ): void {
    if (!this.deps.onColdRead) return
    this.deps.onColdRead({
      sessionId,
      source,
      durationMs: (this.deps.now ?? Date.now)() - startedAt,
      // 本次冷读触发的磁盘枚举目录数（0 = 未枚举）：段 2 全扫的 cwd 分组目录数 +
      // btw 布局兜底枚举的 mainSid 目录数（布局兜底成本必须可观测——设计 §3.1 四要素）
      scannedDirCount,
      found,
    })
  }
}
