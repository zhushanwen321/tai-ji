<script setup lang="ts">
/**
 * DateTimePicker —— once 时刻选择器（自绘月历 + HH/mm 双段编辑，替代原生 datetime-local）。
 *
 * 原生 datetime-local 的弹出日历是 OS 渲染：亮色固定、不跟 6 主题（玄/黛蓝/暖墨/皓/青墨/朱印）、
 * 跨平台不一致——自绘后全部消费 style.css 主题槽位 token，6 主题自动跟随，零色值。
 *
 * 契约：v-model = datetime-local 同形字符串 `yyyy-MM-ddTHH:mm`（本地墙钟，换算单点在
 * datetime-local.ts）——ScheduleForm 的 onceDate / onceTimeValid / dateToOnceCron 折叠链零改动。
 * 空串 = 未选时刻（提交门由 ScheduleForm.canSubmit 承担，本组件只做视觉提示）。
 *
 * 形态：与 ModelPickerPanel 触发框/列表体同构（border-strong + ChevronDown 旋转 + 内联展开——
 * FormOverlay overflow-hidden 不容浮层）；日期格选中 = accent 实色 + accent-fg 深字（6 主题
 * 均有 accent-fg 配对）。月份/星期经 Intl 按当前 locale 输出（与表单 formatAbs 同范式，零词表）。
 *
 * 数据流：modelValue 是唯一数据源；HH/mm 编辑态为本地草稿（blur / 步进 / 点选才 emit，
 * 避免键入中间态回流打断输入）；日历视图随 modelValue 同步月份。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MS_PER_DAY } from './cron-preview'
import { nextFullHour, pad2, parseLocalInput, TIME_FIELD_WIDTH, toLocalInput } from './datetime-local'

const props = defineProps<{
  /** datetime-local 同形字符串（`yyyy-MM-ddTHH:mm`）；空串 = 未选 */
  modelValue: string
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { t, locale } = useI18n()

// ── 一周/步进常量（no-magic-numbers）──
const DAYS_PER_WEEK = 7
/** 周一起始：getDay() 周日=0 → 偏移 6 使周一落 0 */
const MONDAY_FIRST_OFFSET = 6
const HOUR_STEP = 1
const MINUTE_STEP = 15
const HH_MAX = 23
const MM_MAX = 59
/** 日期键长度（`yyyy-MM-dd`，选中/今天判定键） */
const DATE_KEY_LENGTH = 10
/** 周一锚点：2024-01-01 恰为周一（星期表头基准，i 为 0..6 的天数偏移） */
const MONDAY_ANCHOR_YEAR = 2024
/** 整点快捷档（调度场景常用时刻：上午 / 午间 / 傍晚 / 晚间） */
const QUICK_HOUR_MORNING = 9
const QUICK_HOUR_NOON = 12
const QUICK_HOUR_EVENING = 18
const QUICK_HOUR_NIGHT = 21
const QUICK_HOURS = [QUICK_HOUR_MORNING, QUICK_HOUR_NOON, QUICK_HOUR_EVENING, QUICK_HOUR_NIGHT] as const

// ── 解析（modelValue 单一数据源；isPast 交互驱动刷新，纯时间流逝不重算——与表单 nowMs 时钟同语义）──
const parsed = computed(() => parseLocalInput(props.modelValue))
const isPast = computed(() => parsed.value !== null && parsed.value.getTime() <= Date.now())

/** 面板展开态（内联展开，收起即隐藏） */
const open = ref(false)

// ── 日历视图（随选中值同步月份）──
const view = ref(new Date())

watch(
  () => props.modelValue,
  (v) => {
    const d = parseLocalInput(v)
    if (d) view.value = new Date(d.getFullYear(), d.getMonth(), 1)
  },
  { immediate: true },
)

interface CalendarCell {
  /** `yyyy-MM-dd`（选中/今天判定键，跨月同号不冲突） */
  key: string
  label: string
  date: Date
  out: boolean
  today: boolean
  selected: boolean
}

const monthLabel = computed(() =>
  new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long' }).format(view.value),
)

/** 星期短名 formatter（触发框周几后缀；Intl 收口 computed，模板内联构造会因 locale ref
 *  解包差异拿到非字符串 locale） */
