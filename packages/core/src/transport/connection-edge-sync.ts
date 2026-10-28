/**
 * connection-edge-sync —— 连接边沿统一域同步器（connection-datasync-ssot §6.4）。
 *
 * 职责：连接边沿（首次认证成功、每次重连认证成功）触发登记域的同步函数，替代
 * 「initApp 一次性编排 + 重连分支逐域手写刷新」的两套编排。登记分两层：
 * - **数据域**（有加载语义，如 project/sessions/workspace）：登记 {同步函数, 何时需要
 *   同步, 失败语义}；每域暴露**首次落定 promise**（= 该域同步函数首次调用的 settle，
 *   成功与失败均算落定；重连边沿的后续同步不改变已落定的 promise），启动编排经
 *   whenSettled 消费（如 initApp 等 project 域落定后进落地页）。
 * - **辅助刷新**（重连分支的零散刷新，如 extension 扫描 / 聚焦 session 的 subagent 与
 *   workflow 列表 / liveState / 对话流历史）：纳入统一触发点，各自保留现有 catch 降级
 *   语义（fire-and-forget，不参与落定与代次）。
 *
 * 机制约束（§6.4）：
 * - **并发合流 + trailing 补拉**：同一数据域同一时刻最多一个在途加载，进行中再次触发
 *   不重复发、但登记域级 trailing 标志，在途回执成功落定后补拉一轮收敛（多窗口失效
 *   信号形态：project.changed 在消费方 load 在途窗口被合流跳过后，在途回执可能是
 *   命令执行前旧快照——revision 等于发起时基线，交错判旧不命中——无补拉则停留陈旧
 *   数据且信号已消费、无自愈）——在途登记收编于 createInflightDedup 共享原语
 *   （C-data-18 禁手写 Map+settle 清理同构实现；每域固定 key 的单键退化形态，meta
 *   携带发起时刻连接代供回执判旧）。
 * - **仅最新代提交**：每次尝试携带连接代（实装为 connected 边沿的全局单调计数，与
 *   「实例标识+尝试序」在判旧语义上等价——实例变更与重连必经断连→connected 边沿，
 *   generation 随边沿递增，故「不同实例」必然「不同代」；回执仅携带 generation 数字），
 *   回执到达时仅最新代的尝试可提交，旧代回执丢弃并在丢弃点补发一轮（合流保证补发前
 *   无在途，收敛且任一时刻至多一个在途）。
 * - **命令×同步交错规则**（project 域）：project 域两类回执（load 快照、命令新状态）
 *   均携带 revision——在途同步回执到达时若其携带的 revision 早于 store 已提交的最新
 *   revision（期间有命令回执提交），按过时内容丢弃（与旧代回执同处置），并在丢弃点
 *   自动补发一轮该域同步。否则旧快照会提交回滚命令结果（重拉子形态编辑入口放行的
 *   窗口内，命令回执先于在途 load 回执到达）。判据 isStaleReceipt 由 store 提供
 *   （知识与决策同地：revision 状态在 store），机制在本模块。判旧资格以本轮同步发起
 *   时水位为基线（store 侧承载）：低于基线的回执是服务端回退形态（runtime 崩溃重启
 *   revision 回退），不判旧照常提交——否则幻影水位恒丢弃 + 无限补发，与命令通道
 *   revision 校验恒拒形成双通道死锁。
 *
 * 提交形态两态（descriptor.apply 可选）：
 * - **拦截型**（apply 提供）：sync 只拉取返回回执，apply 由本模块在代次/revision 裁决
 *   通过后调用——「失败保留旧值」「旧代不提交」构造性成立（不调 apply 即保留）。
 * - **一体式**（apply 省略）：sync 自含提交（如 store 的 init/load 函数），本模块的
 *   裁决控制「丢弃 + 丢弃点补发」，保证最终一致（旧代回执后被补发轮回执覆盖）。
 *   接入侧从一体式演进到拦截型不需要改本模块。
 *
 * 边沿源：模块级 watch ws-client 的 connected 迁移（首次与重连同一路径，差异只在各域
 * 的 whenToSync 判定）。notifyConnectedEdge 是边沿事件的显式入口（watch 回调与测试
 * 直驱同一入口），requestDomainSync 是域级编程触发入口（project.changed 广播的消费
 * 通道，§6.6「各窗口收到后触发该域重新拉取」）。
 *
 * 依赖方向：ws-client（边沿源）+ vue（watch）。零 DOM / 零 store import（headless，
 * 域 sync 函数由壳层登记时闭包提供）。
 */
