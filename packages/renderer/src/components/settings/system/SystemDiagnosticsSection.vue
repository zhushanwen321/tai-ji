<template>
  <!--
    System · 诊断 Section（crash-forensics-and-watchdog §3.3 D6 / u3b）。
    一键导出诊断包：确认对话框知情展示（shared SSOT 文案）→ main 弹保存对话框
    （用户自选位置）打包双台账 + 日志尾部 + 触发状态表为 zip。动作与三态反馈
    收敛在 DiagnosticsExportAction（与死态块第二入口共享同一组件，行为不分叉）。
  -->
  <GroupCard :title="t('settings.system.diagnosticsTitle')">
    <div class="px-2.5 pt-1 pb-2" data-testid="diagnostics-section">
      <SettingRow :label="t('settings.system.diagnosticsExportLabel')" :desc="t('settings.system.diagnosticsExportDesc')">
        <DiagnosticsExportAction />
      </SettingRow>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import DiagnosticsExportAction from '@/components/panel/DiagnosticsExportAction.vue'

// 独立动作（无 SystemSettings 键，不走 update emit）——同 SystemLlmRetrySection 契约
const { t } = useI18n()
</script>
