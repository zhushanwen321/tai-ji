<template>
  <!-- [w2] 范式对齐 SystemLlmRetrySection：GroupCard + 显式保存按钮 + 行内校验 + 广播同步。
       数据分层：builtinRules = 内置层只读展示（折叠）；customRules = 用户编辑层（全量显式保存）。
       停用等效文案为 real 功能（§3.3.12 停用通道登记：复用上方「LLM 调用」卡 pi 原生配置）。 -->
  <GroupCard :title="t('settings.system.retryRulesTitle')">
    <div class="px-[10px] pt-[4px] pb-[8px]" data-testid="retry-rules-section">
      <p class="px-1.5 pb-2 text-[length:var(--text-sm)] leading-relaxed text-neutral-fg-2" data-testid="retry-rules-desc">
        {{ t('settings.system.retryRulesDesc') }}
      </p>

      <!-- 内置预设展示区（只读，默认收起） -->
      <Collapsible v-model:open="builtinOpen" class="border-t border-hairline" data-testid="retry-rules-builtin">
        <div class="flex items-center px-[6px] py-[10px]">
          <CollapsibleTrigger as-child>
            <Button
              variant="ghost"
              size="sm"
              class="h-auto gap-1.5 px-2 text-[length:var(--text-sm)] text-neutral-mid hover:text-neutral-fg"
              data-testid="retry-rules-builtin-toggle"
            >
              <ChevronRight
                class="size-[12px] shrink-0 transition-transform duration-[var(--duration-fast)]"
                :class="builtinOpen ? 'rotate-90' : ''"
              />
              {{ t('settings.system.retryRulesBuiltinToggle', { n: builtinRules.length }) }}
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <p v-if="builtinRules.length === 0" class="px-1.5 pb-2 text-[length:var(--text-sm)] text-neutral-fg-2">
            {{ t('settings.system.retryRulesBuiltinEmpty') }}
          </p>
          <div
            v-for="rule in builtinRules"
            :key="rule.id"
            class="flex flex-col gap-0.5 border-t border-hairline px-1.5 py-2"
            :data-testid="`retry-rules-builtin-${rule.id}`"
          >
            <div class="flex items-center gap-2">
              <span class="text-[length:var(--text-sm)] text-neutral-fg">{{ rule.name }}</span>
              <span
                class="inline-flex h-[18px] items-center rounded-full px-[7px] text-[length:var(--text-2xs)] font-semibold"
                :class="verdictToneClass(rule.verdict)"
                data-testid="retry-rules-verdict-badge"
              >
                {{ rule.verdict }} · {{ sourceLabel(rule.source) }}
              </span>
            </div>
            <div class="flex items-center gap-2 text-[length:var(--text-xs)] text-neutral-mid">
              <code class="truncate">{{ matchSummary(rule) }}</code>
            </div>
            <p v-if="rule.waitHint" class="text-[length:var(--text-xs)] text-neutral-fg-2">{{ rule.waitHint }}</p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <!-- 自定义规则编辑区 -->
      <div class="border-t border-hairline px-1.5 pt-2.5">
        <p class="pb-1.5 text-[length:var(--text-sm)] text-neutral-fg-2" data-testid="retry-rules-custom-hint">
          {{ t('settings.system.retryRulesCustomHint') }}
        </p>
        <div
          v-for="(row, index) in draft"
          :key="draftKey(index)"
          class="flex flex-col gap-1.5 border-t border-hairline py-2"
          :data-testid="`retry-rules-row-${index}`"
        >
          <div class="flex items-center gap-2">
            <Input
              v-model="row.id"
              type="text"
              :placeholder="t('settings.system.retryRulesIdPlaceholder')"
              class="w-[150px]"
              :data-testid="`retry-rules-id-${index}`"
              :disabled="isRowLocked(row)"
            />
            <Input
              v-model="row.name"
              type="text"
              :placeholder="t('settings.system.retryRulesNamePlaceholder')"
              class="min-w-0 flex-1"
              :data-testid="`retry-rules-name-${index}`"
              :disabled="isRowLocked(row)"
            />
            <Select v-model="row.verdict" :disabled="isRowLocked(row)">
              <SelectTrigger class="h-8 w-[140px] px-2 text-xs" :data-testid="`retry-rules-verdict-${index}`">
                <SelectValue :placeholder="t('settings.system.retryRulesVerdictLabel')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="v in VERDICT_OPTIONS" :key="v.value" :value="v.value">{{ v.label }}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              class="h-8 px-2 text-[length:var(--text-sm)] text-neutral-mid hover:text-warn"
              :data-testid="`retry-rules-remove-${index}`"
              @click="removeRow(index)"
            >
              {{ t('settings.system.retryRulesRemove') }}
            </Button>
          </div>
          <div class="flex items-center gap-2">
            <Select v-model="row.matchKind" :disabled="isRowLocked(row)">
              <SelectTrigger class="h-8 w-[170px] px-2 text-xs" :data-testid="`retry-rules-kind-${index}`">
                <SelectValue :placeholder="t('settings.system.retryRulesMatchKindLabel')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pattern">{{ t('settings.system.retryRulesMatchPattern') }}</SelectItem>
                <SelectItem value="jsonPath">{{ t('settings.system.retryRulesMatchJsonPath') }}</SelectItem>
              </SelectContent>
            </Select>
            <template v-if="row.matchKind === 'pattern'">
              <Input
                v-model="row.pattern"
                type="text"
                :placeholder="t('settings.system.retryRulesPatternPlaceholder')"
                class="min-w-0 flex-1 font-mono"
                :data-testid="`retry-rules-pattern-${index}`"
                :disabled="isRowLocked(row)"
              />
            </template>
            <template v-else>
              <Input
                v-model="row.jsonPath"
                type="text"
                :placeholder="t('settings.system.retryRulesPathPlaceholder')"
                class="w-[150px] font-mono"
                :data-testid="`retry-rules-path-${index}`"
                :disabled="isRowLocked(row)"
              />
              <Select v-model="row.operator" :disabled="isRowLocked(row)">
                <SelectTrigger class="h-8 w-[100px] px-2 text-xs" :data-testid="`retry-rules-operator-${index}`">
                  <SelectValue :placeholder="t('settings.system.retryRulesOperatorLabel')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="op in OPERATOR_OPTIONS" :key="op" :value="op">{{ op }}</SelectItem>
                </SelectContent>
              </Select>
              <Input
                v-model="row.value"
                type="text"
                :placeholder="t('settings.system.retryRulesValuePlaceholder')"
                class="min-w-0 flex-1 font-mono"
                :data-testid="`retry-rules-value-${index}`"
                :disabled="row.operator === 'exists' || isRowLocked(row)"
              />
            </template>
            <Input
              v-model="row.waitHint"
              type="text"
              :placeholder="t('settings.system.retryRulesWaitHintPlaceholder')"
              class="w-[200px]"
              :data-testid="`retry-rules-waithint-${index}`"
              :disabled="isRowLocked(row)"
            />
          </div>
          <p v-if="isRowLocked(row)" class="text-[length:var(--text-xs)] text-warn" :data-testid="`retry-rules-locked-${index}`">
            {{ t('settings.system.retryRulesMultiMatchLocked') }}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          class="mt-1 h-8 px-2 text-[length:var(--text-sm)] text-neutral-mid hover:text-neutral-fg"
          data-testid="retry-rules-add"
          @click="addRow"
        >
          {{ t('settings.system.retryRulesAddRule') }}
        </Button>
      </div>

      <!-- 停用等效文案（§3.3.12 停用通道：复用上方卡 pi 原生 retry 配置） -->
      <p class="border-t border-hairline px-1.5 pt-2.5 pb-1 text-[length:var(--text-sm)] leading-relaxed text-neutral-fg-2" data-testid="retry-rules-disable-hint">
        {{ t('settings.system.retryRulesDisableHint') }}
      </p>

      <!-- 显式保存行（SystemLlmRetrySection 同款布局） -->
      <div class="flex items-center gap-[16px] border-t border-hairline px-[6px] py-[10px]">
        <span class="flex-1"></span>
        <Button
          size="sm"
          class="h-[32px] px-[12px] text-[length:var(--text-sm)]"
          data-testid="retry-rules-save-btn"
          :disabled="saving"
          @click="onSave"
        >
          {{ t('settings.system.retryRulesSave') }}
        </Button>
      </div>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