import { watch } from 'vue'
import { createInflightDedup, type InflightDedup } from '../foundation/create-inflight-dedup'
import { getState } from './ws-client'

// ── 登记接口 ────────────────────────────────────────────────────────

/** 域失败语义三型（§6.4）：呈现差异（状态条/重试/静默）由 sync 实现内部承载，本模块按型分级留痕。 */
export type DomainSyncFailure = 'blocking' | 'retryable' | 'degraded'

/** 连接边沿上下文（whenToSync 判定输入）。 */
export interface ConnectionEdgeContext { // oe-exempt:20261027:framework:设计 §6.4 域同步器机制契约（ADR-0097 方向），renderer 域按描述符注册接入，接口先立单实现常态
  /** 连接代（从 1 递增；实例变更/重连边沿必递增——判旧依据） */
  generation: number
}

/**
 * 数据域登记描述符。
 *
 * 类型参数 T = sync 回执形态（拦截型即 apply 的入参）。
 */
export interface DataDomainDescriptor<T = unknown> { // oe-exempt:20261027:framework:设计 §6.4 域同步器登记契约，三数据域（project/sessions/workspace）按此注册，多实现随域接入
  /** 域 id（登记幂等键，如 'project' / 'sessions' / 'workspace'） */
  id: string
  /**
   * 同步函数（拉取语义）。拦截型下只拉取返回回执（不发提交副作用）；一体式下自含
   * 提交（如 store 的 init/load）。失败语义由 failure 声明、呈现由实现内部承载。
   */
  sync: () => Promise<T>
  /**
   * 提交函数（拦截型可选）：把回执写入该域 store。仅在连接代与 isStaleReceipt 两道
   * 裁决通过后被调用——「失败保留旧值」「旧代回执不提交」构造性成立。省略 = 一体式
   * （sync 自含提交，本模块裁决控制丢弃+补发收敛）。
   */
  apply?: (receipt: T) => void
  /**
   * 何时需要同步（每次连接边沿逐域判定）。当前三域语义（§6.4）：project 在 failed、
   * 实例变更、任何重连边沿都重拉；sessions/workspace 每次连接边沿重拉——failed 恢复
   * 与实例变更必经连接边沿，「任何边沿重拉」即全量覆盖，故均登记恒真谓词；谓词接口
   * 为「仅在特定边沿同步」的域（如只须实例变更重拉）保留判定空间。
   */
  whenToSync: (edge: ConnectionEdgeContext) => boolean
  /** 失败语义（留痕分级：blocking/retryable 走 error 出声，degraded 走 warn 留痕） */
  failure: DomainSyncFailure
  /**
   * 命令×同步交错判据（§6.4 project 域，可选）：返回 true = 回执携带的 revision 早于
   * store 已提交的最新 revision（期间有命令回执提交）→ 按过时内容丢弃 + 丢弃点补发。
   * 省略 = 该域无写命令（sessions/workspace），跳过交错裁决。
   */
  isStaleReceipt?: (receipt: T) => boolean
}

/** 辅助刷新登记描述符（fire-and-forget；各自保留现有 catch 降级语义）。 */
export interface AuxiliaryRefreshDescriptor { // oe-exempt:20261027:framework:设计 §6.4 辅助刷新登记契约，5 处刷新按此注册，多实现随接入增长
  /** 幂等键（如 'extension-scan'） */
  label: string
  /**
   * 刷新动作（连接边沿触发时调用）。内部自带 catch 降级（与现状重连分支逐处 catch
   * 一致）；本模块对返回的 promise 再兜底 catch，防未捕获 rejection。
   */
  refresh: () => unknown
}

// ── 模块级状态 ──────────────────────────────────────────────────────

interface DomainRuntime { // oe-exempt:20261027:framework:域登记运行时条目（descriptor+在途去重表），与登记契约同族机制形态
  descriptor: DataDomainDescriptor
  /** 域级 in-flight 去重表（单键退化形态；并发合流判据 = 有无在途条目） */
  readonly inflight: InflightDedup<unknown, SyncInflightMeta>
  /** 首轮尝试是否已发起（首次落定 promise 只绑定首轮） */
  firstAttemptStarted: boolean
  /** 首次落定 promise（成功与失败均落定；后续边沿的同步不改变它） */
  readonly firstSettle: Promise<void>
  readonly firstSettleResolve: () => void
}

