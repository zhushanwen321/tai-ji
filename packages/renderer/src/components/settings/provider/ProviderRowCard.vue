<template>
  <!--
    provider 实体行卡（从 ProviderPage 拆出，纯结构重构、行为零变化）。
    行头 demo .prow 形态：状态点 → 启用开关 → 名称(点击展开就地编辑) → 认证徽章 → 默认 pill
    → 模型数 → dirty 徽章 → 删除 → chevron。展开体 = ProviderEditBody（就地编辑）。
    状态全由父组件下发（真值在 settings store / 手风琴 guard / oauth 状态机，均在 ProviderPage
    单实例持有），本组件纯受控展示 + 动作上抛，不做 v-model——enabled 等值经父侧乐观更新链路回写，
    行卡不是真值源。新建态合成行（isNew）无开关/状态点/徽章/默认 pill/计数/删除。

    插件来源扩展（provider-plugin-access D2/D5/D10）：pluginInfo 非空 = 插件来源条目——
    展开体内含凭据状态行（插件上报，未上报零 DOM——D5/S5）、条目底部 detail-extra 插件
    渲染区（挂载位 global:provider.detail-extra）与「重新授权」「更新插件」宿主动作。
  -->
  <div
    data-testid="provider-card"
    class="rounded-md bg-surface p-[12px_14px] hover:bg-surface-hover"
  >
    <!-- 行头（demo .prow：状态点/开关/名称/徽标/计数/删除/chevron，gap 12px） -->
    <div class="flex min-w-0 items-center gap-3">
      <span
        v-if="!isNew"
        class="size-[7px] shrink-0 rounded-full"
        :class="statusDot(provider.status)"
      />

      <!-- 启用开关（名称左侧）。新建态无开关 -->
      <Switch
        v-if="!isNew"
        :model-value="provider.enabled"
        class="shrink-0"
        :disabled="toggling"
        :aria-label="`${provider.name} ${t('settings.provider.colEnabled')}`"
        @click.stop
        @update:model-value="emit('toggle-enabled', $event)"
      />

      <!-- 供应商名称（点击展开/收起就地编辑；demo .pname = 14px / fw-mid / neutral-fg） -->
      <span
        class="flex-1 cursor-pointer truncate text-[length:var(--text-base)] font-semibold text-neutral-fg"
        role="button"
        :aria-expanded="expanded"
        @click="emit('toggle', provider.id)"
      >{{ isNew ? t('settings.provider.newProvider') : provider.name }}</span>

      <!-- 插件来源标记（D1 终态样例「WorkBuddy · 插件」：来源类型在列表可辨） -->
      <span
        v-if="!isNew && pluginInfo"
        data-testid="provider-plugin-badge"
        class="inline-flex h-[18px] shrink-0 items-center rounded-full bg-accent-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-accent"
      >{{ t('pluginProvider.row.pluginBadge') }}</span>

      <!-- 认证方式徽章（demo .tag 形态：h18 / px7 / 圆角 999 / text-2xs / fw-mid；配色读 provider-badge） -->
      <span
        v-if="!isNew"
        data-testid="provider-auth-badge"
        class="inline-flex h-[18px] shrink-0 items-center rounded-full px-[7px] text-[length:var(--text-2xs)] font-semibold"
        :class="authBadgeClass(provider)"
      >{{ t(`settings.provider.builtinTemplate.authBadge.${authBadgeTextKey(provider)}`) }}</span>

      <!-- 默认供应商 pill（P2：可点击 → 弹模型选择，选中后 config.setDefaultModel；demo .tag.ok 形态） -->
      <ModelSelectPopover
        v-if="!isNew && isDefault"
        :selected="defaultModel"
        :provider-filter="[provider.id]"
        @select="emit('set-default', $event)"
      >
        <template #trigger>
          <PopoverTrigger as-child>
            <Button
              variant="ghost"
              class="h-[18px] shrink-0 rounded-full bg-accent-soft px-[7px] py-0 text-[length:var(--text-2xs)] font-semibold text-accent hover:bg-accent-soft"
              :title="t('panel.modelSelect.switchModel')"
              data-testid="provider-default-pill"
            >{{ t('settings.provider.defaultPill') }}</Button>
          </PopoverTrigger>
        </template>
      </ModelSelectPopover>

      <span v-if="!isNew" class="shrink-0 text-[length:var(--text-xs)] text-neutral-fg-2">{{ t('settings.provider.modelsCount', { count: provider.models.length }) }}</span>

      <!-- dirty 徽章（展开编辑且有未保存改动时） -->
      <span
        v-if="expanded && dirty"
        data-testid="provider-dirty-badge"
        class="flex shrink-0 items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-[length:var(--text-3xs)] font-semibold text-warn"
      >
        <span class="size-1.5 rounded-full bg-warn" />
        {{ t('settings.provider.unsavedBadge') }}
      </span>

      <span class="flex-1" />

      <!-- 删除按钮（demo .btn.icon.danger-hover：28px 方钮 / neutral-mid / hover danger；
           wave4 TC5：title 按差异收窄——catalog=移除/custom=删除） -->
      <Button
        v-if="!isNew"
        variant="ghost"
        class="h-[28px] w-[28px] shrink-0 rounded-md p-0 text-neutral-mid hover:bg-surface-hover hover:text-danger [&_svg]:size-[14px]"
        :title="provider.kind === 'catalog' ? t('settings.provider.removeTitle') : t('settings.provider.deleteTitle')"
        :data-testid="provider.kind === 'catalog' ? 'provider-remove-btn' : 'provider-delete-btn'"
        @click.stop="emit('remove', provider)"
      >
        <Trash2 />
      </Button>

      <!-- 展开指示（demo：chevron-down 14px mid，收窄 -90°，展开归位） -->
      <ChevronDown
        class="size-[14px] shrink-0 text-neutral-mid transition-transform duration-[var(--duration-fast)]"
        :class="expanded ? '' : '-rotate-90'"
      />
    </div>

    <!-- 展开就地编辑体（R4；demo 展开体 = 行内 border-top hairline + pt 12px）。
         B-1：OAuth 态经 props/事件接线（useProviderOAuth 单实例在 ProviderPage 侧，事件
         上抛由页面驱动共享状态机——无双 listener） -->
    <div v-if="expanded" class="mt-[4px] border-t border-hairline pt-[12px]" data-testid="provider-expand-body">
      <!-- 插件凭据状态行（D5/S17：插件上报的展示映射；undefined = 未上报 → 零 DOM，
           宿主不猜测凭据状态、不显示任何失效标记——S5 负面断言对象） -->
      <div
        v-if="credentialStatus"
        data-testid="provider-plugin-status"
        class="mb-[8px] flex items-center gap-1.5 text-[length:var(--text-xs)]"
        :class="credentialStatus.state === 'valid' ? 'text-success' : 'text-warn'"
      >
        <span
          class="size-[7px] shrink-0 rounded-full"
          :class="credentialStatus.state === 'valid' ? 'bg-success' : 'bg-warn'"
        />
        <span class="truncate">{{ credentialStatus.message ?? (credentialStatus.state === 'valid' ? t('pluginProvider.status.fallbackValid') : t('pluginProvider.status.fallbackInvalid')) }}</span>
      </div>

      <ProviderEditBody
        :provider="isNew ? null : provider"
        :oauth-present="oauthPresent"
        :oauth-supported="oauthSupported"
        :quota-presets="quotaPresets"
        @dirty-change="emit('dirty-change', $event)"
        @saved="emit('saved', $event)"
        @cancel="emit('cancel')"
        @oauth-login="emit('oauth-login')"
        @oauth-logout="emit('oauth-logout')"
      />

      <!-- 插件来源条目扩展（D2/D5/D10）：宿主区（上）与插件渲染区（下）两区边界清晰、
           无字段重叠（S6）——detail-extra 为挂载位容器（无树时零 DOM，不占布局）。 -->
      <template v-if="pluginInfo">
        <div class="mt-[12px] border-t border-hairline pt-[12px]" data-testid="provider-detail-extra-boundary">
          <p class="mb-[8px] text-[length:var(--text-2xs)] font-semibold text-neutral-mid">{{ t('pluginProvider.detailExtra.title') }}</p>
          <ViewHost
            :scope="{ kind: 'global', mountId: DETAIL_EXTRA_MOUNT_ID, pluginId: pluginInfo.pluginId }"
            :view-id="DETAIL_EXTRA_VIEW_ID"
            :title="t('pluginProvider.detailExtra.title')"
            empty="hidden"
          />
        </div>

        <!-- 宿主常驻动作（D5：重新授权按钮不判断是否失效，常驻；S26：更新插件次级动作） -->
        <div class="mt-[12px] flex items-center justify-end gap-2">
          <Button
            v-if="pluginInfo.updateAvailable"
            variant="ghost"
            size="sm"
            data-testid="provider-update-plugin-btn"
            @click.stop="emit('update-plugin', provider.id)"
          >{{ t('pluginProvider.actions.updatePlugin') }}</Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="provider-reauthorize-btn"
            @click.stop="emit('reauthorize', provider.id)"
          >{{ t('pluginProvider.actions.reauthorize') }}</Button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { inject, provide, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PopoverTrigger } from '@/components/ui/popover'
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'
import { ProviderEditBody } from '@taiji/ui/features/settings'
import { VIEW_HOST_SOURCE_KEY, ViewHost } from '@taiji/ui/extension-host'
import { ACTION_EXECUTOR_KEY, UI_EVENT_SENDER_KEY } from '@taiji/ui/rendering-protocol'
import type { PluginViewScope, ProviderId, ProviderInfo, ProviderStatus, QuotaPreset } from '@taiji/shared'
import { authBadgeClass, authBadgeTextKey } from './provider-badge'
import { createPluginActionExecutor, createPluginUiEventSender, type CredentialStatusPayload, type PluginEntryInfo } from './PluginProviderSource'

