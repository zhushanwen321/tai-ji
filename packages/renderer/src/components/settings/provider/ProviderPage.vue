<template>
  <!--
    Settings · Provider 菜单页（v6 spec §6.4 R4：手风琴就地编辑，取代 ProviderEditModal 双层 modal）。
    行布局：状态点 → 启用开关 → 名称(点击展开就地编辑) → 默认pill → 模型数 → dirty 徽章 → 删除。
    展开体：ProviderEditBody（凭据/模型/验证/额度 + sticky save-bar）。
    dirty 守卫：展开行有未保存改动时，切换/收起/新建 → ConfirmDialog 二次确认。
  -->
  <div class="flex flex-col gap-3">
    <header class="mb-3 flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h1 class="text-[20px] font-semibold tracking-[-0.01em] text-neutral-fg">{{ t('settings.menu.provider') }}</h1>
        <p class="mt-2 text-sm text-neutral-mid">{{ t('settings.menu.providerDesc') }}</p>
      </div>
      <div class="flex shrink-0 gap-2">
        <ProviderImportMenu :disabled="importState !== 'idle'" @select="onImportSelect" />
        <!-- F2：入口聚合为「+ 添加供应商 ▾」菜单（内置模板（推荐）/ 自定义），自定义走 createAndExpand 原流程 -->
        <ProviderTemplatePicker
          :providers="builtinProviders"
          @select="onTemplateSelect"
          @custom="createAndExpand"
        />
      </div>
    </header>

    <!-- Scoped Model 配置区（模型白名单 + 有序列表） -->
    <ScopedModelSection
      :scoped-list="scopedRenderItems"
      :selectable-models="selectableModels"
      @add="onScopedAdd"
      @remove="onScopedRemove"
      @move="onScopedMove"
    />

    <!-- 常驻 inline error：toggle enabled / 设默认 / 删除 等动作失败时报错可见 -->
    <div
      v-if="actionError"
      data-testid="provider-action-error"
      class="flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-1.5 text-[11px] text-danger"
    >
      <AlertCircle class="size-3.5 shrink-0" />
      <span class="truncate">{{ actionError }}</span>
    </div>

    <!-- 空状态 -->
    <div v-if="!providers.length && expandedId !== NEW_ID" class="flex flex-col items-center gap-2 py-16 text-center">
      <div class="grid size-16 place-items-center rounded-full border-2 border-dashed border-border-strong">
        <Settings class="size-7 text-neutral-dim" />
      </div>
      <p class="text-[14px] font-medium text-neutral-fg">{{ t('settings.provider.emptyTitle') }}</p>
      <p class="text-[12px] text-neutral-mid">{{ t('settings.provider.emptyDesc') }}</p>
    </div>

    <!-- 实体列表（含新建态合成行）。组头对齐 ExtensionList 分组模式（小节标题 + count）：
         scoped-model 卡片与本列表同为 bg-card 卡片、仅 gap-3 分隔会视觉连片，组头拉开语义分界。 -->
    <section v-if="renderList.length" class="flex flex-col gap-3">
      <div data-testid="provider-list-header" class="flex items-center gap-2 pt-2">
        <h3 class="text-[12px] font-medium text-neutral-fg">{{ t('settings.provider.listTitle') }}</h3>
        <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-neutral-dim">{{ providers.length }}</span>
      </div>
      <div
        v-for="p in renderList"
        :key="p.id"
        data-testid="provider-card"
        class="overflow-hidden rounded-card bg-card"
      >
      <!-- 行头 -->
      <div class="flex min-w-0 items-center gap-3 px-4 py-3">
        <span
          v-if="p.id !== NEW_ID"
          class="size-[7px] shrink-0 rounded-full"
          :class="statusDot(p.status)"
        />

        <!-- 启用开关（名称左侧）。新建态无开关 -->
        <Switch
          v-if="p.id !== NEW_ID"
          :model-value="p.enabled"
          class="shrink-0"
          :disabled="toggling.has(p.id)"
          :aria-label="`${p.name} ${t('settings.provider.colEnabled')}`"
          @click.stop
          @update:model-value="onToggleEnabled(p, $event)"
        />

        <!-- 供应商名称（点击展开/收起就地编辑） -->
        <span
          class="flex-1 cursor-pointer truncate text-[13px] font-medium text-neutral-fg"
          role="button"
          :aria-expanded="expandedId === p.id"
          @click="toggleExpand(p.id)"
        >{{ p.id === NEW_ID ? t('settings.provider.newProvider') : p.name }}</span>

        <!-- 认证方式徽章（demo provider-auth-badge 三色，wave-list-badge） -->
        <span
          v-if="p.id !== NEW_ID"
          data-testid="provider-auth-badge"
          class="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium"
          :class="authBadgeClass(p)"
        >{{ t(`settings.provider.builtinTemplate.authBadge.${authBadgeTextKey(p)}`) }}</span>

        <!-- 默认供应商 pill（P2：可点击 → 弹模型选择，选中后 config.setDefaultModel） -->
        <ModelSelectPopover
          v-if="p.id !== NEW_ID && p.id === defaultProviderId"
          :selected="settingsStore.defaultModel.value"
          :provider-filter="[p.id]"
          @select="onSetDefaultModel"
        >
          <template #trigger>
            <PopoverTrigger as-child>
              <Button
                variant="ghost"
                class="h-auto shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent-soft"
                :title="t('panel.modelSelect.switchModel')"
                data-testid="provider-default-pill"
              >{{ t('settings.provider.defaultPill') }}</Button>
            </PopoverTrigger>
          </template>
        </ModelSelectPopover>

        <span v-if="p.id !== NEW_ID" class="shrink-0 text-[11px] text-neutral-dim">{{ t('settings.provider.modelsCount', { count: p.models.length }) }}</span>

        <!-- dirty 徽章（展开编辑且有未保存改动时） -->
        <span
          v-if="expandedId === p.id && currentBodyDirty"
          data-testid="provider-dirty-badge"
          class="flex shrink-0 items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn"
        >
          <span class="size-1.5 rounded-full bg-warn" />
          {{ t('settings.provider.unsavedBadge') }}
        </span>

        <span class="flex-1" />

        <!-- 删除按钮（wave4 TC5：title 按差异收窄——catalog=移除/custom=删除） -->
        <Button
          v-if="p.id !== NEW_ID"
          variant="ghost"
          class="size-6 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-danger-soft hover:text-danger [&_svg]:size-[13px]"
          :title="p.kind === 'catalog' ? t('settings.provider.removeTitle') : t('settings.provider.deleteTitle')"
          :data-testid="p.kind === 'catalog' ? 'provider-remove-btn' : 'provider-delete-btn'"
          @click.stop="deleteTarget = p"
        >
          <Trash2 />
        </Button>
      </div>

      <!-- 展开就地编辑体（R4）。B-1：OAuth 态经 props/事件接线（composable 内共享单实例 useProviderOAuth，无双 listener） -->
      <div v-if="expandedId === p.id" class="border-t border-border" data-testid="provider-expand-body">
        <ProviderEditBody
          :provider="p.id === NEW_ID ? null : p"
          :oauth-present="hasOauthPresence(p.id)"
          :oauth-supported="isOauthSupported(p.id)"
          @dirty-change="onBodyDirtyChange"
          @saved="onEditSaved"
          @cancel="onBodyCancel"
          @oauth-login="onEditOauthLogin(p)"
          @oauth-logout="onEditOauthLogout(p)"
        />
      </div>
    </div>
    </section>

    <!-- dirty 守卫确认弹窗（切换/收起/新建时拦截未保存改动） -->
    <ConfirmDialog
      v-model:open="guardDialogOpen"
      variant="default"
      :title="t('settings.provider.discardTitle')"
      :description="t('settings.provider.discardDesc')"
      :confirm-text="t('settings.provider.discardConfirm')"
      :cancel-text="t('settings.provider.discardCancel')"
      @confirm="confirmDiscard"
    />

    <!-- 删除/移除确认弹窗（wave4 TC5：文案按 kind 收窄——catalog=移除凭据/custom=删除配置） -->
    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      :variant="deleteTarget?.kind === 'catalog' ? 'default' : 'danger'"
      :title="deleteTarget?.kind === 'catalog'
        ? t('settings.provider.removeConfirmTitle', { name: deleteTarget?.name ?? '' })
        : t('settings.provider.deleteConfirmTitle', { name: deleteTarget?.name ?? '' })"
      :description="deleteTarget?.kind === 'catalog'
        ? t('settings.provider.removeConfirmDesc')
        : t('settings.provider.deleteConfirmDesc')"
      :confirm-text="deleteTarget?.kind === 'catalog'
        ? t('settings.provider.removeConfirmBtn')
        : t('settings.provider.deleteConfirmBtn')"
      :cancel-text="t('settings.providerEdit.cancel')"
      :loading="deleting"
      @confirm="confirmDelete"
    >
      <p v-if="actionError" class="pt-2 text-[12px] text-danger">{{ actionError }}</p>
    </ConfirmDialog>

    <!-- 导入预览弹窗（W2） -->
    <ProviderImportPreviewDialog
      :open="importState === 'previewing' || importState === 'applying'"
      :import-id="importId ?? undefined"
      :preview="importPreview"
      :loading="importState === 'applying'"
      :error="importError"
      @update:open="onPreviewDialogToggle"
      @confirm="onImportConfirm"
    />

    <!-- 内置模板快速配置（wave-quick-setup-c：radio 四选一 + OAuth + env 检测态） -->
    <ProviderQuickSetup
      v-if="selectedTemplate"
      :template="selectedTemplate"
      :open="showQuickSetup"
      :env-check="oauth.envCheck.value"
      :oauth-authorized="quickSetupOauthAuthorized"
      :existing-auth-method="existingAuthMethod"
      @save="onQuickSetupSave"
      @cancel="onQuickSetupCancel"
      @oauth-login="onQuickSetupOAuthLogin"
    />
    <!-- OAuth 授权对话框（wave-oauth-infra T7 产出，四态）。QuickSetup 与编辑体凭证区共用
         同一 useProviderOAuth 状态机（useProviderPageOauth 内单实例 → auth.* listener 不重复注册） -->
    <OAuthDialog
      v-if="oauthDialogInfo"
      :open="oauth.state.value.open"
      :provider="oauthDialogInfo"
      :status="oauth.state.value.status"
      :device-info="oauth.state.value.deviceInfo"
      :auth-url="oauth.state.value.authUrl"
      :error-message="oauth.state.value.errorMessage"
      @cancel="oauth.cancel"
      @retry="oauth.retry"
    />
    <!-- R4 手风琴就地编辑 -->
  </div>
