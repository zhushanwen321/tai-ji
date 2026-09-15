<template>
  <GroupCard :title="t('settings.system.llmRetryTitle')">
    <div class="px-2.5 pt-1 pb-2" data-testid="llm-retry-section">
      <!-- 基础区三键（D5）：enabled / maxRetries / baseDelayMs（秒输入，内部存 ms） -->
      <SettingRow :label="t('settings.system.llmRetryEnable')" :desc="t('settings.system.llmRetryEnableDesc')">
        <Switch
          data-testid="llm-retry-enabled-switch"
          :model-value="enabled"
          @update:model-value="enabled = $event"
        />
      </SettingRow>
      <SettingRow :label="t('settings.system.llmRetryMaxRetriesLabel')" :desc="t('settings.system.llmRetryMaxRetriesDesc')">
        <span v-if="warnings.maxRetries" class="text-[11px] text-warn" data-testid="llm-retry-warn-maxRetries">
          {{ warnings.maxRetries }}
        </span>
        <Input
          data-testid="llm-retry-max-retries-input"
          v-model.number="maxRetries"
          type="number"
          :min="0"
          :max="20"
          :step="1"
          class="h-8 w-[72px] px-2 text-right font-mono text-xs"
          :class="invalidFields.has('maxRetries') ? 'border-warn' : ''"
        />
        <span class="text-neutral-dim text-xs">{{ t('settings.system.llmRetryUnitTimes') }}</span>
      </SettingRow>
      <SettingRow :label="t('settings.system.llmRetryBaseDelayLabel')" :desc="t('settings.system.llmRetryBaseDelayDesc')">
        <span v-if="warnings.baseDelayMs" class="text-[11px] text-warn" data-testid="llm-retry-warn-baseDelayMs">
          {{ warnings.baseDelayMs }}
        </span>
        <Input
          data-testid="llm-retry-base-delay-input"
          v-model.number="baseDelaySec"
          type="number"
          :min="0"
          :max="600"
          :step="1"
          class="h-8 w-[72px] px-2 text-right font-mono text-xs"
          :class="invalidFields.has('baseDelayMs') ? 'border-warn' : ''"
        />
        <span class="text-neutral-dim text-xs">{{ t('settings.system.llmRetryUnitSec') }}</span>
      </SettingRow>

      <!-- 高级折叠区（D5）：provider 层三键，默认收起 -->
      <Collapsible v-model:open="advancedOpen" class="border-t border-hairline" data-testid="llm-retry-advanced">
        <div class="flex items-center px-1.5 py-2.5">
          <CollapsibleTrigger as-child>
            <Button
              variant="ghost"
              size="sm"
              class="h-auto gap-1.5 px-2 text-[12px] text-muted hover:text-fg"
              data-testid="llm-retry-advanced-toggle"
            >
              <ChevronDown
                class="size-3.5 shrink-0 transition-transform duration-150"
                :class="advancedOpen ? 'rotate-180' : ''"
              />
              {{ t('settings.system.llmRetryAdvancedTitle') }}
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <p class="px-1.5 pb-1 text-[11px] text-neutral-mid" data-testid="llm-retry-advanced-hint">
            {{ t('settings.system.llmRetryAdvancedHint') }}
          </p>
          <SettingRow :label="t('settings.system.llmRetryProviderMaxRetriesLabel')" :desc="t('settings.system.llmRetryProviderMaxRetriesDesc')">
            <span v-if="warnings['provider.maxRetries']" class="text-[11px] text-warn" data-testid="llm-retry-warn-provider-maxRetries">
              {{ warnings['provider.maxRetries'] }}
            </span>
            <Input
              data-testid="llm-retry-provider-max-retries-input"
              v-model="providerMaxRetriesInput"
              type="number"
              :min="0"
              :max="10"
              :step="1"
              :placeholder="t('settings.system.llmRetryEmptyAsZero')"
              class="h-8 w-[88px] px-2 text-right font-mono text-xs"
              :class="invalidFields.has('provider.maxRetries') ? 'border-warn' : ''"
            />
          </SettingRow>
          <SettingRow :label="t('settings.system.llmRetryProviderTimeoutLabel')" :desc="t('settings.system.llmRetryProviderTimeoutDesc')">
            <span v-if="warnings['provider.timeoutMs']" class="text-[11px] text-warn" data-testid="llm-retry-warn-provider-timeoutMs">
              {{ warnings['provider.timeoutMs'] }}
            </span>
            <Input
              data-testid="llm-retry-provider-timeout-input"
              v-model="providerTimeoutSecInput"
              type="number"
              :min="1"
              :max="600"
              :step="1"
              :placeholder="t('settings.system.llmRetryTimeoutPlaceholder')"
              class="h-8 w-[88px] px-2 text-right font-mono text-xs"
              :class="invalidFields.has('provider.timeoutMs') ? 'border-warn' : ''"
            />
          </SettingRow>
          <SettingRow :label="t('settings.system.llmRetryProviderMaxDelayLabel')" :desc="t('settings.system.llmRetryProviderMaxDelayDesc')">
            <span v-if="warnings['provider.maxRetryDelayMs']" class="text-[11px] text-warn" data-testid="llm-retry-warn-provider-maxRetryDelayMs">
              {{ warnings['provider.maxRetryDelayMs'] }}
            </span>
            <Input
              data-testid="llm-retry-provider-max-delay-input"
              v-model="providerMaxDelaySecInput"
              type="number"
              :min="0"
              :max="3600"
              :step="1"
              class="h-8 w-[88px] px-2 text-right font-mono text-xs"
              :class="invalidFields.has('provider.maxRetryDelayMs') ? 'border-warn' : ''"
            />
          </SettingRow>
        </CollapsibleContent>
      </Collapsible>

      <!-- 预览行（G3）：随输入实时重算指数退避后果 -->
      <p data-testid="llm-retry-preview" class="border-t border-hairline px-1.5 pt-2 text-xs leading-relaxed text-neutral-dim">
        {{ previewText }}
      </p>

      <!-- 显式保存 + 生效范围固定提示（D6） -->
      <div class="flex items-center gap-3 px-1.5 pt-2">
        <Button
          size="sm"
          class="h-7 px-3 text-[12px]"
          data-testid="llm-retry-save-btn"
          :disabled="saving"
          @click="onSave"
        >
          {{ t('settings.system.llmRetrySave') }}
        </Button>
        <span class="text-[11px] text-neutral-mid" data-testid="llm-retry-effective-hint">
          {{ t('settings.system.llmRetryEffectiveHint') }}
        </span>
        <span
          v-if="configured"
          class="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-neutral-mid"
          data-testid="llm-retry-configured-badge"
        >
          {{ t('settings.system.llmRetryConfiguredBadge') }}
        </span>
      </div>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