/** 在途条目元数据：发起时刻的连接代（回执判旧的比对基线；发起后连接代推进 = 旧代回执）。 */
interface SyncInflightMeta {
  generation: number
}

/** 每域固定单键（全局唯一 in-flight 变量的退化形态）：同域至多一个在途槽。 */
const SYNC_INFLIGHT_KEY = 'sync'

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：域同步器登记表——
// 数据域描述符 + 首次落定簿记（运行时装配状态，壳层 useSidebar 装配段单写点，非任何 GUI
// 数据本体；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const domains = new Map<string, DomainRuntime>()
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：辅助刷新登记表（同上，
// 壳层装配段单写点；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const auxiliary = new Map<string, AuxiliaryRefreshDescriptor>()
/** 连接代计数（全局单调；边沿递增，实例变更/重连必经边沿 → 「不同实例必不同代」） */
let connectionGeneration = 0
/** connected 边沿 watch 的取消函数（非空 = 已安装；resetForTest 时拆卸） */
let stopEdgeWatch: (() => void) | null = null
/**
 * 域级 trailing 补拉登记（dmg-r3-1）：在途期触达被合流跳过时置位（domain id 集合
 * 成员资格，多次触发合并为一次补拉），在途回执成功落定后据此补发一轮。不用
 * createInflightDedup({trailing:true}) 工厂选项承载：工厂 trailing 要求在途期触达
 * 走 run 复用 entry，与 attemptSync 的 has→return 纯跳过契约冲突（见其注释）。
 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：域同步器 trailing
// 补拉标志（域同步器登记表同族机制形态的瞬时协调状态；登记见
// docs/architecture/data-source-registry.md §4 ⑧）
const trailingSyncRequested = new Set<string>()

/**
 * 幂等登记数据域。同 id 重复登记用最新描述符（壳层多次装配 / HMR 重载闭包刷新），
 * 同步进度（在途/首轮落定状态）保留不受影响。
 */
export function registerDataDomain<T>(descriptor: DataDomainDescriptor<T>): void {
  const existing = domains.get(descriptor.id)
  if (existing) {
    existing.descriptor = descriptor as DataDomainDescriptor
    return
  }
  let firstSettleResolve!: () => void
  const firstSettle = new Promise<void>((resolve) => {
    firstSettleResolve = resolve
  })
  domains.set(descriptor.id, {
    descriptor: descriptor as DataDomainDescriptor,
    inflight: createInflightDedup<unknown, SyncInflightMeta>(),
    firstAttemptStarted: false,
    firstSettle,
    firstSettleResolve,
  })
}

/** 幂等登记辅助刷新。同 label 重复登记用最新描述符（闭包刷新），语义同 registerDataDomain。 */
export function registerAuxiliaryRefresh(descriptor: AuxiliaryRefreshDescriptor): void {
  auxiliary.set(descriptor.label, descriptor)
}

// ── 同步尝试（合流 + 仅最新代提交 + 交错裁决的唯一执行体）──────────────────

/**
 * 发起一轮同步尝试（并发合流：同域在途不重复发——新边沿/失效信号在在途期触达同域时
 * 登记 trailing 标志后跳过；在途回执按代次/revision 判旧后于丢弃点补发、成功落定后按
 * trailing 标志补拉，收敛且任一时刻至多一个在途）。
 *
 * 在途登记收编于 createInflightDedup（C-data-18）：has→run 仅在无在途时登记消费侧
 * then（在途期的触达为纯跳过——不重复挂接消费回调，避免同回执多次 apply/补发/失败
 * 留痕；trailing 诉求因此不走工厂选项形态，改由模块级标志承载，回执 then 成功路径
 * 末尾检查补发）；factory 的 settle 清理先于本 then 执行（时序契约），故 then 内的
 * 补发 run 必发起新一轮。meta 携带发起时刻连接代（收编前闭包变量形态，语义等价）。
 */
