<template>
  <!-- 页头 = SettingsModal 共享 .page-head 形态（demo .pg-set .page-head：title 20px/600、desc
       mt-8 13px mid、actions gap-8px）。标题/描述只读；「添加供应商 ▾」聚合菜单（导入/内置模板/
       自定义/插件 Provider 四入口）+ 远程目录陈旧提示，动作全上抛（编排留 ProviderPage）。 -->
  <header class="page-head">
    <div class="head-text">
      <h1 class="title">{{ t('settings.menu.provider') }}</h1>
      <p class="desc">{{ t('settings.menu.providerDesc') }}</p>
    </div>
    <div class="flex shrink-0 flex-col items-end gap-1.5">
      <div class="head-actions">
        <ProviderImportMenu :disabled="importDisabled" @select="emit('import-select', $event)" />
        <!-- F2：入口聚合为「+ 添加供应商 ▾」菜单；provider-plugin-access D1：插件 Provider
             为菜单并列项（原羊毛独立页头按钮 wool-entry-button 已随 WoolWizard 退役删除，
             能力由插件 Provider 来源类型吸收） -->
        <ProviderTemplatePicker
          :providers="builtinProviders"
          @select="emit('template-select', $event)"
          @custom="emit('custom')"
          @plugin-source="emit('plugin-provider')"
        />
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
  /** 菜单「插件 Provider」→ 父侧打开插件接入流程（家族卡，D1） */
  'plugin-provider': []
}>()

const { t } = useI18n()
</script>
