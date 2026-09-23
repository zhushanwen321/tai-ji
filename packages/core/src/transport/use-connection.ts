/**
 * use-connection —— 连接生命周期编排（core 版，架构审计 §10.2 D-1 迁移）。
 *
 * 迁自 renderer composables/useConnection.ts（266 行），保留所有运行时不变量：
 * - init()：发现 runtime 端口 → connect WS（mock 模式走 mock://）
 * - 监听 runtime 重启（onRuntimePort 推新端口 → 断开重连）
 * - visibility 主动重连（切回前台且未连接时用最近 url 重连，不干等指数退避最长 30s）
 * - teardown()：取消全部监听 + 断开
 * - 模块级单例副作用 + initialised/dispatcherInstalled 幂等守卫（保持）
 *
 * 端口发现顺序（不变）：
 *   1. env.isMock → connect('mock://')（ws-client 经 platform 注入 mock factory）
 *   2. ipc.getRuntimePort()（main 已 spawn）→ connect(ws://localhost:port)
 *   3. fallback：BASE_PORT + offset（dev 模式 +DEV_PORT_OFFSET）
 *
 * headless 化改造（core 零 DOM / 零构建环境读取 / 零 renderer import，§10.2）：
 * - visibilityState / addEventListener → visibility 端口（isVisible/onVisibilityChange）
 * - VITE_MOCK/DEV 环境标志 → env 端口（isMock/isDev）
 * - 对话流清理（chat finalize / extension UI pending）→ onRuntimeUnavailable 端口
 * - 入站 dispatcher 经 configureRouteInbound() 安装（缺省直连 transport/api 真实模块，
 *   D3 后壳层不再注入三件套），effects 经端口注入——本文件零 import 任何 store
 *   （renderer useMessageEffects 实现回调，§11.4）
 * - WS 能力复用 core ws-client（同一模块级单例）
 *
 * 依赖方向：use-connection → ws-client + transport/api/pending + coordination/route-inbound
 *   + shared（端口常量）。
 */
import { watch } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import { connect, disconnect, getState, onMessage, onQueueDrop, setFailed, setRestarting } from './ws-client'
import {
  configureRouteInbound,
  type InboundEffects,
} from '../coordination/route-inbound'
import { resubscribeAll } from '../coordination/subscription-state'
import * as pendingApi from './api/pending'
import { transportUnavailableError } from './errors'
import { BASE_PORT, DEV_PORT_OFFSET } from '@taiji/shared'

// ── 端口契约（§10.2 D-1：renderer 装配点注入实现） ─────────────────

/**
 * use-connection 的壳层端口面（D3 收窄后：全部是真随壳变化的端口）。
 *
 * renderer（composables/useConnection.ts 装配点）注入实现：
 * - ipc → lib/ipc（getRuntimePort/getRuntimePortOffset/onRuntimePort/restartRuntime 等）
 * - visibility → visibilityState + visibilitychange 监听（壳层 DOM 实现）
 * - env → VITE_MOCK / DEV（core 不能读构建环境标志，由壳读）
 * - effects → useMessageEffects（renderer 层 store 副作用，§11.4）
 * - t → 壳层 i18n
 * - onRuntimeUnavailable → runtime 崩溃/重启用尽时的对话流清理
 *
 * pending/events/subscribe 三件套已删除（D3）：入站分发与 pending 清理直连
 * core transport/api 真实模块，不再经壳注入。
 */