/**
 * System · LLM 调用重试 Section（llm-retry-settings u3）。
 * 数据层：config.getRetryConfig / setRetryConfig（RPC，整体保存为显式按钮触发）。
 * 校验域：直接消费 shared LLM_RETRY_DOMAIN / validateLlmRetryConfig（禁另写一套域）。
 * 存量超域/坏值（D7/D8）：加载值超出合法域或类型不可用时，对应行显示行内标注。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getRetryConfig, setRetryConfig, onRetryConfig } from '@taiji/core/transport/api/domains/config'
import { useToast } from '@/composables/useToast'
import {
  LLM_RETRY_DOMAIN,
  validateLlmRetryConfig,
  type LlmRetryConfig,
  type LlmRetryProviderConfig,
} from '@taiji/shared'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const MIN_PER_HOUR = 60
const EXP_BACKOFF_BASE = 2
const ROUND_ONE = 10
// pi 默认，见设计文档 §2.2
const PI_DEFAULT_MAX_RETRIES = 3
const PI_DEFAULT_BASE_DELAY_SEC = 2
const PI_DEFAULT_BASE_DELAY_MS = 2000

/** 保留一位小数。 */
function round1(v: number): number {
  return Math.round(v * ROUND_ONE) / ROUND_ONE
}

// ── 表单状态（provider 三键用 string 承载「留空 = 未设」语义）──
const enabled = ref(true)
const maxRetries = ref<number | ''>(PI_DEFAULT_MAX_RETRIES)
const baseDelaySec = ref<number | ''>(PI_DEFAULT_BASE_DELAY_SEC)
const advancedOpen = ref(false)
const providerMaxRetriesInput = ref('')
const providerTimeoutSecInput = ref('')
const providerMaxDelaySecInput = ref('')

