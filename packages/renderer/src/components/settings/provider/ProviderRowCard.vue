<template>
  <!--
    provider 实体行卡（从 ProviderPage 拆出，纯结构重构、行为零变化）。
    行头 demo .prow 形态：状态点 → 启用开关 → 名称(点击展开就地编辑) → 认证徽章 → 默认 pill
    → 模型数 → dirty 徽章 → 删除 → chevron。展开体 = ProviderEditBody（就地编辑）。
    状态全由父组件下发（真值在 settings store / 手风琴 guard / oauth 状态机，均在 ProviderPage
    单实例持有），本组件纯受控展示 + 动作上抛，不做 v-model——enabled 等值经父侧乐观更新链路回写，
    行卡不是真值源。新建态合成行（isNew）无开关/状态点/徽章/默认 pill/计数/删除。
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
      <ProviderEditBody
        :provider="isNew ? null : provider"
        :oauth-present="oauthPresent"
        :oauth-supported="oauthSupported"
        @dirty-change="emit('dirty-change', $event)"
        @saved="emit('saved', $event)"
        @cancel="emit('cancel')"
        @oauth-login="emit('oauth-login')"
        @oauth-logout="emit('oauth-logout')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChevronDown, Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PopoverTrigger } from '@/components/ui/popover'
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'
import { ProviderEditBody } from '@taiji/ui/features/settings'
import type { ProviderId, ProviderInfo, ProviderStatus } from '@taiji/shared'
import { authBadgeClass, authBadgeTextKey } from './provider-badge'

defineProps<{
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
}>()

const { t } = useI18n()

function statusDot(status: ProviderStatus): string {
  const map = { connected: 'bg-success', not_configured: 'bg-neutral-dim', error: 'bg-danger' }
  return map[status]
}
</script>