const weekdayFormatter = computed(() => new Intl.DateTimeFormat(locale.value, { weekday: 'short' }))

/** 星期表头：周一起始，7 个基准日经 Intl 输出（周一=0） */
const dowLabels = computed(() => {
  const fmt = new Intl.DateTimeFormat(locale.value, { weekday: 'short' })
  const base = new Date(MONDAY_ANCHOR_YEAR, 0, 1)
  return Array.from({ length: DAYS_PER_WEEK }, (_, i) => fmt.format(new Date(base.getTime() + i * MS_PER_DAY)))
})

const cells = computed<CalendarCell[]>(() => {
  const y = view.value.getFullYear()
  const m = view.value.getMonth()
  const firstDow = (new Date(y, m, 1).getDay() + MONDAY_FIRST_OFFSET) % DAYS_PER_WEEK
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  const rows = Math.ceil((firstDow + daysInMonth) / DAYS_PER_WEEK)
  const todayKey = toLocalInput(new Date()).slice(0, DATE_KEY_LENGTH)
  const selKey = props.modelValue ? props.modelValue.slice(0, DATE_KEY_LENGTH) : ''
  const arr: CalendarCell[] = []
  for (let i = 0; i < rows * DAYS_PER_WEEK; i++) {
    const date = new Date(y, m, i - firstDow + 1)
    const key = toLocalInput(date).slice(0, DATE_KEY_LENGTH)
    arr.push({
      key,
      label: pad2(date.getDate()),
      date,
      out: date.getMonth() !== m,
      today: key === todayKey,
      selected: key === selKey,
    })
  }
  return arr
})

function shiftMonth(delta: number): void {
  view.value = new Date(view.value.getFullYear(), view.value.getMonth() + delta, 1)
}

/** 选日期：保留已选时刻（仅改日期意图）；无时刻基座 → 下一整点 */
function pickDay(cell: CalendarCell): void {
  const base = parsed.value ?? nextFullHour()
  view.value = new Date(cell.date.getFullYear(), cell.date.getMonth(), 1)
  emit(
    'update:modelValue',
    toLocalInput(
      new Date(cell.date.getFullYear(), cell.date.getMonth(), cell.date.getDate(), base.getHours(), base.getMinutes()),
    ),
  )
}

// ── 时间双段（本地编辑态：blur / 步进 / 快捷档才 emit；键入中不回流打断）──
const hhText = ref('')
const mmText = ref('')

watch(
  () => props.modelValue,
  (v) => {
    const d = parseLocalInput(v)
    hhText.value = d ? pad2(d.getHours()) : ''
    mmText.value = d ? pad2(d.getMinutes()) : ''
  },
  { immediate: true },
)

function emitTime(hh: number, mm: number): void {
  const base = parsed.value ?? nextFullHour()
  emit(
    'update:modelValue',
    toLocalInput(new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm)),
  )
}

function onTimeInput(which: 'hh' | 'mm'): void {
  const el = which === 'hh' ? hhText : mmText
  el.value = el.value.replace(/\D/g, '').slice(0, TIME_FIELD_WIDTH)
}

/** blur/Enter：clamp 归一并 emit（面板时间字段唯一 emit 点之一） */
function commitTime(which: 'hh' | 'mm'): void {
  const raw = which === 'hh' ? hhText.value : mmText.value
  const n = Number.parseInt(raw, 10)
  const max = which === 'hh' ? HH_MAX : MM_MAX
  const clamped = Number.isNaN(n) ? null : Math.min(n, max)
  if (clamped === null) {
    // 无有效输入：回显当前值（空值语义交由 ScheduleForm 提交门）
    const d = parsed.value
    if (which === 'hh') hhText.value = d ? pad2(d.getHours()) : ''
    else mmText.value = d ? pad2(d.getMinutes()) : ''
    return
  }
  const other = which === 'hh' ? curMm() : curHh()
  emitTime(which === 'hh' ? clamped : other, which === 'hh' ? other : clamped)
}