</template>

<script setup lang="ts">
import { computed, ref, provide, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Settings, Trash2 } from '@lucide/vue'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PopoverTrigger } from '@/components/ui/popover'
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'
import type { BuiltinProviderTemplate, ProviderInfo, ProviderStatus, SetProviderData, ProviderId } from '@taiji/shared'
import { config } from '@/api'
import { getSettingsStore } from '@taiji/core'
import { useQuotaStore } from '@/stores/quota'
import { useProviderImport } from '@/composables/features/settings/useProviderImport'
import { useQuotaConfigure } from '@/composables/features/model/useQuotaConfigure'
import { useToast } from '@/composables/useToast'
import {
  ProviderEditBody,
  ProviderImportMenu,
  ProviderImportPreviewDialog,
  ProviderTemplatePicker,
  ProviderQuickSetup,
  OAuthDialog,
  ScopedModelSection,
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
} from '@taiji/ui/features/settings'
import { useProviderPageOauth } from '@/composables/features/settings/useProviderPageOauth'
import { useApiKeyAutoEnable } from '@/composables/features/settings/useApiKeyAutoEnable'
import { useAccordionGuard } from '@/composables/features/settings/useAccordionGuard'
import { useScopedModels } from '@/composables/features/settings/useScopedModels'
import { authBadgeClass, authBadgeTextKey } from './provider-badge'