/**
 * System · 可重试错误规则 Section（subagent-observability §3.3.12 / UC-23）。
 * 数据层：SettingsTransport seam 的 getRetryRules / setRetryRules / onRetryRules（RPC，
 * 显式按钮整体保存；保存读回服务端终态校准）。校验域：直接消费 shared
 * validateRetryRuleFields（禁另写一套域）。多条件存量规则行锁编辑（防单条件编辑器
 * 静默丢条件）。
 */
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { GroupCard } from '@taiji/ui/features/settings'
import { getSettingsTransport } from '@taiji/core'
import { useToast } from '@/composables/useToast'
import { createExplicitSave } from '@/composables/features/settings/setting-field'
import {
  validateRetryRuleFields,
  type RetryableErrorRule,
  type RetryRuleMatch,
  type RetryRuleVerdict,
} from '@taiji/shared'

const transport = getSettingsTransport()
const { t } = useI18n()
const { error: toastError } = useToast()

const VERDICT_OPTIONS: Array<{ value: RetryRuleVerdict; label: string }> = [
  { value: 'retryable', label: 'retryable' },
  { value: 'non_retryable', label: 'non_retryable' },
  { value: 'conditional', label: 'conditional' },
]
const OPERATOR_OPTIONS = ['equals', 'contains', 'exists'] as const

