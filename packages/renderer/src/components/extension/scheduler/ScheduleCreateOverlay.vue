<script setup lang="ts">
// split-justified: scheduler-create 确认表单（draft 预填 + cron/duration 预览计算 + FormResult 回传契约，单文件自洽——拆 cron 预览计算到独立 helper 反增间接层，vue_rules_checker 登记豁免）
/**
 * ScheduleCreateOverlay —— scheduler 创建确认弹框（GUI inline，schedule-create-confirm-modal U6）。
 *
 * agent 调 `schedule` 工具提交预填草稿（ScheduleDraft）→ select 通道经
 * SCHEDULE_CREATE_MARKER 翻译为 extension.ui_request → Panel 分流挂载本组件（覆盖
 * composer 位置，AskUserOverlay 同挂载形态）→ 确认后 emit submit(FormResult JSON) 回传
 * → select resolve → 任务才真正创建（G1）。
 *
 * 视觉与交互对齐 demo（.tmp/scheduler-create-modal-demo.html）+ DESIGN.md 现行 tokens：浮层 12px
 * 圆角、border 仅浮起容器（内部不叠加）、Esc 关闭（= 取消，D5 cancelled 语义）。
 *
 * 时间折叠单点（D2）：once 模式提交前经 dateToOnceCron 折叠为一次性 cron，初值由
 * onceCronToDate 还原——两 helper 收口 @zhushanwen/extension-protocol（U1），GUI/TUI 共用。
 * 下次运行预览为纯前端轻量计算（cron 分钟步进穷举 + duration 步进），不引入 croner 等
 * renderer 新依赖；解析是后端 croner 的子集（5/6 段 + 周域英文名），预览失败仅显示非阻塞
 * 警示、不禁止提交（表达式由创建端 parseSchedule/croner 验证，G1 预填草稿可直接确认）。
 * 文案全走 i18n（extensionUI.scheduleCreate* 段，locale-sync 守卫 U8 零 CJK）；
 * 星期名按当前 locale 经 Intl 输出。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Clock, Cpu, PencilLine } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  dateToOnceCron,
  onceCronToDate,
  type ScheduleDraft,
  type ScheduleFormResult,
  type ScheduleKind,
} from '@zhushanwen/extension-protocol'

const props = defineProps<{
  draft: ScheduleDraft
}>()
const emit = defineEmits<{
  submit: [result: string]  // JSON.stringify(ScheduleFormResult)
  cancel: []
}>()

const { t, locale } = useI18n()

// ── 表单状态（draft 驱动初值；新请求 → Panel 按 requestId 换 draft，watch 重置）──
const kind = ref<ScheduleKind>('recurring')
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

// ── once 时刻换算（datetime-local 值 ↔ Date，本地墙钟语义与 U1 helper 一致）──
/** 时间字段两位补零（no-magic-numbers：目标宽度具名） */
const TIME_FIELD_WIDTH = 2
const pad2 = (n: number): string => String(n).padStart(TIME_FIELD_WIDTH, '0')

function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const onceDate = computed<Date | null>(() => {
  if (!onceLocal.value) return null
  const d = new Date(onceLocal.value)  // 无时区后缀 → 按本地时区解析（ES 规范）
  return Number.isNaN(d.getTime()) ? null : d
})

function setOnceByMinutes(mins: number): void {
  onceLocal.value = toLocalInput(new Date(Date.now() + mins * MS_PER_MINUTE))
}
function setOnceTomorrowAt(hour: number): void {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(hour, 0, 0, 0)
  onceLocal.value = toLocalInput(d)
}

function switchKind(next: ScheduleKind): void {
  kind.value = next
  // 切 once 且尚无时刻 → 默认下一个整点（demo 同款初值）
  if (next === 'once' && !onceLocal.value) {
    const d = new Date(Date.now() + MS_PER_HOUR)
    d.setMinutes(0, 0)
    onceLocal.value = toLocalInput(d)
  }
}

