// connection-view —— 移动壳连接视图状态机（W6：连接 UI 态从 bootstrap 抽取收口的独立模块）。
//
// 拥有面（bootstrap 只装配不拥有）：
//   - shellConnectionState：连接视图四态（connecting/connected/token-input/failed）
//   - hasConnectedOnce：布局粘滞锚点（connected 置位后进程生命周期内不复位）——与四态
//     正交的变化轴（四态随时迁移，锚点只进不退），故不并入五态 enum：瞬时断连
//     （connected → connecting）保持 connected 布局挂载（composer 草稿不丢，BM5）
//   - tokenSubmit：token 提交反馈态（submitting / error）
//   - submitRemoteToken：token 重试入口（TokenInputView 提交路径）
//
// 三输入信号的转移优先级（显式收口于此，一处可读）：
//   ① core getState（watch）：connected 覆盖一切（退出 token-input / failed，置
//      hasConnectedOnce，收口 submitting）；token-input 粘滞——除 connected 外的
//      中间态（connecting/reconnecting/failed）均不覆盖 token-input（重试连接期间
//      保持输入视图，auth 结果落地时才切换）；其余映射 failed → failed（终态）、
//      其他 → connecting
//   ② onAuthRejected（ws-client，经 notifyAuthRejected）：仅「提交中」的拒绝才写
//      tokenSubmit.error='invalid'（用户刚提交的 token 被拒；非提交路径的拒绝如
//      storage 失效凭据，不误报错误）
//   ③ onTokenInputRequired（profile 凭据处置尾部，经 notifyTokenInputRequired）：
//      无条件落 token-input（凭据缺失与其他验身失败同视图同出口）
//   ④ onGoingAway（ws-client onclose 读 close 1001，D8）：置 runtimeRestarting 提示态
//      （断线条文案分流 restarting），不参与 shellConnectionState 转移；复位 = connected
//
// 依赖方向：bootstrap → connection-view（本模块不反向 import bootstrap；profile
// controller 由 bootstrap 创建后经 setupConnectionView 注入——闭包倒转，submitRemoteToken
// 与 auth 成功处置的操作面）。

import { computed, ref, watch } from 'vue'
import {
  disconnect,
  getState,
  initConnection,
  onGoingAway,
  resetAuthRejectionSuppression,
} from '@taiji/core'
import type { ConnectionCredentialController } from '../platform/connection-profile'

/**
 * 移动壳连接装配 UI 态（模块级响应式；App.vue 多视图消费）：
 * - 'connecting'：未连接（编排已提交 / 握手 auth 中 / 断线重连中）初值
 * - 'connected'：auth 通过（凭据有效）
 * - 'token-input'：凭据缺失或验身失败（D8 信号 / D4 皆无分支）——落 token 输入视图
 * - 'failed'：重连预算用尽（ws-client 60s → failed）——终态，UI 必须给可行动恢复指引
 *   而非无限期「连接中」（兜底长期接管 = 正常路径断裂）
 */
export type MobileShellConnectionState = 'connecting' | 'connected' | 'token-input' | 'failed'

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：移动壳连接装配四态（App.vue 多视图切换消费）
export const shellConnectionState = ref<MobileShellConnectionState>('connecting')

// 连接成功过至少一次（进程生命周期内不复位）：瞬时断连（connected → connecting）的
// 视图分支锚点——App.vue 据此保持 connected 布局挂载（composer 草稿不丢）仅插顶部
// 断线条，而非全屏换视图；首连（false）仍走全屏「连接中」。
export const hasConnectedOnce = ref(false)

/**
 * token 提交结果态（TokenInputView 消费）：提交编排进行中 / 验身失败的可见反馈。
 * 验身结果异步于提交编排（initConnection resolve = 编排已提交，auth 结果后续到），
 * submitting 的收口点 = auth 结果落地（watch connected / notifyAuthRejected）。
 */
export const tokenSubmit = ref<{ submitting: boolean; error: 'invalid' | 'failed' | null }>({
  submitting: false,
  error: null,
})

/**
 * 信号入口④（D8 重启感知）：服务端计划内关停窗口（ws-client onclose 读 close 1001 →
 * onGoingAway，P6 探针证实可读）置位；复位点 = 重连成功（watch connected 分支统一收口——
 * 服务回来了）。置位期间重连退避照常（ws-client 侧不改重连机制），本态只影响断线条文案
 * 分流（connectionBannerI18nKey），不改变 shellConnectionState 转移（不升级 failed 全屏）。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：重启窗口提示态（断线条文案分流依据）
export const runtimeRestarting = ref(false)

/**
 * 断线条文案 key 投影（App.vue banner 消费 `t(connectionBannerI18nKey)`）：重启窗口显示
 * restarting 文案，其余断线维持现状 reconnecting 文案（D8 文案区分，不改重连机制）。
 * key 的权威源 = src/locales/ 双侧文件（mobile.restarting / mobile.reconnecting），
 * 双侧对齐由 __tests__/mobile-locale.test.ts 守卫。
 */