function curHh(): number {
  const n = Number.parseInt(hhText.value, 10)
  return Number.isNaN(n) ? 0 : Math.min(n, HH_MAX)
}
function curMm(): number {
  const n = Number.parseInt(mmText.value, 10)
  return Number.isNaN(n) ? 0 : Math.min(n, MM_MAX)
}

/** 键盘上下 / stepper 步进：时 ±1h、分 ±15m，clamp 不环绕（datetime-local 同判） */
function stepTime(which: 'hh' | 'mm', delta: number): void {
  const max = which === 'hh' ? HH_MAX : MM_MAX
  const cur = which === 'hh' ? curHh() : curMm()
  const next = Math.min(Math.max(cur + delta, 0), max)
  const other = which === 'hh' ? curMm() : curHh()
  emitTime(which === 'hh' ? next : other, which === 'hh' ? other : next)
}

/** stepper 作用目标 = 最近聚焦段 */
const lastField = ref<'hh' | 'mm'>('hh')

const quickActive = computed(() => {
  const d = parsed.value
  return d !== null && d.getMinutes() === 0 && (QUICK_HOURS as readonly number[]).includes(d.getHours())
})
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <!-- 触发框：与 ModelPickerPanel 触发框同构（testid 沿用 schedule-create-once-input，回归断言不断） -->
    <Button
      variant="ghost"
      data-testid="schedule-create-once-input"
      :aria-expanded="String(open)"
      class="h-auto w-full items-center gap-2 rounded-sm border border-border-strong px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover"
      @click="open = !open"
    >
      <CalendarDays class="size-3.5 shrink-0 text-neutral-ico" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-xs)]" :class="isPast ? 'text-warn' : 'text-neutral-fg'">
        <template v-if="parsed">
          {{ `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}` }}
          <span class="ml-1.5 text-neutral-dim">{{ weekdayFormatter.format(parsed) }}</span>
        </template>
        <template v-else>{{ t('extensionUI.scheduleCreatePreviewNoTime') }}</template>
      </span>
      <ChevronDown class="size-3 shrink-0 text-neutral-ico transition-transform" :class="open && 'rotate-180'" aria-hidden="true" />
    </Button>

    <!-- 展开面板：内联（FormOverlay overflow-hidden 不容浮层），与 ModelPickerPanel 列表体同构 -->
    <div v-show="open" data-testid="schedule-create-once-panel" class="overflow-hidden rounded-sm border border-border-strong">
      <!-- 月历头 -->
      <div class="flex items-center px-2 py-1.5">
        <Button variant="ghost" data-testid="schedule-create-once-prev-month" class="size-[22px] rounded-sm p-0 text-neutral-ico hover:text-neutral-fg" :aria-label="t('extensionUI.scheduleCreatePickerPrevMonth')" @click="shiftMonth(-1)">
          <ChevronLeft class="size-3" aria-hidden="true" />
        </Button>
        <span class="min-w-0 flex-1 text-center text-[length:var(--text-xs)] font-medium text-neutral-fg">{{ monthLabel }}</span>
        <Button variant="ghost" data-testid="schedule-create-once-next-month" class="size-[22px] rounded-sm p-0 text-neutral-ico hover:text-neutral-fg" :aria-label="t('extensionUI.scheduleCreatePickerNextMonth')" @click="shiftMonth(1)">
          <ChevronRight class="size-3" aria-hidden="true" />
        </Button>
      </div>

      <!-- 日期网格（周一起始；out=跨月补位弱化；today=inset 描边；selected=accent 实色让位描边） -->
      <div class="grid grid-cols-7 px-2 pb-1.5" data-testid="schedule-create-once-calendar">
        <span v-for="w in dowLabels" :key="w" class="pb-1 text-center text-[length:var(--text-3xs)] text-neutral-dim">{{ w }}</span>
        <Button
          v-for="cell in cells"
          :key="cell.key"
          variant="ghost"
          :data-testid="`schedule-create-once-day-${cell.key}`"
          :aria-pressed="cell.selected"
          class="h-[26px] rounded-sm p-0 font-mono text-[length:var(--text-xs)] transition-colors"
          :class="[
            cell.selected
              ? 'bg-accent font-semibold text-accent-fg hover:bg-accent-hover hover:text-accent-fg'
              : cell.out
                ? 'text-neutral-faint hover:text-neutral-mid'
                : 'text-neutral-mid hover:text-neutral-fg',
            cell.today && !cell.selected && 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
          ]"
          @click="pickDay(cell)"
        >{{ cell.label }}</Button>
      </div>

      <!-- 时间双段：blur/Enter 归一 emit；↑↓ 步进（时 ±1h / 分 ±15m）；stepper 作用于最近聚焦段 -->
      <div class="flex items-center gap-2 border-t border-hairline px-2 py-2">
        <span class="shrink-0 text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreatePickerTimeLabel') }}</span>
        <div class="flex items-center gap-1">
          <Input
            v-model="hhText"
            data-testid="schedule-create-once-hh"
            :aria-label="t('extensionUI.scheduleCreatePickerHour')"
            inputmode="numeric"
            class="h-[26px] w-10 px-0 text-center font-mono text-[length:var(--text-xs)]"
            @input="onTimeInput('hh')"
            @blur="commitTime('hh')"
            @keydown.enter="commitTime('hh')"
            @keydown.up.prevent="stepTime('hh', HOUR_STEP)"
            @keydown.down.prevent="stepTime('hh', -HOUR_STEP)"
            @focus="lastField = 'hh'"
          />
          <span class="font-mono text-[length:var(--text-xs)] text-neutral-faint">:</span>
          <Input
            v-model="mmText"
            data-testid="schedule-create-once-mm"
            :aria-label="t('extensionUI.scheduleCreatePickerMinute')"
            inputmode="numeric"
            class="h-[26px] w-10 px-0 text-center font-mono text-[length:var(--text-xs)]"
            @input="onTimeInput('mm')"
            @blur="commitTime('mm')"
            @keydown.enter="commitTime('mm')"
            @keydown.up.prevent="stepTime('mm', MINUTE_STEP)"
            @keydown.down.prevent="stepTime('mm', -MINUTE_STEP)"
            @focus="lastField = 'mm'"
          />
        </div>
        <div class="flex flex-col gap-px">
          <Button variant="ghost" data-testid="schedule-create-once-step-up" class="h-[13px] w-5 rounded-sm p-0 text-neutral-ico hover:text-neutral-fg" :aria-label="t('extensionUI.scheduleCreatePickerStepUp')" @click="stepTime(lastField, lastField === 'hh' ? HOUR_STEP : MINUTE_STEP)">
            <ChevronUp class="size-3" aria-hidden="true" />
          </Button>
          <Button variant="ghost" data-testid="schedule-create-once-step-down" class="h-[13px] w-5 rounded-sm p-0 text-neutral-ico hover:text-neutral-fg" :aria-label="t('extensionUI.scheduleCreatePickerStepDown')" @click="stepTime(lastField, lastField === 'hh' ? -HOUR_STEP : -MINUTE_STEP)">
            <ChevronDown class="size-3" aria-hidden="true" />
          </Button>
        </div>
        <!-- 整点快捷档（保持选中日期，仅改时刻） -->
        <div class="flex flex-wrap gap-1">
          <Button
            v-for="h in QUICK_HOURS"
            :key="h"
            variant="ghost"
            :data-testid="`schedule-create-once-quick-${pad2(h)}00`"
            :aria-pressed="quickActive && parsed?.getHours() === h"
            class="rounded-sm border border-border px-2 py-0.5 font-mono text-[length:var(--text-2xs)] text-neutral-mid transition-colors hover:border-border-strong hover:text-neutral-fg"
            :class="(quickActive && parsed?.getHours() === h) && 'border-accent bg-accent-soft text-neutral-fg'"
            @click="emitTime(h, 0)"
          >{{ pad2(h) }}:00</Button>
        </div>
      </div>

      <!-- 已过时刻警示（提交门在 ScheduleForm.onceTimeValid，此处仅视觉提示） -->
      <div v-if="isPast" class="flex items-center gap-1.5 px-2 pb-2 text-[length:var(--text-2xs)] text-warn">
        <TriangleAlert class="size-3 shrink-0" aria-hidden="true" />
        <span>{{ t('extensionUI.scheduleCreatePreviewTimePast') }}</span>
      </div>
    </div>
  </div>
</template>