// ── draft → 表单初值（预填，用户可改；isScheduleDraft 守卫已在 Panel 侧收窄）──
function initFromDraft(): void {
  const d = props.draft
  promptText.value = d.prompt
  nameText.value = d.name ?? ''
  expires.value = d.expires === '30d' || d.expires === 'never' ? d.expires : '7d'
  // 模型预选：draft.model 优先，回退会话当前模型，再回退列表首项
  const prefer = d.model ?? d.currentModel
  selectedModel.value = prefer !== undefined && d.models.includes(prefer) ? prefer : d.models[0]
  if (d.kind === 'once') {
    // 一次性 cron 还原本地时刻；还原失败（非 once 形态）退默认下一整点
    const restored = onceCronToDate(d.schedule)
    if (restored) {
      onceLocal.value = toLocalInput(restored)
    } else {
      onceLocal.value = ''
      switchKind('once')
    }
  } else {
    // recurring：duration 形态（5m/2h）或非预设 cron → 自定义输入框展示原文
    const matched = CRON_CHIPS.find((c) => c.cron === d.schedule)
    cronText.value = d.schedule
    isCustomCron.value = matched === undefined
  }
}
watch(() => props.draft, initFromDraft, { immediate: true })

// ── 下次运行预览（纯前端轻量计算，非实时刷新——用户改动时重算，demo 同语义）──

type CronField = Set<number> | null  // null = 通配
// cron 五域上限（分 0-59 / 时 0-23 / 日 1-31 / 月 1-12 / 周 0-7；周域 7 = 周日惯例，与 0 等价）
const CRON_MINUTE_MAX = 59
const CRON_HOUR_MAX = 23
const CRON_DAY_MAX = 31
const CRON_MONTH_MAX = 12
const CRON_DOW_MAX = 7
const CRON_FIELD_MIN = [0, 0, 1, 1, 0]
const CRON_FIELD_MAX = [CRON_MINUTE_MAX, CRON_HOUR_MAX, CRON_DAY_MAX, CRON_MONTH_MAX, CRON_DOW_MAX]

function parseCronPart(part: string, rangeIdx: number): CronField | 'invalid' {
  if (part === '*') return null
  const min = CRON_FIELD_MIN[rangeIdx] ?? 0
  const max = CRON_FIELD_MAX[rangeIdx] ?? CRON_MINUTE_MAX
  const out = new Set<number>()
  for (const seg of part.split(',')) {
    // 周域英文名归一为数字（后端权威 croner 接受 MON-SUN；前端预览子集等价映射），
    // 替换后复用既有数字/范围/步进逻辑（MON-FRI → 1-5、MON,WED → 1,3）
    const norm = rangeIdx === CRON_DOW_FIELD_INDEX
      ? seg.replace(DOW_NAME_RE, (m) => String(DOW_NAME_TO_NUMBER[m.toLowerCase()] ?? m))
      : seg
    const step = norm.match(/^\*\/(\d+)$/)
    if (step) {
      const st = Number(step[1])
      if (st < 1) return 'invalid'
      for (let v = min; v <= max; v += st) out.add(v)
      continue
    }
    const rng = norm.match(/^(\d+)-(\d+)$/)
    if (rng) {
      const a = Number(rng[1])
      const b = Number(rng[2])
      if (a < min || b > max || a > b) return 'invalid'
      for (let v = a; v <= b; v++) out.add(v)
      continue
    }
    if (!/^\d+$/.test(norm)) return 'invalid'
    const n = Number(norm)
    if (n < min || n > max) return 'invalid'
    out.add(n)
  }
  return out
}

/** 预览条数（循环任务展示前 5 次下次运行） */
const PREVIEW_RUN_COUNT = 5

function cronMatches(cursor: Date, fields: CronField[]): boolean {
  const vals = [cursor.getMinutes(), cursor.getHours(), cursor.getDate(), cursor.getMonth() + 1, cursor.getDay()]
  for (let i = 0; i < vals.length; i++) {
    const f = fields[i]
    if (!f) continue
    if (f.has(vals[i])) continue
    if (i === CRON_DOW_FIELD_INDEX && vals[i] === 0 && f.has(CRON_DOW_MAX)) continue  // 周域 7 = 周日
    return false
  }
  return true
}

/** 5/6 段 cron 下次运行（分钟步进穷举，上界 366 天，无命中返回 null）。
 *  6 段 = 首段秒（croner 语义）：预览为分钟粒度，跳过秒段算后续字段（秒段非 0/* 时
 *  实际触发在命中分钟内的第 N 秒，预览显示到分钟，不承诺秒级精度）。 */
