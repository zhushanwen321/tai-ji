// bootstrap.ts —— mobile 壳纯装配编排（连接 UI 状态机已抽至 shell/connection-view，
// W6；本模块不再拥有任何连接视图态）。
//
// 序列（core bootstrap 时序链的 mobile 子集；platform 先于连接编排由 await 链顺序保证，
// 同 core bootstrap 死锁防线）：
//   1. providePlatform(createMobilePlatformAdapter()) —— 注入 mobile 平台端口到 core
//   2. createConnectionProfilePort（凭据派生 D4 三分支，onTokenInputRequired 接线到
//      connection-view 信号入口）+ setupConnectionView（连接视图状态机装配：controller
//      注入 + 转移 watch 建立）
//   3. setConnectionPorts(mobile ports) —— 壳层端口注入（visibility/env/connectionProfile/
//      onAuthRejected），远程形态（无 ipc）走 use-connection 的 profile 分支
//   4. initConnection() → restoreSessions() —— core transport/coordination 序列
//      （resolve = 编排已提交，非 connected——core bootstrap D2 裁决②同语义）
//   5. createApp(App).use(createPinia()).mount('#app')
//
// 凭据派生（D4 三分支）在 platform/connection-profile；连接视图态（四态 + hasConnectedOnce
// 粘滞锚点 + tokenSubmit）与三信号转移优先级在 shell/connection-view.ts——依赖方向
// bootstrap → connection-view，App.vue / 测试直接消费 connection-view 导出。

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from './i18n'
import { createLifecycleEffects } from '@taiji/core'
import { chatStore, sessionStore } from './shell/app-runtime'
import {
  errorBarEffects,
  resetCompanionChannelsForExitedSession,
} from './shell/companion-bridge'
import { initConnection, providePlatform, restoreSessions, setConnectionPorts } from '@taiji/core'
import App from './App.vue'
import { applySubagentRecords } from './views/SubagentStatusLine.vue'
import { createConnectionProfilePort } from './platform/connection-profile'
import { createMobilePlatformAdapter } from './platform/mobile-platform-adapter'
import {
  notifyAuthRejected,
  notifyTokenInputRequired,
  setupConnectionView,
} from './shell/connection-view'

// vue-i18n 的 t 复杂重载收窄为 (key, params?) => string（对齐 app-runtime 同款收窄）
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

// session 生命周期 core 语义实例（remote-use D5/U6）：exited/restored/restoreFailed 的
// 最小语义（markSessionError/markDead/流式终结/订阅簿记失效/恢复窗口订阅/revive/重订阅/
// 恢复提示条两形态）单一归属 core factory。文案 bootstrap 期一次求值即可——移动壳无语言
// 切换链（locale 由 navigator.language 启动检测定死），与桌面逐回调 t() 求值的差异仅在此。
const lifecycleEffects = createLifecycleEffects(
  { chat: chatStore, session: sessionStore },
  {
    restored: t('panel.message.respawnRestored'),
    restoreFailed: t('panel.message.respawnFailed'),
  },
)

// 壳层 effects 回调集（remote-use D5/U6/U15；模块级提取供 __testing 装配断言消费）。
// 全 optional call（core InboundEffects 回调全可选）。三段来源：
// - 生命周期三回调 = core lifecycle factory（上文 lifecycleEffects）；
// - onSessionExited 壳扩展段 = exited 分通道重置（companion-bridge 出口：dialog
//   queue.resetFor + form Map 具名清理，M8 防御；禁走 triggerSessionCleanups 销毁语义）；
// - onSessionError/onGlobalError = U14 错误条回调（errorBarEffects）；
// - onSubagents = 壳侧直挂 applySubagentRecords（U15/A9：写 subagent 分区驱动运行状态行；
//   factory 不含 subagent 语义，接线位在壳扩展层，D5 去留表）。
// D5 去留表：onMessageComplete/onWorkflowUpdate/onSubagentEntries 本波不接
//（W4 通知体系 / 桌面面板族）。
const shellEffects = {
  ...errorBarEffects,
  onSessionExited: (sessionId: string, payload: { code: number | null; reason: string }) => {
    // core 序列先落（错误消息/dead 态 UI 反馈先行，factory 保序契约），随后壳扩展清理，
    // 末尾恢复窗口订阅（restored/restoreFailed live 送达的唯一通路，D5 单一归属 factory）
    lifecycleEffects.markSessionDead(sessionId, payload.reason)
    resetCompanionChannelsForExitedSession(sessionId)
    lifecycleEffects.openRestoreWindow(sessionId)
  },
  onSessionRestored: lifecycleEffects.onSessionRestored,
  onSessionRestoreFailed: lifecycleEffects.onSessionRestoreFailed,
  onSubagents: applySubagentRecords,
}

