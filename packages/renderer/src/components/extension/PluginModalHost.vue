<!--
  PluginModalHost（plugin-header-action-modal-points AP-2 / u4b）——plugin modal 全局单例层。

  层状态 owner 分工（AP-2）：renderer 持屏上台（DOM/焦点/Esc/焦点陷阱/焦点归还），
  runtime 持仲裁记录，单一真相帧 = plugin:modalState（经 core plugin-modal-slot 模块级
  shallowRef 镜像消费，槽 null = 层收起）。宿主 chrome 只有标题 + 关闭键；统计行/列表/
  操作全部是插件推的 GuiComponent 树（ViewHost 消费 viewId = modal-<pluginId>-<modalId>
  的 per-session 分区，重开首帧空白 = 契约形态）。

  - title 解析单一源在 renderer：frame.title ?? declaration.title ?? modalId（E1 降级链）
  - width 三档落宿主档位闭集（sm/md/lg → 标准 max-w scale），插件不可指定像素
  - 本地乐观关闭仅 Esc/关闭键（+ 上报 C→S plugin.dismissModal，u5b 落 runtime 接收；
    CompanionBand 确认层挂起时 Esc 跳过——AP-2 规则③裁决权归确认层）；
    切会话 / 宿主浮层 / replaced / plugin-gone 由 plugin:modalState 广播驱动关闭
  - 浮层互斥（AP-2 规则①）：Search 打开（useSearchModal 单例）与 Settings 挂载
    （body 直挂 .fso 全屏层，MutationObserver 检测——settingsOpen 是 AppShell 局部 ref
    无全局态，observer 是不改宿主代码的观察者形态）→ 先关本层 reason='host-overlay'
  - 挂载守卫：本组件随 PanelHeader 每 panel 实例化（split 双实例），模块级 claim 保证
    全应用只有一个实例真正渲染层/接管键盘（槽全局单例，重复渲染 = 重复 DOM）
-->
<template>
  <Teleport to="body">
    <div
      v-if="isHostOwner && slot"
      ref="rootEl"
      class="fixed inset-0 z-[var(--z-modal)] flex flex-col bg-bg"
      role="dialog"
      aria-modal="true"
      data-testid="plugin-modal"
      :aria-label="resolvedTitle"
      @keydown="onKeydown"
    >
      <!-- 宿主 chrome：标题 + 关闭键，只有这两件（AP-2；红黄绿让位 = SettingsModal 同款
           44px header 行——层内自绘 traffic light 平台不与右上关闭键冲突） -->
      <div class="flex h-[44px] shrink-0 items-center justify-between px-[14px] border-b border-border">
        <span data-testid="plugin-modal-title" class="truncate text-[14px] font-semibold text-neutral-fg">{{ resolvedTitle }}</span>
        <Button
          variant="ghost"
          class="flex h-[28px] w-[28px] items-center justify-center rounded-[var(--radius-sm)] p-0 text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [-webkit-app-region:no-drag]"
          data-testid="plugin-modal-close"
          :title="t('extensionUI.pluginModalCloseEsc')"
          :aria-label="t('extensionUI.pluginModalClose')"
          @click="dismiss('dismissed')"
        >
          <X class="!size-4" />
        </Button>
      </div>
      <!-- 插件推的内容树（per-session 分区；树未到 = 空白首帧，showModal 后插件立即 views.update） -->
      <div class="flex min-h-0 flex-1 flex-col overflow-auto">
        <div class="mx-auto flex w-full min-h-0 flex-1 flex-col px-6 py-5" :class="widthClass">
          <ViewHost :view-id="viewId" :session-id="slot.sessionId" empty="hidden" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script lang="ts">
/**
 * 模块级挂载守卫状态（跨实例共享，全局单例层——split 双 PanelHeader 时仅首个
 * setup 声明的实例接管渲染与键盘）。与 <script setup> 分离仅因 setup 块禁止
 * named export（测试隔离钩子需要模块级导出）。
 */
let ownerClaimed = false

/** 测试隔离：释放模块级 claim（跨用例单例状态，resetSearchModal 同款先例）。生产禁调。 */
export function __resetPluginModalHostForTest(): void {
  ownerClaimed = false
}
</script>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import {
  closePluginModal,
  getPluginModalSlot,
  useSearchModal,
  type PluginModalClosedReason,
} from '@taiji/core'
import { Button } from '@/components/ui/button'
import { ViewHost } from '@taiji/ui/extension-host'
import { PLUGIN_MODAL_SOURCE_KEY } from '@/composables/shell/useExtensionHostBridge'

const props = defineProps<{
  /** 挂载 panel 当前 session id：变化 = 切会话 → 关闭（D1 生命周期；split 下以本组件
   *  所属 panel 为锚，非焦点 panel 的会话切换边缘面随挂载守卫收窄到 owner 实例） */
  sessionId?: string
}>()

const { t } = useI18n()
const source = inject(PLUGIN_MODAL_SOURCE_KEY, null)

// ── 挂载守卫声明（首个实例接管；卸载时释放，HMR/条件挂载可重新接管）──
let claimed = false
if (!ownerClaimed) {
  ownerClaimed = true
  claimed = true
}
const isHostOwner = claimed

const slot = computed(() => getPluginModalSlot())
const rootEl = ref<HTMLElement | null>(null)

