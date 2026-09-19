<script setup lang="ts">
/**
 * CompanionBand（W2 · T3，S4 IF3 + clarify Q1/Q2/Q3 + ERR3）——M11 渲染载体。
 *
 * 消费 W1 DialogRequestQueue（transport/source 经 inject 注入，clarify Q1），
 * 渲染当前请求（队首），按 method 路由：
 *  - confirm → 消息 + 确认/取消按钮
 *  - select → 单选 radio 列表（indicator+label+desc 流式，v6 视觉，clarify Q3）+ 确认/取消
 *  - input → 单行文本框；editor → 多行文本（prefill/default 预填）
 *  - 未知 method → 只读降级展示（title + message，无交互按钮，console.warn，ERR3）
 *
 * [ui-presentation-protocol §3.4-1] 原富交互表单分支已随 Panel inline 化退役删除——
 * 表单类请求由 useExtensionUI 消费（FormOverlay 独占），本组件只渲染 band 简单对话框
 * （permission 等），method 路由不再含 'askUser'。
 *
 * 响应回传：用户提交 → queue.respond(requestId, result)；取消 → queue.cancel(requestId)——
 * queue 内部按 source 路由（pi → sendPiResponse 带 method 透传，plugin → sendPluginResponse）。
 *
 * 无请求时根元素 v-if 自隐藏（不占位）；inject 缺失（source/transport 任一未 provide）时
 * 静默空态不崩（design-review R3，先例 StatusBar/ViewHost）。
 */
import { computed, inject, ref, watch } from 'vue'
import { createDialogRequestQueue } from './dialog-request-queue'
import { DIALOG_REQUEST_SOURCE_KEY, UI_RESPONSE_TRANSPORT_KEY, OVERLAY_LIFECYCLE_KEY } from './companion-band-source'
import type { OverlayState } from './companion-band-source'
import { Button } from '../primitives/button'
import { Input } from '../primitives/input'
import { Textarea } from '../primitives/textarea'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  /** 当前活跃 session id（队列按此分区隔离）；null = 无活跃 session（静默空态） */
  sessionId: string | null
}>()

const { t } = useI18n()

const source = inject(DIALOG_REQUEST_SOURCE_KEY, null)
const transport = inject(UI_RESPONSE_TRANSPORT_KEY, null)
// OverlayLifecycle（IF9 状态机，arch-fix-v2 闭环）：inject 缺失 → null（静默，minimize/restore no-op）
const overlayLifecycle = inject(OVERLAY_LIFECYCLE_KEY, null)

/** sessionId prop → Ref<string|null>（queue 工厂契约：null = 无活跃 session） */
const sessionIdRef = computed<string | null>(() => props.sessionId)

// ── 队列：source/transport 均注入时创建；缺失任一则无队列（静默空态） ──
// MF-5：队列必须在 setup 顶层创建（不在 computed getter 内）——createDialogRequestQueue 内部
// 依赖 onScopeDispose 注册退订，computed getter 求值期不在 active effect scope，退订注册静默失败，
// unmount 后 listener 永不退订（重挂时累积翻倍）。inject 结果在 setup 期固定，普通 const 即可。
const queue =
  !source || !transport ? null : createDialogRequestQueue(transport, sessionIdRef, source)

const currentRequest = computed(() => queue?.currentRequest.value)

// 已知 method 集合（ERR3 判定用）
const KNOWN_METHODS = ['confirm', 'select', 'input', 'editor'] as const

// 未知 method（ERR3）：watch 记录 console.warn（模板不做副作用调用）
watch(
  () => currentRequest.value?.method,
  (m) => {
    if (m && !KNOWN_METHODS.includes(m as (typeof KNOWN_METHODS)[number])) {
      console.warn('[CompanionBand] unknown dialog method:', m)
    }
  },
)

// ── OverlayLifecycle 消费（IF9 状态机，arch-fix-v2 闭环）──
/** OverlayLifecycle 取值用 sessionId（null → undefined，落 __global__ 分区） */
const sidForOverlay = computed<string | undefined>(() => props.sessionId ?? undefined)

/** 已知 method（ERR3 判定，控制 minimize chrome 显隐：未知 method 纯只读不显控制） */
const isKnownMethod = computed(() => {
  const m = currentRequest.value?.method
  return m !== undefined && KNOWN_METHODS.includes(m as (typeof KNOWN_METHODS)[number])
})