function cronNextRuns(expr: string, count: number, from: Date): Date[] | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== CRON_FIELD_COUNT && parts.length !== CRON_FIELD_COUNT_WITH_SECONDS) return null
  const fieldOffset = parts.length === CRON_FIELD_COUNT_WITH_SECONDS ? 1 : 0
  const fields: CronField[] = []
  for (let i = 0; i < CRON_FIELD_COUNT; i++) {
    const f = parseCronPart(parts[i + fieldOffset]!, i)
    if (f === 'invalid') return null
    fields.push(f)
  }
  const out: Date[] = []
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = (CRON_SCAN_LIMIT_DAYS * MS_PER_DAY) / MS_PER_MINUTE
  let stepped = 0
  while (out.length < count && stepped < limit) {
    if (cronMatches(cursor, fields)) out.push(new Date(cursor.getTime()))
    cursor.setMinutes(cursor.getMinutes() + 1)
    stepped++
  }
  return out.length > 0 ? out : null
}

// 时长进率常量（no-magic-numbers 单一声明处）：duration 解析与预览/初值计算共用
const MS_PER_MINUTE = 60_000
/** cron 协议常量：5 段表达式（分 时 日 月 周）+ 周域索引（第 5 域）+ 每周 7 天 */
const CRON_FIELD_COUNT = 5
const CRON_DOW_FIELD_INDEX = 4
/** 6 段含秒形态（秒 分 时 日 月 周；croner 接受，后端 normalize 5 段补秒后同为 6 段） */
const CRON_FIELD_COUNT_WITH_SECONDS = 6
/** 周域英文名域（croner 接受 MON-SUN，大小写不敏感）→ 数字（0=周日，与数字域语义一致） */
const DOW_NAME_TO_NUMBER: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const DOW_NAME_RE = /\b(sun|mon|tue|wed|thu|fri|sat)\b/gi
const DAYS_PER_WEEK = 7
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
const DURATION_UNITS: Record<string, number> = { m: MS_PER_MINUTE, h: MS_PER_HOUR, d: MS_PER_DAY, w: DAYS_PER_WEEK * MS_PER_DAY }
/** cron 步进穷举上界天数（闰年覆盖；一步 = 1 分钟） */
const CRON_SCAN_LIMIT_DAYS = 366

/** duration（如 5m/2h/7d）→ ms；非 duration 形态返回 null */
function parseDurationMs(s: string): number | null {
  const m = s.trim().match(/^(\d+)([mhdw])$/)
  if (!m) return null
  const unit = DURATION_UNITS[m[2]]
  return unit === undefined ? null : Number(m[1]) * unit
}

