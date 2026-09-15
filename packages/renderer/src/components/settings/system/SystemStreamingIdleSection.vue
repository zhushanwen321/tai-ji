<template>
  <!--
    对话流式空闲超时（docs/design/timeout-streaming-ui-idle.md §4.3 / §5.3 D3）。
    配置口：config.get/setStreamingIdleTimeout RPC（单位秒，runtime clamp [60, 3600]）；
    表单单位分钟（合法域 1-60、默认 30，D3 单一权威口径）。超范围输入红字拒绝保存；
    保存成功后把 runtime 生效值同步进 chat store（新 turn 的 idle timer 按新值挂载）。
  -->
  <GroupCard :title="t('settings.system.streamingIdleTitle')">
    <div class="px-2.5 pt-1 pb-2">
      <SettingRow :label="t('settings.system.streamingIdleLabel')" :desc="t('settings.system.streamingIdleDesc')">
        <div class="flex flex-col items-end gap-1">
          <div class="flex items-center gap-1.5">
            <Input
              v-model.number="minutes"
              type="number"
              data-testid="setting-streaming-idle-timeout"
              class="h-8 w-[100px] text-xs"
              :error="!isValid"
              :min="MIN_MINUTES"
              :max="MAX_MINUTES"
              @blur="onSave"
            />
            <span class="text-xs text-neutral-mid">{{ t('settings.system.streamingIdleUnitMin') }}</span>
          </div>
          <span
            v-if="!isValid"
            data-testid="setting-streaming-idle-error"
            class="text-[length:var(--text-sm)] text-danger"
          >
            {{ t('settings.system.streamingIdleInvalid', { min: MIN_MINUTES, max: MAX_MINUTES }) }}
          </span>
        </div>
      </SettingRow>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Input } from '@/components/ui/input'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { type SystemSettings } from '@taiji/core'
import { getStreamingIdleTimeout, setStreamingIdleTimeout } from '@taiji/core/transport/api/domains/settings'
import { useChatStore } from '@/stores/chat'
import { useToast } from '@/composables/useToast'

// 统一 Section 契约（同 SystemAutoRenameSection：独立 API，不走 SystemSettings 体系；不 emit）
defineProps<{
  system: SystemSettings
}>()

defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

/** 表单合法域（分钟）＝ D3 单一权威口径 clamp [60, 3600] 秒的分钟形态。 */
const MIN_MINUTES = 1
const MAX_MINUTES = 60
/** 默认值（分钟）＝ D3 默认 1800s 的分钟形态。 */
const DEFAULT_MINUTES = 30
/** RPC 协议单位换算：runtime 存秒，表单展示分钟。 */
const SECONDS_PER_MINUTE = 60
/** RPC 协议单位换算：chat store 注水用 ms。 */
const MS_PER_SECOND = 1000

/** 表单值（分钟）；runtime 返回秒 ÷ SECONDS_PER_MINUTE 换算。 */
const minutes = ref<number>(DEFAULT_MINUTES)
let prevMinutes = DEFAULT_MINUTES

const isValid = computed(() => Number.isFinite(minutes.value) && minutes.value >= MIN_MINUTES && minutes.value <= MAX_MINUTES)

onMounted(async () => {
  try {
    const res = await getStreamingIdleTimeout()
    minutes.value = res.timeout / SECONDS_PER_MINUTE
    prevMinutes = minutes.value
  } catch (e) {
    // best-effort：加载失败保持默认 30 分钟（core 侧同为 1800s 默认），不打扰用户
    console.warn('[SystemStreamingIdleSection] failed to load streaming idle timeout:', e)
  }
})

/** blur 保存：超范围红字拒绝（不发 RPC）；成功后回显 runtime 生效值并同步 chat store。 */
async function onSave(): Promise<void> {
  if (!isValid.value) return
  if (minutes.value === prevMinutes) return
  const prev = prevMinutes
  prevMinutes = minutes.value
  try {
    const res = await setStreamingIdleTimeout(minutes.value * SECONDS_PER_MINUTE)
    // runtime clamp 后生效值为准（表单回显 + chat store 注水，新 turn idle timer 按此值挂载）
    const effectiveMinutes = res.timeout / SECONDS_PER_MINUTE
    minutes.value = effectiveMinutes
    prevMinutes = effectiveMinutes
    useChatStore().setStreamingIdleTimeoutMs(res.timeout * MS_PER_SECOND)
    toastInfo(t('settings.system.saved'))
  } catch (_e) {
    minutes.value = prev
    prevMinutes = prev
    toastError(t('settings.system.saveFailed'))
  }
}
</script>
