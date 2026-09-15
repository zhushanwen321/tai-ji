<template>
  <!--
    L0 Shell · zcode-demo 拓扑（shell/spec.md SSOT）
    base 平铺（bg-bg）+ aside 透明融合 + main float-panel 浮起。
    traffic light 安全区在 AsideRegion 内（padding-top:52px 恒定，spec §三）。
  -->
  <!-- padding：p-1(4) 四周统一 4px（紧凑但有呼吸，上下左右对称）。
       注意：左右 4 使 aside 左缘 x=4，与红黄绿 x=8 有 4px 差（红黄绿位置由 main trafficLightPosition 控制，见 window-factory）；
       若要对齐需调 trafficLightPosition.x 8→4（main 改动，需重启 dev）。
       折叠态 !gap-0：收起态 aside 归零，padding 保持 p-1（四周 4px，和展开一致）。
       !important 必须：gap-0 与 gap-3 同特异性，Tailwind 源码顺序 gap-0 先于 gap-3 生成，不加 ! 会被 gap-3 永久覆盖（死代码 bug）。 -->
  <div
    class="app-shell relative flex h-screen w-screen gap-3 overflow-hidden rounded-[10px] bg-bg p-1"
    :class="sidebar.collapsed ? '!gap-0' : ''"
    data-testid="app-shell"
  >
    <AsideRegion />
    <AppNavControls />
    <MainPanel />
    <!-- 滚动重启四态横幅 + reattach 高压延迟轻态（crash-forensics D5/D3，u7d + #27）：
         fixed 定位挂主界面层，状态源 useRollingRestartStatus（广播加速 + status RPC 拉取，
         重连/刷新不丢）。窗口级互斥（滚动重启优先）= 本条 z-index 覆盖 CrashRecoveredBar，
         机理见组件头注释。restarting 全屏过渡态下 AppShell 整体不渲染，横幅随行（无残留）。 -->
    <RollingRestartBanner />
    <!-- D-8 懒加载：v-if="settingsOpen" 门控是生效前提——defineAsyncComponent 在 AsyncComponentWrapper
         实例化时立即触发 loader（Vue runtime-core setup 内 load()），SettingsModal 内部 v-if="open"
         挡不住启动期加载；首开设置才拉取设置页树 chunk（首次触发才出现在 Network）。
         :key 重挂 wrapper 是重试链路的一环（见 script 注释）。 -->
    <SettingsModal v-if="settingsOpen" :key="settingsRetryKey" v-model:open="settingsOpen" />
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, defineComponent, h, provide, ref, watch } from 'vue'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { useSettingsShell } from '@/composables/shell/useSettingsShell'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import AppNavControls from './AppNavControls.vue'
import AsideRegion from './AsideRegion.vue'
import MainPanel from './MainPanel.vue'
import RollingRestartBanner from '@/components/ui/RollingRestartBanner.vue'
import AsyncErrorFallback, { LAZY_RETRY_KEY } from '@/components/ui/AsyncErrorFallback.vue'
import { useSidebarStore } from '@/stores/sidebar'

// 设置弹窗懒加载（D-8 §3.3 边界判据：首屏不渲染 + 重依赖——设置页树子树）。
// 代价：activeMenu/extensionView 等弹窗内状态随关闭卸载而重置回默认页（此前常驻挂载保留上次页面，
// 设置是低频操作，重置属可接受行为差异）。
// 错误兜底（§3.5）：file:// 下 chunk 404 是配置性错误，不自动重试（onError 只捕获 userRetry 并
// fail 展示错误占位）。重试 = userRetry（重置 pendingRequest 重跑 loader）+ key 重挂 wrapper
// （resolvedComp 就绪则直接渲染，否则 setup 挂到新 load 的 then）——两者缺一不可：
// 只 userRetry 不重挂：已 settled 的 pendingRequest 使 resolve 失效、loaded 永不变；只重挂不 userRetry：
// setup 的 load() 返回旧 rejected 缓存，loader 不重跑。
// [W31 review minor-4] loading/error 占位必须 overlay 形态（fixed 全屏遮罩）：本组件挂载点是根
// div `flex gap-3` 的 flex 子项，默认形态占位（h-full w-full、无定位）会参与布局流——error 态
// 永久挤压 MainPanel、loading 超 200ms 短暂挤压。defineAsyncComponent 的 loading/error 组件
// 无法直接传 props（loading 态无 props、error 态只收 error），用薄包装固定传 overlay: true。
const SettingsModalFallback = defineComponent({
  name: 'SettingsModalFallback',
  props: { error: null },
  setup: (fallbackProps) => () => h(AsyncErrorFallback, { error: fallbackProps.error, overlay: true }),
})
let settingsRetryFn: (() => void) | null = null
const settingsRetryKey = ref(0)
const SettingsModal = defineAsyncComponent({
  loader: () => import('@/components/settings/SettingsModal.vue'),
  loadingComponent: SettingsModalFallback,
  errorComponent: SettingsModalFallback,
  delay: 200,
  onError: (_err, retry, fail) => {
    settingsRetryFn = retry
    fail()
  },
})
provide(LAZY_RETRY_KEY, () => {
  settingsRetryFn?.()
  settingsRetryKey.value++
})

const navigation = useNavigationStore()
const session = useSessionStore()
const sidebar = useSidebarStore()
const { syncSessionToPanel } = useSidebar()

/** Settings modal 开关（⌘, / sidebar 用户区触发） */
const settingsOpen = ref(false)
provide('openSettings', () => { settingsOpen.value = true })

// 平台 + 全屏态同步到 <html>（data-platform / data-fullscreen），驱动 traffic-light / app-nav-controls 两态。
usePlatformChrome()

// Settings 域壳接入（W4）：providePlatform + provideSettingsTransport + core useSettings().init
// （挂常驻订阅 + 同步 system 偏好）+ provide 3 个 ui 注入 key + watch system.theme 挂/卸 matchMedia。
// core 零 DOM；壳持 platform/transport 注入 + DOM 副作用。幂等（core 模块级单例）。
useSettingsShell()

// 导航栈指针变化 → 同步 session.activeId + panel 载入（shell spec §八.5 G3-003「历史状态正确恢复」）。
// 覆盖 ⌘[/⌘] 与 AppNavControls 后退/前进：pointer 变后若落在 chat+sessionId 条目，恢复该 session 到 panel。
// overview/settings 条目不动 session（main 区被覆盖，保留上次 chat session 供回退）。
// selectSession 主路径已立即同步，此 watch 兜底导航回退/前进；syncSessionToPanel 幂等，重复调用无副作用。
watch(
  () => navigation.pointer,
  () => {
    const cur = navigation.current
    if (cur.view === 'chat' && cur.sessionId) {
      session.activeId = cur.sessionId
      syncSessionToPanel(cur.sessionId)
    }
  },
)
</script>
