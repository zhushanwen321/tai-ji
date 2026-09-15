<template>
  <!--
    CodingPlanSection —— ProviderEditBody 内「Coding Plan 额度查询」子组件。

    契约 v2（coding-plan-quota-config-ux §7.4 方案 B 重写）：
    - D8 未选类型：只渲染类型下拉 + 一句说明（开关 / 凭证区 / 按钮全部不渲染）
    - D1 齐备性门控：唯一主动作按钮「保存并测试」按 readiness.ready 置灰
    - D3 凭证来源分段控件（api-key 类）：UI 显示的选择与 runtime 使用的凭证同源
    - D4 开关退化为纯配置位（无网络副作用，即时落盘由父组件 setEnabled 完成）
    - D7 cookie / 专属 Key 输入框不回显掩码，草稿即真相；「已配置 / 必填」徽标与专属 Key 占位
      均与 readiness.missing 同源（§7.4：不在缺口里 = 该字段此刻有效），与字段级提示结构性一致
    - D2 保存与测试合一：按钮 onclick → saveAndTest

    所有业务逻辑在父组件 useQuotaConfigure 中，本组件纯展示 + 事件转发。
  -->
  <div class="border-t border-border pt-4" data-testid="coding-plan-section">
    <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
      {{ t('settings.providerEdit.quotaSection') }}
    </Label>

    <!-- 类型选择（始终渲染：区块对所有 provider 显示，内部按「是否已选类型」分层，D8） -->
    <div class="mb-2">
      <Label class="mb-1 block text-[10px] text-neutral-mid">
        {{ t('settings.providerEdit.quotaType') }}
        <span class="normal-case text-neutral-dim">{{ t('settings.providerEdit.quotaTypeHint') }}</span>
      </Label>
      <Select
        :model-value="fetcherId"
        @update:model-value="onSelectFetcher"
      >
        <SelectTrigger class="h-8 text-[12px]" data-testid="quota-type-select">
          <SelectValue :placeholder="t('settings.providerEdit.quotaTypePlaceholder')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in fetcherOptions"
            :key="opt.value"
            :value="opt.value"
          >{{ opt.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <!--
      D8：类型未定——只留下拉与一句说明，不渲染开关 / 凭证区 / 按钮（也天然堵掉「没选类型就开开关」）。
      「类型未定」有两种来源（§7.2）：草稿为空，或草稿有值但 preset 未命中（历史数据 / 手工编辑
      providers.json）。后者若继续渲染参数区，未知 fetcher 会借 api-key 分支给出一组永远无法生效
      的控件，正是 D8 要堵的反例；两来源共用同一指引。
    -->
    <p v-if="typeUndetermined" class="text-[10px] text-neutral-dim" data-testid="quota-no-type-hint">
      {{ t('settings.providerEdit.quotaTypeFirstHint') }}
    </p>

    <template v-else>
      <!-- 启用开关（D4：纯配置位——拨动即时落盘，不触发任何网络请求） -->
      <div class="flex items-center justify-between py-1.5">
        <span class="text-[12px] text-neutral-fg">
          {{ t('settings.providerEdit.quotaEnable') }}
          <span class="text-[10px] text-neutral-dim">{{ t('settings.providerEdit.quotaEnableHintIdle') }}</span>
        </span>
        <Switch
          :model-value="enabled"
          data-testid="quota-enabled-switch"
          :disabled="configuring"
          @update:model-value="emit('update:enabled', $event === true)"
        />
      </div>

      <!-- Cookie 类：cookie 输入（D7 去掩码，草稿只放用户真实输入；「已配置」为独立标记） -->
      <div v-if="isCookieAuth" class="mt-2" data-testid="quota-cookie-block">
        <Label class="mb-1 block text-[10px] text-neutral-mid">
          Cookie
          <span class="normal-case text-neutral-dim">· {{ fieldBadgeLabel('cookie') }}</span>
        </Label>
        <Textarea
          :model-value="cookieInput"
          class="min-h-[56px] resize-y font-mono text-[11px]"
          :placeholder="t('settings.providerEdit.quotaCookiePlaceholder')"
          data-testid="quota-cookie-input"
          @update:model-value="emit('update:cookieInput', String($event ?? ''))"
        />
        <p
          v-if="isMissing('cookie')"
          class="mt-1 text-[10px] text-warn"
          data-testid="quota-missing-cookie"
        >{{ missingHint('cookie') }}</p>
      </div>

      <!-- api-key 类：凭证来源分段控件（D3）+ 专属 Key 输入（仅选「用专属 Key」时出现） -->
      <template v-else>
        <div v-if="exclusiveApplicable" class="mt-1.5" data-testid="quota-credential-source">
          <Label class="mb-1 block text-[10px] text-neutral-mid">
            {{ t('settings.providerEdit.quotaCredentialSourceLabel') }}
          </Label>
          <div class="inline-flex gap-0.5 rounded-sm bg-bg-input p-0.5" role="group">
            <Button
              variant="ghost"
              class="h-6 rounded-sm px-2.5 text-[11px]"
              :class="credentialSource === 'provider' ? 'bg-surface-2 text-neutral-fg' : 'text-neutral-dim'"
              :aria-pressed="credentialSource === 'provider'"
              :disabled="!providerCredentialAvailable"
              data-testid="quota-source-provider-btn"
              @click="emit('update:credentialSource', 'provider')"
            >{{ t('settings.providerEdit.quotaSourceProvider') }}</Button>
            <Button
              variant="ghost"
              class="h-6 rounded-sm px-2.5 text-[11px]"
              :class="credentialSource === 'exclusive' ? 'bg-surface-2 text-neutral-fg' : 'text-neutral-dim'"
              :aria-pressed="credentialSource === 'exclusive'"
              data-testid="quota-source-exclusive-btn"
              @click="emit('update:credentialSource', 'exclusive')"
            >{{ t('settings.providerEdit.quotaSourceExclusive') }}</Button>
          </div>
          <p class="mt-1 text-[10px] text-neutral-dim" data-testid="quota-source-hint">{{ sourceHint }}</p>
        </div>

        <div v-if="exclusiveApplicable && credentialSource === 'exclusive'" class="mt-1.5" data-testid="quota-exclusive-key-block">
          <Label class="mb-1 block text-[10px] text-neutral-mid">
            {{ t('settings.providerEdit.quotaApiKey') }}
            <span class="normal-case text-neutral-dim">· {{ fieldBadgeLabel('apiKey') }}</span>
          </Label>
          <Input
            :model-value="apiKeyInput"
            type="password"
            class="h-8 font-mono text-[11px]"
            :placeholder="exclusiveKeyPlaceholder"
            data-testid="quota-apikey-input"
            @update:model-value="emit('update:apiKeyInput', String($event ?? ''))"
          />
          <p
            v-if="isMissing('apiKey')"
            class="mt-1 text-[10px] text-warn"
            data-testid="quota-missing-apikey"
          >{{ missingHint('apiKey') }}</p>
        </div>
        <!--
          凭证来源 = Provider 且不可用：两套文案（§7.4 跨区块时序）——provider 表单是草稿模型，
          用户刚填了 Key 但没保存 provider 时，runtime 读不到（按钮仍灰不是判定错误），必须说清。
        -->
        <p
          v-else-if="!providerCredentialAvailable"
          class="mt-1 text-[10px] text-warn"
          data-testid="quota-provider-credential-warning"
        >{{ providerCredentialWarning }}</p>
      </template>

      <!-- Workspace 地址（资源维度 fetcher；明文回显，D13 判定只看草稿） -->
      <div v-if="needsWorkspace" class="mt-2" data-testid="quota-workspace-block">
        <Label class="mb-1 block text-[10px] text-neutral-mid">
          {{ t('settings.providerEdit.quotaWorkspaceLabel') }}
          <span class="normal-case text-neutral-dim">· {{ fieldBadgeLabel('workspace') }}</span>
        </Label>
        <Input
          :model-value="workspaceInput"
          class="h-8 font-mono text-[11px]"
          :placeholder="t('settings.providerEdit.quotaWorkspacePlaceholder')"
          data-testid="quota-workspace-input"
          @update:model-value="emit('update:workspaceInput', String($event ?? ''))"
        />
        <p
          v-if="isMissing('workspace')"
          class="mt-1 text-[10px] text-warn"
          data-testid="quota-missing-workspace"
        >{{ missingHint('workspace') }}</p>
        <p class="mt-1 text-[10px] text-neutral-dim">{{ t('settings.providerEdit.quotaWorkspaceHelp') }}</p>
      </div>

      <!-- 帮助链接 -->
      <p v-if="helpUrl" class="mt-1.5 flex items-start gap-1 text-[10px] text-neutral-dim">
        <ExternalLink class="mt-0.5 size-3 shrink-0" />
        <span>{{ helpText || '' }}
          <a
            :href="helpUrl"
            target="_blank"
            rel="noopener"
            class="text-accent hover:underline"
          >{{ helpUrl }}</a>
        </span>
      </p>

      <!-- D2 单动作按钮：保存并测试（D1 齐备性置灰是唯一门控；无网络副作用之外的第二个动作） -->
      <div class="mt-2 flex items-center gap-2" data-testid="quota-actions">
        <Button
          class="h-7 gap-1 px-2.5 text-[11px]"
          :disabled="!readiness.ready || configuring"
          data-testid="quota-save-test-btn"
          @click="emit('saveAndTest')"
        >
          <Loader2 v-if="configuring" class="animate-spin" />
          {{ configuring ? t('settings.providerEdit.quotaSaveAndTestRunning') : t('settings.providerEdit.quotaSaveAndTest') }}
        </Button>
        <span v-if="!readiness.ready" class="text-[10px] text-neutral-dim" data-testid="quota-ready-hint">
          {{ t('settings.providerEdit.quotaReadyHint') }}
        </span>
      </div>

      <!-- 测试查询成功 + 内联额度预览（3 窗口行；B-3：used/limit 绝对量 + pct 双轨） -->
      <div v-if="testStatus === 'success' && quotaRow" class="mt-2" data-testid="quota-result">
        <div class="flex items-center gap-1.5 text-[11px] text-success">
          <CheckCircle2 class="size-3" />
          {{ t('settings.providerEdit.quotaTestSuccess') }}
          <span v-if="lastFetchAt" class="text-neutral-dim">· {{ formatTimeAgo(lastFetchAt) }}</span>
        </div>
        <div class="mt-2 rounded-sm border border-border bg-bg-input p-2.5" data-testid="quota-result-windows">
          <QuotaWindowList :windows="visibleWindows" :labels="windowLabels" tone="current" />
        </div>
      </div>

      <!-- 测试查询失败（B-3 / A2-4）：失败态整体替换数据展示，旧缓存只经「查看上次成功数据」展开可见 -->
      <div v-if="testStatus === 'error'" class="mt-2" data-testid="quota-error">
        <div class="flex items-center gap-1.5 text-[11px] text-danger" data-testid="quota-error-msg">
          <AlertCircle class="size-3" />
          {{ failMessage }}
        </div>
        <Button
          v-if="isCookieAuth"
          variant="ghost"
          class="mt-1 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          data-testid="quota-update-cookie-btn"
          @click="emit('update:cookieInput', '')"
        >
          {{ t('settings.providerEdit.quotaUpdateCookie') }}
        </Button>
        <!-- 「查看上次成功数据」入口（design §3.4：旧缓存保留内存不直接展示，防陈旧数据当当前额度） -->
        <Button
          v-if="quotaRow"
          variant="ghost"
          class="mt-1 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          data-testid="quota-toggle-last-success"
          @click="showLastSuccess = !showLastSuccess"
        >
          {{ showLastSuccess ? t('settings.providerEdit.collapse') : t('settings.providerEdit.quotaLastSuccessToggle') }}
        </Button>
        <div v-if="showLastSuccess && quotaRow" class="mt-2 rounded-sm border border-border bg-bg-input p-2.5" data-testid="quota-last-success">
          <p v-if="lastFetchAt" class="mb-1 text-[10px] text-neutral-dim">
            {{ t('settings.providerEdit.quotaLastSuccessAt', { time: formatAbsoluteTime(lastFetchAt) }) }}
          </p>
          <QuotaWindowList :windows="visibleWindows" :labels="windowLabels" tone="muted" />
        </div>
      </div>

      <!-- 配置错误（D9：统一走 i18n 的保存类错误出口） -->
      <p v-if="configureErrorMsg" class="mt-1 text-[11px] text-danger" data-testid="quota-configure-error">{{ configureErrorMsg }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * CodingPlanSection props/events 设计（契约 v2，见文件头注释）：
 * - 所有状态由父组件 useQuotaConfigure 管理，本组件纯展示
 * - 事件转发：update:fetcherId / update:enabled / update:credentialSource /
 *   update:{cookieApiKey,workspace}Input / saveAndTest
 */
import { Button, Switch, Label, Textarea, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@taiji/ui'
import { computed, ref } from 'vue'
import { Loader2, CheckCircle2, AlertCircle, ExternalLink } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { formatQuotaTimeAgo } from './format-time-ago'

import type { NormalizedQuotaRow, QuotaAuthKind, QuotaCredentialSource, QuotaFetchFailureReason } from '@taiji/shared'
import { QUOTA_PRESETS, supportsExclusiveCredential } from '@taiji/shared'
import type { QuotaTestStatus, ReadinessMissing } from '../injection-keys'
import QuotaWindowList from './QuotaWindowList.vue'

/** 字段级缺口的显式白名单（§7.4：只对这三个键查 i18n，'type' 走 D8 分支根本不进提示渲染）。 */
type MissingField = 'cookie' | 'apiKey' | 'workspace'

const MISSING_HINT_KEYS: Record<MissingField, string> = {
  cookie: 'settings.providerEdit.quotaMissingCookie',
  apiKey: 'settings.providerEdit.quotaMissingApiKey',
  workspace: 'settings.providerEdit.quotaMissingWorkspace',
}

const props = withDefaults(defineProps<{
  /** 当前类型草稿（未选择 = undefined）；类型只改草稿，由 saveAndTest 一次提交（D5） */
  fetcherId?: string
  /** 下拉框选项列表（value=fetcher id, label=显示名）。默认 QUOTA_PRESETS。 */
  fetcherOptions?: Array<{ value: string; label: string }>
  /** 启用位（D4 纯配置位；开关即时落盘由父组件 setEnabled 完成） */
  enabled: boolean
  /** cookie 输入草稿（D7 去掩码：只放用户真实输入，不回填掩码） */
  cookieInput: string
  /** 专属 API Key 输入草稿（密文不回显） */
  apiKeyInput?: string
  /** 凭证来源选择（D3，api-key 类专用；cookie 类不渲染该控件） */
  credentialSource: QuotaCredentialSource
  /** Provider 侧是否有可用凭据（决定「用 Provider 凭据」分段项是否可点） */
  providerCredentialAvailable: boolean
  /** Provider 侧凭据「已填但未保存」（§7.4 两套文案的区分依据，由 ProviderEditBody 计算写入） */
  providerCredentialPendingSave?: boolean
  /** Workspace 地址输入草稿（明文回显，D13 判定只看草稿） */
  workspaceInput?: string
  /** 当前 fetcher 是否需要 workspace 配置（QuotaPreset.requiresWorkspace） */
  needsWorkspace?: boolean
  /** 齐备性派生量（D1）——「保存并测试」按钮禁用状态的唯一依据 + 字段级提示来源 */
  readiness: { ready: boolean; missing: ReadinessMissing[] }
  testStatus: QuotaTestStatus
  testErrorMsg: string
  /** 最近一次查询失败原因（A2-4 reason 透传；null = 无失败或非 reason 型错误） */
  testFailReason?: QuotaFetchFailureReason | null
  quotaRow: NormalizedQuotaRow | null
  lastFetchAt: number | null
  isCookieAuth: boolean
  /** 当前选中 fetcher 的凭证能力声明（B-3：含 'oauth' → Provider 来源提示区分 OAuth / API Key）。
   *  必传无默认：漏传 = 凭证来源分段控件 / 专属 Key 块 / oauth·cookie 分支全部静默塌缩，
   *  必须由编译期拦截而非 [] 默认值吞掉（与 D8「未判定不可读成已配置」同一哲学）。 */
  authKinds: readonly QuotaAuthKind[]
  /** provider 已完成 OAuth 登录（父组件 useProviderOAuth.oauthPresent） */
  oauthReady?: boolean
  configuring: boolean
  configureErrorMsg: string
  helpUrl?: string
  helpText?: string
}>(), {
  fetcherId: undefined,
  apiKeyInput: '',
  providerCredentialPendingSave: false,
  workspaceInput: '',
  needsWorkspace: false,
  testFailReason: null,
  oauthReady: false,
  // 默认选项 = QUOTA_PRESETS（内置类型），调用方一般无需传
  fetcherOptions: () => QUOTA_PRESETS.map((p) => ({ value: p.fetcher, label: p.label })),
})

const emit = defineEmits<{
  /** 选择类型草稿（父组件 writable computed 同值短路，D5 守卫落在值上） */
  'update:fetcherId': [value: string]
  /** 拨动启用位（父组件 setEnabled，无网络副作用，D4） */
  'update:enabled': [value: boolean]
  /** 切换凭证来源（父组件写 credentialSource 草稿，随 saveAndTest 落盘，D3） */
  'update:credentialSource': [value: QuotaCredentialSource]
  /** 保存并测试（D2：落盘 + 查询合一） */
  saveAndTest: []
  'update:cookieInput': [value: string]
  'update:apiKeyInput': [value: string]
  'update:workspaceInput': [value: string]
}>()

/**
 * 类型下拉变更：reka Select 的 update:modelValue 是宽联合类型，做运行时 guard 只放字符串通过。
 * 不做 String($event) 强转——undefined 会被转成 "undefined" 这个看似合法的类型值。
 */
function onSelectFetcher(value: unknown): void {
  if (typeof value !== 'string') return
  emit('update:fetcherId', value)
}

const { t } = useI18n()

/** 三窗口标签（i18n 化，与 QuotaWins 顺序对齐：5h / 本周 / 本月）。 */
const windowLabels = [
  t('settings.providerEdit.quotaWindow5h'),
  t('settings.providerEdit.quotaWindowWeek'),
  t('settings.providerEdit.quotaWindowMonth'),
]

/** 可见窗口项（过滤 pct=null 的 ∞ 窗口；B-3 双轨携带 used/limit/unit 绝对量）。 */
interface VisibleWindow {
  idx: number
  pct: number | null
  resetSec: number | null
  used?: number | null
  limit?: number | null
  unit?: 'requests' | 'tokens' | 'credits' | null
}

const visibleWindows = computed<VisibleWindow[]>(() => {
  const row = props.quotaRow
  if (!row) return []
  return row.wins.map((w, i) => ({ idx: i, pct: w.pct, resetSec: w.resetSec, used: w.used, limit: w.limit, unit: w.unit }))
})

/** 「查看上次成功数据」展开态（B-3 / design §3.4：失败态下旧缓存折叠展示） */
const showLastSuccess = ref(false)

/**
 * 类型未定（D8 分支的唯一判据，§7.2 两种来源共用同一指引）：
 * - 草稿为空：尚未选择类型；
 * - readiness.missing 含 'type'：草稿有值但 preset 未命中（历史数据 / 手工编辑 providers.json），
 *   readiness 已按「类型缺失」处理 —— UI 必须同形态（只留下拉 + 说明），否则未知 fetcher 会走
 *   api-key 分支渲染出一组永远无法生效的控件，「未判定」也会被读成「已配置」。
 */
const typeUndetermined = computed<boolean>(
  () => !props.fetcherId || props.readiness.missing.includes('type'),
)

/** 缺口判定（白名单三键；'type' 已在模板层走 D8 分支，不进入本判定） */
function isMissing(key: MissingField): boolean {
  return props.readiness.missing.includes(key)
}

/**
 * 专属 Key 对该凭证形态是否适用 —— 与 runtime resolveCredential 的 exclusive 收窄、
 * renderer readiness 的专属 Key 分支调用同一个 shared 谓词（§7 残留 11）。不适用时整组
 * 凭证来源控件（分段控件 + 专属 Key 输入）不渲染：显示一个 runtime 不会采用的选项，
 * 就是「UI 说用 A、runtime 实际用 B」。
 */
const exclusiveApplicable = computed<boolean>(() => supportsExclusiveCredential(props.authKinds))

/** 字段级提示文案（显式白名单查 i18n，不写 missing 兜底循环——让「'type' 不配文案」成为结构保证） */
function missingHint(key: MissingField): string {
  return t(MISSING_HINT_KEYS[key])
}

/**
 * 专属 Key 输入框占位（D7）：与徽标同源读 readiness.missing —— 有缺口时给「粘贴 Key」指引，
 * 无缺口时说明「已配置，输入新值可覆盖」。历史实现读磁盘标记（provider.quota.apiKeySet），在 D5
 * 类型切换（旧 Key 归属失效）态下会与「必填」徽标同屏矛盾（徽标说必填、占位说已配置）。
 * 无缺口 ∧ 草稿为空 ⟺ 磁盘已配置（readiness 专属 Key 分支的判定语义），无需第二份复算。
 */
const exclusiveKeyPlaceholder = computed<string>(() => (isMissing('apiKey')
  ? t('settings.providerEdit.quotaExclusiveKeyPlaceholder')
  : t('settings.providerEdit.quotaApiKeySetPlaceholder')))

/**
 * 字段徽标（「已配置 / 必填」，§7.4 徽标取值规则）。
 *
 * 与字段级提示**同源**：两者都读同一份 readiness.missing。missing 是唯一编码了凭证归属
 * 规则（D5：类型切换后旧 cookie / 旧专属 Key 归属失效）的派生量，因此「不在 missing 里」
 * ⟺「该字段此刻有效」，正是徽标要表达的语义（不是「磁盘上曾存过一份」）。
 * 用磁盘原始标记（provider.quota.cookieSet / provider.quota.apiKeySet / provider.quota.workspace）
 * 各自复算会得到第二份真相：类型切换后徽标说「已配置」而下方提示说「必填」（同屏矛盾，S7 反例）。
 * 同源之后「徽标已配置 + 提示必填」结构性不可达，无需再靠调用方自觉。
 *
 * 「类型未定」（missing 含 'type'）不会走到这里：params 区是 typeUndetermined 的 v-else，
 * 该态只剩下拉 + 说明，因此「未判定被读成已配置」在结构上不可达（不是靠本函数兜底）。
 */
function fieldBadgeLabel(key: MissingField): string {
  return isMissing(key)
    ? t('settings.providerEdit.quotaRequiredBadge')
    : t('settings.providerEdit.quotaConfiguredBadge')
}

/** 凭证来源提示：来源语义（D3）+ Provider 侧凭据形态（OAuth / API Key） */
const sourceHint = computed(() => {
  if (props.credentialSource === 'exclusive') return t('settings.providerEdit.quotaSourceExclusiveHint')
  if (props.authKinds.includes('oauth') && props.oauthReady) {
    return t('settings.providerEdit.quotaSourceProviderOauthHint')
  }
  return t('settings.providerEdit.quotaSourceProviderApiKeyHint')
})

/**
 * Provider 凭据不可用的两套文案（§7.4 跨区块时序）：
 * pendingSave true = provider 表单草稿里已填 Key 但未保存 provider（runtime 读不到），
 * 文案必须指出「先保存 provider 配置」，否则用户会以为按钮灰是判定错误。
 */
const providerCredentialWarning = computed(() => props.providerCredentialPendingSave
  ? t('settings.providerEdit.quotaProviderCredentialPendingSave')
  : t('settings.providerEdit.quotaProviderCredentialMissing'))

/**
 * 失败态文案：reason 可区分时用带恢复指引的专属文案（A2-4 全 reason），否则回退 testErrorMsg/通用文案。
 * cookie 类按 authKinds 分支（§5.2 路径 3/4）：cookie 平台不存在「发起一次对话刷新」这个动作，
 * 且 no-credential 的幽灵态（provider.quota.cookieSet=true 但 secrets 缺失）只能靠重新粘贴 Cookie 恢复。
 */
const failMessage = computed(() => {
  const isCookie = props.authKinds.includes('cookie')
  if (props.testFailReason === 'unauthorized') {
    return isCookie
      ? t('settings.providerEdit.quotaFetchFailUnauthorizedCookie')
      : t('settings.providerEdit.quotaFetchFailUnauthorized')
  }
  if (props.testFailReason === 'network') return t('settings.providerEdit.quotaFetchFailNetwork')
  if (props.testFailReason === 'no-subscription') {
    // S5：cookie 类 provider（如 mimo）的业务码不可区分「无订阅 vs Cookie 失效」（fetcher 层已论证
    // 不可行，commit bfe02bd25），cookie 场景的 no-subscription 可能实为 Cookie 失效 → 提示两可
    return isCookie
      ? t('settings.providerEdit.quotaFetchFailNoSubscriptionCookie')
      : t('settings.providerEdit.quotaFetchFailNoSubscription')
  }
  if (props.testFailReason === 'parse') return t('settings.providerEdit.quotaFetchFailParse')
  // not_configured（D1-3，timeout-audit-hygiene-batch）：必填 workspace 缺失——指引去配置，
  // 而非检查凭证（病根在配置缺失，凭证指引会把用户带偏）
  if (props.testFailReason === 'not_configured') return t('settings.providerEdit.quotaFetchFailNotConfigured')
  // no-credential（D6，§5.2 路径 4）：凭证链解析不到任何凭证；cookie 变体给「重新粘贴 Cookie」
  if (props.testFailReason === 'no-credential') {
    return isCookie
      ? t('settings.providerEdit.quotaFetchFailNoCredentialCookie')
      : t('settings.providerEdit.quotaFetchFailNoCredential')
  }
  return props.testErrorMsg || t('settings.providerEdit.quotaTestFail')
})

/** 绝对时间戳格式化（「数据截至」标注用，locale 感知） */
function formatAbsoluteTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/** 格式化时间戳为相对时间（纯函数见 format-time-ago.ts，S-16 提取使边界可测）。 */
function formatTimeAgo(ts: number): string {
  return formatQuotaTimeAgo(ts, Date.now(), t)
}
</script>