const configured = ref(false)
const saving = ref(false)
/** 保存失败时标红的字段名集合（validateLlmRetryConfig error 信封字段名）。 */
const invalidFields = reactive(new Set<string>())
/** 加载期存量超域/坏值的行内标注（D7/D8），字段名 → 提示文本。 */
const warnings = reactive<Record<string, string>>({})

// 多窗口同步（设计 §3.4，同 terminal 范式）：configured=true 的广播刷新表单。
// 自保存的回声也走此回调：applyLoaded 与已保存值幂等（无闪烁），无需自触发判别。
let unsubscribeRetryConfig: (() => void) | null = null

onMounted(async () => {
  unsubscribeRetryConfig = onRetryConfig((payload) => {
    if (!payload.configured) return
    configured.value = true
    // 其他窗口保存的合法值到达后，本窗口过期的校验红框不应残留
    invalidFields.clear()
    applyLoaded(payload.config)
  })
  try {
    const res = await getRetryConfig()
    configured.value = res.configured
    applyLoaded(res.config)
  } catch (e) {
    // best-effort：加载失败保持默认值（保存时以输入为准），不打扰用户
    console.warn('[SystemLlmRetrySection] failed to load retry config:', e)
  }
})

onUnmounted(() => {
  unsubscribeRetryConfig?.()
  unsubscribeRetryConfig = null
})

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 数值域检查：返回 { ok 是否域内, display 表单展示值（超域原样展示存量值，类型不可用时为 fallbackDisplay）, raw 原值字符串 }。display 恒为 number，仅基础两键回填消费；provider 各键回填走调用点独立 isFiniteNumber 路径（D8 超域原样回填），ms 键警示因需 ms→秒换算走 warnTextForMs(原值) 而弃用 raw。 */
function checkDomain(
  value: unknown,
  min: number,
  max: number,
  fallbackDisplay: number,
): { ok: boolean; display: number; raw: string } {
  if (!isFiniteNumber(value)) {
    // D7 坏值承接：表单显示默认值，行内同款标注
    return { ok: false, display: fallbackDisplay, raw: String(value) }
  }
  const ok = Number.isInteger(value) && value >= min && value <= max
  return { ok, display: value, raw: String(value) }
}

function warnText(raw: string): string {
  return t('settings.system.llmRetryOutOfDomain', { value: raw })
}

/** ms 时长键警示文本：换算为秒展示（输入框为秒口径，避免 ms 原值与秒输入并排单位不符）；坏值原样展示。 */
function warnTextForMs(raw: unknown): string {
  return warnText(isFiniteNumber(raw) ? String(raw / MS_PER_SEC) : String(raw))
}

/** 加载值落到表单：合法值直接显示；超域值原样显示；坏值回落默认显示。超域/坏值均加行内标注。按字段域拆分（applyBasicKeys / applyProviderKeys）。 */
function applyLoaded(config: LlmRetryConfig): void {
  // 广播刷新可重复进入：先清上轮行内标注，避免已修复字段的残留警示
  for (const key of Object.keys(warnings)) delete warnings[key]
  applyBasicKeys(config)
  applyProviderKeys(config)
}

/** 基础区三键回填：enabled / maxRetries / baseDelayMs（秒显示，内部存 ms）。 */
function applyBasicKeys(config: LlmRetryConfig): void {
  enabled.value = config.enabled
  const mr = checkDomain(config.maxRetries, LLM_RETRY_DOMAIN.maxRetries.min, LLM_RETRY_DOMAIN.maxRetries.max, PI_DEFAULT_MAX_RETRIES)
  maxRetries.value = mr.display
  if (!mr.ok) warnings.maxRetries = warnText(mr.raw)

  const bd = checkDomain(config.baseDelayMs, LLM_RETRY_DOMAIN.baseDelayMs.min, LLM_RETRY_DOMAIN.baseDelayMs.max, PI_DEFAULT_BASE_DELAY_MS)
  baseDelaySec.value = bd.display / MS_PER_SEC
  if (!bd.ok) warnings.baseDelayMs = warnTextForMs(config.baseDelayMs)
}