/** 条目扩展区挂载位 id（core bootstrap 注册 + 本组件消费，同字面量即约定）。 */
const DETAIL_EXTRA_MOUNT_ID = 'provider.detail-extra'
/** 条目扩展区主视图 viewId 约定 = 挂载位 id（插件推树时用同名 viewId；跨仓契约）。 */
const DETAIL_EXTRA_VIEW_ID = DETAIL_EXTRA_MOUNT_ID

const props = defineProps<{
  /** 该行的 provider 数据（新建态为父侧合成行 sentinel） */
  provider: ProviderInfo
  /** 新建态合成行：无开关/状态点/徽章/默认 pill/计数/删除（原 p.id !== NEW_ID 分支） */
  isNew: boolean
  /** 该行展开（expandedId === provider.id） */
  expanded: boolean
  /** 当前展开 body 的 dirty 态（徽章显示判据 = expanded && dirty） */
  dirty: boolean
  /** 该行是默认供应商（defaultProviderId === provider.id → 默认 pill） */
  isDefault: boolean
  /** 当前默认模型复合 id（默认 pill 的 ModelSelectPopover selected；undefined → 组件默认空串） */
  defaultModel?: string
  /** 启用开关 in-flight（防双击，父侧 toggling 集合含该 id） */
  toggling: boolean
  /** OAuth presence 三态（undefined=未查询/查询失败，见 useProviderOAuth） */
  oauthPresent?: boolean
  /** 该 provider 支持 OAuth 登录（父侧按 builtinProviders 模板判定） */
  oauthSupported: boolean
  /** quota presets（settings store 快照，透传 ProviderEditBody 匹配展示；undefined → 编辑体回落编译期基线） */
  quotaPresets?: QuotaPreset[]
  /** 插件来源条目信息（undefined = 非插件条目，无扩展区/状态行/宿主动作） */
  pluginInfo?: PluginEntryInfo
  /** 插件上报的凭据状态（undefined = 未上报/未拉取 → 无任何标记，D5/S5） */
  credentialStatus?: CredentialStatusPayload
}>()

