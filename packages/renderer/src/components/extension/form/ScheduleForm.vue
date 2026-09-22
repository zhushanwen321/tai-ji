<script setup lang="ts">
/**
 * ScheduleForm —— schedule 问题渲染器（ScheduleCreateOverlay 整表单原样迁移，设计 D2/D5）。
 *
 * FormOverlay 壳内的「时间输入」领域渲染器：预填草稿经 question.initial 直传，打开即可
 * 一键确认（canSubmit 即壳 Submit 门）；确认回包 = 扁平 ScheduleFormResult JSON。
 *
 * 迁移裁决（设计 D5 壳层）：
 * - 组件级标题行退役（表头由壳的 form header 承担）；根容器 border/shadow 浮起样式随
 *   统一有意退役（无边框一体化，G3 scheduler 形态变更的一部分）
 * - Esc 取消改为 document 级 capture 监听（焦点在 body 也能取消；ask-user 不加 Esc 保零变化）
 * - foot 的取消/提交按钮退役由壳承担；foot 摘要行删除（与预览重复，D5）
 * - cron 预览引擎抽出 cron-preview.ts（script 行数上限；无状态纯函数零耦合）
 *
 * 时间折叠单点（D2）：once 模式提交前经 dateToOnceCron 折叠为一次性 cron，初值由
 * onceCronToDate 还原——两 helper 收口 @zhushanwen/extension-protocol（GUI/TUI 共用）。
 * 下次运行预览为纯前端轻量计算（后端 croner 的子集），预览失败仅显示非阻塞警示、
 * 不禁止提交（表达式由创建端 parseSchedule/croner 验证）。
 * once 时刻选择 = DateTimePicker 自绘组件（原生 datetime-local 的弹出日历是 OS 渲染，
 * 不跟 6 主题）；默认模式 = 单次（kind 缺省与无 draft 均落 once，draft.kind 显式
 * recurring 才落循环视图，还原成功的 once 草稿直接呈现 once 视图）。
 * 文案全走 i18n（extensionUI.scheduleCreate* 段）；星期名按当前 locale 经 Intl 输出。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, Clock, Cpu, PencilLine } from '@lucide/vue'
import ModelPickerPanel, { type ModelPickerGroup } from '@/components/panel/ModelPickerPanel.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import DateTimePicker from './DateTimePicker.vue'
import { minutesFromNow, nextFullHour, pad2, toLocalInput, tomorrowAtHour } from './datetime-local'
import {
  dateToOnceCron,
  onceCronToDate,
  type ScheduleQuestion,
  type ScheduleFormResult,
  type ScheduleKind,
} from '@zhushanwen/extension-protocol'
import {
  cronNextRuns,
  parseDurationMs,
  PREVIEW_RUN_COUNT,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
} from './cron-preview'

const props = defineProps<{
  question: ScheduleQuestion
}>()
const emit = defineEmits<{
  /** 确认回包（扁平 ScheduleFormResult JSON；壳 Submit 门经 submit() 触发） */
  submit: [result: string]
  /** Esc 取消（渲染器级键位，= cancelled result 语义） */
  cancel: []
}>()

const { t, locale } = useI18n()

// ── 表单状态（draft 驱动初值；新请求 → 壳按问题对象换引用，watch 重置）──
/** 默认单次（用户裁决 2026-09-21：打开即勾选「单次」）；draft.kind 显式 recurring 才落循环视图 */
const kind = ref<ScheduleKind>('once')
const cronText = ref('0 9 * * *')
const isCustomCron = ref(false)
const onceLocal = ref('')   // datetime-local 输入值（本地墙钟 yyyy-MM-ddTHH:mm）
const selectedModel = ref<string | undefined>(undefined)
const promptText = ref('')
const nameText = ref('')
const expires = ref<'7d' | '30d' | 'never'>('7d')
const advancedOpen = ref(false)

