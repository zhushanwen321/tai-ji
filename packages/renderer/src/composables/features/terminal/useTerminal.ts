/**
 * useTerminal —— drawer 集成终端的 per-session 状态 + PTY 控制（Phase 3）。
 *
 * 职责：
 * 1. per-session 命令式输出 buffer（非响应式 chunks + 单调版本）+ rAF 输出写队列 + PTY 存活态
 * 2. 模块级订阅 terminal.data/exit/alive（跨组件生命周期存活，W27 分区生命周期上提）
 * 3. 对外暴露 spawn/write/resize/kill/attach/registerFlushListener（TerminalView 调用）
 *
 * ── 分区生命周期上提（W27/D-6.2，R-22）──────────────────────────────────
 * W14 已知缺口（09 文档 E6-c）：TerminalPartition 与 terminal.* 订阅随 TerminalView
 * 组件实例销毁（v-if 挂载，切 tab 即 unmount）→ 切走期间 terminal.data 无人接收、
 * 切回是全新分区 + 重新 spawn，「切走 30s 切回历史完整」不可交付。
 * 本 wave 把分区的持有从 useSessionScopedState（per-instance Map，scope 销毁即清）
 * 提升为模块级持久 Map（partitions），订阅从 useSessionEvents（组件生命周期）
 * 提升为模块级订阅（spawn 时建立、session 销毁 cleanup 时解除）。
 *
 * 选型说明（ADR-0049「全局 sid 协调器例外类」）：useSessionScopedState 是 setup-scoped
 * 工厂——Map 在工厂调用（组件 setup）内创建，onScopeDispose 时反注册 cleanup，组件
 * unmount 即分区销毁，结构上无法满足 R-22「buffer 存组件外」。本模块升级后命中例外
 * 类判据（ADR-0049 §例外清单）：无 Vue setup 上下文（模块级单例）、所有方法显式接收
 * sessionId（appendChunk/flushPending/updatePartition）、buffer 是非响应式数据（markRaw）。
 * 同款先例：core/domain/chat/useChat.ts 的 streamSubscriptions（模块级 Map + 模块级
 * 订阅编排）、core/domain/drawer 的 write-queue factory 单例 Map（terminal-write-queue
 * store 已同款）。cleanup 仍经 registerSessionCleanup 挂载（useSidebar.deleteSession →
 * triggerSessionCleanups → 删分区 + 退订 + 清 flush 监听器），内存语义与工厂一致。
 *
 * 三层生命周期（W27 后）：
 * - PTY（runtime）：跟随 session（session 销毁 → destroyPty），切 terminal tab 不死
 * - buffer 分区 + 订阅（renderer 模块级）：spawn/attach 建立订阅 → session 销毁
 *   cleanup 释放。切走 tab（TerminalView unmount）只移除该视图的 flush 监听器，
 *   分区与订阅保留——切走期间 terminal.data 照常进 buffer，切回 mount 后
 *   replayFrom(0) 全量回放（V-P2-4 可交付）。
 * - xterm 组件：跟随 terminal tab 可见性（TerminalView mount/unmount）
 *
 * rAF 输出写队列（D-6.1 → D-6.2 演进）：
 * - terminal.data 入 outputQueue（markRaw 非响应式），rAF flushPending 批量 append 进
 *   buffer.chunks + 版本前进 + 裁剪，然后直接通知本 sid 已注册的 flush 监听器
 *   （TerminalView 增量 replay）——watch 链消失（D-6.2 检查点：旧 watch 链（监听
 *   scrollback 长度 / flush 版本号）全部删除，回放只靠 replayFrom(version)）。
 * - buffer.version = 累计 append chunk 数（单调递增、裁剪不减，W14 双锚点——flush
 *   版本号 / 累计 append 数——合一）：既是「buffer 有更新」的版本信号，也是回放指针基准。
 *   replayChunks(buffer, fromVersion) 从版本号直接定位物理起点（逻辑索引 - 裁剪量），
 *   O(1) 无辅助结构，幂等（重复回放只是重写既有内容，E6-b）。
 * - 用户输入（writeToTerminal）不走此队列，直连 terminalApi.write（击键即时回显）。
 *
 * 依赖方向：api/events + terminalApi（@/api）+ registerSessionCleanup（core）+ write-queue store。
 * useTerminal 是组件视图层（current computed 按组件 sidRef 读模块分区），模块级状态不依赖组件。
 */
