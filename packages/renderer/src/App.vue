<template>
  <!-- 非连接态分三种展示：
       - connecting/disconnected/reconnecting：logo + 「连接中…」（过渡屏）
       - restarting：logo + 「runtime 重启中…」（崩溃自动恢复，主进程在拉起新实例）
       - failed：logo + 错误提示 + 重试按钮（自动重启用尽，需用户手动触发）
       连接后渲染 AppShell。 -->
  <div v-if="connectionState !== 'connected'" class="connecting-screen grid h-screen w-screen place-items-center bg-bg">
    <div class="flex flex-col items-center gap-4">
      <TaijiLogo :size="48" class="text-accent" />
      <!-- runtime 重启中 -->
      <template v-if="connectionState === 'restarting'">
        <Loader2 class="size-4 animate-spin text-neutral-dim" />
        <span class="text-[12.5px] text-neutral-dim">{{ t('connection.restarting') }}</span>
      </template>
      <!-- runtime 重启用尽，需手动重试。runtimeStartError = 最近一次启动失败真因
           （RD-3#2：binary 缺失/端口占用等，main 经 runtime-error 推送/拉取兜底到达；
           通用 failed 文案保留为兜底，真因到达即补充显示） -->
      <template v-else-if="connectionState === 'failed'">
        <AlertCircle class="size-5 text-danger" />
        <span class="text-[12.5px] text-neutral-mid">{{ t('connection.failed') }}</span>
        <span
          v-if="runtimeStartError"
          data-testid="runtime-error-cause"
          class="max-w-[320px] text-center text-[11.5px] text-neutral-dim"
        >{{ t('connection.errorCause', { message: runtimeStartError }) }}</span>
        <Button variant="default" size="sm" data-testid="runtime-retry-btn" @click="onRetry">
          {{ t('connection.retry') }}
        </Button>
      </template>
      <!-- 默认连接中（connecting/disconnected/reconnecting） -->
      <span v-else class="text-[12.5px] text-neutral-dim">{{ t('connection.connecting') }}</span>
    </div>
  </div>
  <template v-else>
    <!-- L0 Shell 挂载点。traffic light 安全区在 AsideRegion 内（padding-top:52px，spec §三）。 -->
    <AppShell />
  </template>
  <!-- Toast 通知：不再在根部固定挂载——ToastContainer 改 absolute 右上角锚定，挂载点
       收敛到 main-panel 内两分支（PanelContainer main-area（chat 主区）/ MainPanel
       settings 兜底），避免遮 composer 与 drawer。 -->
  <!-- renderer 崩溃恢复一次性提示条（T2）：窗口级，URL query 标志驱动
       （main 侧 reloadWindowAfterCrash 注入），useCrashRecoveryNotice 消费即清除标志
       （手动刷新不重现）。挂根部使 connecting 过渡屏/主界面两态均可见。 -->
  <CrashRecoveredBar />
  <!-- RD-3#7：ToastContainer 上提根部——连接前（connecting/failed/restarting）也渲染，让启动期
       错误（如渲染异常 toast）有 UI 留痕。connected 态仍由 PanelContainer main-area / MainPanel
       内的挂载点承接（保持 drawer 感知定位、恒不遮 drawer），故此处仅非连接态挂载——两态均渲染、
       不双实例。 -->
  <ToastContainer v-if="connectionState !== 'connected'" />
  <!-- RD-3#11：内存压力提示条（最小可见形态）——useMemoryPressure 的 level 接入 UI 消费方。
       warn/critical 时显示，用户据此行动；level 无 normal 回弹（协议 normal 不广播），dismiss 后
       level 变化（升级）经 watch 重显。fixed 顶部居中，零布局侵入（同 CrashRecoveredBar 定位范式）。 -->
  <div
    v-if="memoryLevel !== 'normal' && !memoryBarDismissed"
    data-testid="memory-pressure-bar"
    class="fixed left-1/2 top-3 z-[9999] flex max-w-[min(520px,calc(100vw-6rem))] -translate-x-1/2 items-center gap-2 rounded-[var(--radius)] border border-border bg-surface py-2 pl-3 pr-2 shadow-lg"
  >
    <AlertTriangle class="size-3.5 shrink-0 text-warn" aria-hidden="true" />
    <p data-testid="memory-pressure-text" class="select-text break-words text-[12.5px] leading-snug text-neutral-fg">
      {{ memoryLevel === 'critical' ? t('app.memoryPressureCritical') : t('app.memoryPressureWarn') }}
    </p>
    <Button
      variant="ghost"
      class="ml-1 size-6 shrink-0 rounded-sm p-0 opacity-60 hover:opacity-100"
      :aria-label="t('app.crashDismiss')"
      @click="memoryBarDismissed = true"
    >
      <X class="size-3.5" aria-hidden="true" />
    </Button>
  </div>
  <!-- 权限请求弹窗（全局，session 无关）：bridge bus plugin-permission-request 驱动 pending；
       transport 经 PERMISSION_TRANSPORT_KEY inject 调 WS approve/revoke（main.ts provide）。 -->
  <PermissionRequestDialog :plugin-id="perm.pluginId" :permissions="perm.permissions" :pending="perm.pending" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Loader2, AlertCircle, AlertTriangle, X } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import TaijiLogo from '@/components/icons/TaijiLogo.vue'
