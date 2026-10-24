<template>
  <!--
    插件 Provider 接入流程（provider-plugin-access 设计 U6 / D1/D2/D3/D5）。
    三段视图（显式 phase 状态机：family → confirm → authorize）：
      ① family 家族卡网格：清单 family 条目（名称/厂商/授权方式/模型数/安装状态），S1；
      ② confirm 安装确认卡：preparePluginInstall 回包的知情面全量展示
        （capabilities/readPaths 逐项），展示物 = 暂存解压物 manifest（同源），S27——
        确认前不发生安装落盘（取消/关闭 = cancelPluginInstall 清暂存）；
      ③ authorize 授权挂载位容器：ViewHost(global:provider.authorize) 渲染插件推的树，
         重新授权复用同一挂载位（D5，focus intent=authorize 直达本段）。
  -->
  <Dialog :open="open" @update:open="onDialogToggle">
    <DialogContent data-testid="plugin-provider-flow" class="max-w-[720px]">
      <DialogHeader>
        <DialogTitle>{{ dialogTitle }}</DialogTitle>
        <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ dialogSubtitle }}</p>
      </DialogHeader>

      <!-- ① 家族卡网格 -->
      <div v-if="phase === 'family'" data-testid="plugin-family-grid" class="flex flex-col gap-2">
        <p
          v-if="flowError"
          data-testid="plugin-flow-error"
          class="text-[length:var(--text-xs)] text-danger"
        >{{ flowError }}</p>
        <div
          v-for="entry in familyEntries"
          :key="entry.pluginId"
          data-testid="plugin-family-card"
          class="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-bg-card p-3 hover:border-accent hover:bg-surface-2"
          role="button"
          :aria-label="entry.family?.displayName"
          @click="onFamilySelect(entry)"
        >
          <span
            class="grid size-9 shrink-0 place-items-center rounded-sm bg-accent text-[length:var(--text-base)] font-bold text-accent-fg"
          >{{ familyAvatarChar(entry) }}</span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="truncate text-[length:var(--text-sm)] font-semibold text-neutral-fg">{{ entry.family?.displayName }}</span>
              <span class="shrink-0 text-[length:var(--text-3xs)] text-neutral-mid">{{ entry.family?.vendor }}</span>
              <span
                v-if="entry.installed"
                data-testid="plugin-family-installed"
                class="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] font-medium text-accent"
              >{{ t('pluginProvider.flow.installedBadge') }}</span>
            </span>
            <span class="mt-0.5 flex items-center gap-2 text-[length:var(--text-3xs)] text-neutral-mid">
              <span>{{ credentialSourceLabel(entry.family?.credentialSource) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ t('pluginProvider.flow.modelCount', { count: entry.family?.modelCount ?? 0 }) }}</span>
              <span
                v-if="entry.updateAvailable"
                data-testid="plugin-family-update-badge"
                class="rounded-sm bg-warn-soft px-1.5 py-0.5 font-medium text-warn"
              >{{ t('pluginProvider.flow.updateBadge') }}</span>
            </span>
          </span>
          <!-- 未装家族的显式安装引导（失败路径表：家族卡显示「需要先安装插件」） -->
          <span
            v-if="!entry.installed"
            class="shrink-0 rounded-sm bg-surface-hover px-2 py-1 text-[length:var(--text-3xs)] text-neutral-mid"
          >{{ t('pluginProvider.flow.installHint') }}</span>
        </div>

        <!-- 清单空/失败态（S15 语义：runtime fail-safe 链已降级，宿主呈现重试入口） -->
        <div
          v-if="!familyEntries.length"
          data-testid="plugin-family-empty"
          class="flex flex-col items-center gap-2 px-2 py-8 text-center"
        >
          <p class="text-[length:var(--text-sm)] text-neutral-mid">
            {{ source.catalogLoaded.value ? t('pluginProvider.flow.emptyCatalog') : t('pluginProvider.flow.catalogLoading') }}
          </p>
          <Button
            variant="ghost"
            size="sm"
            data-testid="plugin-catalog-retry"
            :disabled="catalogRefreshing"
            @click="onRetryCatalog"
          >{{ t('pluginProvider.flow.retry') }}</Button>
        </div>

        <!-- 包名直装（D3/S27 第二路径：清单是发现通道不是白名单，用户可直接输入包名安装；
             与家族卡同一确认停点——确认卡全量展示 capabilities/readPaths） -->
        <div class="mt-1 flex items-center gap-2 border-t border-hairline pt-3">
          <Input
            v-model="directSpec"
            data-testid="plugin-direct-spec"
            :placeholder="t('pluginProvider.flow.directInstallPlaceholder')"
            class="h-8"
            @keyup.enter="onDirectInstall"
          />
          <Button
            variant="secondary"
            data-testid="plugin-direct-install-btn"
            :disabled="directSpec.trim() === '' || catalogRefreshing"
            @click="onDirectInstall"
          >{{ t('pluginProvider.flow.directInstallBtn') }}</Button>
        </div>
      </div>

      <!-- ② 安装确认卡（prepare 成功、停在确认停点；S27 知情面） -->
      <div v-else-if="phase === 'confirm' && installPreview" data-testid="plugin-install-confirm" class="flex flex-col gap-3">
        <p class="text-[length:var(--text-sm)] text-neutral-fg">
          {{ installIntent === 'update' ? t('pluginProvider.flow.confirmUpdateDesc') : t('pluginProvider.flow.confirmInstallDesc') }}
          <span class="font-mono text-[length:var(--text-xs)]">{{ installPreview.packageName }}@{{ installPreview.version }}</span>
        </p>
        <div class="flex flex-col gap-2 rounded-md bg-surface p-3">
          <PluginConfirmField
            :label="t('pluginProvider.flow.capabilitiesLabel')"
            :items="installPreview.capabilities"
            :empty-label="t('pluginProvider.flow.noneDeclared')"
            test-id="plugin-confirm-capabilities"
          />
          <PluginConfirmField
            :label="t('pluginProvider.flow.readPathsLabel')"
            :items="installPreview.readPaths"
            :empty-label="t('pluginProvider.flow.noneDeclared')"
            test-id="plugin-confirm-read-paths"
          />
          <PluginConfirmField
            v-if="installPreview.permissions.length"
            :label="t('pluginProvider.flow.permissionsLabel')"
            :items="installPreview.permissions"
            :empty-label="t('pluginProvider.flow.noneDeclared')"
            test-id="plugin-confirm-permissions"
          />
        </div>
        <p class="text-[length:var(--text-3xs)] text-neutral-mid">{{ t('pluginProvider.flow.confirmHint') }}</p>
        <p
          v-if="flowError"
          data-testid="plugin-install-error"
          class="text-[length:var(--text-xs)] text-danger"
        >{{ flowError }}</p>
        <div class="flex justify-end gap-2">
          <Button
            variant="ghost"
            data-testid="plugin-install-cancel"
            :disabled="confirming"
            @click="onInstallCancel"
          >{{ t('pluginProvider.flow.cancel') }}</Button>
          <Button
            variant="default"
            data-testid="plugin-install-confirm-btn"
            :disabled="confirming"
            @click="onInstallConfirm"
          >{{ installIntent === 'update' ? t('pluginProvider.flow.confirmUpdate') : t('pluginProvider.flow.confirmInstall') }}</Button>
        </div>
      </div>

      <!-- ③ 授权挂载位容器（插件渲染区：宿主仅提供容器，D2） -->
      <div v-else-if="phase === 'authorize' && pendingAuthorizePluginId" data-testid="plugin-authorize-container" class="flex min-h-[240px] flex-col">
        <ViewHost
          :scope="{ kind: 'global', mountId: AUTHORIZE_MOUNT_ID, pluginId: pendingAuthorizePluginId }"
          :view-id="AUTHORIZE_VIEW_ID"
          :title="authorizeTitle"
          empty="placeholder"
        />
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * PluginProviderFlow —— 家族卡 + 授权挂载位容器 + 安装引导 + 安装确认卡（U6）。
 *
 * 安装通路（两段式，U4/U6）：经 resolvePluginInstallPort 消费 SettingsTransport 的
 * 三方法（preparePluginInstall / confirmPluginInstall / cancelPluginInstall）——
 * adapter 直连 plugin domain，WS 帧转发 runtime 两段式编排；确认停点对接本组件
 * 确认卡（S27：capabilities/readPaths 全量展示，未确认不落盘）。
 */
