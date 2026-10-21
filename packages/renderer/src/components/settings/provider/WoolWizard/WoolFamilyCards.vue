<template>
  <!--
    羊毛向导 · 家族选择页（D6 ①/D7：三张家族卡 + 登录态检测徽标 + 固定风险行）。
    纯展示组件：卡片数据来自 wool 快照（WoolFamilyState）；登录态检测 = detect 缓存
    （ide-extract 家族显示检测徽标 / oauth 家族固定「需授权」——D3 检测语义）。
    选中经 emit 上抛（WoolWizard 切换到步骤相）。
  -->
  <div class="flex flex-col gap-[16px]" data-testid="wool-family-cards">
    <p class="text-[length:var(--text-sm)] text-neutral-mid">{{ t('wool.familyTitle') }}</p>

    <div
      v-for="f in families"
      :key="f.family"
      :data-testid="`wool-family-card-${f.family}`"
      class="flex cursor-pointer items-center gap-3 rounded-md bg-surface p-[12px_14px] transition-colors hover:bg-surface-hover"
      role="button"
      :aria-label="`${f.displayName} ${t('wool.startAdopt')}`"
      @click="emit('select', f.family)"
    >
      <!-- 家族名 + 厂商（displayName/vendor 来自快照：清单下发或家族名兜底） -->
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ f.displayName }}</span>
        <span v-if="f.vendor" class="truncate text-[length:var(--text-xs)] text-neutral-mid">{{ f.vendor }}</span>
        <span v-if="f.installed" class="text-[length:var(--text-2xs)] text-neutral-mid">
          {{ t('wool.badgeModelsCount', { count: f.catalog?.models.length ?? 0 }) }}
        </span>
      </div>

      <!-- 登录态检测徽标：ide-extract = detect 缓存三态；oauth = 固定「需授权」（D3） -->
      <span
        :data-testid="`wool-family-detect-${f.family}`"
        class="inline-flex h-[18px] shrink-0 items-center rounded-full px-[7px] text-[length:var(--text-2xs)] font-semibold"
        :class="detectBadgeClass(f)"
      >{{ detectBadgeText(f) }}</span>

      <Button variant="ghost" class="h-[24px] shrink-0 rounded-full bg-accent-soft px-[10px] py-0 text-[length:var(--text-2xs)] font-semibold text-accent hover:bg-accent-soft">
        {{ t('wool.startAdopt') }}
      </Button>
    </div>

    <!-- 固定风险行（§3.1 家族卡下方固定文案；清单下发优先，快照兜底文案同义） -->
    <p data-testid="wool-family-risk" class="text-[length:var(--text-2xs)] leading-relaxed text-warn">
      {{ riskNotice }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 家族卡数据 = wool 快照（useWool 上层传入，本组件零 transport 访问——纯展示）。
 * 徽标三态：detect 缓存 null = 检测中（父级打开时已触发 detect 动作）；
 * detected = 绿「检测到登录态」；undetected = 中性「未检测到登录态」。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@taiji/ui'
import type { WoolFamilyId, WoolFamilyState } from '@taiji/shared'

const props = defineProps<{ families: WoolFamilyState[] }>()
const emit = defineEmits<{ select: [family: WoolFamilyId] }>()

const { t } = useI18n()

/** 风险行文案：任一家族的清单文案（三家族同文案由发布通道保证；无清单态取快照兜底文案）。 */
const riskNotice = computed(() => props.families[0]?.riskNotice || t('wool.familyRiskNotice'))

function isOauth(f: WoolFamilyState): boolean {
  return f.credentialsSource === 'oauth'
}

function detectBadgeText(f: WoolFamilyState): string {
  if (isOauth(f)) return t('wool.oauthRequired')
  if (f.detect === null || f.detect === undefined) return t('wool.detectChecking')
  return f.detect.detected ? t('wool.detectOk') : t('wool.detectNone')
}

function detectBadgeClass(f: WoolFamilyState): string {
  if (isOauth(f)) return 'bg-warn-soft text-warn'
  if (f.detect === null || f.detect === undefined) return 'bg-surface text-neutral-mid'
  return f.detect.detected
    ? 'bg-success-soft text-success'
    : 'bg-surface text-neutral-mid'
}
</script>
