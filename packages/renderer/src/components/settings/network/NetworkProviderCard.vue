<template>
  <!-- 按服务商卡（ipv4Only 独立化改造）：逐行列出服务商 + 自定义主机名，每行两个开关
       切换两个主机名清单的成员关系——「走代理」= rules（命中经代理服务器出站）、
       「强制 IPv4」= ipv4Only（命中直连并锁定 A 记录，治 IPv6 握手抖动超时）。
         - 服务商行：名称 + baseURL 主机名（provider 级 → model 级兜底，双缺禁用行）
         - 自定义行：rules/ipv4Only 中不属于任何服务商主机名的条目（中转站域名等），
           行内改主机名 / 删除；空串行（未填主机名）两开关禁用
         - 降灰语义：「走代理」开关受 enabled 门控（代理总开关关闭时规则分流失效），
           「强制 IPv4」开关始终可用（ipv4Only 与 enabled 正交——直连的地址族修正
           不是代理能力） -->
  <GroupCard>
    <template #head>
      <div class="gc-head-text">
        <h3 class="gc-title">{{ t('settings.network.providerCard') }}</h3>
        <p class="gc-sub">{{ t('settings.network.providerCardDesc') }}</p>
      </div>
    </template>

    <div class="flex flex-col" data-testid="network-provider-card">
      <!-- 表头：两列开关（列宽对齐各行开关位置） -->
      <div class="flex items-center gap-[12px] border-b border-hairline px-[10px] pb-[6px] pt-[4px]">
        <span class="flex-1 text-[length:var(--text-xs)] text-[color:var(--neutral-fg-2)]">{{ t('settings.network.providerCol') }}</span>
        <span class="w-[76px] shrink-0 text-center text-[length:var(--text-xs)] text-[color:var(--neutral-fg-2)]">{{ t('settings.network.colProxy') }}</span>
        <span class="w-[76px] shrink-0 text-center text-[length:var(--text-xs)] text-[color:var(--neutral-fg-2)]">{{ t('settings.network.colIpv4') }}</span>
      </div>

      <!-- 服务商行 -->
      <div
        v-for="row in providerRows"
        :key="row.provider.id"
        class="flex items-center gap-[12px] border-b border-hairline px-[10px] py-[8px] last:border-b-0"
        :data-testid="`network-provider-row-${row.provider.id}`"
      >
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-[length:var(--text-sm)] text-neutral-fg">{{ row.provider.name }}</span>
          <span
            class="truncate text-[length:var(--text-xs)] text-[color:var(--neutral-fg-2)]"
            :data-testid="`network-provider-host-${row.provider.id}`"
          >{{ row.host ?? t('settings.network.noBaseUrl') }}</span>
        </div>
        <div class="w-[76px] shrink-0 flex justify-center">
          <Switch
            :model-value="row.host !== null && containsHost(rules, row.host)"
            :disabled="row.host === null || !enabled"
            :title="row.host === null ? t('settings.network.noBaseUrl') : t('settings.network.colProxy')"
            :data-testid="`network-provider-proxy-${row.provider.id}`"
            @update:model-value="toggleHost(rules, row.host, $event === true)"
          />
        </div>
        <div class="w-[76px] shrink-0 flex justify-center">
          <Switch
            :model-value="row.host !== null && containsHost(ipv4Only, row.host)"
            :disabled="row.host === null"
            :title="row.host === null ? t('settings.network.noBaseUrl') : t('settings.network.colIpv4')"
            :data-testid="`network-provider-ipv4-${row.provider.id}`"
            @update:model-value="toggleHost(ipv4Only, row.host, $event === true)"
          />
        </div>
      </div>

      <!-- 自定义主机名行（rules/ipv4Only 的非服务商条目） -->
      <div
        v-for="(host, i) in customRows"
        :key="`custom-${i}`"
        class="flex items-center gap-[12px] border-b border-hairline px-[10px] py-[8px] last:border-b-0"
        :data-testid="`network-custom-row-${i}`"
      >
        <Input
          :model-value="host"
          class="min-w-0 flex-1"
          :placeholder="t('settings.network.customHostPlaceholder')"
          :aria-label="t('settings.network.customHostLabel')"
          :data-testid="`network-custom-input-${i}`"
          @update:model-value="renameCustomEntry(i, String($event))"
        />
        <div class="w-[76px] shrink-0 flex justify-center">
          <Switch
            :model-value="host.trim() !== '' && containsHost(rules, host)"
            :disabled="host.trim() === '' || !enabled"
            :data-testid="`network-custom-proxy-${i}`"
            @update:model-value="toggleHost(rules, host, $event === true)"
          />
        </div>
        <div class="w-[76px] shrink-0 flex justify-center">
          <Switch
            :model-value="host.trim() !== '' && containsHost(ipv4Only, host)"
            :disabled="host.trim() === ''"
            :data-testid="`network-custom-ipv4-${i}`"
            @update:model-value="toggleHost(ipv4Only, host, $event === true)"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          class="size-[28px] shrink-0 p-0 text-neutral-mid hover:text-danger"
          :title="t('settings.network.customHostRemove')"
          :aria-label="t('settings.network.customHostRemove')"
          :data-testid="`network-custom-del-${i}`"
          @click="removeCustomEntry(i)"
        >
          <Trash2 class="size-[14px]" />
        </Button>
      </div>

      <p
        v-if="providerRows.length === 0"
        class="px-[10px] py-[6px] text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]"
        data-testid="network-providers-empty"
      >{{ t('settings.network.providersEmpty') }}</p>

      <Button
        variant="ghost"
        size="sm"
        class="mt-[8px] h-[28px] self-start gap-1 px-2 text-[length:var(--text-xs)] text-neutral-mid hover:text-neutral-fg"
        data-testid="network-add-custom-host"
        @click="addCustomEntry"
      >
        <Plus class="size-3.5" />
        {{ t('settings.network.addCustomHost') }}
      </Button>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