import { computed, markRaw, reactive, ref, type ComputedRef, type Ref } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'
import { registerSessionCleanup } from '@/composables/useSessionScopedState'
import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'
import { terminalApi } from '@taiji/core/transport/api/domains/terminal'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'

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

/** terminal per-session 状态分区（模块级持久，W27/D-6.2）。 */
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
  /** rAF 是否已置位（per-sid 防重入：置位期间新 chunk 只入队不再调度）。 */
  rafPending: boolean
  /** PTY 是否存活（spawn 后置 true，exit 后置 false）。联动 2 的 ptyAlive 判断在全局 store（terminal-write-queue）。 */
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

// ── 模块级持久分区（W27/D-6.2 生命周期上提）──────────────────────────────
// ADR-0049「全局 sid 协调器例外类」：无 setup 上下文、方法显式接收 sid、buffer 非响应式。
// 分区生命周期 = session 生命周期（session 销毁经 registerSessionCleanup 清理），
// 独立于任何 TerminalView 组件实例——切 tab（unmount）只移除视图 flush 监听器，数据不丢。
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：终端输出分区表（ADR-0049「全局 sid 协调器例外类」，生命周期= session 生命周期，上方注释已述）
const partitions = new Map<string, TerminalPartition>()

/** 分区表结构版本：cleanup 删分区时 bump，让各实例 current computed 失效重算（同 core 工厂）。 */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：分区表结构版本计数（cleanup 删分区时 bump 使 computed 失效，同 ADR-0049 例外类基建）
const mapVersion = ref(0)

// ── 模块级 terminal.* 订阅（生命周期 = PTY 生命周期）──────────────────────
// publish-only 契约（W09）：runtime 只把 terminal.data 发给订阅该 sid 的连接，且
// renderer 侧 events.on(sid) 无 handler 时 dispatchSession 直接丢弃——订阅必须跨组件
// 存活，否则切走期间输出无人接收（分区在组件外但没有订阅同样空转）。
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：terminal.* 订阅 sid 集合（订阅生命周期 = PTY 生命周期）
const subscribedSids = new Set<string>()
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：terminal.* 订阅退订函数表（同上）
const subscriptionUnsubs = new Map<string, () => void>()

// ── flush 监听器注册表（sid → 已挂载视图的增量回放回调）────────────────────
// 组件 mount 注册、unmount 反注册。flush 后直接通知，替代 W14 的 watch(flush 版本) 链。
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：flush 监听器注册表（mount 注册/unmount 反注册）
const flushListeners = new Map<string, Set<(buffer: TerminalBuffer) => void>>()

/**
 * 模块级分区读写（updateFor 语义，ADR-0049）：WS handler 用显式 sid，不读组件 sidRef。
 * 分区创建（首次写入）时 bump mapVersion——新分区出现后各实例 current computed 失效
 * 重算，从「临时默认实例」切到真实分区（Fix-2 读/写语义拆分，见 current 注释）。
 */
function getOrCreatePartition(sid: string): TerminalPartition {
  let p = partitions.get(sid)
  if (!p) {
    p = createPartition()
    partitions.set(sid, p)
    mapVersion.value += 1
  }
  return p
}

/** 显式 sid 分区更新（WS handler 用，M1 竞态防护同工厂 updateFor）。 */
function updatePartition(sid: string, updater: (state: TerminalPartition) => void): void {
  updater(getOrCreatePartition(sid))
}