export interface ConnectionPorts {
  ipc: {
    getRuntimePort(): Promise<number | undefined>
    getRuntimePortOffset(): Promise<number | undefined>
    /**
     * 获取当前 runtime 的 WS auth token（S1-W1）。runtime 重启后值刷新（supervisor
     * 每次 spawn 重新生成）——onRuntimePort 重连路径必须重新调用本方法拿新 token。
     */
    getRuntimeToken(): Promise<string | null | undefined>
    onRuntimePort(cb: (port: number) => void): () => void
    onRuntimeRestarting(cb: () => void): () => void
    onRuntimeFailed(cb: () => void): () => void
    /**
     * 监听 runtime 启动失败（RD-3#2：main supervisor startAndNotify 失败 → runtime-error
     * 推送，payload { message }）。失败后 main 不会自动重试——收到即停徒劳自动重连。
     */
    onRuntimeError(cb: (error: { message: string }) => void): () => void
    /**
     * 拉取最近一次启动失败原因（RD-3#2 boot 竞态兜底）：runtime-error 推送可能早于本
     * 编排的监听安装（main whenReady 发事件时 renderer 尚未挂载，webContents.send 静默
     * 丢失），init 时主动拉取对齐「时序竞争必须主动拉取」规则。null = 无已知失败。
     */
    getRuntimeStartError(): Promise<string | null>
    restartRuntime(): Promise<void>
  }
  visibility: {
    isVisible(): boolean
    onVisibilityChange(handler: () => void): () => void
  }
  env: {
    isMock: boolean
    isDev: boolean
  }
  effects: InboundEffects
  t(key: string, params?: Record<string, unknown>): string
  /** runtime 崩溃/重启用尽清理（renderer 实现：chat finalize + extension UI pending 清理） */
  onRuntimeUnavailable(reason: 'restart' | 'disconnect'): void
}

// ── 端口注入（C1 范式：模块级实现变量 + 注入函数 + 未注入 warn 降级） ──

let portsImpl: ConnectionPorts | null = null

/** 注入壳层端口（renderer 装配点调用；幂等，重复注入用最新实现）。 */
export function setConnectionPorts(ports: ConnectionPorts): void {
  portsImpl = ports
}

/** 读取端口；未注入时 warn 并返回 null（调用方 return 降级，不抛不挂起，对齐 subscription-state）。 */
function requirePorts(): ConnectionPorts | null {
  if (!portsImpl) {
    console.warn(
      '[core/use-connection] ConnectionPorts not injected — call setConnectionPorts() (renderer assembly) before useConnection().init()',
    )
  }
  return portsImpl
}

// ── 模块级单例状态（W4/幂等守卫） ─────────────────────────────────

let dispatcherInstalled = false
let removeTransportListener: (() => void) | null = null
let initialised = false
let removeRuntimePortListener: (() => void) | null = null
let removeRuntimeRestartingListener: (() => void) | null = null
let removeRuntimeFailedListener: (() => void) | null = null
let removeRuntimeErrorListener: (() => void) | null = null
let removeStateWatch: (() => void) | null = null
/** pre-auth 队列丢弃监听的取消函数（ws-client onQueueDrop 单槽；teardown 时调用；非空即已安装） */
let removeQueueDropListener: (() => void) | null = null
/** visibility 监听的取消函数（teardown 时调用；非空即已安装） */
let removeVisibilityListener: (() => void) | null = null
/**
 * 最近一次 connect 使用的 url（W4 visibility 重连复用）。
 * 用户从后台切回前台且未连接时，用此 url 主动重连，不干等 ws-client 指数退避（最长 30s）。
 * null 表示从未连过（此时也无 url 可复用，visibility 不触发重连）。
 */
let lastConnectedUrl: string | null = null

// ── 断连宽限兜底（review findings-confirmation #1.2：纯网络断连零复位缺口）──

/**
 * 网络断连宽限期：断连后不立即收口在途流，宽限期内重连成功则由 ring 回放 / live 事件
 * 驱动正常收口；到期仍未恢复才调 onRuntimeUnavailable 收口（streaming 态不再挂到
 * streaming timer 10min）。取 10s 的依据：重连退避序列 1s+2s+4s=7s < 10s（覆盖 2-3 次
 * 退避尝试，秒级网络抖动无收口噪音）；gate v4 实测 30s 断连场景在 10s 即复位。
 */
export const DISCONNECT_GRACE_MS = 10_000