const KIND_OPTIONS: Array<{ value: ScheduleKind; labelKey: string }> = [
  { value: 'once', labelKey: 'extensionUI.scheduleCreateKindOnce' },
  { value: 'recurring', labelKey: 'extensionUI.scheduleCreateKindRecurring' },
]
const CRON_CHIPS: Array<{ cron: string; labelKey: string }> = [
  { cron: '*/5 * * * *', labelKey: 'extensionUI.scheduleCreateChip5m' },
  { cron: '*/30 * * * *', labelKey: 'extensionUI.scheduleCreateChip30m' },
  { cron: '0 * * * *', labelKey: 'extensionUI.scheduleCreateChipHourly' },
  { cron: '0 9 * * *', labelKey: 'extensionUI.scheduleCreateChipDaily9' },
  { cron: '0 9 * * 1-5', labelKey: 'extensionUI.scheduleCreateChipWeekday9' },
]
const EXPIRES_OPTIONS: Array<{ value: '7d' | '30d' | 'never'; labelKey: string }> = [
  { value: '7d', labelKey: 'extensionUI.scheduleCreateExpires7d' },
  { value: '30d', labelKey: 'extensionUI.scheduleCreateExpires30d' },
  { value: 'never', labelKey: 'extensionUI.scheduleCreateExpiresNever' },
]

const activeCronChip = computed(() =>
  isCustomCron.value ? undefined : CRON_CHIPS.find((c) => c.cron === cronText.value),
)

const cronInputFocused = ref<{ $el: HTMLInputElement } | null>(null)

function pickCronChip(chip: { cron: string } | null): void {
  if (chip === null) {
    isCustomCron.value = true
    void nextTick(() => cronInputFocused.value?.$el?.focus())
    return
  }
  isCustomCron.value = false
  cronText.value = chip.cron
}

// ── once 时刻换算：pad2/toLocalInput 收口 datetime-local.ts（与 DateTimePicker 共用，
//    本地墙钟语义与折叠单点一致）──

const onceDate = computed<Date | null>(() => {
  if (!onceLocal.value) return null
  const d = new Date(onceLocal.value)  // 无时区后缀 → 按本地时区解析（ES 规范）
  return Number.isNaN(d.getTime()) ? null : d
})

/** 表单时钟：交互驱动刷新（提交复核时更新）。computed 不依赖真实时钟——纯时间流逝
 *  不触发重算，once 有效性判定统一读它，提交瞬间刷新即可同时驱动提交门/预览重算 */
const nowMs = ref(Date.now())

/** once 目标时刻有效 = 已选且未过（<= now 即过，与 TUI parseMaskedDate 同判）。
 *  已过时刻提交后 dateToOnceCron 折叠的无年份 cron 会被 croner 静默顺延到明年同刻
 *  （用户意图的「今天 14:30」变「明年今天 14:30」）——表单持完整时刻（含年份），
 *  是唯一能精确判定的层。type guard：true 即非 null，供预览 runs 收窄 */
function onceTimeValid(d: Date | null): d is Date {
  return d !== null && d.getTime() > nowMs.value
}

function setOnceByMinutes(mins: number): void {
  onceLocal.value = toLocalInput(minutesFromNow(mins))
}
function setOnceTomorrowAt(hour: number): void {
  onceLocal.value = toLocalInput(tomorrowAtHour(hour))
}

function switchKind(next: ScheduleKind): void {
  kind.value = next
  // 切 once 且尚无时刻 → 默认下一个整点（与 DateTimePicker 无基座初值同语义，单点 nextFullHour）
  if (next === 'once' && !onceLocal.value) {
    onceLocal.value = toLocalInput(nextFullHour())
  }
}

// ── 模型候选（draft 直传；无 initial = 空列表 → 跟随会话当前模型）──
const models = computed(() => props.question.initial?.models ?? [])
const currentModel = computed(() => props.question.initial?.currentModel)

/** 单行选框展开态（D4：模型墙 → 单行选框 + 可搜索/provider 分组列表） */
const modelPickerOpen = ref(false)

/** 候选 → ModelPickerPanel 分组：`provider/model` 前缀分组，无前缀归无标题组。
 *  字符串 id → 展示名映射责任在表单侧（设计 §6.4）——候选即原文 id，无独立显示名 */
const modelGroups = computed<ModelPickerGroup[]>(() => {
  const map = new Map<string, ModelPickerGroup>()
  for (const id of models.value) {
    const provider = id.includes('/') ? id.slice(0, id.indexOf('/')) : ''
    const group = map.get(provider) ?? { provider, models: [] }
    group.models.push({ id })
    map.set(provider, group)
  }
  return [...map.values()]
})

