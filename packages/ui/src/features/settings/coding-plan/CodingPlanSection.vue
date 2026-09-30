<template>
  <!--
    CodingPlanSection —— ProviderEditBody 内「Coding Plan 额度查询」子组件。

    契约 v2（coding-plan-quota-config-ux §7.4 方案 B 重写）：
    - D8 未选类型：只渲染类型下拉 + 一句说明（开关 / 凭证区 / 按钮全部不渲染）
    - D1 齐备性门控：唯一主动作按钮「保存并测试」按 readiness.ready 置灰
    - D3 凭证来源分段控件（api-key 类）：UI 显示的选择与 runtime 使用的凭证同源
    - D4 开关退化为纯配置位（无网络副作用，即时落盘经 module setEnabled 完成）
    - D7 cookie / 专属 Key 输入框不回显掩码，草稿即真相；「已配置 / 必填」徽标与专属 Key 占位
      均与 readiness.missing 同源（§7.4：不在缺口里 = 该字段此刻有效），与字段级提示结构性一致
    - D2 保存与测试合一：按钮 onclick → saveAndTest

    [C1] 本组件跨过 typed InjectionKey seam 直接持有 quota configure module 实例
    （core QuotaConfigureModule：draft / view / test 三个状态透镜 + 3 个写动作），
    逐名 props/emits 管道已删除；规则（类型切换清凭证草稿 / 齐备性 / 失败原因归一 /
    警示分档）全部在 module 内，本组件纯展示 + i18n 映射。
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
        :model-value="view.type.selected"
        @update:model-value="selectType"
      >
        <SelectTrigger class="h-8 text-[12px]" data-testid="quota-type-select">
          <SelectValue :placeholder="t('settings.providerEdit.quotaTypePlaceholder')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in view.type.options"
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
      的控件，正是 D8 要堵的反例；两来源共用同一指引（module view.type.undetermined 归一）。
    -->
    <p v-if="view.type.undetermined" class="text-[10px] text-neutral-dim" data-testid="quota-no-type-hint">
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
          :model-value="view.enabled"
          data-testid="quota-enabled-switch"
          :disabled="view.configuring"
          @update:model-value="onToggleEnabled"
        />
      </div>

      <!-- Cookie 类：cookie 输入（D7 去掩码，草稿只放用户真实输入；「已配置」为独立标记） -->
      <div v-if="view.credential.form === 'cookie'" class="mt-2" data-testid="quota-cookie-block">
        <Label class="mb-1 block text-[10px] text-neutral-mid">
          Cookie
          <span class="normal-case text-neutral-dim">· {{ fieldBadgeLabel('cookie') }}</span>
        </Label>
        <Textarea
          v-model="draft.cookie"
          class="min-h-[56px] resize-y font-mono text-[11px]"
          :placeholder="t('settings.providerEdit.quotaCookiePlaceholder')"
          data-testid="quota-cookie-input"
        />
        <p
          v-if="isMissing('cookie')"
          class="mt-1 text-[10px] text-warn"
          data-testid="quota-missing-cookie"
        >{{ missingHint('cookie') }}</p>
      </div>

      <!-- api-key 类：凭证来源分段控件（D3）+ 专属 Key 输入（仅选「用专属 Key」时出现） -->
      <template v-else>
        <div v-if="view.credential.exclusiveApplicable" class="mt-1.5" data-testid="quota-credential-source">
          <Label class="mb-1 block text-[10px] text-neutral-mid">
            {{ t('settings.providerEdit.quotaCredentialSourceLabel') }}
          </Label>
          <div class="inline-flex gap-0.5 rounded-sm bg-bg-input p-0.5" role="group">
            <Button
              variant="ghost"
              class="h-6 rounded-sm px-2.5 text-[11px]"
              :class="draft.credentialSource === 'provider' ? 'bg-surface-2 text-neutral-fg' : 'text-neutral-dim'"
              :aria-pressed="draft.credentialSource === 'provider'"
              :disabled="!view.credential.providerAvailable"
              data-testid="quota-source-provider-btn"
              @click="setCredentialSource('provider')"
            >{{ t('settings.providerEdit.quotaSourceProvider') }}</Button>
            <Button
              variant="ghost"
              class="h-6 rounded-sm px-2.5 text-[11px]"
              :class="draft.credentialSource === 'exclusive' ? 'bg-surface-2 text-neutral-fg' : 'text-neutral-dim'"
              :aria-pressed="draft.credentialSource === 'exclusive'"
              data-testid="quota-source-exclusive-btn"
              @click="setCredentialSource('exclusive')"
            >{{ t('settings.providerEdit.quotaSourceExclusive') }}</Button>
          </div>
          <p class="mt-1 text-[10px] text-neutral-dim" data-testid="quota-source-hint">{{ sourceHintText }}</p>
        </div>

        <div v-if="view.credential.exclusiveApplicable && draft.credentialSource === 'exclusive'" class="mt-1.5" data-testid="quota-exclusive-key-block">
          <Label class="mb-1 block text-[10px] text-neutral-mid">
            {{ t('settings.providerEdit.quotaApiKey') }}
            <span class="normal-case text-neutral-dim">· {{ fieldBadgeLabel('apiKey') }}</span>
          </Label>
          <Input
            v-model="draft.apiKey"
            type="password"
            class="h-8 font-mono text-[11px]"
            :placeholder="exclusiveKeyPlaceholder"
            data-testid="quota-apikey-input"
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
          分档判定在 module（view.credential.providerWarning），此处只映射文案。
        -->
        <p
          v-else-if="view.credential.providerWarning"
          class="mt-1 text-[10px] text-warn"
          data-testid="quota-provider-credential-warning"
        >{{ providerCredentialWarningText }}</p>
      </template>

      <!-- Workspace 地址（资源维度 fetcher；明文回显，D13 判定只看草稿） -->
      <div v-if="view.workspace.required" class="mt-2" data-testid="quota-workspace-block">
        <Label class="mb-1 block text-[10px] text-neutral-mid">
          {{ t('settings.providerEdit.quotaWorkspaceLabel') }}
          <span class="normal-case text-neutral-dim">· {{ fieldBadgeLabel('workspace') }}</span>
        </Label>
        <Input
          v-model="draft.workspace"
          class="h-8 font-mono text-[11px]"
          :placeholder="t('settings.providerEdit.quotaWorkspacePlaceholder')"
          data-testid="quota-workspace-input"
        />
        <p
          v-if="isMissing('workspace')"
          class="mt-1 text-[10px] text-warn"
          data-testid="quota-missing-workspace"
        >{{ missingHint('workspace') }}</p>
        <p class="mt-1 text-[10px] text-neutral-dim">{{ t('settings.providerEdit.quotaWorkspaceHelp') }}</p>
      </div>

      <!-- 帮助链接 -->
      <p v-if="view.help" class="mt-1.5 flex items-start gap-1 text-[10px] text-neutral-dim">
        <ExternalLink class="mt-0.5 size-3 shrink-0" />
        <span>{{ view.help.text }}
          <a
            :href="view.help.url"
            target="_blank"
            rel="noopener"
            class="text-accent hover:underline"
          >{{ view.help.url }}</a>
        </span>
      </p>

      <!-- D2 单动作按钮：保存并测试（D1 齐备性置灰是唯一门控；无网络副作用之外的第二个动作） -->
      <div class="mt-2 flex items-center gap-2" data-testid="quota-actions">
        <Button
          class="h-7 gap-1 px-2.5 text-[11px]"
          :disabled="!view.readiness.ready || view.configuring"
          data-testid="quota-save-test-btn"
          @click="saveAndTest()"
        >
          <Loader2 v-if="view.configuring" class="animate-spin" />
          {{ view.configuring ? t('settings.providerEdit.quotaSaveAndTestRunning') : t('settings.providerEdit.quotaSaveAndTest') }}
        </Button>
        <span v-if="!view.readiness.ready" class="text-[10px] text-neutral-dim" data-testid="quota-ready-hint">
          {{ t('settings.providerEdit.quotaReadyHint') }}
        </span>
      </div>

      <!-- 测试查询成功 + 内联额度预览（3 窗口行；B-3：used/limit 绝对量 + pct 双轨） -->
      <div v-if="test.status === 'success' && test.row" class="mt-2" data-testid="quota-result">
        <div class="flex items-center gap-1.5 text-[11px] text-success">
          <CheckCircle2 class="size-3" />
          {{ t('settings.providerEdit.quotaTestSuccess') }}
          <span v-if="test.lastFetchAt" class="text-neutral-dim">· {{ formatTimeAgo(test.lastFetchAt) }}</span>
        </div>
        <div class="mt-2 rounded-sm border border-border bg-bg-input p-2.5" data-testid="quota-result-windows">
          <QuotaWindowList :windows="visibleWindows" :labels="windowLabels" tone="current" />
        </div>
      </div>

      <!-- 测试查询失败（B-3 / A2-4）：失败态整体替换数据展示，旧缓存只经「查看上次成功数据」展开可见 -->
      <div v-if="test.status === 'error'" class="mt-2" data-testid="quota-error">
        <div class="flex items-center gap-1.5 text-[11px] text-danger" data-testid="quota-error-msg">
          <AlertCircle class="size-3" />
          {{ failMessage }}
        </div>
        <Button
          v-if="view.credential.form === 'cookie'"
          variant="ghost"
          class="mt-1 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          data-testid="quota-update-cookie-btn"
          @click="clearCookieDraft"
        >
          {{ t('settings.providerEdit.quotaUpdateCookie') }}
        </Button>
        <!-- 「查看上次成功数据」入口（design §3.4：旧缓存保留内存不直接展示，防陈旧数据当当前额度） -->
        <Button
          v-if="test.row"
          variant="ghost"
          class="mt-1 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          data-testid="quota-toggle-last-success"
          @click="showLastSuccess = !showLastSuccess"
        >
          {{ showLastSuccess ? t('settings.providerEdit.collapse') : t('settings.providerEdit.quotaLastSuccessToggle') }}
        </Button>
        <div v-if="showLastSuccess && test.row" class="mt-2 rounded-sm border border-border bg-bg-input p-2.5" data-testid="quota-last-success">
          <p v-if="test.lastFetchAt" class="mb-1 text-[10px] text-neutral-dim">
            {{ t('settings.providerEdit.quotaLastSuccessAt', { time: formatAbsoluteTime(test.lastFetchAt) }) }}
          </p>
          <QuotaWindowList :windows="visibleWindows" :labels="windowLabels" tone="muted" />
        </div>
      </div>

      <!-- 配置错误（D9：统一走 i18n 的保存类错误出口） -->
      <p v-if="view.configureError" class="mt-1 text-[11px] text-danger" data-testid="quota-configure-error">{{ view.configureError }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * CodingPlanSection 消费面（C1 deep module seam）：
 * - 状态 = module 三个透镜（draft / view / test），写入 = 3 个动作 / 草稿直写；
 *   无 props / 无 emits（原 23 props + 7 emits 的逐名管道已删）
 * - 本组件只保留展示职责：i18n 映射（失败文案表 / 徽标 / 提示）、布局分层（D8）、
 *   「查看上次成功数据」折叠态
 */
import { Button, Switch, Label, Textarea, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@taiji/ui'
import { computed, ref } from 'vue'
import { Loader2, CheckCircle2, AlertCircle, ExternalLink } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { formatQuotaTimeAgo } from './format-time-ago'

import type { QuotaCredentialSource } from '@taiji/shared'
import { useQuotaConfigureModule } from '../injection-keys'
import QuotaWindowList from './QuotaWindowList.vue'

/** 字段级缺口的显式白名单（§7.4：只对这三个键查 i18n，'type' 走 D8 分支根本不进提示渲染）。 */
type MissingField = 'cookie' | 'apiKey' | 'workspace'

const MISSING_HINT_KEYS: Record<MissingField, string> = {
  cookie: 'settings.providerEdit.quotaMissingCookie',
  apiKey: 'settings.providerEdit.quotaMissingApiKey',
  workspace: 'settings.providerEdit.quotaMissingWorkspace',
}

const { t } = useI18n()

/** quota configure module 实例（ProviderEditBody provide；缺失 = 接线错误，loud fail） */
const { draft, view, test, selectType, setEnabled, saveAndTest } = useQuotaConfigureModule()

/** 类型下拉变更：非字符串守卫在 module selectType 内（reka Select 的宽联合 payload） */

/** 拨动启用开关：reka Switch 的 update 是宽联合类型，`=== true` 布尔窄化后交给 module（D4） */
function onToggleEnabled(value: unknown): void {
  void setEnabled(value === true)
}

/** 凭证来源切换（D3）：只改草稿这一个字段，随 saveAndTest 落盘 */
function setCredentialSource(value: QuotaCredentialSource): void {
  draft.value.credentialSource = value
}

/** 失败态点「更新 Cookie」：清空草稿引导重贴（清的是草稿不是磁盘，D7） */
function clearCookieDraft(): void {
  draft.value.cookie = ''
}

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
  const row = test.value.row
  if (!row) return []
  return row.wins.map((w, i) => ({ idx: i, pct: w.pct, resetSec: w.resetSec, used: w.used, limit: w.limit, unit: w.unit }))
})