/** 编辑行形状：match 展开为单条件编辑面（kind + pattern / jsonPath 三键）。 */
interface DraftRow {
  id: string
  name: string
  verdict: RetryRuleVerdict
  matchKind: 'pattern' | 'jsonPath'
  pattern: string
  jsonPath: string
  operator: 'equals' | 'contains' | 'exists'
  value: string
  waitHint: string
  /** 原始 match 条件数（>1 = 行锁——单条件编辑器不覆盖多条件存量）。 */
  rawMatchCount: number
  /** 加载读回的原始规则（锁定行保存时原样透传用；新增行无此字段）。 */
  rawRule?: RetryableErrorRule
}

const builtinRules = ref<RetryableErrorRule[]>([])
const draft = reactive<DraftRow[]>([])
const builtinOpen = ref(false)
let draftSeq = 0
const rowKeys = reactive<number[]>([])
function draftKey(index: number): number {
  return rowKeys[index] ?? index
}

function isRowLocked(row: DraftRow): boolean {
  return row.rawMatchCount > 1
}

function toDraftRow(rule: RetryableErrorRule): DraftRow {
  const first = rule.match[0]
  const matchKind = first?.kind === 'jsonPath' ? 'jsonPath' : 'pattern'
  const jp = first?.kind === 'jsonPath' ? first : undefined
  return {
    id: rule.id,
    name: rule.name,
    verdict: rule.verdict,
    matchKind,
    pattern: first?.kind === 'pattern' ? first.pattern : '',
    jsonPath: jp?.path ?? '',
    operator: jp?.operator ?? 'equals',
    value: jp?.value ?? '',
    waitHint: rule.waitHint ?? '',
    rawMatchCount: rule.match.length,
    rawRule: rule,
  }
}

function fromDraftRow(row: DraftRow): RetryableErrorRule {
  const match: RetryRuleMatch =
    row.matchKind === 'pattern'
      ? { kind: 'pattern', pattern: row.pattern }
      : row.operator === 'exists'
        ? { kind: 'jsonPath', path: row.jsonPath, operator: 'exists' }
        : { kind: 'jsonPath', path: row.jsonPath, operator: row.operator, value: row.value }
  return {
    id: row.id,
    name: row.name,
    verdict: row.verdict,
    match: [match],
    class: 'provider',
    ...(row.waitHint !== '' ? { waitHint: row.waitHint } : {}),
    source: 'custom',
  }
}

