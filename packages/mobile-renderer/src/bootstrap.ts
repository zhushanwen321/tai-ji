// bootstrap.ts —— mobile 壳 bootstrap 编排（TODO(P1) 已兑现：对接 core transport/coordination
// 序列，remote-use U1.3 连接装配）。
//
// 序列（core bootstrap 五步时序链的 mobile 子集；platform 先于连接编排由 await 链顺序保证，
// 同 core bootstrap 死锁防线）：
//   1. providePlatform(createMobilePlatformAdapter()) —— 注入 mobile 平台端口到 core
//   2. MOBILE_MOUNT_POINTS.forEach(registerMountPoint) —— 注册 §6.3 mobile 三挂载点
//   3. setConnectionPorts(mobile ports) —— 壳层端口注入（visibility/env/connectionProfile/
//      onAuthRejected），远程形态（无 ipc）走 use-connection 的 profile 分支
//   4. initConnection() → restoreSessions() —— core transport/coordination 序列
//      （resolve = 编排已提交，非 connected——core bootstrap D2 裁决②同语义）
//   5. createApp(App).use(createPinia()).mount('#app')
//
// 凭据派生（D4 三分支）在 platform/connection-profile.ts；auth 拒绝信号消费（D8：落 token
// 输入视图 + 凭据来源分支处置）经 ports.onAuthRejected 接线。连接态 / token 态以模块级响应式
// 状态 shellConnectionState 暴露（App.vue 多视图消费），token 重试入口 = submitRemoteToken。

import { createApp, ref, watch } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from './i18n'
import {
  disconnect,
  getState,
  initConnection,
  providePlatform,
  resetAuthRejectionSuppression,
  restoreSessions,
  setConnectionPorts,
} from '@taiji/core'
import App from './App.vue'
import {
  createConnectionProfilePort,
  type ConnectionCredentialController,
} from './platform/connection-profile'
import { createMobilePlatformAdapter } from './platform/mobile-platform-adapter'
import { MOBILE_MOUNT_POINTS, registerMountPoint } from './shell/mount-points'

/**
 * 移动壳连接装配 UI 态（模块级响应式；App.vue 多视图消费）：
 * - 'connecting'：未连接（编排已提交 / 握手 auth 中 / 断线重连中）初值
 * - 'connected'：auth 通过（凭据有效）
 * - 'token-input'：凭据缺失或验身失败（D8 信号 / D4 皆无分支）——落 token 输入视图
 */
export type MobileShellConnectionState = 'connecting' | 'connected' | 'token-input'

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：移动壳连接装配三态（App.vue 多视图切换消费）
export const shellConnectionState = ref<MobileShellConnectionState>('connecting')

/** bootstrap 装配的凭据控制器（token 重试路径 submitRemoteToken 的操作面） */
let profileController: ConnectionCredentialController | null = null

/**
 * token 重试路径（TokenInputView 提交 → 本入口，D8 reset 入口的壳侧形态）：
 * 采纳手输凭据（语义同 query 来源——验身成功才落 storage，失败不动既有 storage）→ 显式解除
 * ws-client 重连抑制位 → 清理当前连接残态 → 重走连接编排（initialised=true 走 use-connection
 * 重连路径，再次经 profile 解析时手输凭据被优先采纳）。
 */
export async function submitRemoteToken(token: string): Promise<void> {
  if (!profileController) {
    console.warn('[mobile-bootstrap] submitRemoteToken before bootstrap — ignored (run bootstrap() first)')
    return
  }
  profileController.adoptManualToken(token)
  resetAuthRejectionSuppression()
  // auth 拒绝路径的 socket 已 close；此处 disconnect 兜底清理「连接中 / 握手超时窗口内提交」
  // 的残态（connect 幂等守卫会被 OPEN/CONNECTING 拦截，先断开保证重试必达）
  disconnect()
  await initConnection()
}

// bootstrap —— mobile 壳启动编排。
export async function bootstrap(): Promise<void> {
  // 1. 注入 mobile 平台端口（core PlatformPort 单例；真实 adapter：localStorage + 原生 WebSocket）。
  const adapter = createMobilePlatformAdapter()
  providePlatform(adapter)

  // 2. 注册 §6.3 mobile B+D 子集三挂载点（pre-P4 本地 registrar）。
  MOBILE_MOUNT_POINTS.forEach((name) => registerMountPoint(name, {}))

  // 3. 壳层端口注入（远程 profile 形态：无 ipc；凭据派生 D4 + auth 拒绝消费 D8）。
  const profile = createConnectionProfilePort({
    storage: adapter.storage,
    host: location.host,
    search: location.search,
    // D4：query token 验身成功后抹地址栏（replaceState 不产生历史条目）；失败路径刻意保留
    // query（刷新重试入口，D4 显式判定）
    stripQuery: () => history.replaceState(null, '', location.pathname),
    onTokenInputRequired: () => {
      shellConnectionState.value = 'token-input'
    },
  })
  profileController = profile
  setConnectionPorts({
    visibility: {
      isVisible: () => document.visibilityState === 'visible',
      onVisibilityChange(handler: () => void): () => void {
        document.addEventListener('visibilitychange', handler)
        return () => document.removeEventListener('visibilitychange', handler)
      },
    },
    // mobile 壳无 mock 形态（mock 是桌面 dev 装配形态）；isDev 仅本地 fallback 端口派生消费，
    // 远程 profile 分支不触——恒 false。
    env: { isMock: false, isDev: false },
    connectionProfile: profile,
    // D8：auth 被拒 → 凭据来源分支处置（storage 失效清空 / query 不动好 storage）+ 落 token
    // 输入视图。重连抑制位由 ws-client 在信号触发时置位（scheduleReconnect + visibility
    // 两个自动重连触发点均短路）。
    onAuthRejected: () => {
      void profile.handleAuthFailure()
    },
    // effects = session 生命周期 / subagent / workflow 类下行的壳层接线点（桌面
    // useMessageEffects 注入）；移动壳 v1 无对应消费面（D7 面板族 Phase 2），回调全 optional
    // call，空对象安全。对话流主链不经此处（streamSubscribe per-session 通道 + config.sessions）。
    effects: {},
    // key 原文透传是终态而非兜底：t 消费的 connection 域留守桌面壳 locale（无 ui 组件消费，
    // 不入 ui locale 下沉域），移动壳 messages 无此域——透传 key 落在 pending reject 错误消息
    // 里，移动壳消费面 console-only（app-runtime toast 降级 console），可辨识不崩，无需装配文案
    t: (key: string) => key,
    onRuntimeUnavailable: () => {},
  })

  // auth 结果 → UI 态（D4 处置接线）：connected = 验身成功（落 storage / 抹地址栏的时机）；
  // token-input 由 onAuthRejected / onTokenInputRequired 侧写入，不被中间连接态覆盖（重试
  // 连接期间保持输入视图，auth 结果落地时切换）。
  watch(getState(), (s) => {
    if (s === 'connected') {
      shellConnectionState.value = 'connected'
      void profile.handleAuthSuccess()
      return
    }
    if (shellConnectionState.value !== 'token-input') {
      shellConnectionState.value = 'connecting'
    }
  })

  // 4. core transport/coordination 序列（远程 profile 分支：D4 凭据解析 → ws 连接发起）。
  await initConnection()
  await restoreSessions()

  // 5. 挂载 App（多视图：列表/聊天/token 输入；i18n 装配是 ui 组件 useI18n 的前置）。
  createApp(App).use(createPinia()).use(i18n).mount('#app')
}