function attemptSync(domain: DomainRuntime, generation: number): void {
  if (domain.inflight.has(SYNC_INFLIGHT_KEY)) {
    // 在途期触达登记 trailing 补拉（dmg-r3-1）：触达可能是失效信号（project.changed
    // 广播的消费）——多窗口形态下他窗口命令不推进本窗口 revision，本轮回执若是命令
    // 执行前旧快照（revision 等于发起时基线），双判旧均不命中、apply 后停留陈旧数据
    // 且信号已消费无自愈；标志保证回执成功落定后补拉一轮收敛到最新。
    trailingSyncRequested.add(domain.descriptor.id)
    return
  }
  const isFirstAttempt = !domain.firstAttemptStarted
  domain.firstAttemptStarted = true
  const entry = domain.inflight.run(SYNC_INFLIGHT_KEY, () => domain.descriptor.sync(), {
    generation,
  })
  entry.promise.then(
    (receipt) => {
      if (isFirstAttempt) domain.firstSettleResolve()
      // 仅最新代提交：旧连接代回执丢弃（generation 单调，实例变更/重连边沿推进后
      // 旧代回执不再具备提交资格）。isFirstAttempt 场景首轮即最新代，恒不命中。
      const staleByGeneration = entry.meta.generation < connectionGeneration
      // 命令×同步交错（§6.4）：回执 revision 早于 store 已提交的最新 revision = 期间
      // 有命令回执提交，按过时内容丢弃——否则旧快照提交回滚命令结果。
      const staleByRevision = domain.descriptor.isStaleReceipt?.(receipt) ?? false
      if (staleByGeneration || staleByRevision) {
        // 判旧丢弃留痕（可观测性）：无日志时丢弃-补发循环不可见——正常交错一轮补发即
        // 收敛，若持续出现 staleByRevision 丢弃日志 = store 判旧资格基线失效的排障线索
        // （判据资格由 store 侧 isStaleReceipt 承载，见 stores/project.ts syncStartRevision）。
        console.warn(
          `[core/connection-edge-sync] domain '${domain.descriptor.id}' receipt discarded as ${staleByGeneration ? `outdated generation ${entry.meta.generation} < ${connectionGeneration}` : 'stale revision (older than committed baseline)'} — resyncing`,
        )
        // 丢弃点补发（携带最新连接代；合流保证补发前无在途——断连恢复的刷新诉求由
        // 补发轮达成，任一时刻至多一个在途的不变量保持）。一体式 sync 侧若持有自身
        // 在途状态机（如 project 加载状态机的 loading）：回执判旧丢弃不经 store，在途
        // 状态残留由 sync 侧在下一轮入口自行收尾（本模块在丢弃点立即补发，补发轮对
        // sync 的调用即触发收尾）——store 侧不收尾则补发轮撞在途守卫被拒，该域重拉
        // 能力永久失效（F1-27 死锁形态，收尾实装见 stores/project.ts syncLoad）。
        // 在途期触达登记的 trailing 诉求已由本补发轮覆盖（补发即「回执落定后再拉一轮
        // 最新代」形态）——清除标志防补发轮回执 apply 后再叠一轮冗余拉取。
        trailingSyncRequested.delete(domain.descriptor.id)
        attemptSync(domain, connectionGeneration)
        return
      }
      domain.descriptor.apply?.(receipt)
      // trailing 补拉（dmg-r3-1）：在途期有触达被合流跳过（标志置位）→ 回执成功落定
      // 后补发一轮（与判旧丢弃点补发同一入口；factory 的 settle 清理先于本 then 执行，
      // 此刻无在途，任一时刻至多一个在途的不变量保持）。本轮回执可能是触达所反应变更
      // 之前的旧快照（双判旧不命中形态，见入口置位处注释），补拉轮携带最新水位判旧/
      // 提交收敛到最新。
      if (trailingSyncRequested.delete(domain.descriptor.id)) {
        attemptSync(domain, connectionGeneration)
      }
    },
    (error: unknown) => {
      if (isFirstAttempt) domain.firstSettleResolve()
      // 失败不补发：重试通道 = 下一连接边沿（whenToSync 判定）或 store 的手动重试，
      // 不在本模块内建自动重试（事实驱动原则：失败显式上报，不时间推测兜底）。trailing
      // 标志一并清除：其兑现点是在途回执的成功落定，失败后由失败语义（边沿/手动重试，
      // 届时拉取必为最新）承载，残留标志只会在后续无关轮次成功后叠一轮冗余拉取。
      trailingSyncRequested.delete(domain.descriptor.id)
      if (domain.descriptor.failure === 'degraded') {
        console.warn(
          `[core/connection-edge-sync] domain '${domain.descriptor.id}' sync failed (degraded, keeping previous data):`,
          error,
        )
      } else {
        console.error(
          `[core/connection-edge-sync] domain '${domain.descriptor.id}' sync failed (${domain.descriptor.failure}):`,
          error,
        )
      }
    },
  )
}