/**
 * session 销毁 cleanup（registerSessionCleanup 注册一次，triggerSessionCleanups 遍历调）：
 * 删分区 + 解除模块级订阅 + 清 flush 监听器。迟到 rAF 回调持分区引用只写孤儿对象
 * （flushPending 内 `partitions.get(sid) !== p` 守卫不再通知视图，不复活分区）。
 */
function cleanupPartition(sid: string): void {
  if (partitions.delete(sid)) {
    mapVersion.value += 1
  }
  if (subscribedSids.delete(sid)) {
    subscriptionUnsubs.get(sid)?.()
    subscriptionUnsubs.delete(sid)
  }
  flushListeners.delete(sid)
}
// 模块级注册一次（无 setup scope，应用生命周期内不反注册——分区清理点
// useSidebar.deleteSession 的 triggerSessionCleanups 是唯一入口）。
// HMR 注意（Fix-6）：vite 热重载本模块时旧模块的 cleanupPartition 仍在 registry 中
// 残留（triggerSessionCleanups 会多调一次，幂等无害），events.on 的旧 handler 同理
// （只写旧模块的孤儿分区，随 GC 回收）——与 useChat.streamSubscriptions 同类的
// dev-only 有界残留，不做 import.meta.hot.dispose 退订。
registerSessionCleanup(cleanupPartition)

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

/** i18n.global.t 的类型窄化 cast（先例：useConnection.ts 同款）。 */
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

/**
 * 建立 sid 的模块级 terminal.* 订阅（幂等）。时机：spawn（RPC 前）与 attach——
 * PTY 从 spawn 到 session 销毁全程有订阅，覆盖「切走 tab」整个窗口。
 */
function ensureTerminalSubscription(sid: string): void {
  if (subscribedSids.has(sid)) return
  subscribedSids.add(sid)
  const unsub = events.on(sid, (msg) => {
    if (isTerminalDataMsg(msg)) {
      appendChunk(sid, msg.payload.data)
    } else if (isTerminalAliveMsg(msg)) {
      updatePartition(sid, (s) => {
        s.ptyAlive = true
      })
      // store.markAlive 同步 ptyAlive + flush 写队列（Block.vue 入队的命令，联动 2）
      useTerminalWriteQueueStore().markAlive(sid)
    } else if (isTerminalExitMsg(msg)) {
      updatePartition(sid, (s) => {
        s.ptyAlive = false
      })
      useTerminalWriteQueueStore().markExited(sid)
    } else if (isTerminalWriteFailedMsg(msg)) {
      // RT-8#10/RD-5#4：runtime PTY write 失败（进程已死/管道关闭）——输入字节已丢，
      // toast 告知用户（runtime 每 PTY 生命周期至多发一次，无刷屏面）。与 write-queue
      // store 的 writeRpcFailed 分层：那边管 RPC 通道故障，这边管 PTY 管道故障。
      console.warn(`[terminal] write 失败（输入可能丢失）: sid=${sid}`, msg.payload.message)
      useToast().warning(t('panel.terminal.writeFailed', { message: msg.payload.message }))
    }
  })
  subscriptionUnsubs.set(sid, unsub)
}

/**
 * terminal.data chunk 入队（D-6.1 rAF 写队列入口，模块级订阅 handler 调）。
 * 只 push 进 outputQueue 并置位 rAF；buffer 累积与视图通知都推迟到 flush——
 * 高频输出（如 build 日志）时 N 次 data 只产生每帧一次的 flush + 一次 xterm.write。
 * E6-a：rAF 被后台节流导致队列超限时 join 合并成单块（保序全量，不丢弃）。
 */