import { computed, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
} from '@taiji/ui'
import { ViewHost } from '@taiji/ui/extension-host'
import { UI_EVENT_SENDER_KEY } from '@taiji/ui/rendering-protocol'
import {
  createPluginUiEventSender,
  resolvePluginInstallPort,
  usePluginProviderSource,
  type PluginCatalogItem,
  type PluginFlowFocus,
  type PluginInstallPreview,
} from './PluginProviderSource'
import PluginConfirmField from './PluginConfirmField.vue'

/** 授权挂载位 id（core bootstrap 注册 + 本组件消费，同字面量即约定）。 */
const AUTHORIZE_MOUNT_ID = 'provider.authorize'
/** 授权主视图 viewId 约定 = 挂载位 id（插件推树时用同名 viewId；跨仓契约）。 */
const AUTHORIZE_VIEW_ID = AUTHORIZE_MOUNT_ID

const props = defineProps<{
  open: boolean
  /** 焦点家族（ProviderRowCard 的重新授权/更新入口；缺省 = 家族选择段起步） */
  focus?: PluginFlowFocus
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
}>()

const { t } = useI18n()
const source = usePluginProviderSource()

/** 流程段状态机（family 家族选择 / confirm 安装确认停点 / authorize 授权挂载位）。 */
type FlowPhase = 'family' | 'confirm' | 'authorize'
const phase = ref<FlowPhase>('family')
/** 确认卡知情面（preparePluginInstall 回包；非 null = 停在确认停点）。 */
const installPreview = ref<PluginInstallPreview | null>(null)
/** 确认卡意图（全新安装 / 已装家族更新——文案与确认按钮差异）。 */
const installIntent = ref<'install' | 'update'>('install')
/** 当前段错误（family 段 = 清单/通路错误；confirm 段 = prepare/confirm 失败）。 */
const flowError = ref('')
const confirming = ref(false)
const catalogRefreshing = ref(false)
/** 包名直装输入（S27 第二路径：清单是发现通道，用户可直接输入包名） */
const directSpec = ref('')

