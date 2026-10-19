<template>
  <!-- 代理规则卡（llm-network-proxy §3.1 卡 2）：快速添加 chip 组（listProviders 投影，
       点击 toggle 草稿规则集；baseUrl 取值 provider 级 → model 级 → 禁用+title 提示）+
       规则列表（主机名 Input + 删除）+ 添加自定义规则。已添加态判定键 = 主机名条目
       （shared normalizeHostname 归一化相等）。开关关闭时整卡降灰禁交互（page 层 wrapper）。 -->
  <GroupCard>
    <template #head>
      <div class="gc-head-text">
        <h3 class="gc-title">{{ t('settings.network.rulesCard') }}</h3>
        <p class="gc-sub">{{ t('settings.network.rulesCardDesc') }}</p>
      </div>
    </template>

    <div class="flex flex-col gap-[10px] px-[10px] pt-[4px] pb-[8px]" data-testid="network-rules-card">
      <!-- 快速添加 chip 组 -->
      <div class="flex flex-col gap-[6px]">
        <span class="text-[length:var(--text-xs)] text-[color:var(--neutral-fg-2)]">{{ t('settings.network.quickAdd') }}</span>
        <div class="flex flex-wrap gap-[8px]">
          <Button
            v-for="chip in chips"
            :key="chip.id"
            variant="secondary"
            size="sm"
            class="h-[28px] gap-[6px] rounded-[var(--radius-sm)] px-[10px] text-[length:var(--text-xs)]"
            :class="isChipOn(chip) ? 'bg-accent text-accent-fg hover:bg-accent' : ''"
            :disabled="!enabled || chip.host === null"
            :title="chip.host ?? t('settings.network.noBaseUrl')"
            :aria-pressed="isChipOn(chip)"
            :data-testid="`network-chip-${chip.id}`"
            @click="toggleChip(chip)"
          >
            <Check v-if="isChipOn(chip)" class="size-3 shrink-0" />
            <Plus v-else class="size-3 shrink-0" />
            <span class="max-w-[140px] truncate">{{ chip.name }}</span>
            <span class="text-[color:var(--neutral-fg-2)]" :class="isChipOn(chip) ? 'text-accent-fg/70' : ''">{{ chip.host ?? t('settings.network.noBaseUrl') }}</span>
          </Button>
        </div>
      </div>

      <!-- 规则列表（行内直接编辑草稿条目；key=index 保持输入焦点稳定，受控绑定保证删除中间行不错位） -->
      <div class="flex flex-col">
        <div
          v-for="(_, i) in rules"
          :key="i"
          class="flex items-center gap-[8px] border-t border-hairline py-[6px] first:border-t-0"
          :data-testid="`network-rule-row-${i}`"
        >
          <Input
            v-model="rules[i]"
            class="max-w-[360px]"
            :placeholder="t('settings.network.rulePlaceholder')"
            :aria-label="t('settings.network.ruleHostLabel')"
            :disabled="!enabled"
            :data-testid="`network-rule-input-${i}`"
          />
          <Button
            variant="ghost"
            size="sm"
            class="size-[28px] p-0 text-neutral-mid hover:text-danger"
            :title="t('settings.network.ruleRemove')"
            :aria-label="t('settings.network.ruleRemove')"
            :disabled="!enabled"
            :data-testid="`network-rule-del-${i}`"
            @click="rules.splice(i, 1)"
          >
            <Trash2 class="size-[14px]" />
          </Button>
        </div>
        <p
          v-if="rules.length === 0"
          class="py-[6px] text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]"
          data-testid="network-rules-empty"
        >{{ t('settings.network.rulesEmpty') }}</p>
      </div>

      <Button
        variant="ghost"
        size="sm"
        class="h-[28px] self-start gap-1 px-2 text-[length:var(--text-xs)] text-neutral-mid hover:text-neutral-fg"
        :disabled="!enabled"
        data-testid="network-add-rule"
        @click="addRule"
      >
        <Plus class="size-3.5" />
        {{ t('settings.network.addCustomRule') }}
      </Button>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
/**
 * 代理规则卡：规则集是页面草稿的一翼（defineModel 数组，行内编辑/增删直接 mutate——
 * TtsProviderForm 字段级写同型）。chips 数据由 page 拉一次 listProviders 后传入
 * （network-page-model 投影：provider 级 baseUrl → 任一 model 级 → null 禁用态）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Plus, Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { GroupCard } from '@taiji/ui/features/settings'
import type { ProviderInfo } from '@taiji/shared'
import { normalizeHostname } from '@taiji/shared'
import { buildProviderChips, rulesContainHost, type ProviderChip } from './network-page-model'

const { t } = useI18n()

const rules = defineModel<string[]>('rules', { required: true })
const props = defineProps<{
  /** 开关总态：false 时整卡禁交互（降灰由 page 层 wrapper 承担） */
  enabled: boolean
  /** chip 数据源（page 拉取的 provider 清单；空清单 = chip 组无项，规则仍可手输） */
  providers: ProviderInfo[]
}>()

const chips = computed<ProviderChip[]>(() => buildProviderChips(props.providers))

function isChipOn(chip: ProviderChip): boolean {
  return chip.host !== null && rulesContainHost(rules.value, chip.host)
}

/** chip 点击 toggle：已添加（主机名归一化相等的第一条）→ 移除；未添加 → 追加主机名条目。
 *  判定与「已添加态」同一函数（shared normalizeHostname），pattern 唯一性由归一化相等保证。 */
function toggleChip(chip: ProviderChip): void {
  if (chip.host === null) return
  const idx = rules.value.findIndex((rule) => normalizeHostname(rule) === normalizeHostname(chip.host!))
  if (idx >= 0) rules.value.splice(idx, 1)
  else rules.value.push(chip.host)
}

/** 添加自定义规则：push 空条目，用户行内输入主机名（空条目由保存时 shared 校验拦截）。 */
function addRule(): void {
  rules.value.push('')
}
</script>