/** provider 高级区三键回填（D8：超域数值原样回填，未设/坏值留空「留空 = 未设」）。 */
function applyProviderKeys(config: LlmRetryConfig): void {
  const p = config.provider ?? {}
  const pmr = checkDomain(p.maxRetries, LLM_RETRY_DOMAIN.providerMaxRetries.min, LLM_RETRY_DOMAIN.providerMaxRetries.max, 0)
  // D8：超域数值原样回填（与基础键行为对齐），使保存时 validateLlmRetryConfig 拒绝并指向该字段，
  // 而非显示为空 → 提交 undefined → 校验跳过 → runtime 静默删除存量键；未设/坏值仍留空（「留空 = 未设」）
  providerMaxRetriesInput.value = isFiniteNumber(p.maxRetries) ? String(p.maxRetries) : ''
  if (p.maxRetries !== undefined && !pmr.ok) warnings['provider.maxRetries'] = warnText(pmr.raw)

  const pt = checkDomain(p.timeoutMs, LLM_RETRY_DOMAIN.providerTimeoutMs.min, LLM_RETRY_DOMAIN.providerTimeoutMs.max, 0)
  providerTimeoutSecInput.value = isFiniteNumber(p.timeoutMs) ? String(p.timeoutMs / MS_PER_SEC) : ''
  if (p.timeoutMs !== undefined && !pt.ok) warnings['provider.timeoutMs'] = warnTextForMs(p.timeoutMs)

  applyProviderMaxDelayKey(p)
}

/** provider.maxRetryDelayMs 回填：合法域特殊——0（不限制）或 1000-3600000；未设跳过。 */
function applyProviderMaxDelayKey(p: LlmRetryProviderConfig): void {
  const pdRaw = p.maxRetryDelayMs
  if (pdRaw !== undefined) {
    const ok = typeof pdRaw === 'number' && Number.isInteger(pdRaw) &&
      (pdRaw === 0 || (pdRaw >= LLM_RETRY_DOMAIN.providerMaxRetryDelayMs.minNonZero && pdRaw <= LLM_RETRY_DOMAIN.providerMaxRetryDelayMs.max))
    providerMaxDelaySecInput.value = isFiniteNumber(pdRaw) ? String(pdRaw / MS_PER_SEC) : ''
    if (!ok) warnings['provider.maxRetryDelayMs'] = warnTextForMs(pdRaw)
  }
}

/** 时长人性化格式（参照 demo html fmtDur：<1s 毫秒 / <1min 秒 / <1h 分钟 / 小时）。 */
function fmtDur(ms: number): string {
  // 先取整再分档：999.6ms 取整为 1000 须进位为「1 秒」，与 ≥60s/≥60min 的档位边界进位同族
  const rounded = Math.round(ms)
  if (rounded < MS_PER_SEC) return `${rounded} ${t('settings.system.llmRetryUnitMs')}`
  const sec = rounded / MS_PER_SEC
  // 档位边界按显示精度进位：59999ms 显示精度为 60.0 秒，须进位为 1 分钟而非渲染「60.0 秒」
  if (Number(sec.toFixed(1)) < SEC_PER_MIN) {
    return `${Number.isInteger(sec) ? sec : sec.toFixed(1)} ${t('settings.system.llmRetryUnitSec')}`
  }
  const min = rounded / (SEC_PER_MIN * MS_PER_SEC)
  if (round1(min) < MIN_PER_HOUR) return `${round1(min)} ${t('settings.system.llmRetryUnitMin')}`
  return `${round1(min / MIN_PER_HOUR)} ${t('settings.system.llmRetryUnitHour')}`
}

/** 预览行（G3）：enabled=false 时展示关闭语义；开启时实时重算指数退避后果。 */
const previewText = computed<string>(() => {
  if (!enabled.value) return t('settings.system.llmRetryPreviewOff')
  const n = typeof maxRetries.value === 'number' ? maxRetries.value : Number.NaN
  const base = typeof baseDelaySec.value === 'number' ? baseDelaySec.value : Number.NaN
  if (!Number.isFinite(n) || !Number.isFinite(base) || n < 0 || base < 0) {
    // 输入未完成时避免渲染无意义数字，退回关闭文案以外的中性占位（保存会被校验拦下）
    return t('settings.system.llmRetryInvalidInput')
  }
  const totalMs = base * (EXP_BACKOFF_BASE ** n - 1) * MS_PER_SEC
  const longestMs = n === 0 ? 0 : base * EXP_BACKOFF_BASE ** (n - 1) * MS_PER_SEC
  return t('settings.system.llmRetryPreviewOn', {
    n: String(n),
    longest: fmtDur(longestMs),
    total: fmtDur(totalMs),
  })
})

