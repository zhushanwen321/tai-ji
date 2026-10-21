<template>
  <!--
    Settings · Provider 菜单页（v6 spec §6.4 R4：手风琴就地编辑，取代 ProviderEditModal 双层 modal）。
    行布局：状态点 → 启用开关 → 名称(点击展开就地编辑) → 默认pill → 模型数 → dirty 徽章 → 删除。
    展开体：ProviderEditBody（凭据/模型/验证/额度 + sticky save-bar）。
    dirty 检查：展开行有未保存改动时，切换/收起/新建 → ConfirmDialog 二次确认。
  -->
  <!-- 垂直节奏 = demo .gcard+.gcard 唯一 16px 档：根容器无 gap（对齐 AppearancePage 形态），
       页头→首卡 16px 由共享 .page-head margin-bottom 承担；GroupCard 相邻 16px 由
       GroupCard 自带 .group-card + .group-card 规则承担；非卡片兄弟块（inline error /
       空状态 / 列表 section）各自 mt-[16px]（rem gap 类在 14px html 基准下收缩为 demo 值
       的 87.5%，本页全部槽位走绝对 px）。 -->
  <div class="flex flex-col">
    <!-- 页头（.page-head 形态与入口细节见 ProviderPageHeader.vue）：标题 + 导入/模板/羊毛三入口 + 目录过期提示 -->
    <ProviderPageHeader
      :import-disabled="importState !== 'idle'"
      :builtin-providers="builtinProviders"
      :catalogs-stale="catalogsStale"
      @import-select="onImportSelect"
      @template-select="onTemplateSelect"
      @custom="createAndExpand"
      @open-wool="woolEntries.wizardOpen.value = true"
    />

    <!-- Scoped Model 配置区（模型白名单 + 有序列表）。容器 = GroupCard（demo .gcard 卡底
         --bg-card #2d2d30 / r-card / overflow: clip，与下方供应商列表卡同原语）。注意 clip 是
         ProviderEditBody sticky save-bar 生效的前提（hidden 会建立滚动容器，使 sticky 参照
         卡片自身而失效），改 GroupCard overflow 前先读 ProviderEditBody save-bar 注释。白名单
         标题/描述/添加钮由 ScopedModelSection 自带头承载（i18n 文案与 demo gc-title/gc-sub 一致）；
         其卡头形态差异（--card-head 底 / padding 10-16）= w1 交接项 1 归 ui 包波次，本层不动。
         注：ScopedModelSection 根上的 bg-bg-card 与本层 GroupCard 卡底同变量（--bg-card）同色，
         无叠底冲突。 -->
    <GroupCard>
      <ScopedModelSection
        :scoped-list="scopedRenderItems"
        :selectable-models="selectableModels"
        @add="onScopedAdd"
        @remove="onScopedRemove"
        @move="onScopedMove"
      />
    </GroupCard>

    <!-- 常驻 inline error：toggle enabled / 设默认 / 删除 等动作失败时报错可见 -->
    <div
      v-if="actionError"
      data-testid="provider-action-error"
      class="mt-[16px] flex items-center gap-1.5 rounded-md border border-[color-mix(in_oklch,var(--danger)_30%,transparent)] bg-danger-soft px-3 py-1.5 text-[length:var(--text-2xs)] text-danger"
    >
      <AlertCircle class="size-3.5 shrink-0" />
      <span class="truncate">{{ actionError }}</span>
    </div>

    <!-- 空状态（demo .pg-set .empty 形态：64px 虚线圆 ring + 14px/600 标题 + 13px mid 描述） -->
    <div v-if="!providers.length && expandedId !== NEW_ID" class="mt-[16px] flex flex-col items-center px-[16px] py-[40px] text-center">
      <div class="mb-[12px] grid size-16 place-items-center rounded-full border-[1.5px] border-dashed border-border-strong">
        <Settings class="size-[26px] text-neutral-mid" />
      </div>
      <p class="text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ t('settings.provider.emptyTitle') }}</p>
      <p class="mt-[6px] text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.provider.emptyDesc') }}</p>
    </div>

    <!-- 实体列表（含新建态合成行）。demo .gcard 形态：GroupCard（gc-title 卡头 + bdg 计数徽标），
         行 = .prow（bg-surface 8px 圆角内嵌行，行间 8px）。section 包裹使 .group-card+.group-card
         相邻选择器不命中，卡间 16px 由本层 mt-[16px] 承担。 -->
    <section v-if="renderList.length" class="mt-[16px]">
      <GroupCard>
        <template #head>
          <div data-testid="provider-list-header" class="gc-head-text">
            <h3 class="gc-title">{{ t('settings.provider.listTitle') }}</h3>
          </div>
        </template>
        <template #actions>
          <!-- demo .bdg：h16 / bg-surface / mono / 10px / fw-bold / neutral-fg-2 -->
          <span class="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-surface px-[5px] font-mono text-[length:var(--text-3xs)] font-bold text-[color:var(--neutral-fg-2)]">{{ providers.length }}</span>
        </template>
        <div class="flex flex-col gap-[8px] p-[12px_16px]">
        <!-- 行卡（demo .prow 形态与展开体细节见 ProviderRowCard.vue）：父侧下发每行受控态，
             动作经事件上抛回本页编排（乐观更新 / 手风琴 guard / OAuth 状态机均在本页单实例） -->
        <ProviderRowCard
          v-for="p in renderList"
          :key="p.id"
          :provider="p"
          :is-new="p.id === NEW_ID"
          :expanded="expandedId === p.id"
          :dirty="currentBodyDirty"
          :is-default="p.id === defaultProviderId"
          :default-model="settingsStore.defaultModel.value"
          :toggling="toggling.has(p.id)"
          :oauth-present="oauthPresenceStatus(p.id)"
          :oauth-supported="isOauthSupported(p.id)"
          @toggle="toggleExpand"
          @toggle-enabled="onToggleEnabled(p, $event)"
          @set-default="onSetDefaultModel"
          @remove="deleteTarget = $event"
          @dirty-change="onBodyDirtyChange"
          @saved="onEditSaved"
          @cancel="onBodyCancel"
          @oauth-login="onEditOauthLogin(p)"
          @oauth-logout="onEditOauthLogout(p)"
        />
        </div>
      </GroupCard>
    </section>

    <!-- 羊毛条目区（wool-provider D6 ③：已接入家族；数据 = wool 快照，不进 config.providers——S9 零回归） -->
    <section v-if="woolEntries.adoptedFamilies.value.length" class="mt-[16px]">
      <GroupCard>
        <template #head>
          <div data-testid="wool-entries-header" class="gc-head-text">
            <h3 class="gc-title">{{ t('wool.listTitle') }}</h3>
          </div>
        </template>
        <div class="flex flex-col gap-[8px] p-[12px_16px]">
          <WoolEntryCard
            v-for="f in woolEntries.adoptedFamilies.value"
            :key="f.family"
            :family="f"
            :refreshing="woolEntries.runningActions.value.has(f.family)"
            :checkin-running="woolEntries.runningActions.value.has(f.family)"
            @refresh="woolEntries.refreshEntry(f.family)"
            @checkin="woolEntries.checkin(f.family)"
          />
        </div>
      </GroupCard>
    </section>

    <!-- 羊毛接入向导（D6 ①/D7 两族模板） -->
    <WoolWizard v-model:open="woolEntries.wizardOpen.value" />

    <!-- dirty 检查确认弹窗（切换/收起/新建时拦截未保存改动） -->
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
      <p v-if="actionError" class="pt-2 text-[length:var(--text-xs)] text-danger">{{ actionError }}</p>
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
         同一 useProviderOAuth 状态机（ProviderPage 单实例 → auth.* listener 不重复注册） -->
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
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Settings } from '@lucide/vue'
import { useProviderCatalogsStale } from '@/composables/features/settings/useProviderCatalogsStale'
import { ConfirmDialog } from '@/components/ui/dialog'
import type { BuiltinProviderTemplate, ProviderInfo, SetProviderData, ProviderId } from '@taiji/shared'
import { getSettingsStore, getSettingsTransport } from '@taiji/core'
import { useQuotaStore } from '@/stores/quota'
import { useProviderImport } from '@/composables/features/settings/useProviderImport'
import { useToast } from '@/composables/useToast'
import {
  GroupCard,
  ProviderImportPreviewDialog,
  ProviderQuickSetup,
  OAuthDialog,
  ScopedModelSection,
} from '@taiji/ui/features/settings'
import { useProviderOAuth } from '@/composables/features/settings/useProviderOAuth'
import { useApiKeyAutoEnable } from '@/composables/features/settings/useApiKeyAutoEnable'
import { useQuotaAutoEnableNotice } from '@/composables/features/settings/useQuotaAutoEnableNotice'
import { useAccordionGuard } from '@/composables/features/settings/useAccordionGuard'
import { useScopedModels } from '@/composables/features/settings/useScopedModels'
import { useWoolEntries } from '@/composables/features/settings/useWoolEntries'
import { WoolEntryCard, WoolWizard } from './WoolWizard'
import ProviderPageHeader from './ProviderPageHeader.vue'
import ProviderRowCard from './ProviderRowCard.vue'

