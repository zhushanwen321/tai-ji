<template>
  <!-- 页头 = SettingsModal 共享 .page-head 形态（demo .pg-set .page-head：title 20px/600、desc
       mt-8 13px mid、actions gap-8px）。标题/描述只读；三个添加入口 + 远程目录陈旧提示，
       动作全上抛（编排留 ProviderPage：导入预览 / QuickSetup / 羊毛向导）。 -->
  <header class="page-head">
    <div class="head-text">
      <h1 class="title">{{ t('settings.menu.provider') }}</h1>
      <p class="desc">{{ t('settings.menu.providerDesc') }}</p>
    </div>
    <div class="flex shrink-0 flex-col items-end gap-1.5">
      <div class="head-actions">
        <ProviderImportMenu :disabled="importDisabled" @select="emit('import-select', $event)" />
        <!-- F2：入口聚合为「+ 添加供应商 ▾」菜单（内置模板（推荐）/ 自定义），自定义走 createAndExpand 原流程 -->
        <ProviderTemplatePicker
          :providers="builtinProviders"
          @select="emit('template-select', $event)"
          @custom="emit('custom')"
        />
        <!-- 羊毛 provider 入口（wool-provider D6 ①：类型选择第三分支——Beta + 释义 title） -->
        <Button
          variant="secondary"
          class="h-[28px] shrink-0 rounded-md px-[10px] text-[length:var(--text-xs)]"
          :title="t('wool.entryDesc')"
          data-testid="wool-entry-button"
          @click="emit('open-wool')"
        >{{ t('wool.menuLabel') }}<span class="ml-1 text-[length:var(--text-3xs)] text-neutral-mid">{{ t('wool.menuBeta') }}</span></Button>
      </div>
      <!-- RD-4#10：远程模型目录刷新失败/部分失败 → 「目录可能过期」（离线时列表陈旧无痕迹） -->
      <span
        v-if="catalogsStale"
        data-testid="provider-catalogs-stale"
        class="flex items-center gap-1 text-[length:var(--text-2xs)] text-warn"
      >
        <AlertTriangle class="size-3.5 shrink-0" />
        {{ t('settings.provider.catalogsStale') }}
      </span>
    </div>
  </header>
</template>

<script setup lang="ts">
/** Provider 页头（从 ProviderPage 拆出，纯结构重构、行为零变化）：纯受控展示 + 事件上抛。 */
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ProviderImportMenu, ProviderTemplatePicker } from '@taiji/ui/features/settings'
import type { BuiltinProviderTemplate, ProviderSource } from '@taiji/shared'

defineProps<{
  /** 导入入口禁用（父侧 importState 非 idle 时） */
  importDisabled?: boolean
  /** 内置模板清单（ProviderTemplatePicker 数据源；拉取失败为空数组） */
  builtinProviders: BuiltinProviderTemplate[]
  /** 远程模型目录陈旧（RD-4#10 →「目录可能过期」提示） */
  catalogsStale: boolean
}>()

const emit = defineEmits<{
  /** 导入菜单选中源（payload 透传）→ 父侧 useProviderImport 预览流程 */
  'import-select': [source: ProviderSource]
  /** 内置模板选中（payload 透传）→ 父侧打开 QuickSetup（含 OAuth presence + env 检测） */
  'template-select': [tpl: BuiltinProviderTemplate]
  /** 模板菜单「自定义」→ 父侧新建并展开合成行 */
  custom: []
  /** 羊毛向导入口点击 → 父侧打开 WoolWizard */
  'open-wool': []
}>()

const { t } = useI18n()
</script>
