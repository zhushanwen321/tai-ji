<script setup lang="ts">
// ModelSheet —— 模型与思考档切换 Sheet（remote-use-mobile-v2 §7.2 映射表 F9/思考档行）。
//
// 数据面：
// - 模型清单 = model.list 广播订阅（subscribeModels）+ listModels 主动拉兜底（订阅注册
//   时序竞态的请求-响应兜底，model.ts 契约）；候选列表**不过滤 enabled === false** 的模型，
//   渲染为「不可用」标注 + 禁用（spec §14 边界行：用户能看到「曾经可切但现在不可用」的
//   模型并理解原因——桌面 model-picker 直接过滤是桌面裁决，不照搬）；
// - 当前值 = liveStateOf（会话运行时状态层唯一读口；缓存缺失 = 显式未知，显示未知占位，
//   禁回退其他会话的值——core 状态层 I5）；切换回执写显示态（applyLiveState）：模型回执
//   = pi 生效值（静默换模防线，禁请求值乐观写）、思考档回执 = pi 钳制值。
// 思考档 UI（§7.2 思考档行）：四段 SegmentedControl（低/中/高/最高）↔ 七值映射 +
// chip 短词表，映射纯函数单点 ./thinking-levels（值域权威 shared PI_THINKING_LEVELS，
// A-03 禁手写）；非段值（off/minimal/xhigh）四段全不选中（aria-selected 全 false，
// roving tabindex 锚首段保键盘可达），段外原值经 chip 短词 + offSegmentHint 提示行标注。
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Sheet, SegmentedControl } from '@taiji/ui'
import type { ModelInfo } from '@taiji/shared'
import {
  fetchModels,
  liveStateOf,
  liveStateStore,
  setSessionThinkingLevel,
  subscribeModels,
  switchSessionModel,
} from '../shell/app-runtime'
import { showErrorBar } from '../shell/error-bar'
import { isSegmentSelected, nearestSegmentOf, THINKING_LEVEL_LABEL_KEYS, THINKING_SEGMENTS } from './thinking-levels'