// ui 包组件 renderer 侧依赖经 provide/inject 注入（ui 零 renderer import 铁律）
provide(USE_QUOTA_CONFIGURE_KEY, useQuotaConfigure)
const toast = useToast()
provide(SETTINGS_TOAST_KEY, toast)

// Scoped Models 白名单（乐观更新 + 失败回滚；RPC 失败 rethrow 由下方包装 handler 统一反馈）
const { scopedRenderItems, selectableModels, addScopedModels, removeScopedModel, moveScopedModel } = useScopedModels()

const props = defineProps<{ providers: ProviderInfo[] }>()

const { t } = useI18n()
const {
  importState,
  importId,
  importPreview,
  importError,
  onImportSelect,
  onImportConfirm,
  onPreviewDialogToggle,
} = useProviderImport()

// ── 内置 provider 模板（wave 3 builtin-provider-ui）──
const builtinProviders = ref<BuiltinProviderTemplate[]>([])
const selectedTemplate = ref<BuiltinProviderTemplate | null>(null)
const showQuickSetup = ref(false)

onMounted(async () => {
  try {
    builtinProviders.value = await config.listBuiltinProviders()
  } catch {
    // 拉取失败静默降级（Picker 渲染空列表），不阻断页面
    toast.error(t('settings.provider.builtinTemplate.fetchFailed'))
  }
  // 远程模型目录按需刷新：不阻塞页面（先展示缓存/快照），结果经 config.providers
  // 广播推回 store 自动更新。失败静默——离线/超时时列表保持原样。
  config.refreshProviderCatalogs().catch(() => {})
})