/** 宽限 timer（模块级单例，随 stateWatch 生命周期；teardown 清理）。null = 未 armed。 */
let disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null

function clearDisconnectGrace(): void {
  if (disconnectGraceTimer) {
    clearTimeout(disconnectGraceTimer)
    disconnectGraceTimer = null
  }
}

/**
 * 网络断连宽限：到期仍非 connected → 收口在途流。
 *
 * 收口时机语义论证（「立即收口」被否决的原因）：网络断连大概率短暂可恢复（退避重连
 * 1-30s），重连成功后 runtime MessageBus ring 回放补齐断连窗口内的 message.complete
 * （gate v4 已证实该回放链内容级工作）。若断连瞬间立即 finalizeAllStreaming，在途流被
 * 收口为 error 态，回放的 message.complete 因 sealed 守卫（D-010：complete handler 只
 * 收口 status==='streaming' 的实体）无法覆盖已收口的 error——可恢复的流被不可逆误伤。
 * 故选「等重连结果 + 超时兜底」：到期时已重连成功则不收口（回放失败子场景仍由既有
 * streaming timer 10min 兜底——不以误伤重连后在途流为代价缩短它）；到期仍断连才收口
 * （网络中断超宽限，error 语义成立）。IPC 崩溃路径（restarting/failed）不走宽限：进程
 * 没了流物理不可能恢复，立即收口（见 stateWatch）。
 *
 * 已 armed 则不重置：从首次断连起算单窗口，断连/恢复 flapping 下累计宽容有界。
 */
function armDisconnectGrace(): void {
  if (disconnectGraceTimer !== null) return
  disconnectGraceTimer = setTimeout(() => {
    disconnectGraceTimer = null
    if (getState().value !== 'connected') {
      currentPorts().onRuntimeUnavailable('disconnect')
    }
  }, DISCONNECT_GRACE_MS)
}

/**
 * 安装入站分发器（幂等：仅安装一次）。onMessage 占用 ws-client 单槽。
 *
 * configureRouteInbound 缺省直连 transport/api 真实模块（D3：pending/events/subscribe
 * 三件套不再经壳注入）+ 注入 effect 回调（session.exited/message.complete/
 * session.subagents/session.workflowUpdate/全局 error），内部 setSubscriptionPorts 把
 * subscribe RPC + replay dispatcher 灌入 core subscription-state（gap 检测副作用依赖）。
 *
 * dispatcher 可选注入（D9）——core 内部测试 seam，与 configureRouteInbound 的可选 ports
 * 同体例，不出现在壳装配面（壳装配仍只调 useConnection().init()）：注入时直接安装
 * （不调 configureRouteInbound，defaultPorts 不参与），测试可经真实 configureRouteInbound
 * 的 TransportPorts 显式传参替换三件套，消 vi.mock 模块内部；缺省按现状构造，生产行为不变。
 */
export function ensureDispatcher(
  ports: ConnectionPorts,
  dispatcher?: (msg: ServerMessage) => void,
): void {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  // route-inbound 是消息分发单一真相源（ADR-0060：raw-message-tap 旁路已移除）。
  // ExtensionHost 经 events.onCrossSession/onGlobal 正规通道订阅。
  removeTransportListener = onMessage(dispatcher ?? configureRouteInbound(undefined, ports.effects))
}

/**
 * 连接 WS 并记录 url（W4 visibility 重连复用）。
 * 包装 ws-client connect：调前把 url 存入 lastConnectedUrl，供用户切回前台时主动重连。
 * token（S1-W1）透传给 ws-client：传值时 open 后走 auth 握手；未传时 ws-client 复用
 * 上次 token（内部退避重连场景，runtime 未重启 token 不变）。
 */
function connectWs(url: string, token?: string): void {
  lastConnectedUrl = url
  connect(url, token)
}

