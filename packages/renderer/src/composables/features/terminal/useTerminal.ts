/**
 * useTerminal —— drawer 集成终端的 per-instance 状态 + PTY 控制（Phase 3 / 多实例 u2）。
 *
 * 主键迁移（terminal-multi-instance 设计 §2.2 四层锚点 / §3.3）：本模块三张表（输出缓冲 /
 * 广播订阅 / flush 监听）与订阅表全部从**会话 id** 迁移到**实例编号** `term:<sid>:<序号>`；
 * 实例注册表镜像 + 切换条状态在 terminal-instance-registry.ts（write-queue 入队守卫同源）。
 *
 * 职责：
 * 1. per-instance 命令式输出 buffer（非响应式 chunks + 单调版本）+ rAF 输出写队列 + PTY 存活态
 * 2. 模块级订阅 terminal.data/exit/alive/writeFailed（**按 terminalId 幂等**，生命周期 = PTY
 *    生命周期；跨组件生命周期存活）
 * 3. 对外暴露实例维度 API（新建 / 切换 / 关闭 / 当前实例）+ spawn/attach/write/resize/kill/clear
 *    + registerFlushListener（TerminalView 调用）
 * 4. `terminal.list` 对账（⌘R / 会话激活 / 世代变更重连三触发点）+ 世代变更失效重置
 *    （auth token 判据）+ `unknown_terminal_id` 平行守卫（提示与焦点按触发面分档）
 *
 * ── 分区生命周期上提（W27/D-6.2，R-22）+ 实例编号化 ────────────────────────
 * W14 缺口（09 文档 E6-c）：TerminalPartition 与 terminal.* 订阅随 TerminalView 组件实例销毁
 * （v-if 挂载，切 tab 即 unmount）→ 切走期间 terminal.data 无人接收、切回是全新分区 + 重新
 * spawn。W27 把分区持有提升为模块级持久 Map（partitions，键 = terminalId），订阅提升为模块级
 * 订阅（ack 建档时建立、关闭沿 / 会话销毁 / 世代变更时解除）。
 *
 * 选型说明（ADR-0049「全局 sid 协调器例外类」）：useSessionScopedState 是 setup-scoped 工厂——
 * Map 在工厂调用（组件 setup）内创建，onScopeDispose 时反注册 cleanup，组件 unmount 即分区销毁，
 * 结构上无法满足「buffer 存组件外」。本模块命中例外类判据：无 Vue setup 上下文（模块级单例）、
 * 所有方法显式接收 terminalId、buffer 是非响应式数据（markRaw）。同款先例：core/domain/chat/
 * useChat.ts 的 streamSubscriptions、core 的 write-queue factory 单例 Map。
 *
 * 三层生命周期（多实例）：
 * - PTY（runtime）：跟随**实例**（关闭沿 / 会话删除 / runtime shutdown → 进程销毁）
 * - buffer 分区 + 订阅（renderer 模块级）：ack 建档 / list 对账建立 → 关闭沿 / 会话销毁 /
 *   世代变更重置释放。切走 tab（TerminalView unmount）只移除该视图的 flush 监听器。
 * - xterm 组件：跟随 terminal tab 可见性 × 当前显示实例（TerminalView mount/unmount + 切换）
 *
 * rAF 输出写队列（D-6.1 → D-6.2）：同 W27，仅键由 sid 改 terminalId。
 *
 * 依赖方向：api/events + terminalApi（core）+ registerSessionCleanup（core）+ write-queue store
 * + 实例注册表 + ws-client（世代判据）。
 */