export const connectionBannerI18nKey = computed(() =>
  runtimeRestarting.value ? 'mobile.restarting' : 'mobile.reconnecting',
)

/** setup 注入的凭据控制器（submitRemoteToken / auth 成功处置的操作面） */
let profileController: ConnectionCredentialController | null = null

/**
 * 连接视图装配入口（bootstrap 在 profile 创建后调用）：注入凭据控制器 + 建立 core
 * 连接态 → 视图态的转移 watch。bootstrap 只跑一次的装配前提下 watch 单份（重复调用
 * 会叠加 watch，不设防）。
 */
export function setupConnectionView(controller: ConnectionCredentialController): void {
  profileController = controller

  // 信号入口④接线（D8）：服务端计划内关停（close 1001）→ 置「重启中」提示态；
  // ws-client 侧重连退避照常，此处只落文案分流状态（不碰 shellConnectionState）。
  onGoingAway(() => {
    runtimeRestarting.value = true
  })

  // auth 结果 → UI 态（D4 处置接线）：connected = 验身成功（落 storage / 抹地址栏的时机，
  // 同时收口 token 提交 submitting + 复位重启提示态——服务回来了）；token-input 由
  // notifyAuthRejected / notifyTokenInputRequired 侧写入，不被中间连接态覆盖（重试连接
  // 期间保持输入视图，auth 结果落地时切换）；failed = 重连预算用尽（终态，UI 落可行动
  // 指引），token-input 优先级高于 failed。
  watch(getState(), (s) => {
    if (s === 'connected') {
      hasConnectedOnce.value = true
      shellConnectionState.value = 'connected'
      tokenSubmit.value.submitting = false
      runtimeRestarting.value = false
      void controller.handleAuthSuccess()
      return
    }
    if (shellConnectionState.value === 'token-input') return
    shellConnectionState.value = s === 'failed' ? 'failed' : 'connecting'
  })
}

/**
 * 信号入口③：凭据缺失 / 验身失败处置尾部通知（profile handleAuthFailure 尾部经 deps
 * 接线调用）——无条件落 token 输入视图（覆盖 connected / failed，凭据没了视图必须给
 * 恢复入口）。
 */
export function notifyTokenInputRequired(): void {
  shellConnectionState.value = 'token-input'
}

/**
 * 信号入口②：auth 被拒（ws-client onAuthRejected 经 ports 接线转发）。仅「提交中」的
 * 拒绝置可见错误（用户刚提交的 token 被拒 → invalid）；非提交路径的拒绝（如 storage
 * 失效凭据）不误报错误。凭据处置（来源分支清 storage / 保留 query）由 bootstrap 接线
 * 处的 profile.handleAuthFailure 承接，其尾部回调信号入口③落 token 输入视图。
 */
export function notifyAuthRejected(): void {
  if (tokenSubmit.value.submitting) {
    tokenSubmit.value = { submitting: false, error: 'invalid' }
  }
}

/**
 * token 重试路径（TokenInputView 提交 → 本入口，D8 reset 入口的壳侧形态）：
 * 采纳手输凭据（语义同 query 来源——验身成功才落 storage，失败不动既有 storage）→ 显式解除
 * ws-client 重连抑制位 → 清理当前连接残态 → 重走连接编排（initialised=true 走 use-connection
 * 重连路径，再次经 profile 解析时手输凭据被优先采纳）。
 */
export async function submitRemoteToken(token: string): Promise<void> {
  if (!profileController) {
    console.warn('[connection-view] submitRemoteToken before setup — ignored (run bootstrap() first)')
    return
  }
  tokenSubmit.value = { submitting: true, error: null }
  try {
    profileController.adoptManualToken(token)
    resetAuthRejectionSuppression()
    // auth 拒绝路径的 socket 已 close；此处 disconnect 兜底清理「连接中 / 握手超时窗口内提交」
    // 的残态（connect 幂等守卫会被 OPEN/CONNECTING 拦截，先断开保证重试必达）
    disconnect()
    await initConnection()
    // 编排提交成功；submitting 不在此清——auth 结果（connected / 拒绝）异步落地时收口，
    // 避免「提交中」与「验身中」两个阶段闪烁
  } catch (e) {
    console.error('[connection-view] submitRemoteToken failed:', e)
    tokenSubmit.value = { submitting: false, error: 'failed' }
  }
}