/**
 * 拉取最新 token 后连接（runtime 重启路径专用：supervisor 每次 spawn 重新生成 token，
 * 旧 token 对新 runtime 无效，auth 必失败——必须先 invoke 拿新值）。
 */
async function refreshTokenAndConnect(url: string): Promise<void> {
  let token: string | null | undefined
  try {
    token = await currentPorts().ipc.getRuntimeToken()
  } catch (e) {
    console.warn('[core/use-connection] getRuntimeToken failed, connecting without token:', e)
    token = undefined
  }
  connectWs(url, token ?? undefined)
}

/** 当前注入端口（requirePorts 已在 init 校验，此处于事件回调内兜底取值） */
function currentPorts(): ConnectionPorts {
  return portsImpl as ConnectionPorts
}

/** 获取 fallback 端口（考虑 dev 偏移） */
async function resolveFallbackPort(ports: ConnectionPorts): Promise<number> {
  const offset = await ports.ipc.getRuntimePortOffset()
  if (offset !== undefined) return BASE_PORT + offset
  // DEV 环境下 runtime 在 BASE_PORT+100，不能 fallback 到 prod 端口
  if (ports.env.isDev) return BASE_PORT + DEV_PORT_OFFSET
  return BASE_PORT
}

export function useConnection() {
  const state = getState()

  async function init(): Promise<void> {
    const ports = requirePorts()
    if (!ports) return

    // 入站消息分发器在任何模式下都安装（mock 模式仅收到 pong，无副作用）
    ensureDispatcher(ports)

    // W4：安装 visibilitychange 监听（幂等——removeVisibilityListener 守卫防重复注册）。
    // 用户从其它标签页 / 系统切回应用（visibilityState 变 visible）且当前未连接时，
    // 用最近一次 url 主动重连，不干等 ws-client 指数退避（最长 30s）。
    if (!removeVisibilityListener) {
      removeVisibilityListener = ports.visibility.onVisibilityChange(() => {
        // 守卫 1：只有切回可见（visible）才重连，切到后台（hidden）不触发
        if (!ports.visibility.isVisible()) return
        // 守卫 2：已连接就不重连（避免无谓连接触发）
        if (getState().value === 'connected') return
        // 守卫 3：从未连过（无 url 复用）则不触发
        if (!lastConnectedUrl) return
        connectWs(lastConnectedUrl)
      })
    }

    if (initialised) {
      // HMR 后重连
      if (!ports.env.isMock) {
        await refreshTokenAndConnect('ws://localhost:' + await resolveFallbackPort(ports))
      }
      return
    }
    initialised = true

    // L10：WS 连接状态监听在任何模式都安装（含 mock），确保 mock 断连时也 rejectAll pending。
    // 此前在 mock 分支之后，mock 模式跳过安装 → mock 断连时 pending 永不 reject。
    // M1（W09 follow-up）：connected false→true 迁移时恢复全部 bus 订阅——runtime 侧
    // ws onDisconnect → bus.unsubscribeAll(ws) 已清空该连接订阅，core 侧幂等守卫
    // （subscribed 标记）不会自行失效，不主动重发则重连后 session 级消息永久丢失
    // （W09 删除 broadcast 兜底腿后 publish 定向推送是唯一通道）。首次连接时
    // subscriptionStates 为空 → no-op，无副作用。
    //
    // [review findings-confirmation #1.2] 本 watch 是断连清理的**单一汇合点**：网络断连
    // （onclose → disconnected/reconnecting）与 IPC 崩溃（setRestarting/setFailed 置态）
    // 都经 state 迁移在此汇合调 pending.rejectAll + onRuntimeUnavailable（消两份触发逻辑）。
    // IPC 监听器（onRuntimeRestarting/onRuntimeFailed）只负责置态，不再各自携带清理副本。
    const stopStateWatch = watch(getState(), (newState, oldState) => {
      // IPC 崩溃路径：进入 restarting/failed 即收口——任何旧态进入均适用（含未连上 /
      // 重试中 runtime 崩溃，对齐原 IPC 监听器无条件清理语义）。runtime 崩溃 = pi 子进程
      // 没了 = 流物理不可能恢复，不走断连宽限（等下去没有意义），且清掉已 armed 的宽限
      // timer（避免到期二次触发）。
      if (newState === 'restarting' || newState === 'failed') {
        pendingApi.rejectAll(
          transportUnavailableError(
            ports.t(newState === 'restarting' ? 'connection.runtimeRestarting' : 'connection.runtimeUnavailable'),
          ),
        )
        clearDisconnectGrace()
        ports.onRuntimeUnavailable(newState === 'restarting' ? 'restart' : 'disconnect')
        return
      }
      if (oldState === 'connected' && newState !== 'connected') {
        // 网络断连路径（ws onclose → disconnected/reconnecting）：code='disconnected' 供调用方
        // （useFileTree catch 等）识别传输断开类失败——构造统一走 transport/errors 工厂单点
        // （与 request.ts send-fail reject 同源，D10①）。
        pendingApi.rejectAll(transportUnavailableError(ports.t('connection.disconnectedError')))
        // 在途流不立即收口：等重连结果（ring 回放补齐终态），DISCONNECT_GRACE_MS 超时兜底。
        // 语义论证见 armDisconnectGrace 注释。
        armDisconnectGrace()
      }
      if (newState === 'connected' && oldState !== 'connected') {
        resubscribeAll()
      }
    })
    removeStateWatch = stopStateWatch

    // pre-auth 队列丢弃 → 立即 reject 对应 pending（任何模式都安装，对齐 stateWatch 体例）。
    // 队列消息与 request 层 pending 一一对应：TCP open → auth.result 窗口内 send() 入队的
    // 消息在 auth 失败 / 断连清队时永无 reply，若不在此 reject，pending 要等 request 层
    // 65s sweep 才收口。错误构造走 transport/errors 工厂单点（code='disconnected' 供调用方
    // 识别传输断开类失败）；无 id 消息（非 RPC 型，如 flush 前 close 的 notify）无 pending 可收，跳过。
    if (!removeQueueDropListener) {
      removeQueueDropListener = onQueueDrop((msgs) => {
        for (const msg of msgs) {
          if (typeof msg.id !== 'string') continue
          pendingApi.reject(msg.id, transportUnavailableError(ports.t('connection.disconnectedError')))
        }
      })
    }

    // mock 模式：走 mock，不需要端口发现，也不监听 runtime 崩溃事件（mock 无 runtime 进程）
    if (ports.env.isMock) {
      connectWs('mock://localhost')
      return
    }

    // 监听 runtime 端口推送（runtime 重启成功后推新端口 → 断开重连）。
    // S1-W1：runtime 重启 = supervisor 重新 spawn = token 已刷新，重连前必须重新拉取
    // （旧 token 对新 runtime 的 auth 必失败 → 1008 → 重连循环直到 failed）。
    removeRuntimePortListener = ports.ipc.onRuntimePort((newPort) => {
      if (newPort && state.value !== 'disconnected') {
        disconnect()
        void refreshTokenAndConnect('ws://localhost:' + newPort)
      }
    })

    // 监听 runtime 崩溃重启中（主进程正在拉起新实例 → 进 restarting 态，停自动重连）。
    // [review findings-confirmation #1.2] 监听器只置态；pending 清理 + 对话流收口
    // （onRuntimeUnavailable）统一在 stateWatch 汇合点执行（restarting 迁移分支），
    // 不在此携带副本——网络断连与 IPC 崩溃两条路径同一处触发。
    // runtime 崩溃 = pi 子进程没了 = 流不可能继续，收口语义（chat 活跃态重置 + ask-user
    // pending 清空，T5）见 stateWatch / onRuntimeUnavailable 注释。
    removeRuntimeRestartingListener = ports.ipc.onRuntimeRestarting(() => {
      setRestarting()
    })

    // 监听 runtime 重启用尽（主进程放弃 → 进 failed 态，等用户手动重试）。
    // 同上：只置态，清理经 stateWatch 的 failed 迁移分支汇合触发。
    removeRuntimeFailedListener = ports.ipc.onRuntimeFailed(() => {
      setFailed()
    })

    // RD-3#2：runtime 启动失败（boot 的 startAndNotify 失败——binary 缺失/端口占用等）。
    // 失败后 main 不会自动重试，WS 对 fallback 端口的重试必不可能成功：收到推送即置
    // failed（用户拿到重试入口），不再干等 60s 重连时长上限。connected 守卫防极端误伤：
    // waitForHealth 超时但 runtime 实际存活时推送与活连接并存，不干扰已建立的连接。
    removeRuntimeErrorListener = ports.ipc.onRuntimeError(() => {
      if (getState().value !== 'connected') {
        setFailed()
      }
    })

    // 启动失败真因拉取（boot 竞态兜底）：推送早于本监听安装时（main whenReady 启动失败
    // 先于 renderer 挂载——boot 失败的主形态），推送已丢，init 主动拉取一次。有失败记录
    // 说明 runtime 已死且 main 不会自动拉起 → 直接置 failed 短路徒劳自动重连（真因显示
    // 在连接屏 failed 分支，由壳层 App.vue 经 lib/ipc 拉取渲染；本编排只管状态转移）。
    const startError = await ports.ipc.getRuntimeStartError()
    if (startError) {
      setFailed()
      return
    }

    // 尝试从主进程获取已知端口（S1-W1：连接前拉 token——auth 握手凭据经 IPC 下发）
    const knownPort = await ports.ipc.getRuntimePort()
    if (knownPort) {
      await refreshTokenAndConnect('ws://localhost:' + knownPort)
      return
    }

    // Runtime 尚未启动：用 fallback 端口（ws-client 会自动重连，runtime 起来后连上）
    await refreshTokenAndConnect('ws://localhost:' + await resolveFallbackPort(ports))
  }

  /**
   * 手动重试（用户从「runtime 不可用」状态条点重试触发）。
   * 委托 IPC runtime-restart → 主进程 supervisor.restartRuntime。
   * supervisor 重启成功会广播 runtime-port（onRuntimePort 监听自动重连）。
   */
  async function retryRuntime(): Promise<void> {
    const ports = requirePorts()
    if (!ports) return
    await ports.ipc.restartRuntime()
  }

  function teardown(): void {
    if (removeRuntimePortListener) {
      removeRuntimePortListener()
      removeRuntimePortListener = null
    }
    if (removeRuntimeRestartingListener) {
      removeRuntimeRestartingListener()
      removeRuntimeRestartingListener = null
    }
    if (removeRuntimeFailedListener) {
      removeRuntimeFailedListener()
      removeRuntimeFailedListener = null
    }
    if (removeRuntimeErrorListener) {
      removeRuntimeErrorListener()
      removeRuntimeErrorListener = null
    }
    if (removeStateWatch) {
      removeStateWatch()
      removeStateWatch = null
    }
    // pre-auth 队列丢弃监听随 stateWatch 一同拆卸（teardown 后不应再有 pending reject 回调）
    if (removeQueueDropListener) {
      removeQueueDropListener()
      removeQueueDropListener = null
    }
    // 断连宽限 timer 随 stateWatch 一同拆卸（teardown 后不应再有收口回调）
    clearDisconnectGrace()
    // W4：卸载 visibilitychange 监听（与 init 的安装配对，防内存泄漏 + 重复触发）
    if (removeVisibilityListener) {
      removeVisibilityListener()
      removeVisibilityListener = null
    }
    if (removeTransportListener) {
      removeTransportListener()
      removeTransportListener = null
    }
    dispatcherInstalled = false
    disconnect()
    initialised = false
    lastConnectedUrl = null
  }

  return { state, init, teardown, retryRuntime }
}