// ── title/width 单一解析源（renderer）──
const declaration = computed(() => {
  const s = slot.value
  if (!s || !source) return undefined
  return source.getDeclaration(s.pluginId, s.modalId)
})
const resolvedTitle = computed(() => {
  const s = slot.value
  if (!s) return ''
  return s.title ?? declaration.value?.title ?? s.modalId
})
const WIDTH_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'max-w-xl',
  md: 'max-w-3xl',
  lg: 'max-w-5xl',
}
const widthClass = computed(() => {
  const w = slot.value?.width ?? declaration.value?.width ?? 'md'
  return WIDTH_CLASS[w]
})
const viewId = computed(() => (slot.value ? `modal-${slot.value.pluginId}-${slot.value.modalId}` : ''))

// ── 关闭编排：本地乐观关闭（槽清空 → 层卸载）+ C→S 上报 ──
// 上报经 bridge 门面（PLUGIN_MODAL_SOURCE_KEY.dismiss，D3 WS send 统一门面收口——
// 组件禁直调 ws-client）；帧名/形状按设计 protocol.ts，runtime 接收侧归 u5b。
function dismiss(reason: PluginModalClosedReason): void {
  const s = getPluginModalSlot()
  if (!s) return
  closePluginModal(s.pluginId, s.modalId, s.epoch, reason)
  if (!source) {
    // 异常装配（无 bridge provide）——本地层已收起但帧未上报，warn 出声不静默
    console.warn('[PluginModalHost] bridge source not provided: plugin.dismissModal not reported')
    return
  }
  source.dismiss(s.pluginId, s.modalId, s.epoch, reason)
}

// ── 焦点管理：open 捕获触发元素 + 层内聚焦；close 焦点归还（场景 1 Esc 归焦判据）──
let triggerEl: HTMLElement | null = null
watch(slot, (next, prev) => {
  if (!claimed) return
  if (next && !prev) {
    triggerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void nextTick(() => {
      rootEl.value?.querySelector<HTMLElement>('button')?.focus()
    })
  } else if (!next && prev && triggerEl) {
    triggerEl.focus()
    triggerEl = null
  }
})

// ── 切会话关闭（D1）；landing（undefined→sid 首次赋值）不视为切换 ──
watch(() => props.sessionId, (_sid, prev) => {
  if (!claimed || prev === undefined) return
  dismiss('session-switched')
})

// ── 浮层互斥（AP-2 规则①）：Search 打开 / Settings 挂载 → host-overlay 关闭 ──
const { isOpen: searchOpen } = useSearchModal()
watch(searchOpen, (open) => {
  if (!claimed || !open) return
  dismiss('host-overlay')
})
let overlayObserver: MutationObserver | null = null
function isHostOverlayNode(node: Node): boolean {
  return node instanceof HTMLElement && node.classList.contains('fso')
}
onMounted(() => {
  if (!claimed) return
  overlayObserver = new MutationObserver((mutations) => {
    if (!getPluginModalSlot()) return
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (isHostOverlayNode(node)) {
          dismiss('host-overlay')
          return
        }
      }
    }
  })
  overlayObserver.observe(document.body, { childList: true })
})
onBeforeUnmount(() => {
  if (claimed) ownerClaimed = false
  overlayObserver?.disconnect()
  overlayObserver = null
})

// ── 键盘：Esc 双路 + Tab 焦点陷阱（SettingsModal 同款三路编排的层内两路）──
/**
 * CompanionBand 确认层挂起观测（AP-2 规则③）：renderer 侧无响应式 pending 态可读
 * （DialogRequestQueue 实例局部于 CompanionBand，用户 respond/cancel 不经 bus 广播，
 * 宿主侧自记簿记会在应答后滞留），按审查裁决用「band 挂载」观测形态判定——含
 * minimized 收起态（收起只是视觉折叠，请求仍待响应）。挂起期间确认层在本层之上
 * （--z-dialog > --z-modal），Esc 裁决权归确认层：本层（含 window 兜底）跳过
 * dismiss，禁「顺手关掉 modal 而 confirm 仍挂起」。
 */
function hasPendingDialogRequest(): boolean {
  return document.querySelector('[data-testid="companion-band"]') !== null
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (hasPendingDialogRequest()) return
    e.preventDefault()
    dismiss('dismissed')
    return
  }
  if (e.key === 'Tab') handleTabCycle(e)
}
/** window 级 Esc 兜底：焦点逃逸到层外（如 Teleport 后焦点落 body）时层内 @keydown 收不到。
 *  层内 onKeydown 先 fire（preventDefault），本监听检查 defaultPrevented 跳过防重复 dismiss；
 *  确认层挂起时同样跳过（hasPendingDialogRequest——AP-2 规则③ Esc 裁决权归确认层）。 */
useEventListener(
  () => (claimed && slot.value ? window : null),
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (e.defaultPrevented) return
    if (hasPendingDialogRequest()) return
    e.preventDefault()
    dismiss('dismissed')
  },
)
/** Tab 焦点陷阱：末个非 shift → 首个；首个 shift → 末个；中间 Tab 交浏览器原生顺序。 */
function handleTabCycle(e: KeyboardEvent): void {
  const list = getFocusables()
  if (list.length === 0) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (active === last && !e.shiftKey) {
    e.preventDefault()
    first.focus()
  } else if (active === first && e.shiftKey) {
    e.preventDefault()
    last.focus()
  }
}
function getFocusables(): HTMLElement[] {
  const root = rootEl.value
  if (!root) return []
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}
</script>
