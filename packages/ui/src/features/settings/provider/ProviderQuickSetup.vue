<script setup lang="ts">
/**
 * 内置 Provider 快速配置面板（wave-quick-setup-c，对齐 demo 模块 C configOverlay）。
 *
 * Dialog 弹层：内置信息块（Base URL/协议/推荐 env var/模型列表）+ 认证方式 radio 四选一
 * （明文/环境变量[推荐]/OAuth/云凭证，按 authMode 条件渲染）+ footer 动态落盘提示 + 取消/保存。
 *
 * 表单逻辑在 use-quick-setup-form（script setup 行数上限拆分）；emit 上抛模式
 * （ui 零 renderer import 铁律）：OAuth 登录经 emit('oauth-login') 上抛，父驱动 OAuthDialog；
 * 授权状态经 props oauthAuthorized 回写；env 检测态经 props envCheck 传入。
 *
 * footer hint 有意偏离 demo：明文/env 态落 models.json apiKey（spec §4.1），OAuth 态与 demo 一致。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Check, Cloud, Eye, EyeOff } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Button,
  Label,
} from '@taiji/ui'
import type { BuiltinProviderTemplate, SetProviderData } from '@taiji/shared'
import { useQuickSetupForm, CUSTOM_ENV_VALUE, type ExistingAuthMethod } from './use-quick-setup-form.js'

const props = defineProps<{
  template: BuiltinProviderTemplate
  open: boolean
  /** env 检测结果（父调 config.checkEnvVars 后传入；未拉取时 undefined 不显示检测态） */
  envCheck?: Record<string, boolean>
  /** OAuth 已授权（auth.success 后父回写） */
  oauthAuthorized?: boolean
  /** 该 provider 已存配置的认证方式（MF-1：重开 QuickSetup 恢复上次方式，防 env 默认盲保存清 OAuth） */
  existingAuthMethod?: ExistingAuthMethod
}>()

const emit = defineEmits<{
  save: [payload: { providerId: string; data: SetProviderData }]
  cancel: []
  /** 点 OAuth「登录」按钮 → 父驱动 OAuthDialog（ui 零 renderer import） */
  'oauth-login': []
}>()

const { t } = useI18n()

const templateRef = computed(() => props.template)
const envCheckRef = computed(() => props.envCheck)
const oauthAuthorizedRef = computed(() => props.oauthAuthorized)
const existingAuthMethodRef = computed(() => props.existingAuthMethod)

// 解构到顶层：模板访问嵌套对象里的 ref 不解包，必须显式解构
const {
  authMethod,
  apiKeyInput,
  envVar,
  customEnvVar,
  showKey,
  resolvedEnvVar,
  authOptions,
  saveDisabled,
  footerHintKey,
  envDetected,
  onSave,
} = useQuickSetupForm(
  templateRef,
  envCheckRef,
  oauthAuthorizedRef,
  (payload) => emit('save', payload),
  existingAuthMethodRef,
)

/** 关闭（X/ESC/遮罩）即上抛 cancel（受控代理） */
const openProxy = computed<boolean>({
  get: () => props.open,
  set: (v) => {
    if (!v) emit('cancel')
  },
})

// ── M4：模板卡协议 / 端点展示（设计 catalog-provider-field-authority §3.3 D5）──
//
// 模板 provider 级 api/baseUrl 是构建期 artifact（gen-builtin-providers.mjs 取
// `models[0].api` 冒充 provider 协议、`provider.baseUrl ?? ''` 落空串），直接展示会把
// 「取第一个模型的协议冒充 provider 协议」泄漏给用户（混合协议 provider 如 opencode-go
// 卡片显示 anthropic-messages）。改为按模板模型集聚合：单一值 → 该值；混合 → 按模型分发；
// 无值 → 空值占位（协议）/ 内置目录未提供（端点）。

/**
 * 模型集单值字段聚合：undefined = 无任何非空值；null = 混合（>1 种）；string = 单值。
 * null 与 undefined 分开返回——「混合」与「没有」在展示上是两种不同事实。
 */
function aggregateModelField(values: Array<string | undefined>): string | undefined | null {
  const distinct = [...new Set(values.filter((v): v is string => !!v))]
  if (distinct.length === 0) return undefined
  if (distinct.length > 1) return null
  return distinct[0]
}