// 测试后门命名空间（生产代码禁止消费，对齐 app-runtime __testing 先例）：
// 壳 effects 装配断言入口——接线位断言（onSubagents 与壳模块导出同源直挂、非 factory 内）。
export const __testing = { shellEffects }

// bootstrap —— mobile 壳启动编排。
export async function bootstrap(): Promise<void> {
  // 1. 注入 mobile 平台端口（core PlatformPort 单例；真实 adapter：localStorage + 原生 WebSocket）。
  const adapter = createMobilePlatformAdapter()
  providePlatform(adapter)

  // 2. 连接视图状态机装配 + 凭据派生端口：profile controller 注入 connection-view
  //    （submitRemoteToken / auth 成功处置的操作面）；onTokenInputRequired 落视图信号入口。
  const profile = createConnectionProfilePort({
    storage: adapter.storage,
    host: location.host,
    // WS scheme 派生源：http: → ws://，https: → wss://（wsUrlFromHost）
    protocol: location.protocol,
    search: location.search,
    // D4：query/manual 凭据验身成功后抹地址栏（replaceState 不产生历史条目；manual 同抹——
    // 手输前地址栏可能残留旧 ?token=，不抹则刷新时旧值压过已落盘新凭据成循环）；失败路径
    // 刻意保留 query（刷新重试入口，D4 显式判定）
    stripQuery: () => history.replaceState(null, '', location.pathname),
    // 凭据缺失 / 验身失败处置尾部落 token 输入视图（connection-view 信号入口③）
    onTokenInputRequired: notifyTokenInputRequired,
  })
  setupConnectionView(profile)

  // 3. 壳层端口注入（远程 profile 形态：无 ipc；凭据派生 D4 + auth 拒绝消费 D8）。
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
    // D8：auth 被拒 → 连接视图信号（仅提交中的拒绝置可见错误，判定在 connection-view）+
    // 凭据来源分支处置（storage 失效清空 / query 不动好 storage，处置尾部经
    // onTokenInputRequired 落 token 输入视图）。重连抑制位由 ws-client 在信号触发时置位
    // （scheduleReconnect + visibility 两个自动重连触发点均短路）。
    onAuthRejected: () => {
      notifyAuthRejected()
      void profile.handleAuthFailure()
    },
    // effects = session 生命周期 / 错误类下行 / subagent 运行态的壳层接线点
    //（remote-use D5/U6/U15；此前 S6 全弃——`effects: {}` 使会话崩溃不 markDead、流式无人
    // 终结、无恢复提示）。回调集来源见上方 shellEffects 定义段。
    effects: shellEffects,
    // t 必须真实现而非 key 透传：core 用它构造断连错误消息（connection.disconnectedError /
    // runtimeRestarting / runtimeUnavailable），消息经 session store listLoadError / pending
    // reject 流入用户可见 UI（列表 loadError role=alert）。透传 key 会把裸 key 直出给用户。
    // i18n.global.t 的复杂重载收窄为 (key, params?) => string（对齐 app-runtime 同款收窄）。
    t: i18n.global.t as (key: string, params?: Record<string, unknown>) => string,
    // 断连/重启用尽的对话流收口（对齐桌面 useMessageEffects.handleRuntimeUnavailable，减去
    // extensionUI clearAllPending——移动壳无 extension UI）：断连宽限（10s）到期或重连放弃
    // （failed）时，把在途 streaming 消息落终态、错误作为 assistant 消息插入对话流（项目
    // 规则#3：错误必须重置状态）。不接线 = 断连后 composer 永久卡「生成中」。
    onRuntimeUnavailable: (reason) => {
      chatStore.finalizeAllStreaming(reason)
    },
  })

  // 4. core transport/coordination 序列（远程 profile 分支：D4 凭据解析 → ws 连接发起）。
  await initConnection()
  await restoreSessions()

  // 5. 挂载 App（多视图：列表/聊天/token 输入；i18n 装配是 ui 组件 useI18n 的前置）。
  createApp(App).use(createPinia()).use(i18n).mount('#app')
}