/**
 * 当前 overlay 状态（ref，非 computed）：OverlayLifecycle 是非响应式类，其内部 Map 变更不被
 * Vue 追踪，故 transition 后需显式 refreshOverlayState 重读 getState 同步本 ref。
 */
const overlayState = ref<OverlayState | undefined>(undefined)

/** 重读当前请求的 overlay 状态（inject 缺失或无请求 → undefined） */
function refreshOverlayState(): void {
  const r = currentRequest.value
  overlayState.value = r && overlayLifecycle ? overlayLifecycle.getState(sidForOverlay.value, r.requestId) : undefined
}

const isMinimized = computed(() => overlayState.value === 'minimized')

/**
 * z-index 状态驱动（契约闭环）：expanded → 模态层（活跃顶层）；minimized/restored → 覆盖层
 * （低层级，为多 overlay 编排预留语义）；无状态（undefined）→ 不设 z-index（默认层）。
 * 单 dialog 场景值实际恒定，但契约要求状态驱动层级（design-token，非硬编码魔数）。
 */
const bandStyle = computed<Record<string, string> | undefined>(() => {
  const s = overlayState.value
  if (s === undefined) return undefined
  return { zIndex: s === 'expanded' ? 'var(--z-modal)' : 'var(--z-overlay)' }
})

/** 收起当前 overlay（transition expanded→minimized；inject 缺失静默跳过） */
function onMinimize(): void {
  const r = currentRequest.value
  if (!r || !overlayLifecycle) return
  overlayLifecycle.transition(sidForOverlay.value, r.requestId, 'minimized')
  refreshOverlayState()
}

/** 展开已收起的 overlay（transition minimized→restored；inject 缺失静默跳过） */
function onRestore(): void {
  const r = currentRequest.value
  if (!r || !overlayLifecycle) return
  overlayLifecycle.transition(sidForOverlay.value, r.requestId, 'restored')
  refreshOverlayState()
}

// ── select/input 交互状态 ──
const inputValue = ref('')
const selectValue = ref('')

// 新请求到来时，重置输入状态 + 重读 overlay 状态（新请求 OverlayLifecycle 自动建 expanded 分区）
watch(currentRequest, (r) => {
  if (!r) {
    overlayState.value = undefined
    return
  }
  inputValue.value = r.default ?? r.prefill ?? ''
  selectValue.value = r.default ?? ''
  refreshOverlayState()
})

/** confirm：确认回传 true，取消回传 null */
function onConfirm(): void {
  const r = currentRequest.value
  if (!r) return
  if (r.method === 'input' || r.method === 'editor') {
    queue?.respond(r.requestId, inputValue.value)
  } else if (r.method === 'select') {
    queue?.respond(r.requestId, selectValue.value)
  } else {
    queue?.respond(r.requestId, true)
  }
}

/** 取消当前请求（回传 null） */
function onCancel(): void {
  const r = currentRequest.value
  if (!r) return
  queue?.cancel(r.requestId)
}

</script>