/**
 * 「留空 = 未设」字符串输入 → 数值；解析失败标记字段并记录 label（供 toast 指明字段），返回 null。
 * toMs 两键（provider.timeoutMs / provider.maxRetryDelayMs）接受小数秒，Math.round 秒转 ms——
 * 与 baseDelaySec 的组装语义对齐，存量非整秒域内值（如 timeoutMs=1500 → 回填 "1.5"）可原样回存。
 */
let parseErrorFieldLabel: string | null = null
function parseIntInput(input: string | number, field: string, label: string, toMs = false): number | undefined | null {
  // provider 三键 v-model 挂在 type=number 的 Input 上，非整数输入（如 1.5）经 Vue loose 转换得到 number
  const trimmed = String(input).trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  // toMs 键放宽为有限浮点（Math.round 落 ms），NaN/Infinity 仍走拒绝路径；maxRetries 键保持仅收整数
  const ok = toMs ? Number.isFinite(n) : Number.isInteger(n)
  if (!ok) {
    invalidFields.add(field)
    parseErrorFieldLabel = label
    return null
  }
  return toMs ? Math.round(n * MS_PER_SEC) : n
}

/** 组装保存载荷；任何字段解析失败返回 null（invalidFields 已标记）。 */
function buildConfig(): LlmRetryConfig | null {
  invalidFields.clear()
  parseErrorFieldLabel = null
  const provider: LlmRetryProviderConfig = {}
  const pmr = parseIntInput(providerMaxRetriesInput.value, 'provider.maxRetries', t('settings.system.llmRetryProviderMaxRetriesLabel'))
  if (pmr === null) return null
  if (pmr !== undefined) provider.maxRetries = pmr
  const pt = parseIntInput(providerTimeoutSecInput.value, 'provider.timeoutMs', t('settings.system.llmRetryProviderTimeoutLabel'), true)
  if (pt === null) return null
  if (pt !== undefined) provider.timeoutMs = pt
  const pd = parseIntInput(providerMaxDelaySecInput.value, 'provider.maxRetryDelayMs', t('settings.system.llmRetryProviderMaxDelayLabel'), true)
  if (pd === null) return null
  if (pd !== undefined) provider.maxRetryDelayMs = pd

  // 两键独立检查：同时为空时两键各自标红，不遗漏
  if (typeof maxRetries.value !== 'number') invalidFields.add('maxRetries')
  if (typeof baseDelaySec.value !== 'number') invalidFields.add('baseDelayMs')
  if (typeof maxRetries.value !== 'number' || typeof baseDelaySec.value !== 'number') return null
  return {
    enabled: enabled.value,
    maxRetries: maxRetries.value,
    baseDelayMs: Math.round(baseDelaySec.value * MS_PER_SEC),
    provider: Object.keys(provider).length > 0 ? provider : undefined,
  }
}

/** 保存：先前端同规则校验（shared validateLlmRetryConfig），失败 toast + 标红不发 RPC。 */
async function onSave(): Promise<void> {
  if (saving.value) return
  const config = buildConfig()
  if (config === null) {
    // 解析失败时指明字段（provider 三键）；基础键为空走通用文案
    toastError(
      parseErrorFieldLabel !== null
        ? t('settings.system.llmRetryInvalidFieldInput', { field: parseErrorFieldLabel })
        : t('settings.system.llmRetryInvalidInput'),
    )
    return
  }
  const res = validateLlmRetryConfig(config)
  if (!res.ok) {
    // error 信封格式「<字段名> 超出范围(...)：<值>」，前缀即字段名
    invalidFields.add(res.error.split(' ')[0])
    toastError(res.error)
    return
  }
  saving.value = true
  try {
    await setRetryConfig(config)
    toastInfo(t('settings.system.llmRetrySavedToast'))
  } catch (e) {
    console.warn('[SystemLlmRetrySection] failed to save retry config:', e)
    toastError(t('settings.system.llmRetrySaveFailed'))
  } finally {
    saving.value = false
  }
}
</script>