/** 选中内置模板 → 打开 QuickSetup（先刷新 OAuth presence + env 检测） */
async function onTemplateSelect(tpl: BuiltinProviderTemplate): Promise<void> {
  // MF-1 残余路径：打开前刷新 auth.json OAuth presence（has ? add : delete，MF-3）。
  // 必须在 selectedTemplate 设置之前完成——QuickSetup 表单 init 时（watch immediate）
  // existingAuthMethod/oauthAuthorized 需已就绪，否则已授权场景仍默认 env radio + 盲保存清凭据。
  await oauth.refreshOAuthPresence(tpl.id)
  selectedTemplate.value = tpl
  showQuickSetup.value = true
  await oauth.checkEnv(tpl)
}

/**
 * 已存配置的认证方式（MF-1 根治）：优先级 ① models.json 已存/推断 authMethod
 * ② auth.json 有 OAuth 凭据且无标注 → 'oauth'（未保存即关闭的授权/旧数据）
 * ③ undefined 走默认（env 推荐）。避免重开默认 env radio 盲保存误删 OAuth 凭据。
 */
const existingAuthMethod = computed(() => {
  const tpl = selectedTemplate.value
  if (!tpl) return undefined
  return props.providers.find(p => p.id === tpl.id)?.authMethod
    ?? (oauth.oauthPresent.value.has(tpl.id) ? ('oauth' as const) : undefined)
})