// ── draft → 表单初值（预填，用户可改；isScheduleDraft 守卫已在挂载侧收窄）──
/** prompt/name 文本与 recurring 过期档的标量初值（draft 缺省回落空串/7d） */
function initPromptNameAndExpires(d: ScheduleQuestion['initial']): void {
  promptText.value = d?.prompt ?? ''
  nameText.value = d?.name ?? ''
  expires.value = d?.expires === '30d' || d?.expires === 'never' ? d.expires : '7d'
}

/** 模型预选：draft.model 优先，回退会话当前模型，再回退列表首项 */
function initModelSelection(d: ScheduleQuestion['initial']): void {
  const prefer = d?.model ?? d?.currentModel
  selectedModel.value = prefer !== undefined && models.value.includes(prefer) ? prefer : models.value[0]
}

/** once 路径还原：一次性 cron 还原本地时刻；还原失败（非 once 形态）退默认下一整点 */
function restoreOnceSchedule(schedule: string): void {
  const restored = onceCronToDate(schedule)
  if (restored) {
    onceLocal.value = toLocalInput(restored)
  } else {
    onceLocal.value = ''
    switchKind('once')
  }
}

/** recurring 路径还原：duration 形态（5m/2h）或非预设 cron → 自定义输入框展示原文 */
function restoreRecurringSchedule(schedule: string | undefined): void {
  const matched = CRON_CHIPS.find((c) => c.cron === schedule)
  cronText.value = schedule ?? '0 9 * * *'
  isCustomCron.value = matched === undefined
}

function initFromDraft(): void {
  const d = props.question.initial
  initPromptNameAndExpires(d)
  initModelSelection(d)
  if (d === undefined || d.kind === 'once') {
    // 无 draft 或单次草稿：kind 落 once（默认模式，视图与草稿一致——还原成功的 once 草稿
    // 直接呈现 once 视图，不再藏于 recurring 视图待手动切换）
    kind.value = 'once'
    if (d) restoreOnceSchedule(d.schedule)
    else onceLocal.value = toLocalInput(nextFullHour())
  } else {
    kind.value = 'recurring'
    restoreRecurringSchedule(d.schedule)
  }
}
watch(() => props.question, initFromDraft, { immediate: true })

// ── 下次运行预览（纯前端轻量计算，非实时刷新——用户改动时重算，引擎在 cron-preview.ts）──
const nextRuns = computed<{ runs: Date[]; once: boolean } | null>(() => {
  if (kind.value === 'once') {
    const d = onceDate.value
    // 已过时刻不出预览（负相对时间会落「不到 1 分钟后」误导）——由 hint 位给出已过警示
    return onceTimeValid(d) ? { runs: [d], once: true } : null
  }
  const expr = cronText.value.trim()
  const durMs = parseDurationMs(expr)
  if (durMs !== null) {
    const runs = Array.from({ length: PREVIEW_RUN_COUNT }, (_, i) => new Date(Date.now() + durMs * (i + 1)))
    return { runs, once: false }
  }
  const runs = cronNextRuns(expr, PREVIEW_RUN_COUNT, new Date())
  return runs ? { runs, once: false } : null
})