import AppShell from '@/components/shell/AppShell.vue'

import CrashRecoveredBar from '@/components/ui/CrashRecoveredBar.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import { Button } from '@/components/ui/button'
import { useConnection } from '@/composables/useConnection'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { bootstrapSettingsCore } from '@/composables/shell/useSettingsShell'
import { usePermissionRequest } from '@/composables/shell/usePermissionRequest'
import { PermissionRequestDialog } from '@taiji/ui/extension-host'
import { useSettings, isDevMode, setFailed } from '@taiji/core'
import { bootstrap } from '@taiji/core/bootstrap'
import { resolvePlatform } from '@/platform/resolve-platform'
import { bindForkNoticeEffect } from '@/composables/effects/useForkNoticeEffect'
import { bindHandoffEffect } from '@/composables/effects/useHandoffEffect'
import { bindSessionStreamSync } from '@/composables/effects/useSessionStreamSync'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import { installInboundFrameGuard, uninstallInboundFrameGuard } from '@/composables/useInboundFrameGuard'
import { useMemoryPressure } from '@/composables/useMemoryPressure'
import { onRuntimeError, getRuntimeStartError } from '@/lib/ipc'
import { reportRuntimeStartError } from '@/boot/error-reporter'

// 应用挂载（onMounted bootstrap 第 2 步）即提交连接编排（mock 模式 200ms 直进 connected；真 runtime 走端口发现）。
// settings 域核心初始化（transport + 订阅注册）必须在 WS 连接前完成：
// AppShell 仅在 connected 后渲染，若订阅注册留在 AppShell setup 会晚于 sendInitialState 首推 →
// 首条 model.list / config.defaults 丢失 → settingsStore.models / defaultModel 永空
// （模型选择器下拉空 + landing 按钮文案空，[HISTORICAL] 2026-08-05）。platform 注入归
// main.ts resolvePlatform()（setup 期 settings init 消费点先于 onMounted）。
bootstrapSettingsCore()

const { t, locale } = useI18n()
// 窗口标题随语言切换：太极（zh）/ TaiJi（en）。index.html 的 <title> 是渲染前的 fallback。
// dev 模式加「 - dev」后缀，与打包版并存时窗口标题可区分（renderer 加载前的初始 title
// 由 window-factory 设 'TaiJi dev'，此处接管后保持一致后缀）。
watch(locale, () => {
  document.title = t('app.title') + (isDevMode() ? ' - dev' : '')
}, { immediate: true })
const { state: connectionState, teardown, retryRuntime } = useConnection()
// RD-3#2：runtime 启动失败真因（binary 缺失/端口占用等）。此前 main 发 runtime-error
// 全仓零消费——启动失败用户只能干等 60s 后看到通用 failed，真因永不可见。
// 挂点选 App.vue 而非 core 编排：① failed 屏（真因显示位）就在本组件；② 状态转移
// （置 failed 短路徒劳重连）归 core use-connection（经 ConnectionPorts 消费同一事件），
// 本组件只管显示 + 台账，两层各司其职。推送 + 拉取双通道：boot 竞态下 main whenReady
// 发事件早于本组件挂载，webContents.send 静默丢失——拉取兜底对齐「时序竞争必须主动
// 拉取」既有规则。connected 即清（陈旧真因不再显示）。
const runtimeStartError = ref<string | null>(null)
let removeRuntimeErrorListener: (() => void) | null = null