/** 协议单元格：混合 → 「按模型分发」；无 → 「—」；单值 → 该协议 */
const templateApiText = computed<string>(() => {
  const aggregated = aggregateModelField(props.template.models.map(m => m.api))
  if (aggregated === null) return t('settings.providerEdit.apiMixed')
  return aggregated ?? t('settings.provider.builtinTemplate.emptyValue')
})

/** 端点单元格：混合 → 「按模型分发」；模板模型集无端点信息 → 「内置目录未提供」；单值 → 该端点 */
const templateBaseUrlText = computed<string>(() => {
  const aggregated = aggregateModelField(props.template.models.map(m => m.baseUrl))
  if (aggregated === null) return t('settings.providerEdit.apiMixed')
  return aggregated ?? t('settings.providerEdit.endpointNotProvided')
})

/** footer hint：动态落盘说明 */
const footerHint = computed(() => t(`settings.provider.builtinTemplate.${footerHintKey.value}`))

/** 点 OAuth 登录按钮 → 上抛（父驱动 OAuthDialog + config.oauthLogin） */
function onOAuthLogin(): void {
  emit('oauth-login')
}
</script>

<template>
  <Dialog v-model:open="openProxy">
    <DialogContent
      data-testid="provider-quick-setup"
      class="max-w-lg"
    >
      <DialogHeader>
        <DialogTitle>{{ t('settings.provider.builtinTemplate.setupTitle', { name: template.name }) }}</DialogTitle>
      </DialogHeader>

      <!-- 内置配置信息块（demo builtinInfo）。端点/协议按模板模型集聚合展示（M4/D5）：
           模板 provider 级 api/baseUrl 是构建期 artifact，禁止直接展示。 -->
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[12px]">
        <span class="text-neutral-dim">{{ t('settings.provider.builtinTemplate.infoBaseUrl') }}</span>
        <span class="truncate font-mono text-[11px] text-neutral-fg" data-testid="builtin-baseurl">{{ templateBaseUrlText }}</span>
        <span class="text-neutral-dim">{{ t('settings.provider.builtinTemplate.infoApi') }}</span>
        <span class="truncate text-neutral-fg" data-testid="builtin-api">{{ templateApiText }}</span>
        <!-- 推荐环境变量（demo envLine） -->
        <template v-if="template.envVars.length > 0">
          <span class="text-neutral-dim">{{ t('settings.provider.builtinTemplate.infoEnvVar') }}</span>
          <span class="truncate font-mono text-[11px] text-neutral-fg" data-testid="builtin-envvar">${{ template.envVars[0] }}</span>
        </template>
        <span class="text-neutral-dim">{{ t('settings.provider.builtinTemplate.infoModels') }}</span>
        <span data-testid="builtin-models">
          <code
            v-for="m in template.models.slice(0, 8)"
            :key="m.id"
            class="mr-1 rounded-sm bg-surface-hover px-1 py-0.5 font-mono text-[10px] text-neutral-mid"
          >{{ m.id }}</code>
          <span v-if="template.models.length > 8" class="text-[10px] text-neutral-dim">+{{ template.models.length - 8 }}</span>
        </span>
      </div>

      <!-- 认证方式（demo auth-options，radio 四选一） -->
      <div class="flex flex-col gap-2">
        <Label class="text-[11px] font-semibold uppercase tracking-wide text-neutral-mid">
          {{ t('settings.provider.builtinTemplate.credentialModeLabel') }}
        </Label>
        <div
          v-for="opt in authOptions"
          :key="opt.id"
          class="cursor-pointer rounded-md border px-3 py-2.5"
          :class="authMethod === opt.id
            ? 'border-accent bg-accent-soft'
            : 'border-border bg-bg-card hover:border-border-strong'"
          :data-testid="`auth-option-${opt.id}`"
          @click="authMethod = opt.id"
        >
          <div class="flex items-center gap-2">
            <span
              class="grid size-4 shrink-0 place-items-center rounded-full border-2"
              :class="authMethod === opt.id ? 'border-accent' : 'border-neutral-dim'"
            >
              <span v-if="authMethod === opt.id" class="size-2 rounded-full bg-accent"></span>
            </span>
            <span class="flex-1 text-[13px] font-medium text-neutral-fg">{{ t(`settings.provider.builtinTemplate.${opt.titleKey}`) }}</span>
            <span
              v-if="opt.rec"
              class="rounded-sm bg-accent px-1.5 py-0.5 text-[9px] font-semibold text-accent-fg"
            >{{ t('settings.provider.builtinTemplate.menuRecommended') }}</span>
          </div>

          <!-- 选项 body：仅选中时展开（demo ao-body） -->
          <div v-if="authMethod === opt.id" class="mt-2.5 pl-6">
            <!-- 明文：API Key 输入 + 显示切换 -->
            <div v-if="opt.id === 'plaintext'" class="flex items-center gap-2">
              <Input
                v-model="apiKeyInput"
                :type="showKey ? 'text' : 'password'"
                :placeholder="t('settings.providerEdit.apiKeyPlaceholderEmpty')"
                class="flex-1"
                data-testid="credential-apikey-input"
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
            </div>

            <!-- 环境变量：select（常见 env var + 自定义）+ 检测态 + 存盘预览 -->
            <template v-else-if="opt.id === 'env'">
              <Select v-model="envVar">
                <SelectTrigger data-testid="credential-envvar-select">
                  <SelectValue :placeholder="t('settings.provider.builtinTemplate.envVarPlaceholder')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="ev in template.envVars" :key="ev" :value="ev">
                    {{ ev }}
                  </SelectItem>
                  <SelectItem :value="CUSTOM_ENV_VALUE">
                    {{ t('settings.provider.builtinTemplate.envVarCustom') }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input
                v-if="envVar === CUSTOM_ENV_VALUE"
                v-model="customEnvVar"
                :placeholder="t('settings.provider.builtinTemplate.envVarCustomPlaceholder')"
                class="mt-1.5 h-8"
                data-testid="credential-envvar-custom"
              />
              <!-- 检测态（demo env-detected） -->
              <div
                v-if="envDetected !== undefined"
                class="mt-1.5 flex items-center gap-1.5 text-[11px]"
                :class="envDetected ? 'text-success' : 'text-warn'"
                data-testid="env-detected"
              >
                <Check v-if="envDetected" class="size-3.5" />
                <AlertCircle v-else class="size-3.5" />
                {{ envDetected
                  ? t('settings.provider.builtinTemplate.envDetected', { name: resolvedEnvVar })
                  : t('settings.provider.builtinTemplate.envNotSet', { name: resolvedEnvVar }) }}
              </div>
              <div class="mt-1.5 text-[10px] text-neutral-dim">
                {{ t('settings.provider.builtinTemplate.envStoredPreview', { value: `$${resolvedEnvVar || 'VAR'}` }) }}
              </div>
            </template>

            <!-- OAuth：登录按钮 / 已授权态 -->
            <div v-else-if="opt.id === 'oauth'" class="text-center">
              <div
                v-if="oauthAuthorized"
                class="flex items-center justify-center gap-1.5 text-[12px] font-medium text-success"
                data-testid="oauth-authorized"
              >
                <Check class="size-4" />
                {{ t('settings.provider.builtinTemplate.oauthAuthorized', { name: template.oauthName || template.name }) }}
              </div>
              <template v-else>
                <Button
                  size="dense"
                  data-testid="oauth-login-button"
                  @click="onOAuthLogin"
                >
                  {{ t('settings.provider.builtinTemplate.oauthLogin', { name: template.oauthName || template.name }) }}
                </Button>
                <p class="mt-1.5 text-[11px] text-neutral-dim">
                  {{ t('settings.provider.builtinTemplate.oauthHint', { name: template.oauthName || template.name }) }}
                </p>
              </template>
            </div>

            <!-- 云凭证：说明（demo ambient-box） -->
            <div v-else-if="opt.id === 'ambient'" class="flex items-center gap-1.5 text-[12px] text-neutral-mid" data-testid="credential-ambient">
              <Cloud class="size-4 shrink-0 text-neutral-dim" />
              {{ t('settings.provider.builtinTemplate.ambientHint') }}
            </div>
          </div>
        </div>
      </div>

      <!-- 底部操作区：footer hint + 取消/保存 -->
      <div class="flex items-center justify-end gap-2">
        <span class="mr-auto text-[11px] text-neutral-dim" data-testid="footer-hint">{{ footerHint }}</span>
        <Button variant="secondary" size="dense" @click="emit('cancel')">
          {{ t('settings.providerEdit.cancel') }}
        </Button>
        <Button
          size="dense"
          data-testid="provider-quick-setup-save"
          :disabled="saveDisabled"
          @click="onSave"
        >
          {{ t('settings.provider.builtinTemplate.save') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