/** 「查看上次成功数据」展开态（B-3 / design §3.4：失败态下旧缓存折叠展示） */
const showLastSuccess = ref(false)

/** 缺口判定（白名单三键；'type' 已在模板层走 D8 分支，不进入本判定） */
function isMissing(key: MissingField): boolean {
  return view.value.readiness.missing.includes(key)
}

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
 * 「类型未定」（missing 含 'type'）不会走到这里：params 区是 view.type.undetermined 的 v-else，
 * 该态只剩下拉 + 说明，因此「未判定被读成已配置」在结构上不可达（不是靠本函数兜底）。
 */
function fieldBadgeLabel(key: MissingField): string {
  return isMissing(key)
    ? t('settings.providerEdit.quotaRequiredBadge')
    : t('settings.providerEdit.quotaConfiguredBadge')
}

/** 凭证来源提示：来源语义（D3）+ Provider 侧凭据形态（OAuth / API Key），分档判定在 module */
const sourceHintText = computed(() => {
  const hint = view.value.credential.sourceHint
  if (hint === 'exclusive') return t('settings.providerEdit.quotaSourceExclusiveHint')
  if (hint === 'providerOauth') return t('settings.providerEdit.quotaSourceProviderOauthHint')
  return t('settings.providerEdit.quotaSourceProviderApiKeyHint')
})