import { computed, markRaw, reactive, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'
import { getCurrentToken, getState as getWsState } from '@taiji/core/transport/ws-client'
import { registerSessionCleanup } from '@/composables/useSessionScopedState'
import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'
import { terminalApi } from '@taiji/core/transport/api/domains/terminal'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import type { TerminalInstanceBarItem } from '@/components/panel/TerminalInstanceBar.vue'
import {
  activeTerminalIdOf,
  allTerminalIds,
  hasInstance,
  instanceLabel,
  isTerminalIdOfSession,
  listInstances,
  registerInstance,
  resetTerminalInstanceRegistry,
  sessionIdOfTerminalId,
  setActiveTerminalId,
  setInstanceAlive,
  terminalIdsOfSession,
  unregisterInstance,
  unregisterInstanceBySession,
  __resetTerminalInstanceRegistryForTest,
} from './terminal-instance-registry'

/** 命令式输出 buffer（D-6.2）：append-only 非响应式 chunk 数组 + 单调版本号。 */
export interface TerminalBuffer {
  /**
   * 物理 chunk 数组（append-only，超限裁剪截头）。非响应式（markRaw）——
   * 高频 push 零 reactivity 开销，xterm 写入全命令式。
   */
  chunks: string[]
  /**
   * 单调递增版本 = 累计 append 进 buffer 的 chunk 总数（裁剪不减，物理长度失义后
   * 版本仍是稳定回放锚点）。兼为「buffer 有更新」信号（每次有内容的 flush 前进）。
   * 逻辑索引基准：逻辑索引 - (version - chunks.length) = 物理索引。
   */
  version: number
}

/** terminal per-instance 状态分区（模块级持久，键 = terminalId）。 */
interface TerminalPartition {
  /** 命令式输出 buffer（D-6.2，markRaw 非响应式）。 */
  buffer: TerminalBuffer
  /**
   * rAF 写队列（D-6.1）：一帧内待 flush 的 PTY 输出 chunk 暂存。
   * terminal.data handler 只 push 这里，等 rAF flush 时批量进 buffer——
   * 高频输出时 N 次 data 合并为每帧一次 flush + 一次 xterm.write。
   * 命名避开 terminal-write-queue 的 pendingWrites（那是命令队列，drop-oldest 语义）。
   */
  outputQueue: string[]
  /** rAF 是否已置位（per-instance 防重入：置位期间新 chunk 只入队不再调度）。 */
  rafPending: boolean
  /** PTY 是否存活（ack 建档置 true / alive 帧幂等，exit 后条目回收）。 */
  ptyAlive: boolean
  /** 当前 PTY 尺寸（xterm fit 后记录）。 */
  cols: number
  rows: number
}

/**
 * 新分区的默认状态。reactive 容器（ADR-0049 响应式契约：模板读 ptyAlive/cols/rows
 * 需在 reactive 代理上建立依赖，updatePartition mutate 才能触发重渲染）；
 * buffer/outputQueue 用 markRaw 包裹——非响应式，高频 push/splice 零 reactivity 开销。
 */
function createPartition(): TerminalPartition {
  return reactive({
    buffer: markRaw({ chunks: [], version: 0 }),
    outputQueue: markRaw([]),
    rafPending: false,
    ptyAlive: false,
    cols: 80,
    rows: 24,
  })
}

/** scrollback 上限（Phase 6 后由 settings 配置，当前固定 5000，按 chunk 计）。 */
const SCROLLBACK_LIMIT = 5000

/**
 * outputQueue 防御上限（E6-a）：rAF 被后台节流（窗口最小化/隐藏）长时间不触发时，
 * 队列按 join 合并成单块而非丢弃——输出侧语义是「保序全量」，丢 chunk 会在历史留空洞。
 * 与命令队列 terminal-write-queue 的 drop-oldest（保最新命令）语义刻意分离。
 */
const MAX_OUTPUT_QUEUE = 1000

/** 回放分批每批 chunk 数上限（Fix-5）：每帧一批，避免全量单串 write 卡住主线程。 */
const REPLAY_BATCH_CHUNKS = 500

// ── 模块级持久分区（W27/D-6.2 生命周期上提，键 = terminalId）─────────────────
// ADR-0049「全局 sid 协调器例外类」：无 setup 上下文、方法显式接收 terminalId、buffer 非响应式。
// 分区生命周期 = 实例生命周期（关闭沿 / 会话销毁 / 世代重置清理），独立于任何 TerminalView。
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，已登记）：终端输出分区表（键 = terminalId，生命周期 = 实例生命周期）
const partitions = new Map<string, TerminalPartition>()

/** 分区表结构版本：分区增删时 bump，让各实例 current computed 失效重算。 */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，已登记）：分区表结构版本计数
const mapVersion = ref(0)

// ── 模块级 terminal.* 订阅（生命周期 = 实例生命周期，键 = terminalId）────────
// publish-only 契约（W09）：runtime 只把 terminal.* 发给订阅该 sid 的连接，且 renderer 侧
// events.on(sid) 无 handler 时 dispatchSession 直接丢弃——订阅必须跨组件存活。
// 多实例：一个 sid 可挂多个 handler（每实例一个），handler 内按 payload.terminalId 过滤。
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，已登记）：terminal.* 订阅实例编号集合
const subscribedTerminalIds = new Set<string>()
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，已登记）：terminal.* 订阅退订函数表（键 = terminalId）
const subscriptionUnsubs = new Map<string, () => void>()

// ── flush 监听器注册表（terminalId → 已挂载视图的增量回放回调）──────────────
// 组件 mount 注册、unmount 反注册。flush 后直接通知，替代 W14 的 watch(flush 版本) 链。
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，已登记）：flush 监听器注册表（键 = terminalId）
const flushListeners = new Map<string, Set<(buffer: TerminalBuffer) => void>>()

// ── 自动新建腿同会话互斥（dev-merge review dmg-r1-3）────────────────────────
// `terminal.list` RPC 往返窗口内快速切走再切回，两轮激活各见空清单各 spawn 一档 → 同会话
// 双默认 PTY（多余进程持续存活需手动关闭；旧版「ptyMap.has(sid) → no-op」幂等防线已随
// 多实例化删除）。per-sid in-flight 表：后到激活轮复用先到轮的 spawn promise（ack 建档
// 四件事幂等，复用方 await 同一落定即可）；settle（含失败）即摘除——失败后重试
// （retrySpawn）不复用旧失败 promise。互斥只覆盖自动新建腿：「+」显式新建
// （createWithToast → spawnTerminal）是用户显式意图不受限，runtime 无状态分配语义不动。
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：自动新建腿 per-sid in-flight
// spawn promise 去重簿记（条目持 Promise 本体非 GUI 数据，对照 useGenStats inflightGenStatsFetch 先例；
// 写方 = spawnTerminalAuto 单点 set / settle 摘除，cleanupSession 会话删除一并摘除；§4 ⑧ dmg-r1-1 补登）
const autoSpawnInFlight = new Map<string, Promise<string>>()

/**
 * 模块级分区读写（updateFor 语义，ADR-0049）：WS handler 用显式 terminalId，不读组件。
 * 分区创建（首次写入/建档）时 bump mapVersion——分区出现后各实例 current computed 失效重算。
 */
function getOrCreatePartition(terminalId: string): TerminalPartition {
  let p = partitions.get(terminalId)
  if (!p) {
    p = createPartition()
    partitions.set(terminalId, p)
    mapVersion.value += 1
  }
  return p
}

/** 显式 terminalId 分区更新（WS handler 用，M1 竞态防护同工厂 updateFor）。 */
function updatePartition(terminalId: string, updater: (state: TerminalPartition) => void): void {
  updater(getOrCreatePartition(terminalId))
}

/** 分区移除（关闭沿 ① / 会话销毁 / 世代重置）。 */
function removePartition(terminalId: string): void {
  if (partitions.delete(terminalId)) mapVersion.value += 1
}

/** i18n.global.t 的类型窄化 cast（先例：useConnection.ts 同款）。 */
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

/**
 * 「输入可能丢失」提示（对齐 runtime terminal.writeFailed 的 toast 范式，设计 §3.3）：
 * 滞留命令随实例关闭 / 世代重置丢弃、或对已关闭实例的写入被拒时告知用户。
 */
function warnInputMayBeLost(terminalId: string): void {
  useToast().warning(t('panel.terminal.writeFailed', { message: instanceLabel(terminalId) }))
}

/**
 * 建立 terminalId 的模块级订阅（幂等）。时机：ack 建档 / list 对账建档 / attach 兜底。
 * handler 内按 payload.terminalId 过滤——同会话多实例各有独立 handler。
 */
function ensureTerminalSubscription(terminalId: string): void {
  if (subscribedTerminalIds.has(terminalId)) return
  const sessionId = sessionIdOfTerminalId(terminalId)
  if (sessionId === null) return
  subscribedTerminalIds.add(terminalId)
  const unsub = events.on(sessionId, (msg) => {
    if (terminalIdOf(msg) !== terminalId) return
    if (isTerminalDataMsg(msg)) {
      appendChunk(terminalId, msg.payload.data)
    } else if (isTerminalAliveMsg(msg)) {
      setInstanceAlive(terminalId, true)
      updatePartition(terminalId, (s) => {
        s.ptyAlive = true
      })
      // store.markAlive 同步 ptyAlive + flush 写队列（联动 2 入队的命令）
      useTerminalWriteQueueStore().markAlive(terminalId)
    } else if (isTerminalExitMsg(msg)) {
      handleInstanceExit(terminalId)
    } else if (isTerminalWriteFailedMsg(msg)) {
      // RT-8#10/RD-5#4：runtime PTY write 失败（进程已死/管道关闭）——输入字节已丢，
      // toast 告知用户（runtime 每 PTY 生命周期至多发一次，无刷屏面）。与 write-queue
      // store 的 writeRpcFailed 分层：那边管 RPC 通道故障，这边管 PTY 管道故障。
      console.warn(`[terminal] write 失败（输入可能丢失）: terminalId=${terminalId}`, msg.payload.message)
      useToast().warning(t('panel.terminal.writeFailed', { message: msg.payload.message }))
    }
  })
  subscriptionUnsubs.set(terminalId, unsub)
}

/** 解除订阅（关闭沿 ③ / 会话销毁 / 世代重置）。 */
function unsubscribeTerminal(terminalId: string): void {
  if (!subscribedTerminalIds.delete(terminalId)) return
  subscriptionUnsubs.get(terminalId)?.()
  subscriptionUnsubs.delete(terminalId)
}

/**
 * 建档（定义一次，全文引用——设计 §3.3「renderer 建档口径」四件事）：
 * ①建 terminalId 条目（实例注册表镜像）；②建输出分区；③建立该实例的模块级订阅（幂等）；
 * ④置位 ptyAlive 镜像（等价 markAlive——runtime 在 spawn 内同步 publish alive 后才回 ack，
 * 同连接 FIFO 下 alive 先于 ack 到达，只按 ack 建订阅会让 alive 落地即丢、镜像恒 false 且
 * 无自愈；故显式裁决置位等价 markAlive）。ack 建档与 `terminal.list` 对账建档均走此处。
 */
function establishInstance(
  terminalId: string,
  opts: { cols?: number; rows?: number; alive: boolean },
): void {
  const sessionId = sessionIdOfTerminalId(terminalId)
  if (sessionId === null) return
  registerInstance(terminalId, opts.alive)
  const p = getOrCreatePartition(terminalId)
  if (opts.cols !== undefined) p.cols = opts.cols
  if (opts.rows !== undefined) p.rows = opts.rows
  p.ptyAlive = opts.alive
  ensureTerminalSubscription(terminalId)
  const store = useTerminalWriteQueueStore()
  if (opts.alive) store.markAlive(terminalId)
  else store.markExited(terminalId)
}

/**
 * 关闭沿 renderer 资源处置（设计 §3.3「实例关闭沿 renderer 资源处置」——主动关闭与自然
 * 退出同语义）：①输出分区移除；②terminal-write-queue 实例态清理（滞留命令丢弃，确有滞留时
 * 提示）；③模块级订阅退订。flush 监听器腿豁免（mount/unmount 自管理，视图随切换/卸载自然移除）。
 */
function releaseInstance(terminalId: string, opts: { promptPendingWrites: boolean }): void {
  const store = useTerminalWriteQueueStore()
  const dropped = store.removeInstance(terminalId)
  if (opts.promptPendingWrites && dropped > 0) warnInputMayBeLost(terminalId)
  removePartition(terminalId)
  unsubscribeTerminal(terminalId)
  unregisterInstance(terminalId)
}

/** terminal.exit 帧：自然退出 = 关闭沿（滞留命令丢弃并提示）。 */
function handleInstanceExit(terminalId: string): void {
  if (!hasInstance(terminalId) && !partitions.has(terminalId) && !subscribedTerminalIds.has(terminalId)) return
  releaseInstance(terminalId, { promptPendingWrites: true })
}

/**
 * session 销毁 cleanup（registerSessionCleanup 注册一次，triggerSessionCleanups 遍历调）：
 * 按精确前缀 `term:<sid>:` 释放该会话全部实例（分区 + 订阅 + write-queue 实例态 + 注册表条目），
 * 覆盖竞态重建的幽灵条目。不依赖实例注册表遍历。
 */
function cleanupSession(sessionId: string): void {
  const store = useTerminalWriteQueueStore()
  const candidates = new Set<string>([...partitions.keys(), ...subscribedTerminalIds])
  for (const terminalId of candidates) {
    if (!isTerminalIdOfSession(terminalId, sessionId)) continue
    store.removeInstance(terminalId)
    removePartition(terminalId)
    unsubscribeTerminal(terminalId)
  }
  unregisterInstanceBySession(sessionId)
  // 在途自动新建标记一并摘除（会话已删，spawn 落定后互斥表不得再拦同 sid 后续激活轮）
  autoSpawnInFlight.delete(sessionId)
  // write-queue 层再按前缀兜底一次（覆盖未建分区/订阅的幽灵条目）
  store.removeSession(sessionId)
}
// 模块级注册一次（无 setup scope，应用生命周期内不反注册——分区清理点
// useSidebar.deleteSession 的 triggerSessionCleanups 是唯一入口）。
registerSessionCleanup(cleanupSession)

// ServerMessage 是泛型接口（非可判别联合），type 字面量比较不会自动收窄 payload——
// 用类型谓词显式收窄（与 useSessionEvents 的 TypedHandler 同构，无需 as 断言）
function isTerminalDataMsg(msg: ServerMessage): msg is ServerMessage<'terminal.data'> {
  return msg.type === 'terminal.data'
}
function isTerminalAliveMsg(msg: ServerMessage): msg is ServerMessage<'terminal.alive'> {
  return msg.type === 'terminal.alive'
}
function isTerminalExitMsg(msg: ServerMessage): msg is ServerMessage<'terminal.exit'> {
  return msg.type === 'terminal.exit'
}
function isTerminalWriteFailedMsg(msg: ServerMessage): msg is ServerMessage<'terminal.writeFailed'> {
  return msg.type === 'terminal.writeFailed'
}

/**
 * 提取帧的实例编号归属（多实例路由键）。ServerMessage.payload 是宽联合，
 * 四条 terminal.* 广播帧均带 `terminalId`——此处做一次受控读取（非空字符串才算命中），
 * 避免为了过滤而在四个类型谓词上重复展开。
 */
function terminalIdOf(msg: ServerMessage): string | undefined {
  const payload = msg.payload
  if (payload === null || typeof payload !== 'object') return undefined
  const value = (payload as { terminalId?: unknown }).terminalId
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * terminal.data chunk 入队（D-6.1 rAF 写队列入口，模块级订阅 handler 调）。
 * 只 push 进 outputQueue 并置位 rAF；buffer 累积与视图通知都推迟到 flush。
 * E6-a：rAF 被后台节流导致队列超限时 join 合并成单块（保序全量，不丢弃）。
 */
function appendChunk(terminalId: string, chunk: string): void {
  let schedule = false
  let partition: TerminalPartition | null = null
  updatePartition(terminalId, (s) => {
    // updater 同步执行，schedule 为 true 时 partition 必已赋值
    partition = s
    s.outputQueue.push(chunk)
    if (s.outputQueue.length > MAX_OUTPUT_QUEUE) {
      s.outputQueue = markRaw([s.outputQueue.join('')])
    }
    if (!s.rafPending) {
      s.rafPending = true
      schedule = true
    }
  })
  const p = partition
  if (schedule && p !== null) {
    // rAF 回调捕获 terminalId + 分区引用：实例回收后迟到的回调只写孤儿对象，
    // flushPending 的 `partitions.get(terminalId) !== p` 守卫保证不复活分区、不通知视图。
    requestAnimationFrame(() => flushPending(terminalId, p))
  }
}

/**
 * rAF 回调：把 outputQueue 批量刷进 buffer（D-6.2 命令式语义）。
 * ① append-only push 全部 chunk + 版本前进（version += 本批 chunk 数，裁剪不减）；
 * ② 超限裁剪（SCROLLBACK_LIMIT 按 chunk 计）；
 * ③ 通知本实例已挂载视图增量回放——任何分支都不得丢弃 outputQueue 内容。
 */
function flushPending(terminalId: string, p: TerminalPartition): void {
  p.rafPending = false
  const q = p.outputQueue
  if (q.length === 0) return
  const buf = p.buffer
  for (const queued of q) {
    buf.chunks.push(queued)
  }
  buf.version += q.length
  q.length = 0
  if (buf.chunks.length > SCROLLBACK_LIMIT) {
    buf.chunks.splice(0, buf.chunks.length - SCROLLBACK_LIMIT)
  }
  // 分区已被回收：孤儿 flush 只写孤儿对象（随 GC 回收），不通知任何视图。
  if (partitions.get(terminalId) !== p) return
  notifyFlushListeners(terminalId, buf)
}

function notifyFlushListeners(terminalId: string, buf: TerminalBuffer): void {
  const listeners = flushListeners.get(terminalId)
  if (!listeners) return
  for (const cb of listeners) {
    try {
      cb(buf)
    } catch (e) {
      // 单监听器抛错不阻断其余视图（events 层 safeForEach 同款，M4）
      console.error('[terminal] flush listener threw:', e)
    }
  }
}

/**
 * 版本回放纯函数（D-6.2）：从 fromVersion（含）之后 append 的 chunk 合并为单块。
 * fromVersion 是逻辑索引版本（= 已回放的 chunk 总数）；裁剪后物理起点
 * = fromVersion - 裁剪量，指针落后裁剪线时钳制到 0（保留区全量重放）。
 * 返回 null = 无新增。xterm.write 是追加语义，视图侧需配合 clamped 信号先清屏（S-15）。
 */
export function replayChunks(buffer: TerminalBuffer, fromVersion: number): string | null {
  if (fromVersion >= buffer.version) return null
  const cropped = buffer.version - buffer.chunks.length
  const physicalStart = Math.max(fromVersion - cropped, 0)
  return buffer.chunks.slice(physicalStart).join('')
}

/**
 * 分批版本回放（Fix-5）：replayChunks 的全量单串合并拆成每批 ≤ maxBatchChunks 个 chunk 的
 * 批次数组，由视图侧分帧写（TerminalView enqueueReplayWrites）。物理起点/幂等语义与
 * replayChunks 完全一致。返回 null = 无新增；clamped=true 时视图必须先 xterm.clear()。
 */
export function replayChunksBatched(
  buffer: TerminalBuffer,
  fromVersion: number,
  maxBatchChunks = REPLAY_BATCH_CHUNKS,
): { batches: string[]; targetVersion: number; clamped: boolean } | null {
  if (fromVersion >= buffer.version) return null
  const cropped = buffer.version - buffer.chunks.length
  const clamped = fromVersion < cropped
  const physicalStart = clamped ? 0 : fromVersion - cropped
  const batches: string[] = []
  for (let i = physicalStart; i < buffer.chunks.length; i += maxBatchChunks) {
    batches.push(buffer.chunks.slice(i, i + maxBatchChunks).join(''))
  }
  return { batches, targetVersion: buffer.version, clamped }
}

// ── terminal.list 对账（⌘R / 会话激活 / 世代变更重连三触发点）────────────────

interface ReconcileResult {
  /** 拉取是否成功（false = 保留既有条目、区分「成功空清单」与「拉取失败」）。 */
  ok: boolean
  /** 清单条目数（ok=true 时有效；ok=false 时为 -1，调用方不得据此自动新建）。 */
  count: number
}

/**
 * 对账：清单 = 被查询会话在 runtime 注册表上的存活全集。
 * - 清单内条目按 ack 同口径四件事建档（订阅建立幂等；不清空既有 pendingWrites——
 *   需保留 pendingWrites 的存活实例均在清单内）；
 * - 清单外条目按关闭沿三腿清理（含 ack 窗口内死亡产生的假阳幽灵）；
 * - **范围钉死 = 本次查询所属会话**（与查询会话无关的 terminalId 键不参与增删）；
 * - 拉取失败：保留既有条目、下一次触发自然重试（**禁定时兜底**）。失败是否提示由调用方
 *   按触发点分腿（世代变更重连腿静默）。
 */
async function reconcileSession(sessionId: string): Promise<ReconcileResult> {
  // 纵深防护：请求发起时捕获连接世代判据（auth token，getCurrentToken 与世代重置同源）。
  // await 落定后世代已变 = 响应属于旧连接世代，按失败腿丢弃（保留既有条目、不自动新建）。
  // 当前接线下断连时 use-connection 的 pendingApi.rejectAll 已把在途请求 reject 走失败腿，
  // 本防护是第二层：传输层行为变化（旧响应不再被 reject 直达此处）时兜住「旧清单响应
  // 复活幽灵终端」，与 resetTerminalDomain 的世代重置语义配套。
  const generationToken = getCurrentToken()
  let listed: { terminalId: string; alive: boolean }[]
  try {
    listed = await terminalApi.list(sessionId)
  } catch (e: unknown) {
    // 失败分腿（设计 §3.3）：保留既有条目、不清空、不展示误导性空态；由下一次触发重试。
    console.warn(`[terminal] terminal.list 拉取失败（保留既有条目，下次触发重试）: sid=${sessionId}`, e)
    return { ok: false, count: -1 }
  }
  if (getCurrentToken() !== generationToken) return { ok: false, count: -1 }
  const listedIds = new Set(listed.map((i) => i.terminalId))
  for (const terminalId of terminalIdsOfSession(sessionId)) {
    if (!listedIds.has(terminalId)) releaseInstance(terminalId, { promptPendingWrites: true })
  }
  for (const item of listed) {
    // 范围钉死：只对本次查询会话的编号建档（他会话编号为 runtime 异常形态，防御跳过）
    if (!isTerminalIdOfSession(item.terminalId, sessionId)) continue
    if (!hasInstance(item.terminalId)) establishInstance(item.terminalId, { alive: item.alive })
    else {
      setInstanceAlive(item.terminalId, item.alive)
      const p = getOrCreatePartition(item.terminalId)
      p.ptyAlive = item.alive
      if (item.alive) useTerminalWriteQueueStore().markAlive(item.terminalId)
      ensureTerminalSubscription(item.terminalId)
    }
  }
  return { ok: true, count: listed.length }
}

// ── 世代变更失效重置（设计 §0.5 P6 / §3.3「实例注册表与恢复」）───────────────

/**
 * 上一次连接建立时的 auth token（undefined = 旧值不可得——首次连接）。新旧值比较：
 * 变化 = runtime 世代变更（每次 spawn 重新生成 token），未变 = 同世代（WS 闪断 /
 * 无新进程的幂等 `runtime-port` 广播沿）→ 不重置。
 */
let lastConnectionToken: string | null | undefined = undefined

/**
 * 世代判据播种（设计 §0.5 P6）：本模块经 TerminalView 的 `defineAsyncComponent` 懒加载
 * （底部抽屉 isOpen 默认 false，开抽屉才求值），模块求值可能晚于首次连接建立——此时模块
 * 观察到的第一条 `connected` 边沿不是「首次连接」而是**同世代重连**（ws-client 退避 /
 * visibility 重连复用 currentToken 与 url，token 不变）。若不播种，旧值仍为 undefined
 * 会被 `handleConnectionEstablished` 的「旧值不可得」分支保守判为世代变更 → 误跑
 * resetTerminalDomain（清空分区 / 订阅 / 滞留命令并弹「输入可能丢失」），与 §3.3
 * 「重置触发面显式收窄为世代变更」相悖，T11/T12 反向验收落空。
 *
 * 故模块求值时按当前连接态播种旧值（ws-client 只读取值面）：已有已知 token
 * （已连接 / 连接中 / 等待重连）即取为旧值，使「旧值不可得」只对应真正无任何已知 token
 * 的首次连接——该腿无输出历史与滞留命令，重置为空操作，正是 P6 的代价前提。
 */
function seedGenerationBaseline(): void {
  const token = getCurrentToken()
  if (token !== null) lastConnectionToken = token
}
seedGenerationBaseline()

/**
 * 世代变更重连沿处理（触发信号 = WS connected 边沿——`runtime-port` 广播沿每次必致重连，
 * 为其保守超集；判据 = auth token 是否变化）：
 * - 世代变更 → 终端域失效重置（见 resetTerminalDomain）；
 * - 同世代 → 不重置（闪断保持分区与订阅，重连后新输出恢复推进）；
 * - **旧 token 不可得（首次连接）→ 保守判为世代变更**（宁可清空过期历史，不可漏重置
 *   造成跨世代撞号串数据；首次连接腿无输出历史与滞留命令，重置为空操作）。
 */
function handleConnectionEstablished(token: string | null): void {
  const generationChanged = lastConnectionToken === undefined || token !== lastConnectionToken
  lastConnectionToken = token
  if (generationChanged) resetTerminalDomain()
}

/**
 * 世代变更失效重置：①清空输出分区与切换条（含 flush 监听表——跨世代编号同形，残留监听
 * 随重置回收；视图 dispose 亦会反注册）；②terminal-write-queue 状态机清空（旧世代
 * 滞留命令随重置丢弃，**提示仅在确有滞留命令时发出**）；③模块级订阅表**先退订再清空**
 * （键跨世代同形，残留条目会命中订阅建立的幂等守卫导致新世代订阅静默 no-op）。
 * 重置后按 `terminal.list` 拉取重建（新 runtime 清单为空 → 空态；**失败不提示**）。
 */
function resetTerminalDomain(): void {
  const affectedSessions = new Set<string>()
  const collect = (terminalId: string): void => {
    const sid = sessionIdOfTerminalId(terminalId)
    if (sid !== null) affectedSessions.add(sid)
  }
  for (const terminalId of partitions.keys()) collect(terminalId)
  for (const terminalId of subscribedTerminalIds) collect(terminalId)
  for (const terminalId of allTerminalIds()) collect(terminalId)
  const store = useTerminalWriteQueueStore()
  let pendingBearingInstance: string | null = null
  for (const terminalId of allTerminalIds()) {
    if (pendingBearingInstance === null && store.pendingCountOf(terminalId) > 0) {
      pendingBearingInstance = terminalId
    }
  }
  // ③ 先退订再清空（防同形键命中幂等守卫）
  for (const unsub of subscriptionUnsubs.values()) unsub()
  subscriptionUnsubs.clear()
  subscribedTerminalIds.clear()
  // ① 分区 + 切换条 + flush 监听表
  partitions.clear()
  flushListeners.clear()
  mapVersion.value += 1
  // 注册表镜像（生产重置入口；测试别名 __resetTerminalInstanceRegistryForTest 仅供测试）
  resetTerminalInstanceRegistry()
  // ② write-queue 状态机（滞留命令丢弃；确有滞留才提示）
  const dropped = store.clearAll()
  if (dropped > 0) warnInputMayBeLost(pendingBearingInstance ?? '')
  // 重建：新 runtime 清单恒为空（拉取仅保持通路一致性，失败静默）
  for (const sid of affectedSessions) void reconcileSession(sid)
}

// 连接建立边沿监听（模块级单例）：同世代闪断 / 幂等广播沿 token 未变 → 不重置。
watch(getWsState(), (state, previous) => {
  if (state === 'connected' && previous !== 'connected') handleConnectionEstablished(getCurrentToken())
})

/**
 * terminal per-instance 状态 + PTY 控制的组件视图层。
 *
 * @param sessionIdRef session id ref（string | null）
 * @returns current（当前显示实例的分区）+ 实例清单 / 当前实例 + 实例与 PTY 控制 + flush 监听注册
 */
export function useTerminal(sessionIdRef: Ref<string | null>) {
  /** 当前会话的实例清单（切换条数据源，顺序 = 注册顺序）。 */
  const instances: ComputedRef<TerminalInstanceBarItem[]> = computed(() => {
    const sid = sessionIdRef.value
    if (sid === null) return []
    return listInstances(sid).map((e) => ({ terminalId: e.terminalId, seq: e.seq, alive: e.alive }))
  })

  /** 当前显示实例编号（null = 空态）。 */
  const activeTerminalId: ComputedRef<string | null> = computed(() => {
    const sid = sessionIdRef.value
    if (sid === null) return null
    return activeTerminalIdOf(sid)
  })

  /**
   * 当前显示实例的分区（读/写语义拆分，Fix-2）：null 或「分区不存在/已回收」返回临时默认
   * 实例（不写 Map）。依赖 mapVersion 让回收后本 computed 失效重算。禁止 create-on-read：
   * 会话删除流程中 cleanup 后、active 回退之前若渲染重算，会重建已删实例的空分区且不再被
   * cleanup（永久泄漏）。分区由写入方（establishInstance/updatePartition）创建并 bump。
   */
  const current: ComputedRef<TerminalPartition> = computed(() => {
    void mapVersion.value
    const terminalId = activeTerminalId.value
    if (terminalId === null) return createPartition()
    return partitions.get(terminalId) ?? createPartition()
  })

  /**
   * 注册本视图的增量回放监听（mount 调、unmount 反注册）。
   * @param terminalId 所属实例编号
   * @param cb 收到最新 buffer 的回调（视图持有自己的回放指针，只写增量）
   * @returns 反注册函数
   */
  function registerFlushListener(terminalId: string, cb: (buffer: TerminalBuffer) => void): () => void {
    let set = flushListeners.get(terminalId)
    if (!set) {
      set = new Set()
      flushListeners.set(terminalId, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0) {
        flushListeners.delete(terminalId)
      }
    }
  }

  /**
   * 新建实例（新建形态 spawn：不带 terminalId，编号由 runtime 分配经 ack 回传）：
   * **renderer 以 ack 为唯一编号来源建档**（不本地预分配——双视图/快速连点撞号）。失败
   * 直接 rethrow（不吞，反馈职责归调用方：mount 自动新建走 inline 错误条、「+」走全局错误通道）。
   */
  async function spawnTerminal(cwd: string | undefined, cols: number, rows: number): Promise<string> {
    const sid = sessionIdRef.value
    if (!sid) throw new Error('terminal.spawn skipped: no active session')
    let ack: { terminalId?: string } | undefined
    try {
      ack = await terminalApi.spawn({ sessionId: sid, cwd, cols, rows })
    } catch (e: unknown) {
      // RD-5#2：spawn 是 PTY 起不来的权威点——留痕后 rethrow（调用方决定显形方式）
      console.warn(`[terminal] spawn RPC 失败: sid=${sid}`, e)
      throw e
    }
    const terminalId = ack?.terminalId
    if (!terminalId) {
      const err = new Error('terminal.spawn ack missing terminalId')
      console.warn(`[terminal] spawn ack 缺编号: sid=${sid}`, ack)
      throw err
    }
    // ack 建档四件事（含置位存活镜像，见 establishInstance 注释）
    establishInstance(terminalId, { cols, rows, alive: true })
    return terminalId
  }

  /**
   * 自动新建默认实例（挂载/激活腿专用，见 autoSpawnInFlight 注释）：同会话已有在途自动
   * 新建时**复用其 promise**（后到激活轮等先到轮落定，不发第二个 spawn RPC）；settle
   * （含失败）后摘除标记，重试腿可再发。失败 rethrow（反馈职责归调用方，同 spawnTerminal）。
   */
  function spawnTerminalAuto(cwd: string | undefined, cols: number, rows: number): Promise<string> {
    const sid = sessionIdRef.value
    if (!sid) return Promise.reject(new Error('terminal.spawn skipped: no active session'))
    const inFlight = autoSpawnInFlight.get(sid)
    if (inFlight) return inFlight
    const tracked = spawnTerminal(cwd, cols, rows).finally(() => {
      if (autoSpawnInFlight.get(sid) === tracked) autoSpawnInFlight.delete(sid)
    })
    autoSpawnInFlight.set(sid, tracked)
    return tracked
  }

  /** 切换当前显示实例（切换条 select）。 */
  function selectInstance(terminalId: string): void {
    const sid = sessionIdRef.value
    if (!sid || !hasInstance(terminalId)) return
    setActiveTerminalId(sid, terminalId)
  }

  /**
   * 关闭实例（切换条 close）：杀进程 + **同步**释放界面侧资源（三腿，不驻留）。
   * 进程终结后 runtime 的 terminal.exit 广播到达时走 handleInstanceExit（幂等收敛）。
   * 当前显示实例被关闭时 active 落相邻（无右取左，注册表内实现）。
   * kill RPC 通道类失败（非 unknown_terminal_id）→ handleRoutingError kill 分档 toast 反馈
   * 并按「实例仍活」重建镜像条目（dmg-r1-4：UI 不再显示已关而 PTY 仍存活的无反馈窗口）。
   */
  function closeInstance(terminalId: string): void {
    const sid = sessionIdRef.value
    if (!sid || !hasInstance(terminalId)) return
    releaseInstance(terminalId, { promptPendingWrites: true })
    terminalApi.kill(sid, terminalId).catch((e: unknown) => {
      handleRoutingError(terminalId, e, 'kill')
    })
  }

  /**
   * `terminal.list` 对账（会话激活 / ⌘R 界面刷新触发点）。
   * 返回值区分「成功空清单」与「拉取失败」——调用方据此决定是否自动新建默认实例
   * （失败不得自动新建，否则会与后台存活实例撞号并存）。
   */
  function reconcileInstances(): Promise<ReconcileResult> {
    const sid = sessionIdRef.value
    if (!sid) return Promise.resolve({ ok: false, count: -1 })
    return reconcileSession(sid)
  }

  /**
   * `unknown_terminal_id` 平行守卫（设计 §3.3）：任意已建档条目收到首个
   * `unknown_terminal_id`（write / kill / attach / resize 均可触发）→ 执行关闭沿三腿清理。
   * 判据 = runtime「该 terminalId 不在注册表」的否定回执（与关闭沿守卫同源）。
   * 用户可见语义按触发面分档：
   * - `write` 命中 → 经「输入可能丢失」通道告知（对齐死亡沿 pendingWrites 丢弃范式）
   *   + 迁焦点（焦点按关闭沿规则落相邻实例；**先告知后迁移**——prompt 在同步路径先发，
   *   焦点迁移由视图对 active 变化的异步 watcher 落地）；
   * - `attach` / `resize` 命中 → **静默回收**（不提示、不迁焦点）。
   * - `kill` 命中 → **静默回收**（同上）。
   * 重复打击静默收敛（条目已回收 → 后续命中直接早退）。
   * **非 `unknown_terminal_id` 的失败分两档**（dmg-r1-4）：
   * - `kill` 失败 = 用户「关闭/终止」动作未生效（PTY 仍存活继续产输出），必须给可见反馈
   *   （toast「关闭失败，实例仍在运行」，C-proc-21）：closeInstance 腿此前已同步释放界面侧
   *   资源，这里按「实例仍活」重建镜像条目（establishInstance 幂等），使 UI 与 runtime 实况
   *   立即一致，不等下次 `terminal.list` 对账才「复活」；
   * - `write` / `attach` / `resize` 走普通错误通道留痕即可——write 的输入丢失面由 runtime
   *   `terminal.writeFailed` 帧覆盖，resize/attach 无用户动作成败语义。
   */
  function handleRoutingError(terminalId: string, e: unknown, trigger: 'write' | 'kill' | 'attach' | 'resize'): void {
    const code = (e as { code?: string } | null)?.code
    if (code === 'unknown_terminal_id') {
      // 三腿判据（与 handleInstanceExit 同形）：注册表 / 分区 / 订阅皆无才早退（重复打击静默）。
      // 仅注册表条目已删而分区或订阅仍在场时不得早退——设计 §3.3 守卫覆盖「刚建立的订阅条目与
      // 分区」（注册表条目删 ≠ 已回收），此时仍需走 releaseInstance（幂等）回收。
      if (!hasInstance(terminalId) && !partitions.has(terminalId) && !subscribedTerminalIds.has(terminalId)) return
      // 先告知后迁移焦点：prompt 走同步路径先发；焦点迁移由视图对 active 变化的异步
      // watcher 落地（关闭沿显示规则落相邻实例）
      if (trigger === 'write') warnInputMayBeLost(terminalId)
      releaseInstance(terminalId, { promptPendingWrites: false })
      return
    }
    if (trigger === 'kill') {
      // C-proc-21：kill 失败 ≠ 已关闭——PTY 仍在运行，用户必须得到可见反馈 + UI 即时对齐
      //（条目重建幂等：killTerminal 腿条目未释放时仅刷新存活镜像；closeInstance 腿在此复活）
      console.warn(`[terminal] kill RPC 失败（实例仍在运行）: terminalId=${terminalId}`, e)
      useToast().warning(t('panel.terminal.closeFailed', { message: instanceLabel(terminalId) }))
      establishInstance(terminalId, { alive: true })
      return
    }
    // 普通错误通道（write/attach/resize，含交叉校验拒绝码）：留痕即可，PTY 管道级故障由 runtime 广播覆盖
    console.warn(`[terminal] ${trigger} RPC 失败: terminalId=${terminalId}`, e)
  }

  /** 写入字节（用户输入 / 联动 2 填命令）。 */
  function writeToTerminal(data: string): void {
    const sid = sessionIdRef.value
    const terminalId = activeTerminalId.value
    if (!sid || !terminalId) return
    terminalApi.write(sid, terminalId, data).catch((e: unknown) => {
      handleRoutingError(terminalId, e, 'write')
    })
  }

  /** 调整尺寸（xterm fit addon 触发）。 */
  function resizeTerminal(cols: number, rows: number): void {
    const sid = sessionIdRef.value
    const terminalId = activeTerminalId.value
    if (!sid || !terminalId) return
    updatePartition(terminalId, (s) => {
      s.cols = cols
      s.rows = rows
    })
    terminalApi.resize(sid, terminalId, cols, rows).catch((e: unknown) => {
      handleRoutingError(terminalId, e, 'resize')
    })
  }

  /** kill 当前显示实例的 PTY（工具栏 kill 按钮）。 */
  function killTerminal(): void {
    const sid = sessionIdRef.value
    const terminalId = activeTerminalId.value
    if (!sid || !terminalId) return
    terminalApi.kill(sid, terminalId).catch((e: unknown) => {
      handleRoutingError(terminalId, e, 'kill')
    })
  }

  /**
   * 通知 PTY 活跃（TerminalView mount / 切换实例调）。attach 保留「确保订阅」职责
   * （幂等兜底——现状 attachTerminal 同调 ensureTerminalSubscription；设计 §3.3 明示不退役）。
   */
  function attachTerminal(): void {
    const sid = sessionIdRef.value
    const terminalId = activeTerminalId.value
    if (!sid || !terminalId) return
    ensureTerminalSubscription(terminalId)
    terminalApi.attach(sid, terminalId).catch((e: unknown) => {
      handleRoutingError(terminalId, e, 'attach')
    })
  }

  /** 当前实例分区（xterm 回放起点；与 current 同源，供视图按 terminalId 显式取用）。 */
  function partitionOf(terminalId: string): TerminalPartition {
    return partitions.get(terminalId) ?? createPartition()
  }

  return {
    /** 当前会话实例清单（切换条数据源）。 */
    instances,
    /** 当前显示实例编号（null = 空态）。 */
    activeTerminalId,
    /** 当前显示实例分区状态（null 返回默认实例）。 */
    current,
    /** 实例与 PTY 控制。 */
    spawnTerminal,
    /** 自动新建默认实例（挂载/激活腿专用，带同会话 in-flight 互斥）。 */
    spawnTerminalAuto,
    selectInstance,
    closeInstance,
    reconcileInstances,
    writeToTerminal,
    resizeTerminal,
    killTerminal,
    attachTerminal,
    partitionOf,
    /** flush 监听注册（TerminalView mount/unmount 编排）。 */
    registerFlushListener,
  }
}

/** useTerminal 返回类型（供组件 type import）。 */
export type UseTerminalReturn = ReturnType<typeof useTerminal>

// ── 测试专用 hooks（生产代码禁止调用，参照 core lru.ts _resetLruForTest 先例）──

/** 测试专用：清空模块级状态（分区/订阅/监听器/注册表/世代 token + bump mapVersion）。 */
export function __resetTerminalStateForTest(): void {
  partitions.clear()
  for (const unsub of subscriptionUnsubs.values()) unsub()
  subscriptionUnsubs.clear()
  subscribedTerminalIds.clear()
  flushListeners.clear()
  __resetTerminalInstanceRegistryForTest()
  lastConnectionToken = undefined
  mapVersion.value += 1
}

/** 测试专用：驱动「WS 连接建立边沿」处理（世代核对 + 重置）。 */
export function __handleConnectionEstablishedForTest(token: string | null): void {
  handleConnectionEstablished(token)
}

/** 测试专用：当前分区数（断言实例回收 / 会话销毁后分区释放）。 */
export function __terminalPartitionCountForTest(): number {
  return partitions.size
}

/** 测试专用：已注册 flush 监听器总数（断言实例回收后监听清空）。 */
export function __terminalFlushListenerCountForTest(): number {
  let count = 0
  for (const set of flushListeners.values()) count += set.size
  return count
}

/** 测试专用：已建立订阅的实例编号数（断言关闭沿 / 世代重置退订）。 */
export function __terminalSubscriptionCountForTest(): number {
  return subscribedTerminalIds.size
}