const emit = defineEmits<{
  /** 行头名称点击 → 展开/收起（payload = provider id；父侧 useAccordionGuard 做 dirty 检查） */
  toggle: [id: string]
  /** 启用开关拨动 → 父侧 useApiKeyAutoEnable 乐观更新 + 持久化 */
  'toggle-enabled': [enabled: boolean]
  /** 默认 pill 选模型（payload 透传 ModelSelectPopover select）→ setDefaultModel */
  'set-default': [payload: { modelId: string; provider: ProviderId }]
  /** 删除/移除按钮点击（父侧弹 ConfirmDialog 二次确认） */
  remove: [provider: ProviderInfo]
  /** ProviderEditBody dirty 状态上抛（父侧展开切换检查用） */
  'dirty-change': [value: boolean]
  /** ProviderEditBody 保存成功上抛（payload 原样透传：wroteApiKey / quotaAutoEnabled） */
  saved: [payload?: { wroteApiKey: boolean; quotaAutoEnabled?: boolean }]
  /** ProviderEditBody 取消上抛 */
  cancel: []
  /** ProviderEditBody OAuth 登录上抛（父侧驱动共享状态机） */
  'oauth-login': []
  /** ProviderEditBody OAuth 退出上抛（父侧移除 auth.json 凭证并刷新 presence） */
  'oauth-logout': []
  /** 「重新授权」点击（D5：展开 provider.authorize 挂载位，payload = provider id） */
  reauthorize: [providerId: string]
  /** 「更新插件」点击（S26：两段式安装链重跑，payload = provider id） */
  'update-plugin': [providerId: string]
}>()