/**
 * Provider 凭据不可用的两套文案（§7.4 跨区块时序，分档判定在 module）：
 * pendingSave = provider 表单草稿里已填 Key 但未保存 provider（runtime 读不到），
 * 文案必须指出「先保存 provider 配置」，否则用户会以为按钮灰是判定错误。
 */
const providerCredentialWarningText = computed(() => (
  view.value.credential.providerWarning === 'pendingSave'
    ? t('settings.providerEdit.quotaProviderCredentialPendingSave')
    : t('settings.providerEdit.quotaProviderCredentialMissing')
))

/**
 * 失败态文案：module 已把 reason 归一为分档（QuotaFailureKind）+ cookie 形态（A2-4），
 * 此处只做 i18n 映射。cookie 类按 cookieAuth 分支（§5.2 路径 3/4）：cookie 平台不存在
 * 「发起一次对话刷新」这个动作，且 no-credential 的幽灵态（provider.quota.cookieSet=true
 * 但 secrets 缺失）只能靠重新粘贴 Cookie 恢复。
 */
const failMessage = computed(() => {
  const failure = test.value.failure
  if (!failure) return ''
  const isCookie = failure.cookieAuth
  if (failure.kind === 'unauthorized') {
    return isCookie
      ? t('settings.providerEdit.quotaFetchFailUnauthorizedCookie')
      : t('settings.providerEdit.quotaFetchFailUnauthorized')
  }
  if (failure.kind === 'network') return t('settings.providerEdit.quotaFetchFailNetwork')
  if (failure.kind === 'no-subscription') {
    // S5：cookie 类 provider（如 mimo）的业务码不可区分「无订阅 vs Cookie 失效」（fetcher 层已论证
    // 不可行，commit bfe02bd25），cookie 场景的 no-subscription 可能实为 Cookie 失效 → 提示两可
    return isCookie
      ? t('settings.providerEdit.quotaFetchFailNoSubscriptionCookie')
      : t('settings.providerEdit.quotaFetchFailNoSubscription')
  }
  if (failure.kind === 'parse') return t('settings.providerEdit.quotaFetchFailParse')
  // not-configured（D1-3，timeout-audit-hygiene-batch）：必填 workspace 缺失——指引去配置，
  // 而非检查凭证（病根在配置缺失，凭证指引会把用户带偏）
  if (failure.kind === 'not-configured') return t('settings.providerEdit.quotaFetchFailNotConfigured')
  // no-credential（D6，§5.2 路径 4）：凭证链解析不到任何凭证；cookie 变体给「重新粘贴 Cookie」
  if (failure.kind === 'no-credential') {
    return isCookie
      ? t('settings.providerEdit.quotaFetchFailNoCredentialCookie')
      : t('settings.providerEdit.quotaFetchFailNoCredential')
  }
  return failure.message || t('settings.providerEdit.quotaTestFail')
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