/** 家族条目（清单 family 非空者——Provider 来源插件的家族卡数据）。 */
const familyEntries = computed(() => source.catalog.value.filter((e) => e.family !== undefined))

const dialogTitle = computed(() => {
  if (phase.value === 'confirm') {
    return installIntent.value === 'update' ? t('pluginProvider.flow.updateTitle') : t('pluginProvider.flow.installTitle')
  }
  if (phase.value === 'authorize' && pendingAuthorizePluginId.value !== null) {
    return props.focus?.intent === 'update'
      ? t('pluginProvider.flow.updateTitle')
      : t('pluginProvider.flow.authorizeTitle', { name: authorizeTitle.value })
  }
  return t('pluginProvider.flow.title')
})

const dialogSubtitle = computed(() => {
  if (phase.value === 'confirm') return t('pluginProvider.flow.installSubtitle')
  if (phase.value === 'authorize') return t('pluginProvider.flow.authorizeSubtitle')
  return t('pluginProvider.flow.subtitle')
})

/** 授权段的目标插件 id（清单刷新后回读最新条目；包名直装可能不在清单内）。 */
const pendingAuthorizePluginId = ref<string | null>(null)

/** 授权段的清单条目（缺失 = 直装包未进清单，标题回落 pluginId）。 */
const authorizeEntry = computed<PluginCatalogItem | undefined>(() => {
  const pluginId = pendingAuthorizePluginId.value
  if (pluginId === null) return undefined
  return source.catalog.value.find((e) => e.pluginId === pluginId)
})

const authorizeTitle = computed<string>(() =>
  authorizeEntry.value?.family?.displayName ?? pendingAuthorizePluginId.value ?? '',
)

// text-input 值回传出口（D8/S7）：挂载位容器同时掌握 pluginId + viewId，故在此 provide；
// 原语只报 (componentId, event, value)。插件侧始终持有最新值（fire-and-forget）。
provide(UI_EVENT_SENDER_KEY, createPluginUiEventSender(() => pendingAuthorizePluginId.value, AUTHORIZE_VIEW_ID))

watch(() => props.open, (open) => {
  if (!open) {
    resetFlow()
    return
  }
  void enterFlow()
}, { immediate: true })

/** 打开：拉清单 → 有焦点则直达（authorize 直进挂载位容器；update 直进确认卡）。 */
async function enterFlow(): Promise<void> {
  flowError.value = ''
  catalogRefreshing.value = true
  try {
    await source.refreshCatalog()
  } finally {
    catalogRefreshing.value = false
  }
  const focus = props.focus
  if (!focus) return
  const entry = source.catalog.value.find((e) => e.pluginId === focus.pluginId)
  if (entry === undefined) {
    flowError.value = t('pluginProvider.flow.focusMissing')
    return
  }
  if (focus.intent === 'authorize') {
    pendingAuthorizePluginId.value = entry.pluginId
    phase.value = 'authorize'
    return
  }
  // update 意图：直达确认卡（安装链与首次安装同构，文案按 update 差异化）
  await beginInstall(entry.packageName, 'update')
}