function appendChunk(sid: string, chunk: string): void {
  let schedule = false
  let partition: TerminalPartition | null = null
  updatePartition(sid, (s) => {
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
    // rAF 回调捕获 sid + 分区引用（W14 审查 Fix-4 语义延续）：session 销毁
    // （triggerSessionCleanups 删分区）后迟到的回调只写孤儿对象，flushPending 的
    // `partitions.get(sid) !== p` 守卫保证不复活分区、不通知新分区视图。
    requestAnimationFrame(() => flushPending(sid, p))
  }
}

/**
 * rAF 回调：把 outputQueue 批量刷进 buffer（D-6.2 命令式语义）。
 * ① append-only push 全部 chunk + 版本前进（version += 本批 chunk 数，裁剪不减）；
 * ② 超限裁剪（SCROLLBACK_LIMIT 按 chunk 计，F3 证伪 splice 不是成本）；
 * ③ 通知本 sid 已挂载视图增量回放——任何分支都不得丢弃 outputQueue 内容
 *   （xterm 可见性只影响 ③，buffer 累积永远先做）。
 */
function flushPending(sid: string, p: TerminalPartition): void {
  p.rafPending = false
  const q = p.outputQueue
  if (q.length === 0) return
  const buf = p.buffer
  for (const queued of q) {
    buf.chunks.push(queued)
  }
  buf.version += q.length
  q.length = 0
  // 裁剪 buffer 上限（保留最新 N chunk，语义同改造前的 per-push 裁剪）
  if (buf.chunks.length > SCROLLBACK_LIMIT) {
    buf.chunks.splice(0, buf.chunks.length - SCROLLBACK_LIMIT)
  }
  // 分区已被 session 销毁清理：孤儿 flush 只写孤儿对象（随 GC 回收），
  // 不通知任何视图（也不复活分区——Fix-4 语义）。
  if (partitions.get(sid) !== p) return
  const listeners = flushListeners.get(sid)
  if (listeners) {
    for (const cb of listeners) {
      try {
        cb(buf)
      } catch (e) {
        // 单监听器抛错不阻断其余视图（events 层 safeForEach 同款，M4）
        console.error('[terminal] flush listener threw:', e)
      }
    }
  }
}

/**
 * 清屏（Fix-3，TerminalView clear 按钮）：重置 sid 分区 buffer（chunks/version 归零）
 * + 清 pending 输出队列（防帧边界 flush 回填）+ 通知已注册 flush 监听器。
 * buffer.version 单调只增（裁剪不减），回退即被 clear 重置——监听器据此清空本视图
 * xterm + 回放指针归零（多视图同 sid 同步清屏，见 TerminalView onFlushed）。
 * 不 bump mapVersion：buffer 非响应式，视图靠 flush 监听器感知，无需渲染重算。
 */
function clearPartition(sid: string): void {
  const p = partitions.get(sid)
  if (!p) return
  p.buffer.chunks.length = 0
  p.buffer.version = 0
  p.outputQueue.length = 0
  p.rafPending = false
  const listeners = flushListeners.get(sid)
  if (listeners) {
    for (const cb of listeners) {
      try {
        cb(p.buffer)
      } catch (e) {
        // 单监听器抛错不阻断其余视图（events 层 safeForEach 同款，M4）
        console.error('[terminal] flush listener threw:', e)
      }
    }
  }
}

/**
 * 版本回放纯函数（D-6.2）：从 fromVersion（含）之后 append 的 chunk 合并为单块。
 * fromVersion 是逻辑索引版本（= 已回放的 chunk 总数）；裁剪后物理起点
 * = fromVersion - 裁剪量，指针落后裁剪线时钳制到 0（保留区全量重放，内容层面无重复）。
 * 返回 null = 无新增（fromVersion 已是最新）。
 * 注意：本函数只保证返回内容不与「指针语义上的已回放区间」重复；xterm.write 是追加
 * 语义，视图侧需配合 replayChunksBatched 的 clamped 信号先清屏（S-15，见下）。
 */
export function replayChunks(buffer: TerminalBuffer, fromVersion: number): string | null {
  if (fromVersion >= buffer.version) return null
  const cropped = buffer.version - buffer.chunks.length
  const physicalStart = Math.max(fromVersion - cropped, 0)
  return buffer.chunks.slice(physicalStart).join('')
}

/**
 * 分批版本回放（Fix-5）：replayChunks 的全量单串合并（5000 chunks × 4KB ≈ 20MB 一次
 * write 会卡住主线程）拆成每批 ≤ maxBatchChunks 个 chunk 的批次数组，由视图侧分帧写
 * （TerminalView enqueueReplayWrites）。物理起点/幂等语义与 replayChunks 完全一致。
 * 返回 null = 无新增；targetVersion = 本批覆盖的最终版本（视图回放指针推进目标）。
 *
 * clamped（S-15，PR #175 R1）：指针落后裁剪线（fromVersion < 裁剪量）时 physicalStart
 * 被钳到 0、保留区全量重放。xterm.write 是追加语义，若视图屏上旧内容与全量重放区间
 * 重叠（指针失步场景：通知丢失/批量挂起/多视图），全量重写会重复显示——视图收到
 * clamped=true 必须先 xterm.clear() + 丢挂起批次再写（对齐 TerminalView onFlushed 的
 * version 回退 clear 模式）。当前可达路径（mount/切 session/clear 后，指针恒为 0 且
 * xterm 空或新建）clear 幂等无害；本信号同时是防御性守卫。
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

/**
 * terminal per-session 状态 + PTY 控制的组件视图层。
 *
 * @param sessionIdRef session id ref（string | null）
 * @returns current（按组件 sidRef 读模块分区的 computed）+ PTY 控制 + flush 监听注册
 */
export function useTerminal(sessionIdRef: Ref<string | null>) {
  // 模块分区视图（读/写语义拆分，Fix-2）：null sid 或「分区不存在/已 cleanup」返回
  // 临时默认实例（不写 Map，同工厂语义）；依赖 mapVersion 让 cleanup（删分区）后本
  // computed 失效重算。禁止 create-on-read：deleteSession 流程中 cleanup 后、activeId
  // 回退到下一 session 之前若渲染重算，会重建已删 sid 的空分区且该 sid 不再被 cleanup
  // （永久泄漏，W27-4 原测试假阳性即因此漏检）。分区由写入方（updatePartition：
  // spawn/resize/appendChunk）创建并 bump mapVersion，本 computed 随之切到真实分区。
  const current: ComputedRef<TerminalPartition> = computed(() => {
    void mapVersion.value
    const sid = sessionIdRef.value
    if (sid === null) return createPartition()
    return partitions.get(sid) ?? createPartition()
  })

  /**
   * 注册本视图的增量回放监听（mount 调、unmount 反注册）：每次有内容的 flush 后调用，
   * 回调内按本视图已回放版本做增量 write。替代 W14 的 watch(flush 版本) 链。
   *
   * @param sid 所属 session
   * @param cb 收到最新 buffer 的回调（视图持有自己的回放指针，只写增量）
   * @returns 反注册函数
   */
  function registerFlushListener(sid: string, cb: (buffer: TerminalBuffer) => void): () => void {
    let set = flushListeners.get(sid)
    if (!set) {
      set = new Set()
      flushListeners.set(sid, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0) {
        flushListeners.delete(sid)
      }
    }
  }

  /** 创建 PTY（TerminalView mount 且 !ptyAlive 时调）。cwd 取 session.cwd。 */
  async function spawnTerminal(cwd: string | undefined, cols: number, rows: number): Promise<void> {
    const sid = sessionIdRef.value
    if (!sid) return
    // 订阅先于 spawn RPC 建立：PTY 输出在 alive 之后到达，订阅窗口覆盖全程
    ensureTerminalSubscription(sid)
    // 先记录尺寸
    updatePartition(sid, (s) => {
      s.cols = cols
      s.rows = rows
    })
    // RD-5#2：spawn 是 PTY 起不起来的权威点——await 无 catch 时失败既无日志也不显形
    // （调用方 void 丢弃 → 裸 reject + 用户看到空白终端）。此处留痕后 rethrow：反馈
    // 职责归调用方（TerminalView 渲染 inline 错误条 + 重试，复用 useFileTree error 态范式），
    // 本层不吞（吞了调用方无从分辨成功/失败）。
    try {
      await terminalApi.spawn({ sessionId: sid, cwd, cols, rows })
    } catch (e: unknown) {
      console.warn(`[terminal] spawn RPC 失败: sid=${sid}`, e)
      throw e
    }
    // 注：ptyAlive 由 terminal.alive 广播置位（异步），这里不等
  }

  /** 写入字节（用户输入）。TerminalView 的 xterm.onData 调。 */
  function writeToTerminal(data: string): void {
    const sid = sessionIdRef.value
    if (!sid) return
    // RD-5#4：fire-and-forget 必须留痕——击键流不 toast（PTY 死亡时 runtime 会广播
    // terminal.writeFailed 走上面的 toast 显示链），这里只 warn 保证 unhandled 不裸奔
    terminalApi.write(sid, data).catch((e: unknown) => {
      console.warn(`[terminal] write RPC 失败: sid=${sid}`, e)
    })
  }

  /** 调整尺寸（xterm fit addon 触发）。 */
  function resizeTerminal(cols: number, rows: number): void {
    const sid = sessionIdRef.value
    if (!sid) return
    updatePartition(sid, (s) => {
      s.cols = cols
      s.rows = rows
    })
    terminalApi.resize(sid, cols, rows).catch((e: unknown) => {
      console.warn(`[terminal] resize RPC 失败: sid=${sid} cols=${cols} rows=${rows}`, e)
    })
  }

  /** kill PTY（工具栏 kill 按钮）。 */
  function killTerminal(): void {
    const sid = sessionIdRef.value
    if (!sid) return
    terminalApi.kill(sid).catch((e: unknown) => {
      console.warn(`[terminal] kill RPC 失败: sid=${sid}`, e)
    })
  }

  /** 清屏（TerminalView clear 按钮）：重置当前 sid 分区 buffer + 通知监听器（Fix-3）。 */
  function clearTerminal(): void {
    const sid = sessionIdRef.value
    if (!sid) return
    clearPartition(sid)
  }

  /** 通知 PTY 活跃（TerminalView mount 调）。attach 保持 no-op 预留（09 §3.3.1 定案，不做源头过滤）。 */
  function attachTerminal(): void {
    const sid = sessionIdRef.value
    if (!sid) return
    // 幂等补订阅：切回 mount 时若 PTY 早已 alive（分区 ptyAlive=true），
    // 订阅可能已在旧实例清理外存活（模块级）——此处确保窗口覆盖
    ensureTerminalSubscription(sid)
    terminalApi.attach(sid).catch((e: unknown) => {
      console.warn(`[terminal] attach RPC 失败: sid=${sid}`, e)
    })
  }

  return {
    /** 当前 sid 分区状态（null sid 返回默认实例）。 */
    current,
    /** PTY 控制方法。 */
    spawnTerminal,
    writeToTerminal,
    resizeTerminal,
    killTerminal,
    clearTerminal,
    attachTerminal,
    /** flush 监听注册（TerminalView mount/unmount 编排）。 */
    registerFlushListener,
  }
}

/** useTerminal 返回类型（供组件 type import）。 */
export type UseTerminalReturn = ReturnType<typeof useTerminal>

// ── 测试专用 hooks（生产代码禁止调用，参照 core lru.ts _resetLruForTest 先例）──

/** 测试专用：清空模块级状态（分区/订阅/监听器 + bump mapVersion）。 */
export function __resetTerminalStateForTest(): void {
  partitions.clear()
  for (const unsub of subscriptionUnsubs.values()) unsub()
  subscriptionUnsubs.clear()
  subscribedSids.clear()
  flushListeners.clear()
  mapVersion.value += 1
}

/** 测试专用：当前分区数（断言 session 销毁后分区释放）。 */
export function __terminalPartitionCountForTest(): number {
  return partitions.size
}

/** 测试专用：已注册 flush 监听器总数（断言 session 销毁后监听清空，Fix-2 W27-4）。 */
export function __terminalFlushListenerCountForTest(): number {
  let count = 0
  for (const set of flushListeners.values()) count += set.size
  return count
}