// ui 包组件 renderer 侧依赖由 AppShell 级 useSettingsShell 统一 provide（SETTINGS_TOAST_KEY /
// QUOTA_CONFIGURE_FACTORY_KEY 已在壳层注入 SettingsModal 全子树，此处不再组件级重复 provide）
const toast = useToast()
// [C3] settings 域 transport 只经 SettingsTransport seam（禁直连 @/api 门面 / 禁深 import transport 域）
const transport = getSettingsTransport()

// Scoped Models 白名单（乐观更新 + 失败回滚；RPC 失败 rethrow 由下方包装 handler 统一反馈）
const { scopedRenderItems, selectableModels, addScopedModels, removeScopedModel, moveScopedModel } = useScopedModels()

const woolEntries = useWoolEntries() // 羊毛条目区编排（D6 ③；快照数据在 useWool 单例）
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

// RD-4#10：远程模型目录陈旧标记（refreshProviderCatalogs failed[] / reject → 「目录可能过期」）
const { catalogsStale, refreshCatalogs } = useProviderCatalogsStale()

onMounted(async () => {
  try {
    builtinProviders.value = await transport.listBuiltinProviders()
  } catch {
    // 拉取失败静默降级（Picker 渲染空列表），不阻断页面
    toast.error(t('settings.provider.builtinTemplate.fetchFailed'))
  }
  // 远程模型目录按需刷新：不阻塞页面（先展示缓存/快照），结果经 config.providers
  // 广播推回 store 自动更新。RD-4#10 的陈旧判据（failed[] / transport reject）见
  // composables/features/settings/useProviderCatalogsStale.ts。
  await refreshCatalogs()
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

/** QuickSetup 保存 → SettingsTransport.setProvider（[C3] 与编辑体保存合流同一 seam 方法），成功后关闭 + toast */
async function onQuickSetupSave({
  providerId,
  data,
}: {
  providerId: string
  data: SetProviderData
}): Promise<void> {
  try {
    const res = await transport.setProvider(providerId, data)
    showQuickSetup.value = false
    selectedTemplate.value = null
    // apikey 模式（plaintext 填值 / env '$VAR' 引用）保存后：被禁用的 provider 自动启用
    // （oauth/ambient 分支 data.apiKey 无值不触发；新建 runtime ensure 已启用 → no-op）
    await afterApiKeySave(providerId, Boolean(data.apiKey))
    toast.info(t('settings.provider.builtinTemplate.toastSuccess', { name: data.name ?? providerId }))
    notifyQuotaAutoEnabled(res?.quotaAutoEnabled, data.name ?? providerId)
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
const unsubscribeDefaults = transport.onDefaultsWithSource(({ defaultModel, source }) => {
  const prev = lastDefaultModel.value
  lastDefaultModel.value = defaultModel
  if (!defaultModel || defaultModel === prev || source === 'default-set') return
  toast.info(t('settings.provider.defaultAutoUpdated', { model: defaultModel }))
})
onUnmounted(unsubscribeDefaults)

/** P2：pill 点击选择默认模型 → setDefaultModel（状态经 onDefaults 广播推回，无需本地乐观更新） */
async function onSetDefaultModel({ modelId, provider }: { modelId: string; provider: ProviderId }): Promise<void> {
  actionError.value = ''
  try {
    await transport.setDefaultModel(provider, modelId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    actionError.value = msg
    toast.error(msg)
  }
}

/** 新建态 sentinel id（渲染合成行 + null provider 进 ProviderEditBody） */
const NEW_ID = '__new__' as ProviderId

// 手风琴展开 + dirty 检查（R4）。wave4 提取为 composable 减轻 script setup 行数压力。
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

// ── OAuth 编排（B-1：QuickSetup 与编辑体凭证区共用单实例状态机，[C4·尾项] 合并后单 module）──
const oauth = useProviderOAuth({
  builtinProviders,
  providers: computed(() => props.providers),
  selectedTemplate,
  expandedId,
  newId: NEW_ID,
})
const {
  isOauthSupported,
  oauthPresenceStatus,
  quickSetupOauthAuthorized,
  oauthDialogInfo,
  onEditOauthLogin,
  onEditOauthLogout,
  onQuickSetupOauthLogin: startQuickSetupOauth,
} = oauth

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
const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()

/** 编辑体保存成功 → 收起展开行；本次写入了 apikey 且该 provider 被禁用 → 自动启用（afterApiKeySave）；
 * 新建分支额度显示自动开启写成功 → toast（useQuotaAutoEnableNotice，与 QuickSetup 路径同语义） */
async function onEditSaved(payload?: { wroteApiKey: boolean; quotaAutoEnabled?: boolean }): Promise<void> {
  const savedId = expandedId.value
  onBodySaved()
  if (payload?.wroteApiKey && savedId) await afterApiKeySave(savedId, true)
  notifyQuotaAutoEnabled(payload?.quotaAutoEnabled, savedId ? (props.providers.find(p => p.id === savedId)?.name ?? savedId) : undefined)
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
    await transport.removeProviderByKind(target.id, target.kind ?? 'custom')
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
</script>