const nextRuns = computed<{ runs: Date[]; once: boolean } | null>(() => {
  if (kind.value === 'once') {
    const d = onceDate.value
    return d ? { runs: [d], once: true } : null
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

/** 预览摘要（foot note 用）：cron 命中预设 chip 显本地化标签，否则原样表达式 */
const scheduleSummary = computed<string>(() => {
  if (kind.value === 'once') {
    return onceDate.value
      ? t('extensionUI.scheduleCreateSummaryOnce', { detail: formatAbs(onceDate.value) })
      : t('extensionUI.scheduleCreateSummaryOnceNoTime')
  }
  const expr = cronText.value.trim()
  return t('extensionUI.scheduleCreateSummaryRecurring', { detail: activeCronChip.value ? t(activeCronChip.value.labelKey) : expr })
})

// canSubmit 与预览解耦：预览是前端轻量解析子集（后端权威 = 创建端 parseSchedule/croner），
// 预览失败不禁止提交——表达式由创建端验证（非法时后端拒，G1 预填草稿可直接确认）。
// once 未选时刻除外：提交体需要时间值，属「未补全」而非「预览失败」。
const canSubmit = computed(() =>
  promptText.value.trim().length > 0
  && (props.draft.models.length === 0 || selectedModel.value !== undefined)
  && (kind.value === 'recurring' || onceDate.value !== null),
)

/** 预览不可用时的非阻塞警示文案（once 未选时刻 / recurring 前端子集解析不了） */
const previewUnavailableHint = computed(() =>
  kind.value === 'once'
    ? t('extensionUI.scheduleCreatePreviewNoTime')
    : t('extensionUI.scheduleCreatePreviewUnavailable'),
)

const footNote = computed(() =>
  canSubmit.value
    ? `${scheduleSummary.value}${selectedModel.value ? ` · ${selectedModel.value.split('/').pop() ?? ''}` : ''}`
    : t('extensionUI.scheduleCreateFootIncomplete'),
)

// ── Submit：构造 FormResult（once 折叠为一次性 cron，D2）→ JSON 回传 select 通道 ──
function onSubmit(): void {
  if (!canSubmit.value) return
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
  emit('submit', JSON.stringify(result))
}
</script>

<template>
  <!-- 浮层容器：12px 圆角 + border 仅在此浮起容器（DESIGN.md tokens；内部不叠加）。
       Esc 关闭 = 取消（D5：select resolve undefined → cancelled，非错误）。 -->
  <div
    data-testid="schedule-create-overlay"
    class="content-col relative flex flex-col overflow-hidden rounded-lg border border-strong bg-bg-input shadow-[var(--shadow-2)] animate-ask-user-slide-up motion-reduce:animate-none"
    @keydown.esc="emit('cancel')"
  >
    <!-- head：脉冲点 + 标题 + 副标题 -->
    <div class="flex items-center gap-2 px-3.5 pb-1 pt-2.5">
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <span class="text-[length:var(--text-sm)] font-medium text-neutral-fg">{{ t('extensionUI.scheduleCreateTitle') }}</span>
      <span class="truncate text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateSubtitle') }}</span>
    </div>

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
                'rounded-sm border px-2.5 py-1 text-[length:var(--text-2xs)] transition-colors',
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

        <!-- once：datetime 控件 + 快捷 chips -->
        <template v-else>
          <div class="flex flex-wrap items-center gap-1.5">
            <Input
              v-model="onceLocal"
              type="datetime-local"
              data-testid="schedule-create-once-input"
              class="h-7 w-52 text-[length:var(--text-xs)]"
            />
          </div>
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

      <!-- ② 执行模型（单选；空列表 = 跟随会话当前模型） -->
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center gap-1.5">
          <Cpu class="size-3 shrink-0 text-neutral-ico" aria-hidden="true" />
          <span class="text-[length:var(--text-2xs)] font-semibold tracking-[0.04em] text-neutral-dim">{{ t('extensionUI.scheduleCreateModelLabel') }}</span>
        </div>
        <div v-if="draft.models.length > 0" class="flex flex-col gap-1">
          <div
            v-for="m in draft.models"
            :key="m"
            role="radio"
            :tabindex="0"
            :aria-checked="selectedModel === m"
            :data-testid="`schedule-create-model-${m}`"
            :class="[
              'flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
              selectedModel === m ? 'bg-accent-soft' : 'hover:bg-surface-hover',
            ]"
            @click="selectedModel = m"
            @keydown.enter="selectedModel = m"
            @keydown.space.prevent="selectedModel = m"
          >
            <span
              :class="[
                'size-3.5 shrink-0 rounded-full border-2 transition-colors',
                selectedModel === m ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_var(--bg-input)]' : 'border-border-strong',
              ]"
            />
            <span class="truncate font-mono text-[length:var(--text-xs)] text-neutral-fg">{{ m }}</span>
            <span v-if="m === draft.currentModel" class="shrink-0 rounded-sm border border-border-strong px-1 text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateCurrentTag') }}</span>
          </div>
        </div>
        <p v-else class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateNoModelsHint') }}</p>
        <p v-if="draft.models.length > 0" class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('extensionUI.scheduleCreateModelHint') }}</p>
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

    <!-- foot：摘要 + 取消 / 创建任务 -->
    <div class="flex items-center gap-2.5 px-3.5 pb-3 pt-2">
      <span class="min-w-0 flex-1 truncate text-[length:var(--text-2xs)] text-neutral-dim" data-testid="schedule-create-foot-note">{{ footNote }}</span>
      <Button variant="ghost" data-testid="schedule-create-cancel" @click="emit('cancel')">{{ t('common.cancel') }}</Button>
      <Button variant="default" data-testid="schedule-create-submit" :disabled="!canSubmit" @click="onSubmit">{{ t('extensionUI.scheduleCreateSubmit') }}</Button>
    </div>
  </div>
</template>
