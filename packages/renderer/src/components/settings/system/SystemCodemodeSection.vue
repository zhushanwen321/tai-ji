<template>
  <GroupCard :title="t('settings.system.codemodeTitle')">
    <div class="px-2.5 pt-1 pb-2" data-testid="codemode-section">
      <SettingRow :label="t('settings.system.codemodeEnable')" :desc="t('settings.system.codemodeDesc')">
        <Switch
          data-testid="codemode-enabled-switch"
          :model-value="enabled"
          :disabled="corrupted"
          @update:model-value="onToggle"
        />
      </SettingRow>

      <!-- 损坏错误态（codemode 设计 D3 定死形态）：Switch 禁用 + 完整路径可复制 +
           修复指引（含「无需重启」）+ 已隔离时附 .corrupt- 副本路径提示 -->
      <div
        v-if="corruption"
        data-testid="codemode-corruption-error"
        class="mt-1 border-t border-hairline px-1.5 pt-2"
      >
        <p class="flex items-center gap-1.5 text-[length:var(--text-sm)] text-warn" data-testid="codemode-corruption-title">
          <AlertTriangle class="size-3.5 shrink-0" />
          {{ t('settings.system.codemodeCorruptionTitle') }}
        </p>
        <div class="mt-1.5 flex items-center gap-2">
          <code
            class="min-w-0 flex-1 truncate rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-neutral-mid"
            data-testid="codemode-corruption-path"
            :title="corruption.filePath"
          >
            {{ corruption.filePath }}
          </code>
          <Button
            variant="ghost"
            size="sm"
            class="h-6 shrink-0 gap-1 px-2 text-[11px] text-muted hover:text-fg"
            data-testid="codemode-copy-path-btn"
            @click="copyCorruptedPath"
          >
            <Copy class="size-3" />
            {{ t('settings.system.codemodeCopyPath') }}
          </Button>
        </div>
        <p class="mt-1.5 text-[11px] leading-relaxed text-neutral-mid" data-testid="codemode-corruption-guide">
          {{ t('settings.system.codemodeCorruptionGuide') }}
        </p>
        <p
          v-if="corruption.corruptCopyPath"
          class="mt-1 text-[11px] leading-relaxed text-warn"
          data-testid="codemode-corrupt-copy-path"
        >
          {{ t('settings.system.codemodeCorruptCopyHint', { path: corruption.corruptCopyPath }) }}
        </p>
      </div>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
/**
 * System · Code Mode（脚本模式）Section（codemode 设计 D3）。
 *
 * 数据层：SettingsTransport seam 的 getCodemodeEnabled / setCodemodeEnabled（config.* 命令对，
 * runtime 写 settings.json defaultTools 字段域——D1/D2 写入语义归 runtime，本组件只表达目标态）。
 * 说明文案含生效时机（配置随新启动的会话读取——运行中 pi 进程不热重读，设计问题点 4）。
 * 乐观写协议：切换即更新 UI，失败回滚 + toast；服务端两态信封（CodemodeSetEnabledResult）：
 * ok:true 以落盘终态校准显示，ok:false（损坏拒入）转入错误态。
 * 损坏错误态（D3 定死形态 + A1 读侧）：get 返回 corruption 非空时 Switch 禁用，Section 内驻留
 * 错误文案行——settings.json 完整路径（带复制按钮）+ 修复指引（无需重启，损坏检测每次现查）+
 * 已被自动隔离时附 .corrupt- 副本路径提示；修复文件后重试即恢复。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Copy } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getSettingsTransport } from '@taiji/core'
import type { CodemodeSettingsCorruption } from '@taiji/shared'
import { useToast } from '@/composables/useToast'

// [C3] settings 域 transport 只经 SettingsTransport seam（禁直连门面 / 禁深 import transport 域）
const transport = getSettingsTransport()

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

// 默认开（产品裁决：常驻默认打开——加载失败 best-effort 保持默认值，同 retry 先例）
const enabled = ref(true)
const switching = ref(false)
const corruption = ref<CodemodeSettingsCorruption | null>(null)
const corrupted = computed(() => corruption.value !== null)

onMounted(async () => {
  try {
    const res = await transport.getCodemodeEnabled()
    enabled.value = res.enabled
    corruption.value = res.corruption
  } catch (e) {
    // best-effort：加载失败保持默认开，不打扰用户（故障面 = 开关状态短暂失真，非数据风险）
    console.warn('[SystemCodemodeSection] failed to load codemode state:', e)
  }
})

/** 开关切换（乐观写协议）：先更新 UI 再发协议，失败回滚 + toast；损坏拒入（ok:false）按服务端
 * 错误态转入禁用 + Section 错误文案行（D3：开关操作被拒绝，错误信息驻留 Section 不止于 toast）。 */
async function onToggle(next: boolean): Promise<void> {
  if (switching.value || corrupted.value) return
  switching.value = true
  enabled.value = next
  try {
    const res = await transport.setCodemodeEnabled(next)
    if (res.ok) {
      enabled.value = res.enabled
    } else {
      enabled.value = false
      corruption.value = res.corruption
      toastError(t('settings.system.codemodeSetRejected', { path: res.corruption.filePath }))
    }
  } catch (e) {
    enabled.value = !next
    console.warn('[SystemCodemodeSection] failed to toggle codemode:', e)
    // 失败路径 2（codemode 设计 §3.1）：非损坏类 RPC 失败（如 settings.json 只读 EACCES
    // 写失败）的 error 信封 message 含目标文件路径（runtime handler_error 透传 Node fs
    // 错误原文），透传给用户定位修复对象；message 缺失时回退静态提示。
    const detail = e instanceof Error && e.message ? e.message : ''
    toastError(
      detail
        ? t('settings.system.codemodeSwitchFailedDetail', { message: detail })
        : t('settings.system.codemodeSwitchFailed'),
    )
  } finally {
    switching.value = false
  }
}

/** 复制 settings.json 完整路径（D3：路径可复制——用户定位与修复入口）。 */
async function copyCorruptedPath(): Promise<void> {
  if (!corruption.value) return
  try {
    await navigator.clipboard.writeText(corruption.value.filePath)
    toastInfo(t('settings.system.codemodePathCopied'))
  } catch (e) {
    // best-effort：复制失败不打断错误态（路径仍完整可见，用户可手动选中复制）
    console.warn('[SystemCodemodeSection] failed to copy corrupted path:', e)
  }
}
</script>