function addRow(): void {
  draft.push({
    id: '',
    name: '',
    verdict: 'retryable',
    matchKind: 'pattern',
    pattern: '',
    jsonPath: '',
    operator: 'equals',
    value: '',
    waitHint: '',
    rawMatchCount: 1,
  })
  rowKeys.push(++draftSeq)
}

function removeRow(index: number): void {
  draft.splice(index, 1)
  rowKeys.splice(index, 1)
}

function applyView(view: { builtinRules: RetryableErrorRule[]; customRules: RetryableErrorRule[] }): void {
  builtinRules.value = view.builtinRules
  draft.splice(0, draft.length)
  rowKeys.splice(0, rowKeys.length)
  for (const rule of view.customRules) {
    draft.push(toDraftRow(rule))
    rowKeys.push(++draftSeq)
  }
}

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  unsubscribe = transport.onRetryRules((view) => {
    applyView(view)
  })
  try {
    applyView(await transport.getRetryRules())
  } catch (e) {
    // best-effort 初始加载降级：挂载期拉取失败不阻断设置页渲染，展示空默认视图，
    // 用户保存动作走独立写路径（失败在那里显式上报）——非吞错误的静默路径
    console.warn('[SystemRetryRulesSection] failed to load retry rules:', e)
  }
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})

function verdictToneClass(verdict: RetryRuleVerdict): string {
  if (verdict === 'retryable') return 'bg-accent-soft text-accent'
  if (verdict === 'non_retryable') return 'bg-danger-soft text-danger'
  return 'bg-warn-soft text-warn'
}

function sourceLabel(source: RetryableErrorRule['source']): string {
  if (source === 'remote') return t('settings.system.retryRulesSourceRemote')
  if (source === 'custom') return t('settings.system.retryRulesSourceCustom')
  return t('settings.system.retryRulesSourceBuiltin')
}

/** 匹配条件单行摘要（内置预设展示用）。 */
function matchSummary(rule: RetryableErrorRule): string {
  return rule.match
    .map((m) =>
      m.kind === 'pattern' ? `/${m.pattern}/i` : m.operator === 'exists' ? `${m.path} exists` : `${m.path} ${m.operator} ${m.value ?? ''}`,
    )
    .join(' AND ')
}

const saveAction = createExplicitSave<RetryableErrorRule[]>({
  run: (rules) => transport.setRetryRules(rules).then(() => undefined),
  savedToastKey: 'settings.system.retryRulesSavedToast',
  onError: () => t('settings.system.retryRulesSaveFailed'),
})
const saving = saveAction.saving

/** 保存：逐条 shared 域校验 + 整单 id 去重，失败 toast 指向首错不发 RPC。
 *  锁定行原样透传（row 保护 = 不可编辑，非不可持久化——写侧 customRules 整段替换，
 *  载荷缺行 = 删除存量规则），不经单条件编辑面重建。 */
async function onSave(): Promise<void> {
  if (saving.value) return
  const seen = new Set<string>()
  const rules: RetryableErrorRule[] = []
  for (const row of draft) {
    if (isRowLocked(row)) {
      // 锁定行：字段不可编辑，读回值已过服务端域校验，原对象透传（不重跑表单校验）。
      const raw = row.rawRule
      if (raw !== undefined) {
        if (seen.has(raw.id)) {
          toastError(t('settings.system.retryRulesInvalidInput', { error: `id duplicated: ${raw.id}` }))
          return
        }
        seen.add(raw.id)
        rules.push(raw)
      }
      continue
    }
    if (row.id !== '') {
      if (seen.has(row.id)) {
        toastError(t('settings.system.retryRulesInvalidInput', { error: `id duplicated: ${row.id}` }))
        return
      }
      seen.add(row.id)
    }
    const rule = fromDraftRow(row)
    const result = validateRetryRuleFields(rule)
    if (!result.ok) {
      toastError(t('settings.system.retryRulesInvalidInput', { error: result.errors[0] ?? '' }))
      return
    }
    rules.push(rule)
  }
  await saveAction.run(rules)
}

</script>