/**
 * 每域首次落定 promise：该域同步函数首次调用的 settle（成功与失败均算落定）。
 * 首轮尚未发起时由此处 ensure 发起（调用即驱动首轮——启动编排先于边沿 watch 消费时
 * 不死等，序收敛：边沿先到则此处只等待在途首轮）。
 *
 * 未登记 id 抛错（fail-fast）：启动编排对域落定的依赖是装配契约，登记缺失 = 装配
 * 错误，静默等待会以「永不进落地页」的挂死形态掩盖。
 */
export function whenSettled(id: string): Promise<void> {
  const domain = domains.get(id)
  if (!domain) {
    throw new Error(
      `[core/connection-edge-sync] whenSettled('${id}'): domain not registered — registerDataDomain() must run before awaiting first settle`,
    )
  }
  if (!domain.firstAttemptStarted) attemptSync(domain, connectionGeneration)
  return domain.firstSettle
}

/**
 * 域级编程触发入口（project.changed 广播的消费通道，§6.6「事件只作失效信号——各窗口
 * 收到后触发该域重新拉取」）：合流/代次/交错裁决与边沿触发的同步尝试同一条路径。
 * 未登记 id warn 不抛（事件消费路径，装配缺失留痕排障）。
 */
export function requestDomainSync(id: string): void {
  const domain = domains.get(id)
  if (!domain) {
    console.warn(`[core/connection-edge-sync] requestDomainSync('${id}'): domain not registered`)
    return
  }
  attemptSync(domain, connectionGeneration)
}

// ── 连接边沿 ────────────────────────────────────────────────────────

/**
 * 连接边沿事件入口：推进连接代 + 触发全部登记域与辅助刷新。生产由 connected 迁移
 * watch 调用（ensureConnectionEdgeSync 安装），测试可编程直驱同一入口（首连与重连
 * 同一路径，无分支）。
 */
export function notifyConnectedEdge(): void {
  connectionGeneration++
  const edge: ConnectionEdgeContext = { generation: connectionGeneration }
  for (const domain of domains.values()) {
    if (!domain.descriptor.whenToSync(edge)) continue
    attemptSync(domain, connectionGeneration)
  }
  for (const descriptor of auxiliary.values()) {
    try {
      // refresh 自带 catch 降级（现状重连分支逐处 catch 语义保留）；此处对返回 promise
      // 兜底 catch，防登记方遗漏时 unhandled rejection。
      void Promise.resolve(descriptor.refresh()).catch((e: unknown) => {
        console.warn(`[core/connection-edge-sync] auxiliary refresh '${descriptor.label}' failed:`, e)
      })
    } catch (e) {
      // 降级策略（best-effort）：辅助刷新失败留痕即止——各刷新自带 catch 降级语义，同步
      // 抛错兜到此处同样只 warn 不阻断（不中断同批其余域与辅助刷新的边沿触发）。
      console.warn(`[core/connection-edge-sync] auxiliary refresh '${descriptor.label}' failed:`, e)
    }
  }
}

/**
 * 幂等安装 connected 边沿 watch（connected false→true 迁移 = 首次认证成功与每次重连
 * 认证成功的统一边沿，§6.4）。壳层装配点（域登记处）调用。
 */
export function ensureConnectionEdgeSync(): void {
  if (stopEdgeWatch) return
  stopEdgeWatch = watch(getState(), (next, prev) => {
    if (next === 'connected' && prev !== 'connected') notifyConnectedEdge()
  })
}

/** 测试隔离：拆卸边沿 watch + 清空全部登记与代次状态（对齐 useSidebar resetAppBootstrap 体例）。 */
export function resetConnectionEdgeSyncForTest(): void {
  stopEdgeWatch?.()
  stopEdgeWatch = null
  domains.clear()
  auxiliary.clear()
  trailingSyncRequested.clear()
  connectionGeneration = 0
}