/** QuickSetup 保存 → config.setProvider（方案 B 占位 data），成功后关闭 + toast */
async function onQuickSetupSave({
  providerId,
  data,
}: {
  providerId: string
  data: SetProviderData
}): Promise<void> {
  try {
    await config.setProvider(providerId as ProviderId, data)
    showQuickSetup.value = false
    selectedTemplate.value = null
    // apikey 模式（plaintext 填值 / env '$VAR' 引用）保存后：被禁用的 provider 自动启用
    // （oauth/ambient 分支 data.apiKey 无值不触发；新建 runtime ensure 已启用 → no-op）
    await afterApiKeySave(providerId, Boolean(data.apiKey))
    toast.info(t('settings.provider.builtinTemplate.toastSuccess', { name: data.name ?? providerId }))
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

/** QuickSetup 取消/关闭 → 清空选中态；OAuth 登录按钮 → 启动 flow */
function onQuickSetupCancel(): void {
  showQuickSetup.value = false
  selectedTemplate.value = null
  oauth.envCheck.value = undefined
}

function onQuickSetupOAuthLogin(): void {
  if (!selectedTemplate.value) return
  startQuickSetupOauth(selectedTemplate.value)
}

const settingsStore = getSettingsStore()
const defaultProviderId = computed(() => settingsStore.defaultModel.value?.split('/')[0] ?? '')

// ── P2：默认模型自动修复 toast（任务 3）──
// runtime 在 setProvider/applyImportProviders/deleteProvider/toggleProviderEnabled 等 provider
// 变更后自动对账默认模型（reconcileDefaultModelAfterProviderChange + getDefaultModel 兜底）并广播
// config.defaults。前端消费广播：默认模型实际发生变化（非用户主动 default-set）时 toast 告知。
const lastDefaultModel = ref(settingsStore.defaultModel.value)
const unsubscribeDefaults = config.onDefaultsWithSource(({ defaultModel, source }) => {
  const prev = lastDefaultModel.value
  lastDefaultModel.value = defaultModel
  if (!defaultModel || defaultModel === prev || source === 'default-set') return
  toast.info(t('settings.provider.defaultAutoUpdated', { model: defaultModel }))
})
onUnmounted(unsubscribeDefaults)

/** P2：pill 点击选择默认模型 → config.setDefaultModel（状态经 onDefaults 广播推回，无需本地乐观更新） */
async function onSetDefaultModel({ modelId, provider }: { modelId: string; provider: ProviderId }): Promise<void> {
  actionError.value = ''
  try {
    await config.setDefaultModel(provider, modelId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    actionError.value = msg
    toast.error(msg)
  }
}

/** 新建态 sentinel id（渲染合成行 + null provider 进 ProviderEditBody） */
const NEW_ID = '__new__' as ProviderId

// 手风琴展开 + dirty 守卫（R4）。wave4 提取为 composable 减轻 script setup 行数压力。
const {
  expandedId,
  currentBodyDirty,
  guardDialogOpen,
  toggleExpand,
  createAndExpand,
  confirmDiscard,
  onBodyDirtyChange,
  onBodySaved,
  onBodyCancel,
} = useAccordionGuard(NEW_ID)

// ── OAuth 编排（B-1：QuickSetup 与编辑体凭证区共用单实例状态机，提取见 useProviderPageOauth）──
const {
  oauth,
  isOauthSupported,
  hasOauthPresence,
  quickSetupOauthAuthorized,
  oauthDialogInfo,
  onEditOauthLogin,
  onEditOauthLogout,
  onQuickSetupOauthLogin: startQuickSetupOauth,
} = useProviderPageOauth({
  builtinProviders,
  providers: computed(() => props.providers),
  selectedTemplate,
  expandedId,
  newId: NEW_ID,
})

/** 删除目标 + 删除中 */
const deleteTarget = ref<ProviderInfo | null>(null)
const deleting = ref(false)
const deleteDialogOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (open: boolean) => {
    if (!open) deleteTarget.value = null
  },
})

/** 动作错误（删除/启用失败时显示，非静默吞） */
const actionError = ref('')

// ── scoped 模型操作接线（失败反馈：模型选择类操作，对齐 onSetDefaultModel 惯例 = 常驻 inline error + toast）──
// useScopedModels 乐观更新 + 回滚后 rethrow，此处统一捕获展示，不让 RPC 失败静默吞掉。

async function runScopedAction(action: () => Promise<void>): Promise<void> {
  actionError.value = ''
  try {
    await action()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    actionError.value = msg
    toast.error(msg)
  }
}

function onScopedAdd(models: string[]): void {
  void runScopedAction(() => addScopedModels(models))
}

function onScopedRemove(scoped: string): void {
  void runScopedAction(() => removeScopedModel(scoped))
}

function onScopedMove({ scoped, dir }: { scoped: string; dir: 'up' | 'down' }): void {
  void runScopedAction(() => moveScopedModel(scoped, dir))
}

// ── 渲染列表：真实 providers + 新建态合成行 ──

const NEW_PROVIDER_SENTINEL: ProviderInfo = {
  id: NEW_ID,
  name: '',
  apiKeySet: false,
  status: 'not_configured',
  models: [],
}

const renderList = computed<ProviderInfo[]>(() => {
  return expandedId.value === NEW_ID
    ? [...props.providers, NEW_PROVIDER_SENTINEL]
    : props.providers
})

// ── 启用开关：乐观更新 store + config.toggleProviderEnabled 持久化（wave4 C1）──
// 链路收编进 useApiKeyAutoEnable（含「apikey 配置完自动启用」增强），template 解构同名不变。

const { toggling, onToggleEnabled, afterApiKeySave } = useApiKeyAutoEnable({
  providers: () => props.providers,
  setActionError: msg => { actionError.value = msg },
})

/** 编辑体保存成功 → 收起展开行；本次写入了 apikey 且该 provider 被禁用 → 自动启用（afterApiKeySave） */
async function onEditSaved(payload?: { wroteApiKey: boolean }): Promise<void> {
  const savedId = expandedId.value
  onBodySaved()
  if (payload?.wroteApiKey && savedId) await afterApiKeySave(savedId, true)
}

// ── 删除/移除（wave4 IF3：按 ProviderInfo.kind 走 removeProviderByKind） ──

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  actionError.value = ''
  try {
    // wave4：按 kind 调 removeProviderByKind（catalog 清凭据/custom 删条目）。
    // kind 缺失兼容 'custom'（wave2 聚合层保证 listProviders 返回的 ProviderInfo 已标 kind）。
    await config.removeProviderByKind(target.id, target.kind ?? 'custom')
    // MF-3：同步清理 oauth 内存态（runtime 已清 auth.json 凭据），防重开 QuickSetup 误默认 oauth。
    oauth.clearOAuthPresence(target.id)
    if (settingsStore.defaultModel.value.startsWith(`${target.id}/`)) {
      settingsStore.defaultModel.value = ''
    }
    useQuotaStore().clearCache(target.id)
    deleteTarget.value = null
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}

function statusDot(status: ProviderStatus): string {
  const map = { connected: 'bg-success', not_configured: 'bg-neutral-dim', error: 'bg-danger' }
  return map[status]
}
</script>