/**
 * 按服务商卡：两个主机名清单（rules / ipv4Only）的逐行可视化编辑器。
 *   - 行 = 一个主机名（服务商的 baseURL 主机名，或自定义条目），行内两开关分别表示
 *     该主机名在两个清单中的成员关系；切换 = push / remove 条目（判定键 = 归一化
 *     主机名，与 shared normalizeHostname 语义一致）。
 *   - 自定义行底层存储 = rules/ipv4Only 两个数组的条目本身（不引入第三份存储）：
 *     新增行 = push 空串到 rules（空 host 行两开关禁用；保存时 shared 校验显式拦截
 *     「第 N 条为空」），改名行 = 两个数组原位替换该条目，删除行 = 两个数组移除。
 *   - 「强制 IPv4」开关不受 enabled 门控（ipv4Only 独立于代理总开关，shared 契约语义）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { GroupCard } from '@taiji/ui/features/settings'
import type { ProviderInfo } from '@taiji/shared'
import { normalizeHostname } from '@taiji/shared'
import { providerBaseHost } from './network-page-model'

const { t } = useI18n()

const rules = defineModel<string[]>('rules', { required: true })
const ipv4Only = defineModel<string[]>('ipv4Only', { required: true })
const props = defineProps<{
  /** 代理总开关：仅门控「走代理」列（ipv4Only 与 enabled 正交） */
  enabled: boolean
  /** 服务商清单（page 拉取的 provider 清单；空清单 = 无行，自定义区仍可用） */
  providers: ProviderInfo[]
}>()

/** 服务商行（含无可用 baseURL 的禁用行——名称仍展示，开关禁用 + title 提示）。 */
const providerRows = computed<Array<{ provider: ProviderInfo; host: string | null }>>(() =>
  props.providers.map((provider) => ({ provider, host: providerBaseHost(provider) })),
)

/** 自定义行：rules ∪ ipv4Only 中不属于任何服务商主机名的条目（保序去重，空串行保留）。 */
const customRows = computed<string[]>(() => {
  const providerHosts = new Set(
    providerRows.value.flatMap((row) => (row.host === null ? [] : [normalizeHostname(row.host)])),
  )
  const seen = new Set<string>()
  const rows: string[] = []
  for (const entry of [...rules.value, ...ipv4Only.value]) {
    if (providerHosts.has(normalizeHostname(entry))) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    rows.push(entry)
  }
  return rows
})

/** 清单内归一化主机名匹配的条目下标（未命中 -1；归一化目标在循环外算一次）。
 *  成员判定与行内开关增删共用同一判据——两处判定键必须一致，否则会出现
 *  「开关显示未添加但点击却移除 / 显示已添加但点击却追加」的错位。 */
function findHostIndex(list: string[], host: string): number {
  const target = normalizeHostname(host)
  return list.findIndex((entry) => normalizeHostname(entry) === target)
}

/** 清单成员判定：归一化主机名相等（开关显示态与 toggleHost 增删判据同源）。 */
function containsHost(list: string[], host: string): boolean {
  return findHostIndex(list, host) >= 0
}

/** 行内开关：on = push 主机名（未在清单时），off = remove 清单内该主机名（归一化相等匹配）。
 *  host = null（无可用 baseURL 的服务商）走 no-op：该行的开关 disabled 已拦点击，这里再兜一次。 */
function toggleHost(list: string[], host: string | null, on: boolean): void {
  if (host === null) return
  const idx = findHostIndex(list, host)
  if (on && idx < 0) list.push(host)
  if (!on && idx >= 0) list.splice(idx, 1)
}

/** 新增自定义行：push 空串到 rules（空 host 行两开关禁用；保存时校验拦截）。 */
function addCustomEntry(): void {
  rules.value.push('')
}

/** 自定义行改名：两个数组原位替换该条目（按行序号定位 customRows 快照取旧值）。 */
function renameCustomEntry(index: number, next: string): void {
  const old = customRows.value[index]
  if (old === undefined) return
  for (const list of [rules, ipv4Only]) {
    const idx = list.value.indexOf(old)
    if (idx >= 0) list.value.splice(idx, 1, next)
  }
}

/** 自定义行删除：两个数组均移除该条目。 */
function removeCustomEntry(index: number): void {
  const host = customRows.value[index]
  if (host === undefined) return
  for (const list of [rules, ipv4Only]) {
    const idx = list.value.indexOf(host)
    if (idx >= 0) list.value.splice(idx, 1)
  }
}
</script>