const { t } = useI18n()

function statusDot(status: ProviderStatus): string {
  const map = { connected: 'bg-success', not_configured: 'bg-neutral-dim', error: 'bg-danger' }
  return map[status]
}

// ── 插件来源条目扩展区（D2/D5/D8）──

/** 插件渲染区数据源（壳 provide；单测注入 mock——无注入时 view 恒空，点击退化为零 DOM）。 */
const viewHostSource = inject(VIEW_HOST_SOURCE_KEY, null)
/** 扩展区归属 scope（全局域：挂载位 + 插件维度；pluginInfo 缺失时占位不读）。 */
function detailExtraScope(): PluginViewScope | null {
  const pluginId = props.pluginInfo?.pluginId
  return pluginId === undefined ? null : { kind: 'global', mountId: DETAIL_EXTRA_MOUNT_ID, pluginId }
}

// text-input 值回传出口（D8/S7）：扩展区容器掌握 pluginId + viewId，故在此 provide。
provide(UI_EVENT_SENDER_KEY, createPluginUiEventSender(() => props.pluginInfo?.pluginId ?? null, DETAIL_EXTRA_VIEW_ID))
// action-bar 命令执行器（D7/S7）：扩展区 action-bar 的命令活在插件 fork（不在宿主命令表），
// 容器 provide 局部执行器直发 plugin.executeCommand，覆盖 app 级 pi 扩展命令执行器。
provide(ACTION_EXECUTOR_KEY, createPluginActionExecutor(() => props.pluginInfo?.pluginId ?? null))

/**
 * 首次展开主动拉取（ADR-0155「拉为主」：挂载位首次渲染须能主动拉取，不能只依赖推送）。
 * ViewHost 的 hidden 挂载点不自举拉取（无内容属常态），故由本组件在展开时拉一次；
 * 推送丢失（renderer 重载 / 插件重启）由下一次展开收敛，不建推送补偿。
 */
watch(
  () => [props.expanded, props.pluginInfo?.pluginId] as const,
  ([expanded]) => {
    if (!expanded) return
    const scope = detailExtraScope()
    if (scope === null) return
    viewHostSource?.refreshViewInScope?.(scope, DETAIL_EXTRA_VIEW_ID)
  },
  { immediate: true },
)
</script>