<template>
  <!-- v6 无边框一体化：单容器 bg-input 靠间距分区（对齐统一表单 overlay 容器样式）。
       无请求时 v-if 自隐藏（不占位）。z-index 由 OverlayLifecycle 状态驱动（bandStyle）。
       MF-7：fixed 定位（overlay 挂载，脱离文档流）——弹 dialog 不挤压 panel 布局，
       bandStyle 的 z-index 对 fixed 元素生效；minimize 后 body 隐藏也不占位。 -->
  <div
    v-if="currentRequest"
    data-testid="companion-band"
    :style="bandStyle"
    class="fixed bottom-6 left-1/2 flex w-full max-w-lg -translate-x-1/2 flex-col overflow-hidden rounded-lg bg-bg-input motion-reduce:animate-none"
  >
    <!-- head 行：title（左）+ minimize/restore 控制（右，仅已知 method；ERR3 未知 method 纯只读不显控制） -->
    <div
      v-if="currentRequest.title || isKnownMethod"
      data-testid="companion-band-header"
      class="flex items-center justify-between gap-2 px-3.5 pt-2.5"
    >
      <span
        v-if="currentRequest.title"
        data-testid="companion-band-title"
        class="text-[13px] font-medium text-neutral-fg"
      >{{ currentRequest.title }}</span>
      <!-- minimize（收起）：未收起且已知 method 时可见 -->
      <Button
        v-if="!isMinimized && isKnownMethod"
        variant="ghost"
        size="sm"
        data-testid="companion-minimize"
        @click="onMinimize"
      >{{ t('common.collapse') }}</Button>
      <!-- restore（展开）：已收起时可见 -->
      <Button
        v-if="isMinimized"
        variant="ghost"
        size="sm"
        data-testid="companion-restore"
        @click="onRestore"
      >{{ t('common.expand') }}</Button>
    </div>

    <!-- body：收起态隐藏（仅 header + restore），展开态按 method 路由 -->
    <div v-if="!isMinimized" class="flex flex-col gap-2 px-3.5 pb-2.5 pt-2.5">
      <!-- message（confirm/未知 method 共用） -->
      <p
        v-if="currentRequest.message"
        data-testid="companion-band-message"
        class="text-[13px] leading-1.5 text-neutral-mid"
      >
        {{ currentRequest.message }}
      </p>

      <!-- confirm：确认/取消 -->
      <div v-if="currentRequest.method === 'confirm'" class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" data-testid="companion-confirm-cancel" @click="onCancel">{{ t('common.cancel') }}</Button>
        <Button variant="default" data-testid="companion-confirm-ok" @click="onConfirm">{{ t('common.confirm') }}</Button>
      </div>

      <!-- select：单选 radio 列表（clarify Q3，indicator+label+desc 流式）+ 确认/取消 -->
      <div v-else-if="currentRequest.method === 'select'" class="flex flex-col gap-1">
        <div
          v-for="opt in currentRequest.options ?? []"
          :key="opt.value"
          :data-testid="`companion-select-option-${opt.value}`"
          role="radio"
          :tabindex="0"
          :aria-checked="selectValue === opt.value"
          :class="[
            'flex cursor-pointer items-start gap-2 rounded px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
            selectValue === opt.value ? 'bg-accent-soft' : 'hover:bg-white/[0.04]',
          ]"
          @click="selectValue = opt.value"
          @keydown.enter="selectValue = opt.value"
          @keydown.space.prevent="selectValue = opt.value"
        >
          <div
            :class="[
              'mt-0.5 size-4 shrink-0 rounded-full border-2 transition-colors',
              selectValue === opt.value ? 'border-accent bg-accent' : 'border-border-strong',
            ]"
          />
          <div class="flex min-w-0 flex-1 flex-col">
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span data-testid="companion-select-option-label" class="text-[13px] leading-1.5 text-neutral-fg">{{ opt.label }}</span>
              <span v-if="opt.description" class="text-[12px] leading-1.5 text-neutral-dim">{{ opt.description }}</span>
            </div>
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <Button variant="ghost" data-testid="companion-select-cancel" @click="onCancel">{{ t('common.cancel') }}</Button>
          <Button variant="default" data-testid="companion-select-ok" :disabled="!selectValue" @click="onConfirm">
            {{ t('common.confirm') }}
          </Button>
        </div>
      </div>

      <!-- input / editor -->
      <div v-else-if="currentRequest.method === 'input' || currentRequest.method === 'editor'" class="flex flex-col gap-2">
        <Textarea
          v-if="currentRequest.method === 'editor'"
          v-model="inputValue"
          rows="6"
          data-testid="companion-editor"
          class="font-mono text-[12px]"
        />
        <Input
          v-else
          v-model="inputValue"
          data-testid="companion-input"
        />
        <div class="flex justify-end gap-2 pt-1">
          <Button variant="ghost" data-testid="companion-input-cancel" @click="onCancel">{{ t('common.cancel') }}</Button>
          <Button variant="default" data-testid="companion-input-ok" @click="onConfirm">{{ t('common.confirm') }}</Button>
        </div>
      </div>

      <!-- 未知 method（ERR3）：只读降级展示（title/message 已在上方渲染，无交互按钮），不白屏不崩溃 -->
      <p
        v-else
        data-testid="companion-band-unknown"
        class="text-[13px] text-neutral-dim"
      >
        {{ currentRequest.method }}
      </p>
    </div>
  </div>
</template>