/** 关闭/重开复位：确认停点残留的暂存交 cancelPluginInstall 清理（S27 未确认不落盘）。 */
function resetFlow(): void {
  if (installPreview.value !== null) {
    resolvePluginInstallPort()?.cancelPluginInstall(installPreview.value.pluginId).catch((e: unknown) => {
      console.warn('[plugin-provider-flow] cancelPluginInstall on close failed:', e)
    })
  }
  phase.value = 'family'
  installPreview.value = null
  pendingAuthorizePluginId.value = null
  directSpec.value = ''
  flowError.value = ''
}

function onRetryCatalog(): void {
  catalogRefreshing.value = true
  void source.refreshCatalog().finally(() => { catalogRefreshing.value = false })
}

function credentialSourceLabel(credentialSource: NonNullable<PluginCatalogItem['family']>['credentialSource'] | undefined): string {
  return credentialSource === 'oauth' ? t('pluginProvider.flow.credentialOauth') : t('pluginProvider.flow.credentialExtract')
}

function familyAvatarChar(entry: PluginCatalogItem): string {
  return (entry.family?.displayName ?? entry.pluginId).charAt(0).toUpperCase()
}

/** 家族卡点击：已装 → 授权容器；未装 → 安装段（确认卡）。 */
function onFamilySelect(entry: PluginCatalogItem): void {
  if (entry.installed) {
    pendingAuthorizePluginId.value = entry.pluginId
    phase.value = 'authorize'
    return
  }
  void beginInstall(entry.packageName, 'install')
}

/** 包名直装（S27 第二路径）：与家族卡共用确认停点。 */
function onDirectInstall(): void {
  const spec = directSpec.value.trim()
  if (spec === '') return
  void beginInstall(spec, 'install')
}

/** prepare → 确认卡（成功）或 family 段错误提示（失败/通路未就绪）。 */
async function beginInstall(packageSpec: string, intent: 'install' | 'update'): Promise<void> {
  installIntent.value = intent
  flowError.value = ''
  const port = resolvePluginInstallPort()
  if (port === null) {
    flowError.value = t('pluginProvider.flow.channelUnavailable')
    return
  }
  try {
    installPreview.value = await port.preparePluginInstall(packageSpec)
    phase.value = 'confirm'
  } catch (e) {
    // prepare 失败（下载/校验/NAMESPACE_MISMATCH）：错误可见 + 不进确认卡（暂存由
    // runtime prepare 失败路径自清，S18）
    flowError.value = e instanceof Error ? e.message : String(e)
    installPreview.value = null
    phase.value = 'family'
  }
}

/** 确认安装/更新：提交落盘 + 激活；成功后清单刷新（installed/updateAvailable 复位）。 */
async function onInstallConfirm(): Promise<void> {
  const preview = installPreview.value
  if (preview === null || confirming.value) return
  const port = resolvePluginInstallPort()
  if (port === null) {
    flowError.value = t('pluginProvider.flow.channelUnavailable')
    return
  }
  confirming.value = true
  flowError.value = ''
  try {
    const result = await port.confirmPluginInstall(preview.pluginId)
    if (!result.success) {
      flowError.value = result.error ?? t('pluginProvider.flow.confirmFailed')
      return
    }
    installPreview.value = null
    pendingAuthorizePluginId.value = preview.pluginId
    phase.value = 'authorize'
    // 安装状态刷新不阻塞进入授权容器（家族卡在下次打开时呈现最新安装态）
    void source.refreshCatalog()
  } catch (e) {
    flowError.value = e instanceof Error ? e.message : String(e)
  } finally {
    confirming.value = false
  }
}

/** 取消安装：清暂存 + 退回家族卡（S27 未确认不发生安装落盘）。 */
async function onInstallCancel(): Promise<void> {
  const preview = installPreview.value
  installPreview.value = null
  phase.value = 'family'
  if (preview === null) return
  try {
    await resolvePluginInstallPort()?.cancelPluginInstall(preview.pluginId)
  } catch (e) {
    // 取消清理失败不阻断 UI（暂存残留由 runtime 启动清扫收敛），warn 可见
    console.warn('[plugin-provider-flow] cancelPluginInstall failed:', e)
  }
}

/** Dialog 关闭（X / 遮罩 / esc）：父侧 v-model:open 更新后 watch 复位流程态。 */
function onDialogToggle(open: boolean): void {
  emit('update:open', open)
}
</script>