/** 记录真因 + 落台账（幂等：同因去重；空消息丢弃）。状态转移归 core，本组件不置态 */
function handleRuntimeStartError(message: string): void {
  if (!message || runtimeStartError.value === message) return
  runtimeStartError.value = message
  reportRuntimeStartError(message)
}
removeRuntimeErrorListener = onRuntimeError((err) => handleRuntimeStartError(err?.message ?? ''))
// 拉取兜底：推送可能早于上面的订阅安装（boot 竞态），挂载编排后主动问一次 main 侧
// 最近一次启动失败原因（无 IPC / 无失败记录返回 null，no-op）
void getRuntimeStartError().then((message) => {
  if (message) handleRuntimeStartError(message)
})
// 启动编排（#1/#3）：连接建立后自动进 new-task landing（首次）或恢复最近 session。
// 五步 bootstrap（onMounted）第 2 步 initConnection 提交连接编排——resolve = 编排已提交
// 而非 connected（connectWs 异步握手不等待，D2 裁决②）；state==='connected' 是「连接成功」
// 唯一可靠信号——watch 它触发 onConnected，appBootstrapped 守卫保证 HMR/重连幂等。
const { onConnected } = useSidebar()
// settings 订阅的 dispose（HMR/App 卸载销毁）+ models 兜底拉取（防订阅时序竞态）。
// 订阅注册在 bootstrapSettingsCore（上见），此处只持有 dispose/refreshModels 句柄。
const { dispose: disposeSettings, refreshModels } = useSettings()
// RV1+RV2：fork 反馈行 + 后台分支通知全局订阅（session.forkNotice 广播 → transient feed；
// useForkBranchNotify diff 分支状态 → 状态变化反馈行）。App setup 是全局 effect 作用域，
// onScopeDispose 随 App 卸载退订（单实例，与 events.onGlobalType 范式一致）。
bindForkNoticeEffect()
// fast-handoff：订阅 session.handoffComplete 广播 → 复位源 session handingOff 态 + 刷新列表 + 跳转新 session。
// 与 bindForkNoticeEffect 同范式（effect 层订阅，非 useChat switch）。onScopeDispose 随 App 卸载退订。
bindHandoffEffect()
// session 全量事件订阅编排：watch sessionStore.list，added → ensureStreamSubscription，removed → disposeSession。
// 对齐派生态视野（isGenerating 由消息实体 per-session 惰性派生，D-3），消除惰性订阅盲区（非交互 session 终态事件丢失 → 侧栏卡 running）。
// flush:'sync' 保证 appendSession 同 tick 建订阅（fork-ask 路径 send 前订阅就绪）。onScopeDispose 随 App 卸载退订。
bindSessionStreamSync()
// compact-queued-messages：初始化 useCompactQueue 单例。App setup 是全局 effect 作用域，
// 首次调用绑定 app 级 scope（onScopeDispose 随 App 卸载触发，registerSessionCleanup 常驻，
// 防模块级 onScopeDispose 警告与过早反注册）。
useCompactQueue()
// 内存压力降级消费（crash-forensics-and-watchdog §3.3 D4，u7d / 偏差 #28② 的 renderer 半边）：
// 窗口级单例挂载（refCount 订阅，onScopeDispose 随 App 卸载退订）——订阅 watchdog:memoryPressure，
// warn 持续拍压窗 LRU 8→4 + evictIfNeeded 驱逐。Gate W 默认 off 时 runtime 不广播、零成本待命。
// 【oe-audit C2】此前全链零装配（hook 零调用方 = 双重休眠，impl-plan u7d「经 useRollingRestartStatus
// 引用链生产挂载」登记失实——该文件仅注释引用范式）；本挂载补齐生产消费方。
// 【RD-3#11】捕获 level 供上方提示条消费（此前返回值丢弃、level 无 UI 消费方——内存压力 warn 阶段
// 用户无从得知、无法据以行动）。
const { level: memoryLevel } = useMemoryPressure()
const memoryBarDismissed = ref(false)
// level 变化（normal→warn→critical 升级）时重显提示条：dismiss 只对当前 level 生效，不跨级别持久。
watch(memoryLevel, () => { memoryBarDismissed.value = false })
// 入站超界帧守卫消费编排（crash-forensics-and-watchdog §3.3 D8）：模块级单例（状态源在
// core ws-client），幂等安装一次——丢帧上报 + 终止阀静态提示态投影 + 切走切回重试订阅。
// App setup 顶层装配（与 bindForkNoticeEffect 同区），teardown 在 onBeforeUnmount 配对；
// 提示条由 Panel.vue 会话视图承接（InboundFrameDroppedNotice）。
installInboundFrameGuard()
// permissionRequest 全局弹窗状态（bus plugin-permission-request 驱动，session 无关）。
// App 根挂载 PermissionRequestDialog，复用 ExtensionHost bridge 的 bus 单例。
const perm = usePermissionRequest()
// 五步启动编排（core bootstrap：providePlatform → initConnection → restoreSessions →
// registerMountPoints → scanContributions）。ES1 最小 catch：任一步 reject 上抛在此可见
// （错误不静默），connected 驱动的视图初始化走下方 watch（bootstrap 不等待 connected）。
// tc 设计 §5.2 第三条（bootstrap 步骤失败）：catch 内 setFailed 置 failed 终止态 →
// 上方 failed 分支渲染降级 UI（错误提示 + 重试按钮）。不置则 connectionState 停在
// connecting，UI 永卡「连接中…」且无重试入口。
onMounted(() => {
  void bootstrap({ platform: resolvePlatform() }).catch((err) => {
    console.error('[App] bootstrap failed', err)
    setFailed()
  })
})
// [W8] onConnected 内部用模块级 hasConnectedBefore 区分首次 vs 重连：
// - 首次 connected → initApp（内部含 workspaceStore.load + presetCwd）
// - 重连 connected → initApp 因 appBootstrapped 守卫直接 return，records 停留在断连前 stale 数据
//   （runtime 可能重启后从磁盘重载了新记录，如另一窗口写入），故额外 fire-and-forget load() 刷新。
//   hasConnectedBefore 与 appBootstrapped 同为模块级，组件卸载重挂（非模块重载）时保留值，
//   避免新实例误判为「首次」再调 initApp（被守卫吞）导致 load 不刷新。
watch(connectionState, (s) => {
  if (s === 'connected') {
    // RD-3#2：连接成功即清除启动失败真因（陈旧原因不再出现在后续 failed 屏）
    runtimeStartError.value = null
    void onConnected()
    // 兜底：连接后主动拉一次 models（对齐 refreshProviders 范式，防订阅时序竞态未来回归）。
    // mock 模式 WS 不回 model.list reply（mockSend 仅 ping/pong）→ pending 65s 超时，跳过避免 boot 卡顿。
    if (import.meta.env.VITE_MOCK !== 'true') {
      void refreshModels()
    }
  }
})

/** 用户点击「重试」：委托 IPC runtime-restart → 主进程 supervisor.restartRuntime。
 *  重启成功后 supervisor 广播 runtime-port，onRuntimePort 监听自动重连 → 回到 connected。 */
function onRetry(): void {
  void retryRuntime()
}

onBeforeUnmount(() => {
  teardown()
  // RD-3#2：runtime-error 订阅随 App 卸载退订（与 setup 顶层安装配对，HMR/测试卸载后
  // 重挂可再次安装，不留残留 listener）
  removeRuntimeErrorListener?.()
  removeRuntimeErrorListener = null
  // 入站守卫消费编排解绑（与 setup 顶层 installInboundFrameGuard 配对：HMR/测试卸载后
  // 重挂可再次安装；core 侧监听与 focus watch 不留残留）。
  uninstallInboundFrameGuard()
  // settings 订阅随 App 卸载销毁（HMR/测试场景）。不断在 AppShell unmount（断连）时销毁——
  // 订阅跨断重连常驻（global handler 存于模块级 Map，重连后 dispatcher 复用，无需重注册）。
  disposeSettings()
})
</script>