// ── 展示格式化（本地墙钟；星期名按当前 locale 经 Intl 输出）──
function formatAbs(d: Date): string {
  const wd = new Intl.DateTimeFormat(locale.value, { weekday: 'short' }).format(d)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} ${wd}`
}

function formatRel(d: Date): string {
  const ms = d.getTime() - Date.now()
  if (ms < MS_PER_MINUTE) return t('extensionUI.scheduleCreateRelUnderMin')
  if (ms < MS_PER_HOUR) return t('extensionUI.scheduleCreateRelMinutes', { n: Math.round(ms / MS_PER_MINUTE) })
  if (ms < MS_PER_DAY) {
    const h = Math.floor(ms / MS_PER_HOUR)
    const m = Math.round((ms % MS_PER_HOUR) / MS_PER_MINUTE)
    return m > 0
      ? t('extensionUI.scheduleCreateRelHoursMinutes', { h, m })
      : t('extensionUI.scheduleCreateRelHours', { h })
  }
  return t('extensionUI.scheduleCreateRelDays', { n: Math.round(ms / MS_PER_DAY) })
}

// canSubmit 与预览解耦：预览是前端轻量解析子集（后端权威 = 创建端 parseSchedule/croner），
// 预览失败不禁止提交——表达式由创建端验证（非法时后端拒，预填草稿可直接确认）。
// once 未选时刻 / 已过时刻除外：提交体需要有效未来时间值，属「未补全」而非「预览失败」。
const canSubmit = computed(() =>
  promptText.value.trim().length > 0
    && (models.value.length === 0 || selectedModel.value !== undefined)
    && (kind.value === 'recurring' || onceTimeValid(onceDate.value)),
)

/** 预览不可用时的非阻塞警示文案（once 未选时刻 / once 已过 / recurring 前端子集解析不了） */
const previewUnavailableHint = computed(() => {
  if (kind.value !== 'once') return t('extensionUI.scheduleCreatePreviewUnavailable')
  return onceDate.value === null
    ? t('extensionUI.scheduleCreatePreviewNoTime')
    : t('extensionUI.scheduleCreatePreviewTimePast')
})

// ── Esc 取消：document 级 capture（根 div 不可聚焦，焦点在 body 时根上的 keydown 收不到），
// 卸载清理；capture 阶段保证子输入框未 stopPropagation 时也能收口。
function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.preventDefault()
  emit('cancel')
}
onMounted(() => document.addEventListener('keydown', onDocumentKeydown, true))
onUnmounted(() => document.removeEventListener('keydown', onDocumentKeydown, true))

// ── 确认：构造 FormResult（once 折叠为一次性 cron，D2）→ JSON 回传 ──
// 壳 Submit 门委托 canSubmit；提交按钮在壳（本组件不再自带按钮）。submit() 是唯一
// 提交入口：emit 供直挂消费方接线，返回值供壳同步编入 FormAnswers envelope。
function submit(): string | null {
  // 提交瞬间刷新表单时钟再过提交门：否则「选 +1 分钟时刻后停留 2 分钟」场景下
  // canSubmit 返回缓存 true，已过时刻会绕过 onceTimeValid 静默提交（顺延到明年）
  nowMs.value = Date.now()
  if (!canSubmit.value) return null
  const result: ScheduleFormResult = {
    action: 'create',
    kind: kind.value,
    schedule:
      kind.value === 'once' && onceDate.value
        ? dateToOnceCron(onceDate.value)
        : cronText.value.trim(),
    ...(selectedModel.value !== undefined ? { model: selectedModel.value } : {}),
    prompt: promptText.value.trim(),
    ...(nameText.value.trim() !== '' ? { name: nameText.value.trim() } : {}),
    ...(kind.value === 'recurring' ? { expires: expires.value } : {}),
  }
  const json = JSON.stringify(result)
  emit('submit', json)
  return json
}

defineExpose({ canSubmit, submit })
</script>

<template>
  <!-- Esc 关闭 = 取消（D5：select resolve undefined → cancelled，非错误；document 级 capture 监听）。
       border/shadow 浮起样式随壳统一有意退役（无边框一体化）；按钮由壳承担。 -->
  <div class="flex flex-col">
    <div class="flex max-h-[400px] flex-col gap-3 overflow-y-auto px-3.5 pb-1 pt-2">
      <!-- ① 执行模式 + 执行时间（含下次运行预览） -->
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center gap-1.5">
          <Clock class="size-3 shrink-0 text-neutral-ico" aria-hidden="true" />
          <span class="text-[length:var(--text-2xs)] font-semibold tracking-[0.04em] text-neutral-dim">{{ t('extensionUI.scheduleCreateTimeLabel') }}</span>
          <span class="flex-1" />
          <div class="flex gap-0.5 rounded-sm bg-surface-2 p-0.5" role="radiogroup" :aria-label="t('extensionUI.scheduleCreateModeLabel')">
            <Button
              v-for="k in KIND_OPTIONS"
              :key="k.value"
              variant="ghost"
              :data-testid="`schedule-create-kind-${k.value}`"
              :aria-pressed="kind === k.value"
              :class="[
                'px-3 py-1 text-[length:var(--text-xs)] transition-colors',
                kind === k.value ? 'bg-bg-elevated font-medium text-neutral-fg' : 'text-neutral-dim hover:text-neutral-mid',
              ]"
              @click="switchKind(k.value)"
            >{{ t(k.labelKey) }}</Button>
          </div>
        </div>

        <!-- recurring：cron 预设 chips + 自定义输入 -->
        <template v-if="kind === 'recurring'">
          <div class="flex flex-wrap gap-1.5">
            <Button
              v-for="chip in CRON_CHIPS"
              :key="chip.cron"
              variant="ghost"
              :data-testid="`schedule-create-cron-chip-${chip.cron}`"
              :aria-pressed="activeCronChip?.cron === chip.cron"
              :class="[
                'rounded-sm border px-2.5 py-1 font-mono text-[length:var(--text-2xs)] transition-colors',
                activeCronChip?.cron === chip.cron
                  ? 'border-accent bg-accent-soft text-neutral-fg'
                  : 'border-border-strong text-neutral-mid hover:text-neutral-fg',
              ]"
              @click="pickCronChip(chip)"
            >{{ t(chip.labelKey) }}</Button>
            <Button
              variant="ghost"
              data-testid="schedule-create-cron-custom"
              :aria-pressed="isCustomCron"
              :class="[
                'rounded-sm border px-2.5 py-1 font-mono text-[length:var(--text-2xs)] transition-colors',
                isCustomCron
                  ? 'border-accent bg-accent-soft text-neutral-fg'
                  : 'border-border-strong text-neutral-mid hover:text-neutral-fg',
              ]"
              @click="pickCronChip(null)"
            >{{ t('extensionUI.scheduleCreateCronCustom') }}</Button>
          </div>
          <div v-show="isCustomCron" class="flex items-center gap-2">
            <Input
              ref="cronInputFocused"
              v-model="cronText"
              type="text"
              data-testid="schedule-create-cron-input"
              placeholder="*/10 * * * *"
              class="h-7 w-44 font-mono text-[length:var(--text-xs)]"
            />
          </div>
        </template>

        <!-- once：自绘时刻选择器（自绘月历 + HH/mm 双段，6 主题 token 跟随）+ 快捷 chips -->
        <template v-else>
          <DateTimePicker v-model="onceLocal" />
          <div class="flex flex-wrap gap-1.5">
            <Button variant="ghost" data-testid="schedule-create-once-plus-1h" class="rounded-sm border border-border-strong px-2.5 py-1 text-[length:var(--text-2xs)] text-neutral-mid transition-colors hover:text-neutral-fg" @click="setOnceByMinutes(60)">{{ t('extensionUI.scheduleCreateOncePlus1h') }}</Button>
            <Button variant="ghost" data-testid="schedule-create-once-tomorrow-9" class="rounded-sm border border-border-strong px-2.5 py-1 text-[length:var(--text-2xs)] text-neutral-mid transition-colors hover:text-neutral-fg" @click="setOnceTomorrowAt(9)">{{ t('extensionUI.scheduleCreateOnceTomorrow9') }}</Button>
            <Button variant="ghost" data-testid="schedule-create-once-tomorrow-20" class="rounded-sm border border-border-strong px-2.5 py-1 text-[length:var(--text-2xs)] text-neutral-mid transition-colors hover:text-neutral-fg" @click="setOnceTomorrowAt(20)">{{ t('extensionUI.scheduleCreateOnceTomorrow20') }}</Button>
          </div>
        </template>

        <!-- 下次运行预览 -->
        <div data-testid="schedule-create-preview" class="rounded-sm bg-surface-2 px-2.5 py-2 text-[length:var(--text-2xs)] leading-[1.8] text-neutral-mid">
          <template v-if="nextRuns">
            <div class="font-semibold tracking-[0.04em] text-neutral-dim">{{ nextRuns.once ? t('extensionUI.scheduleCreatePreviewOnce') : t('extensionUI.scheduleCreatePreviewRecurring') }}</div>
            <div
              v-for="(d, i) in nextRuns.runs"
              :key="`${d.getTime()}-${i}`"
              class="flex gap-2"
              :class="i > 0 && 'font-mono'"
            >
              <span class="w-3.5 shrink-0 text-right text-neutral-dim">{{ i + 1 }}</span>
              <span>{{ formatAbs(d) }}</span>
              <span class="text-accent">{{ formatRel(d) }}</span>
            </div>
          </template>
          <div v-else class="text-warn">{{ previewUnavailableHint }}</div>
        </div>
      </div>

      <!-- ② 执行模型（单行选框；空列表 = 跟随会话当前模型） -->
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center gap-1.5">
          <Cpu class="size-3 shrink-0 text-neutral-ico" aria-hidden="true" />
          <span class="text-[length:var(--text-2xs)] font-semibold tracking-[0.04em] text-neutral-dim">{{ t('extensionUI.scheduleCreateModelLabel') }}</span>
        </div>
        <div v-if="models.length > 0" class="flex flex-col gap-1">
          <!-- D4 单行选框：默认选中会话当前模型；展开 = 可搜索 + provider 分组列表。
               内联展开（非 portal）避免浮层被 FormOverlay overflow-hidden 裁切；列表体常挂 v-show。 -->
          <Button
            variant="ghost"
            data-testid="schedule-create-model-trigger"
            :aria-expanded="modelPickerOpen"
            class="flex w-full items-center gap-2 rounded-sm border border-border-strong px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover"
            @click="modelPickerOpen = !modelPickerOpen"
          >
            <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-xs)] text-neutral-fg">{{ selectedModel ?? '—' }}</span>
            <span v-if="selectedModel === currentModel" class="shrink-0 rounded-sm border border-border-strong px-1 text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateCurrentTag') }}</span>
            <ChevronDown :class="['size-3 shrink-0 text-neutral-ico transition-transform', modelPickerOpen && 'rotate-180']" aria-hidden="true" />
          </Button>
          <div v-show="modelPickerOpen" data-testid="schedule-create-model-list" class="overflow-hidden rounded-sm border border-border-strong">
            <ModelPickerPanel
              :groups="modelGroups"
              :model-value="selectedModel ?? ''"
              :has-candidates="models.length > 0"
              item-test-id-prefix="schedule-create-model"
              @update:model-value="selectedModel = $event; modelPickerOpen = false"
            />
          </div>
        </div>
        <p v-else class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateNoModelsHint') }}</p>
        <p v-if="models.length > 0" class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateModelHint') }}</p>
      </div>

      <!-- ③ 提示词 -->
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center gap-1.5">
          <PencilLine class="size-3 shrink-0 text-neutral-ico" aria-hidden="true" />
          <span class="text-[length:var(--text-2xs)] font-semibold tracking-[0.04em] text-neutral-dim">{{ t('extensionUI.scheduleCreatePromptLabel') }}</span>
          <span v-if="promptText.trim().length > 0" class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreatePromptHint', { count: promptText.trim().length }) }}</span>
        </div>
        <Textarea
          v-model="promptText"
          rows="3"
          data-testid="schedule-create-prompt"
          class="min-h-14 text-[length:var(--text-xs)]"
        />
      </div>

      <!-- 高级选项（任务名 / 过期策略；折叠） -->
      <div class="flex flex-col gap-1.5">
        <Button
          variant="ghost"
          data-testid="schedule-create-advanced-toggle"
          class="h-auto w-fit px-0 py-0 text-[length:var(--text-2xs)] text-neutral-dim hover:text-neutral-fg"
          :aria-expanded="advancedOpen"
          @click="advancedOpen = !advancedOpen"
        >
          <ChevronRight :class="['size-3 transition-transform', advancedOpen && 'rotate-90']" aria-hidden="true" />
          {{ t('extensionUI.scheduleCreateAdvancedToggle') }}
        </Button>
        <div v-show="advancedOpen" class="flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <span class="w-14 shrink-0 text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateNameLabel') }}</span>
            <Input v-model="nameText" type="text" data-testid="schedule-create-name" :placeholder="t('extensionUI.scheduleCreateNamePlaceholder')" class="h-7 flex-1 text-[length:var(--text-xs)]" />
          </div>
          <div class="flex items-center gap-2">
            <span class="w-14 shrink-0 text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateExpiresLabel') }}</span>
            <Button
              v-for="opt in EXPIRES_OPTIONS"
              :key="opt.value"
              variant="ghost"
              :data-testid="`schedule-create-expires-${opt.value}`"
              :aria-pressed="expires === opt.value"
              :class="[
                'rounded-sm border px-2 py-0.5 text-[length:var(--text-2xs)] transition-colors',
                expires === opt.value
                  ? 'border-accent bg-accent-soft text-neutral-fg'
                  : 'border-border-strong text-neutral-mid hover:text-neutral-fg',
              ]"
              @click="expires = opt.value"
            >{{ t(opt.labelKey) }}</Button>
            <span class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateExpiresHint') }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Esc 取消提示（foot 摘要行已退役：与下次运行预览重复，D5） -->
    <div class="flex items-center justify-end px-3.5 pb-1 pt-0.5">
      <span data-testid="schedule-create-esc-hint" class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateEscHint') }}</span>
    </div>
  </div>
</template>
