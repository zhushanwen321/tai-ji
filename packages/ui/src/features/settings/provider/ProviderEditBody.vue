<template>
  <!--
    ProviderEditBody —— Provider 手风琴就地编辑体（R4 · 取代 ProviderEditModal 双层 modal）。
    由 ProviderPage 在展开行内渲染，承载原 ProviderEditModal 的全部表单字段：
    凭据（名称/类型/baseUrl/凭证区[OAuth 状态 | apiKey]/authHeader/headers）+ Coding Plan 额度 +
    测试/发现 + 模型清单（custom=ModelListSection / catalog=混合列表）+ sticky save-bar。

    业务编排全在 useProviderEdit composable（core 域），本组件只做展示 + 事件绑定。
    OAuth 状态机不在此组件（ui 零 renderer import 铁律）：凭证区登录/切换按钮经
    @oauth-login 上抛父组件（ProviderPage 共享单实例 useProviderOAuth，无双 listener）。
    dirty 状态经 @dirty-change 上抛父组件做展开切换守卫；保存/取消经 @saved/@cancel 通知父收起。
  -->
  <div class="flex flex-col">
    <!-- 凭据 + 额度 + 验证（左侧区，垂直堆叠） -->
    <div class="flex flex-col gap-4 px-5 py-4">
      <!-- 名称 -->
      <div>
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">{{ t('settings.providerEdit.fieldName') }}</Label>
        <Input
          v-model="form.name"
          data-testid="provider-edit-name"
          :placeholder="t('settings.providerEdit.fieldNamePlaceholder')"
        />
      </div>

      <!-- 类型 + 端点（D5 派生展示，逻辑见 provider-catalog-display.ts）：catalog 类型为只读派生文案、端点为「自定义网关」可选框；custom 照旧（provider 级 api/baseUrl 是定义权威） -->
      <div data-testid="provider-edit-type-field">
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">{{ t('settings.providerEdit.fieldType') }}<span v-if="!isCatalog" class="normal-case tracking-normal">{{ t('settings.providerEdit.fieldTypeHint') }}</span></Label>
        <p v-if="isCatalog" data-testid="provider-edit-api-derived" class="text-[12px] text-neutral-fg">{{ catalogApiText }}</p>
        <Select v-else v-model="form.api">
          <SelectTrigger class="h-9">
            <SelectValue :placeholder="t('settings.providerEdit.selectTypePlaceholder')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="anthropic-messages">{{ t('settings.providerEdit.apiAnthropic') }}</SelectItem>
            <SelectItem value="openai-completions">{{ t('settings.providerEdit.apiOpenai') }}</SelectItem>
            <SelectItem value="openai-responses">{{ t('settings.providerEdit.apiOpenaiResponses') }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">{{ isCatalog ? t('settings.providerEdit.fieldEndpoint') : t('settings.providerEdit.fieldBaseUrl') }}</Label>
        <template v-if="isCatalog">
          <Input :model-value="endpointDraft" data-testid="provider-edit-endpoint" :placeholder="t('settings.providerEdit.fieldEndpointPlaceholder')" @update:model-value="onEndpointInput" />
          <p class="mt-1 text-[10px] text-neutral-dim" data-testid="provider-edit-endpoint-hint">{{ endpointHint }}</p>
        </template>
        <template v-else>
          <Input v-model="form.baseUrl" placeholder="https://api.anthropic.com" />
          <p class="mt-1 text-[10px] text-neutral-dim">{{ t('settings.providerEdit.baseUrlKeepHint') }}</p>
        </template>
      </div>

      <!-- 凭证区（B-1：按 authMethod 条件化——oauth → OAuth 状态区 + 形态切换；
           api_key / env_var / ambient → 现有 API Key 输入不变。切换经确认弹窗，I9 双凭据互斥） -->
      <div v-if="isOauthForm" data-testid="provider-credential-oauth">
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.providerEdit.credentialLabel') }}
        </Label>
        <div class="flex flex-wrap items-center gap-2">
          <span
            v-if="oauthPresent"
            data-testid="oauth-status-loggedin"
            class="flex items-center gap-1.5 text-[12px] font-medium text-success"
          >
            <span class="size-1.5 rounded-full bg-success" />
            {{ t('settings.providerEdit.credentialOauthLoggedIn') }}
          </span>
          <span
            v-else
            data-testid="oauth-status-not-loggedin"
            class="text-[12px] font-medium text-warn"
          >{{ t('settings.providerEdit.credentialOauthNotLoggedIn') }}</span>
          <span class="flex-1" />
          <Button
            variant="secondary"
            class="h-7 px-2.5 text-[11px] text-neutral-mid"
            data-testid="oauth-relogin-btn"
            @click="emit('oauthLogin')"
          >
            {{ oauthPresent ? t('settings.providerEdit.credentialOauthRelogin') : t('settings.providerEdit.credentialOauthLogin') }}
          </Button>
          <!-- B-1 场景 C：退出登录（runtime config.oauthLogout 移除 auth.json 凭证）。
               RPC 编排在父组件（ui 零 renderer import），经 @oauth-logout 上抛。 -->
          <Button
            variant="ghost"
            class="h-7 px-2.5 text-[11px] text-neutral-dim"
            data-testid="oauth-logout-btn"
            @click="emit('oauthLogout')"
          >
            {{ t('settings.providerEdit.credentialOauthLogout') }}
          </Button>
        </div>
        <p class="mt-1 text-[10px] text-neutral-dim">{{ t('settings.providerEdit.credentialOauthHint') }}</p>
        <Button
          variant="ghost"
          class="mt-1.5 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          data-testid="auth-switch-to-apikey"
          @click="requestAuthSwitch('api_key')"
        >
          {{ t('settings.providerEdit.switchToApiKey') }}
        </Button>
      </div>
      <div v-else data-testid="provider-credential-apikey">
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.providerEdit.fieldApiKey') }}
          <span class="normal-case tracking-normal">{{ t('settings.providerEdit.apiKeyHint') }}</span>
        </Label>
        <div class="flex items-center gap-2">
          <Input
            v-model="form.apiKey"
            :type="showKey ? 'text' : 'password'"
            :placeholder="provider?.apiKeySet ? t('settings.providerEdit.apiKeyPlaceholderSet') : t('settings.providerEdit.apiKeyPlaceholderEmpty')"
            class="flex-1"
            data-testid="provider-edit-apikey"
          />
          <Button
            variant="ghost"
            class="size-8 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
            :aria-label="showKey ? t('settings.providerEdit.hideKey') : t('settings.providerEdit.showKey')"
            @click="showKey = !showKey"
          >
            <EyeOff v-if="showKey" class="size-4" />
            <Eye v-else class="size-4" />
          </Button>
          <Button
            v-if="provider?.apiKeySet && form.apiKey !== '__CLEAR__'"
            variant="ghost"
            class="size-8 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-danger-soft hover:text-danger"
            :aria-label="t('settings.providerEdit.clearKey')"
            :title="t('settings.providerEdit.clearKey')"
            @click="clearApiKey"
          >
            <Trash2 class="size-4" />
          </Button>
        </div>
        <p class="mt-1 text-[10px] text-neutral-dim">
          {{ t('settings.providerEdit.apiKeyNoteKeep') }}{{ provider?.apiKeySet ? t('settings.providerEdit.apiKeyNoteClear') : '' }}
        </p>
        <Button
          v-if="oauthSupported"
          variant="ghost"
          class="mt-1.5 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          data-testid="auth-switch-to-oauth"
          @click="requestAuthSwitch('oauth')"
        >
          {{ t('settings.providerEdit.switchToOauth') }}
        </Button>
      </div>

      <!-- authHeader 开关 -->
      <div class="flex items-center justify-between">
        <Label class="text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.providerEdit.fieldAuthHeader') }}
          <span class="normal-case tracking-normal">{{ t('settings.providerEdit.authHeaderHint') }}</span>
        </Label>
        <Switch
          :model-value="form.authHeader"
          data-testid="auth-header-switch"
          :aria-label="t('settings.providerEdit.fieldAuthHeader')"
          @update:model-value="form.authHeader = $event as boolean"
        />
      </div>

      <!-- headers 行编辑 -->
      <div data-testid="headers-editor">
        <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.providerEdit.customHeaders') }}
          <span class="normal-case tracking-normal">{{ t('settings.providerEdit.customHeadersHint') }}</span>
        </Label>
        <div class="flex flex-col gap-1.5">
          <div
            v-for="(row, i) in headerRows"
            :key="i"
            class="flex items-center gap-1.5"
          >
            <Input
              v-model="row.key"
              :placeholder="t('settings.providerEdit.headerKeyPlaceholder')"
              class="h-8 flex-1 text-[12px]"
              @update:model-value="syncHeadersFromRows"
            />
            <Input
              v-model="row.value"
              :placeholder="t('settings.providerEdit.headerValuePlaceholder')"
              class="h-8 flex-1 text-[12px]"
              @update:model-value="syncHeadersFromRows"
            />
            <Button
              variant="ghost"
              class="size-8 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-transparent hover:text-danger [&_svg]:size-3.5"
              :aria-label="t('settings.providerEdit.removeHeader')"
              @click="removeHeader(i)"
            >
              <X />
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          class="mt-1.5 h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
          @click="addHeader"
        >
          {{ t('settings.providerEdit.addHeader') }}
        </Button>
      </div>

      <!-- Coding Plan 额度查询（契约 v2 接线：D3 凭证来源 / D1 齐备性 / D4 开关 / D2 保存并测试） -->
      <CodingPlanSection
        :fetcher-id="quotaFetcherId"
        :fetcher-options="quotaFetcherOptions"
        :enabled="quotaEnabled"
        :cookie-input="quotaCookieInput"
        :api-key-input="quotaApiKeyInput"
        :credential-source="quotaCredentialSource"
        :provider-credential-available="quotaProviderCredentialAvailable"
        :provider-credential-pending-save="quotaProviderCredentialPendingSave"
        :workspace-input="quotaWorkspaceInput"
        :needs-workspace="quotaNeedsWorkspace"
        :readiness="quotaReadiness"
        :test-status="quotaTestStatus"
        :test-error-msg="quotaTestError"
        :quota-row="quotaData"
        :last-fetch-at="quotaLastFetchAt"
        :is-cookie-auth="quotaIsCookieAuth"
        :configuring="quotaConfiguring"
        :configure-error-msg="quotaConfigureError"
        :auth-kinds="quotaAuthKinds"
        :oauth-ready="oauthPresent"
        :test-fail-reason="quotaTestFailReason"
        :help-url="quotaHelpUrl"
        :help-text="quotaHelpText"
        @update:fetcher-id="quotaFetcherId = $event"
        @update:enabled="quotaSetEnabled"
        @update:credential-source="quotaCredentialSource = $event"
        @save-and-test="quotaSaveAndTest"
        @update:cookie-input="quotaCookieInput = $event"
        @update:api-key-input="quotaApiKeyInput = $event"
        @update:workspace-input="quotaWorkspaceInput = $event"
      />

      <!-- 测试连接 / 自动发现（纯展示块抽为 ProviderTestDiscoverSection，编排仍在 useProviderEdit）。
           props 经 useCatalogDisplay().testDiscoverProps 整体接线（含 M3b 的 providerKind /
           testResults / testError / providerBaseUrl 4 项），派生来源见 provider-catalog-display.ts。 -->
      <ProviderTestDiscoverSection
        v-bind="testDiscoverProps"
        @test="testConnection"
        @discover="autoDiscover"
      />
    </div>

    <!--
      模型区（B-2 混合列表）。
      wave4 C4 决策边界修订（design §3.6 UI 决策 1，非推翻）：C4 禁止的是「修改内置模型定义」
      ——builtin 条目保持只读（pi 升级自动覆盖编辑无意义）；「追加自定义模型」与「对内置条目做
      参数 override」是 pi 原生支持的合法操作（D1 探针：builtin ∪ override 并集合并），非 C4
      禁止场景——故 catalog provider 开放自定义模型增删，保存只回传 override 条目。
    -->
    <div class="border-t border-border" :data-testid="isCatalog ? 'provider-models-mixed' : 'provider-models-editable'">
      <template v-if="isCatalog">
        <!-- builtin 只读列表（徽章「内置」；编辑/删除按钮刻意缺席——C4 边界） -->
        <div class="px-5 py-4" data-testid="provider-models-builtin">
          <Label class="mb-1.5 block text-[11px] font-semibold text-neutral-mid">
            {{ t('settings.providerEdit.builtinModelsLabel') }}
          </Label>
          <p class="mb-2 text-[10px] text-neutral-dim">{{ t('settings.providerEdit.catalogModelsMixedHint') }}</p>
          <ul v-if="builtinModels.length" class="flex flex-col gap-1">
            <li
              v-for="m in builtinModels"
              :key="m.id"
              data-testid="builtin-model-row"
              class="flex items-center gap-1.5 rounded-sm bg-surface px-2.5 py-1 text-[12px] text-neutral-mid"
            >
              <span class="font-medium text-neutral-fg">{{ m.name || m.id }}</span>
              <span class="text-[10px] text-neutral-dim">{{ m.id }}</span>
              <span
                data-testid="model-badge-builtin"
                class="ml-auto shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5 text-[9px] font-medium text-neutral-mid"
              >{{ t('settings.providerEdit.modelSourceBuiltin') }}</span>
            </li>
          </ul>
        </div>
        <!-- override 条目（徽章「自定义」）：复用 ModelListSection 行编辑能力 + 手动添加入口 -->
        <ModelListSection
          v-model:show-add-model="showAddModel"
          title-key="settings.providerEdit.customModelsLabel"
          :badge-text="t('settings.providerEdit.modelSourceOverride')"
          @add-model="onAddModel"
        />
      </template>
      <ModelListSection
        v-else
        v-model:show-add-model="showAddModel"
        @add-model="onAddModel"
      />
    </div>

    <!-- 形态切换确认弹窗（B-1：I9 双凭据互斥，双向切换均显式确认；取消不动凭证） -->
    <Dialog v-model:open="authSwitchDialogOpen">
      <DialogContent hide-close class="max-w-[360px]" data-testid="auth-switch-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{{ authSwitchDialogTitle }}</DialogTitle>
          <DialogDescription>{{ authSwitchDialogDesc }}</DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-4">
          <Button
            variant="ghost"
            data-testid="auth-switch-cancel-btn"
            @click="authSwitchDialogOpen = false"
          >
            {{ t('settings.providerEdit.cancel') }}
          </Button>
          <Button data-testid="auth-switch-confirm-btn" @click="confirmAuthSwitch">
            {{ t('settings.providerEdit.switchConfirmBtn') }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <!-- sticky save-bar：dirty 时出现（spec §4.3）。负 margin 撑满 expand-body padding。 -->
    <div
      v-if="isDirty"
      data-testid="provider-save-bar"
      class="sticky bottom-0 flex items-center gap-2 border-t border-border bg-surface px-5 py-3"
    >
      <span class="flex items-center gap-1.5 text-[12px] font-semibold text-warn">
        <span class="size-1.5 rounded-full bg-warn" />
        {{ t('settings.provider.unsavedBadge') }}
      </span>
      <span v-if="actionError" class="flex-1 truncate text-[12px] text-danger">{{ actionError }}</span>
      <span v-else class="flex-1" />
      <Button
        variant="ghost"
        data-testid="provider-cancel-btn"
        :disabled="saving"
        @click="emit('cancel')"
      >
        {{ t('settings.providerEdit.cancel') }}
      </Button>
      <Button
        data-testid="provider-save-btn"
        :disabled="saving"
        @click="onSave"
      >
        {{ saving ? t('settings.providerEdit.saving') : t('settings.providerEdit.save') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch, Label, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@taiji/ui'
import { provide, watch, ref, computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Eye, EyeOff,
  X, Trash2,
} from '@lucide/vue'
import { matchQuotaPreset } from '@taiji/shared'

import type { ProviderInfo } from '@taiji/shared'
import { useProviderEdit, API_KEY_CLEAR_SENTINEL } from '@taiji/core'
import { useQuotaConfigureFactory as useQuotaConfigure } from '../injection-keys'
import CodingPlanSection from '../coding-plan/CodingPlanSection.vue'
import ModelListSection from '../common/ModelListSection.vue'
import ProviderTestDiscoverSection from './ProviderTestDiscoverSection.vue'
import { useCatalogDisplay } from './provider-catalog-display.js'
import { useSettingsToast as useToast } from '../injection-keys'

const props = defineProps<{
  provider: ProviderInfo | null
  /** auth.json 已有该 provider 的 OAuth 凭据（父组件 useProviderOAuth.oauthPresent，展开时刷新） */
  oauthPresent?: boolean
  /** 该 provider 支持 OAuth 登录（父组件按 builtinProviders 模板 oauthSupported 判定） */
  oauthSupported?: boolean
}>()
const emit = defineEmits<{
  /** 保存成功（wroteApiKey=本次写入非空 apiKey，父组件据此做「配置完即自动启用」） */
  saved: [payload?: { wroteApiKey: boolean }]
  cancel: []
  /** dirty 状态变化（true=有未保存改动）。父组件用于展开切换守卫 */
  dirtyChange: [value: boolean]
  /** OAuth 登录/重新登录（B-1：父组件驱动共享 useProviderOAuth 状态机 + OAuthDialog，单实例无双 listener） */
  oauthLogin: []
  /** OAuth 退出登录（B-1 场景 C：父组件调 config.oauthLogout 移除 auth.json 凭证并刷新 presence） */
  oauthLogout: []
}>()

const { t } = useI18n()
const { info: toastInfo } = useToast()

// wave4 C4 边界修订（B-2）：catalog provider 的 builtin 条目只读，override 条目开放增删
// （追加自定义模型是 pi 原生支持的合法操作，见模板区注释）。kind 缺失当作 custom（向后兼容）。
const isCatalog = computed(() => props.provider?.kind === 'catalog')

/** builtin 只读条目（B-2 徽章「内置」；override 条目在 localModels 内经 ModelListSection 编辑） */
const builtinModels = computed(() => props.provider?.models.filter((m) => m.source === 'builtin') ?? [])

// ── Coding Plan 额度查询：自动关联 + 配置 ──
const matchedPreset = computed(() => {
  const p = props.provider
  return matchQuotaPreset({ baseUrl: p?.baseUrl, name: p?.name })
})

const quotaFactory = useQuotaConfigure()

const {
  fetcherId: quotaFetcherId,
  fetcherOptions: quotaFetcherOptions,
  enabled: quotaEnabled,
  cookieInput: quotaCookieInput,
  apiKeyInput: quotaApiKeyInput,
  credentialSource: quotaCredentialSource,
  providerCredentialAvailable: quotaProviderCredentialAvailable,
  providerCredentialPendingSave: quotaProviderCredentialPendingSave,
  workspaceInput: quotaWorkspaceInput,
  needsWorkspace: quotaNeedsWorkspace,
  readiness: quotaReadiness,
  testStatus: quotaTestStatus,
  testError: quotaTestError,
  testFailReason: quotaTestFailReason,
  quotaData,
  lastFetchAt: quotaLastFetchAt,
  isCookieAuth: quotaIsCookieAuth,
  authKinds: quotaAuthKinds,
  helpUrl: quotaHelpUrl,
  helpText: quotaHelpText,
  configuring: quotaConfiguring,
  configureError: quotaConfigureError,
  setEnabled: quotaSetEnabled,
  saveAndTest: quotaSaveAndTest,
} = quotaFactory(matchedPreset, toRef(props, 'provider'))

// 业务编排全在 composable。整份返回值留作 edit：展示接线 composable 从这里读 test 状态与模型数
// （test/discover 结果不再逐个解构到本组件——第 1 轮抽走展示逻辑后本组件行数余量已用尽）。
const edit = useProviderEdit(toRef(props, 'provider'), { t })
const {
  form,
  newModel,
  localModels,
  headerRows,
  showKey,
  showAddModel,
  saving,
  actionError,
  isDirty,
  expandedCompat,
  getStrategyFromMap,
  testConnection,
  autoDiscover,
  save,
  clearApiKey,
  toggleInput,
  toggleNewInput,
  updateCtx,
  pickStrategy,
  addModel,
  removeModel,
  toggleCompatExpand,
  addHeader,
  removeHeader,
  syncHeadersFromRows,
} = edit

// R4：providerCredentialPendingSave 是 carry-in ref（useQuotaConfigure 的输入只有 preset + providerRef，
// 看不到 provider 表单草稿），由本组件按 §7.4 判定式写入——漏接则「已填未保存」文案区分不生效。
// 判定式必须排除清除哨兵：用户点「清除」时 form.apiKey === API_KEY_CLEAR_SENTINEL（非空但语义是
// 无凭据），只用 `!== ''` 会显示与事实相反的「已填写，保存后即可查询」。
watch(
  () => form.apiKey,
  (v) => {
    quotaProviderCredentialPendingSave.value = v !== '' && v !== API_KEY_CLEAR_SENTINEL
  },
  { immediate: true },
)

// catalog 展示字段（类型只读派生文案 + 端点自定义网关；设计 D5）+ 测试连接区 props 接线（M3b）
// ——逻辑在同目录 composable（受本组件行数约束抽出；runtime 已下发派生值，此处只做展示转译）
const { apiText: catalogApiText, endpointDraft, endpointHint, onEndpointInput, syncBeforeSave, testDiscoverProps } =
  useCatalogDisplay(toRef(props, 'provider'), edit, t, isCatalog)

// ── B-1 凭证区条件化（需 form 已就绪，故置于 useProviderEdit 之后） ──

/** oauth 形态 → OAuth 状态区；api_key / env_var / ambient → 现有 API Key 输入（现状不动） */
const isOauthForm = computed(() => form.authMethod === 'oauth')

/** 形态切换目标（非 null = 确认弹窗打开） */
const pendingAuthSwitch = ref<'api_key' | 'oauth' | null>(null)
const authSwitchDialogOpen = computed({
  get: () => pendingAuthSwitch.value !== null,
  set: (open: boolean) => { if (!open) pendingAuthSwitch.value = null },
})
const authSwitchDialogTitle = computed(() => pendingAuthSwitch.value === 'oauth'
  ? t('settings.providerEdit.switchToOauthConfirmTitle')
  : t('settings.providerEdit.switchToApiKeyConfirmTitle'))
const authSwitchDialogDesc = computed(() => pendingAuthSwitch.value === 'oauth'
  ? t('settings.providerEdit.switchToOauthConfirmDesc')
  : t('settings.providerEdit.switchToApiKeyConfirmDesc'))

/** 发起形态切换（I9 双凭据互斥——确认后才动凭证形态） */
function requestAuthSwitch(target: 'api_key' | 'oauth'): void {
  pendingAuthSwitch.value = target
}

/** 确认切换：oauth→api_key 改本地形态（保存时 apiKey 覆写 auth.json OAuth 凭证，catalog 原生 I9）；
 *  api_key→oauth 上抛 oauthLogin（父驱动 flow，成功后 authMethod='oauth' 持久化并广播回推） */
function confirmAuthSwitch(): void {
  const target = pendingAuthSwitch.value
  pendingAuthSwitch.value = null
  if (target === 'api_key') {
    form.authMethod = 'api_key'
  } else if (target === 'oauth') {
    emit('oauthLogin')
  }
}

// ModelListSection 经 provide('modelListDeps') 拿到状态/方法（与原 ProviderEditModal 同构）
provide('modelListDeps', {
  newModel,
  localModels,
  toggleNewInput,
  toggleInput,
  updateCtx,
  pickStrategy,
  getStrategyFromMap,
  removeModel,
  expandedCompat,
  toggleCompatExpand,
  // providerApi（ModelListSection 据此选 compat 字段集，design D5 消费点表）：
  // catalog 的 provider 级协议 = runtime 派生值（ProviderInfo.api；混合协议 → undefined），
  // **不取 form.api**——composable 对 catalog 的回填是 `p.api ?? 'anthropic-messages'`
  // （三值 Select 历史兜底，对 catalog 无用户语义），拿它会把混合 provider 误判成
  // anthropic-messages 的 compat 字段集；undefined 时 ModelListSection 走通用字段集，
  // 并由模型自身 api 回落（见 ModelListSection compat 判定）。
  providerApi: computed(() => isCatalog.value ? props.provider?.api : form.api),
})

// dirty 上抛父组件（展开切换守卫）。immediate 让父组件初始即知当前 dirty 态
watch(isDirty, (v) => emit('dirtyChange', v), { immediate: true })

/** 添加模型：捕获 addModel 校验错填到 actionError（save-bar 显示） */
function onAddModel(): void {
  actionError.value = ''
  try {
    addModel()
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

/** 保存成功 → toast 反馈 + 上抛 @saved（父组件收起展开行；状态经 onProviders 订阅推回） */
async function onSave(): Promise<void> {
  // catalog 端点按输入框归一：form.baseUrl 初值是 runtime 派生端点（展示信息，不是用户网关），
  // 未改动直接保存会把它当网关写回并冻结成覆盖式网关——非空 = 设置网关 / 空 = 显式清除网关
  syncBeforeSave()
  const result = await save()
  if (result.ok) {
    toastInfo(t('settings.saved'))
    emit('saved', { wroteApiKey: result.wroteApiKey })
  }
}
</script>