const props = defineProps<{
  /** 槽位开合（sheet-manager activeSheet === 'model'） */
  open: boolean
  /** 目标会话（切换与会话级状态读写都锚定它） */
  sessionId: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

// ── 模型清单（订阅 + 主动拉兜底）──────────────────────────────────────

const models = ref<ModelInfo[]>([])

onMounted(() => {
  void subscribeModels((list) => {
    models.value = list
  })
  fetchModels()
    .then((list) => {
      models.value = list
    })
    .catch((e: unknown) => {
      // 清单拉取失败降级：列表空态（辅助流不拖垮核心，§7.4）；订阅帧后到仍会填充
      console.warn('[ModelSheet] model.list fetch failed:', e)
    })
})

/** 当前会话的权威值（响应式读状态层；undefined = 显式未知） */
const current = computed(() => liveStateOf(props.sessionId))

/** liveState 复合串拆段（core 契约 "provider/modelId"，live-state.ts:33；无 '/' 时按裸 id
 *  全局匹配）——拆段单点，行选中/「当前」标记/失效提示三处比对共用（桌面
 *  ModelPickerPanel.defaultModelParts 同构先例）。 */
const currentModelParts = computed<{ id: string; providerId?: string } | null>(() => {
  const v = current.value?.modelId
  if (!v) return null
  const i = v.lastIndexOf('/')
  return i > 0 ? { providerId: v.slice(0, i), id: v.slice(i + 1) } : { id: v }
})

/** 行是否当前模型：id + provider 归属双匹配（同 short-id 多 provider 不双行命中） */
function isCurrentModel(m: ModelInfo): boolean {
  const cur = currentModelParts.value
  if (!cur || m.id !== cur.id) return false
  return cur.providerId !== undefined ? m.providerId === cur.providerId : true
}

/** 当前模型是否在可用清单（失效提示分支判据：回读值不在清单 → 原值 + 提示切换） */
const currentModelKnown = computed(() => models.value.some(isCurrentModel))

/** 模型行展示名（providerName · name，桌面 model-picker 同款拼法） */
function modelDisplayName(m: ModelInfo): string {
  return `${m.providerName} · ${m.name}`
}

const switching = ref(false)

async function onSelectModel(m: ModelInfo): Promise<void> {
  if (switching.value || m.enabled === false) return
  switching.value = true
  try {
    // 回执写显示态（pi 生效值；静默换模时生效值 ≠ 请求值）
    const reply = await switchSessionModel(props.sessionId, m.providerId, m.id)
    liveStateStore.applyLiveState(props.sessionId, { modelId: reply.modelId })
  } catch (e) {
    console.warn('[ModelSheet] model switch failed:', e)
    showErrorBar(t('mobile.model.switchFailed'))
  } finally {
    switching.value = false
  }
}

// ── 思考档（七值四段映射，./thinking-levels 单点）────────────────────────

const thinkingLevel = computed(() => current.value?.thinkingLevel)
const thinkingBusy = ref(false)

/** 就近段派生（非段值 off/minimal→low、xhigh→max）——唯一消费 = offSegmentHint 提示行显隐判据，不进段控 */
const nearestSegment = computed(() => nearestSegmentOf(thinkingLevel.value))

/**
 * 段控选中段（§7.2：非段值不点亮段选中态）：仅当前值精确等于段值才传给段控点亮；
 * off/minimal/xhigh 传空串（四段全不选中、无选中底，roving tabindex 锚首段保键盘可达），
 * 段外原值经 chip 短词 + offSegmentHint 提示行标注；nearestSegment 不进段控选中态。
 */
const selectedSegment = computed(() => {
  const nearest = nearestSegment.value
  if (nearest === null) return ''
  return isSegmentSelected(thinkingLevel.value, nearest) ? nearest : ''
})

const segmentOptions = THINKING_SEGMENTS.map((s) => ({ value: s, label: t(`mobile.model.segment.${s}`) }))

async function onSelectSegment(segment: string): Promise<void> {
  if (thinkingBusy.value) return
  thinkingBusy.value = true
  try {
    // 回执 level = runtime set→get_state 读回的生效档（pi 钳制时 ≠ 请求值）
    const reply = await setSessionThinkingLevel(props.sessionId, segment)
    liveStateStore.applyLiveState(props.sessionId, { thinkingLevel: reply.level })
  } catch (e) {
    console.warn('[ModelSheet] thinking level set failed:', e)
    showErrorBar(t('mobile.model.thinkingFailed'))
  } finally {
    thinkingBusy.value = false
  }
}

/** 思考档 chip 短词（七值全覆盖词表 i18n；undefined = 未知占位） */
function thinkingShortWord(level: string | undefined): string {
  if (level === undefined) return t('mobile.model.thinkingUnknown')
  const key = THINKING_LEVEL_LABEL_KEYS[level as keyof typeof THINKING_LEVEL_LABEL_KEYS]
  return key !== undefined ? t(`mobile.model.level.${key}`) : level
}

function onClose(): void {
  emit('close')
}
</script>

<template>
  <Sheet
    :open="open"
    :title="t('mobile.model.title')"
    @update:open="!$event && onClose()"
  >
    <!-- 模型清单（enabled===false 不过滤：不可用标注 + 禁用，spec §14 边界行） -->
    <div class="flex flex-col gap-1" data-testid="model-sheet-models">
      <!-- 当前模型失效（回读值不在清单）：原值 + 提示切换 -->
      <p
        v-if="current?.modelId !== undefined && !currentModelKnown"
        class="rounded bg-surface-hover px-2.5 py-1.5 text-[length:var(--m-text-sub)] text-warn"
        data-testid="model-sheet-current-invalid"
      >
        {{ t('mobile.model.currentUnavailable', { model: current.modelId }) }}
      </p>
      <Button
        v-for="m in models"
        :key="`${m.providerId}/${m.id}`"
        :data-testid="`model-sheet-model-${m.id}`"
        variant="ghost"
        :disabled="m.enabled === false || switching"
        class="flex min-h-[var(--m-tap)] items-center gap-2 rounded px-2.5 py-2 text-left"
        :class="isCurrentModel(m) ? 'bg-accent-soft' : 'bg-surface-2'"
        @click="onSelectModel(m)"
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[length:var(--m-text-sub)] text-neutral-fg">{{ modelDisplayName(m) }}</span>
          <span
            v-if="m.enabled === false"
            class="block text-[length:var(--m-text-sub)] text-neutral-mid"
          >{{ t('mobile.model.unavailable') }}</span>
        </span>
        <span
          v-if="isCurrentModel(m)"
          class="shrink-0 text-[length:var(--m-text-sub)] font-medium text-accent"
        >{{ t('mobile.model.current') }}</span>
      </Button>
      <p v-if="models.length === 0" class="py-2 text-center text-[length:var(--m-text-sub)] text-neutral-mid" data-testid="model-sheet-empty">
        {{ t('mobile.model.empty') }}
      </p>
    </div>

    <!-- 思考档区：chip 短词（当前值）+ 四段段控（非段值不点亮选中态） -->
    <div class="mt-2 flex flex-col gap-2 border-t border-hairline pt-3" data-testid="model-sheet-thinking">
      <div class="flex items-center justify-between">
        <span class="text-[length:var(--m-text-sub)] font-medium text-neutral-fg">{{ t('mobile.model.thinkingLabel') }}</span>
        <span class="text-[length:var(--m-text-sub)] text-neutral-mid" data-testid="model-sheet-thinking-current">
          {{ thinkingShortWord(thinkingLevel) }}
        </span>
      </div>
      <p
        v-if="thinkingLevel !== undefined && nearestSegment !== null && !isSegmentSelected(thinkingLevel, nearestSegment)"
        class="text-[length:var(--m-text-sub)] text-neutral-mid"
        data-testid="model-sheet-thinking-offsegment"
      >
        {{ t('mobile.model.offSegmentHint', { level: thinkingShortWord(thinkingLevel) }) }}
      </p>
      <SegmentedControl
        :model-value="selectedSegment"
        :options="segmentOptions"
        :label="t('mobile.model.thinkingLabel')"
        data-testid="model-sheet-thinking-segments"
        @update:model-value="onSelectSegment($event)"
      />
      <Button variant="quiet" data-testid="model-sheet-close" @click="onClose">
        {{ t('common.close') }}
      </Button>
    </div>
  </Sheet>
</template>
