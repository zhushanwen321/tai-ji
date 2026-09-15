<script setup lang="ts">
/**
 * PluginSettingsPage（W4 · T2，IF7）——插件管理页。
 *
 * 展示已发现插件列表（名称/版本/启用状态/信任级别）+ 每插件 contributions 可用性：
 * available=false 的 contribution 置灰标注（is-unavailable class + 原因文案），
 * available=true 正常展示。
 *
 * 数据源经 inject 注入（PluginSettingsDataSourceKey），壳（P5）provide 真实实现
 * （接 runtime config.plugins 订阅 + S2 contribution-registry），单测 mock 注入。
 * 组件本体只做展示，入口挂载归 P5 壳。
 *
 * 置灰锚点契约（design-review C3）：data-testid='contribution-unavailable' +
 * class 'is-unavailable' + 文案（reason ?? '当前平台不支持该挂载点'）。
 */
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PluginInfo } from '@taiji/shared'
import {
  PluginSettingsDataSourceKey,
  type ContributionInfo,
} from './plugin-settings-data-source'

const UNAVAILABLE_REASON = '当前平台不支持该挂载点'

const dataSource = inject(PluginSettingsDataSourceKey, null)

const plugins = ref<PluginInfo[]>([])
/** pluginId → contributions 可用性（watch 插件列表变化时拉取） */
const contributionsByPlugin = ref<Record<string, ContributionInfo[]>>({})

let unsubscribe: (() => void) | null = null

function loadContributions(pluginId: string) {
  if (!dataSource) return
  contributionsByPlugin.value = {
    ...contributionsByPlugin.value,
    [pluginId]: dataSource.getContributions(pluginId),
  }
}

onMounted(() => {
  if (!dataSource) return
  unsubscribe = dataSource.onPlugins((list) => {
    plugins.value = list
  })
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})

// 插件列表变化（含首次订阅回调）→ 逐插件拉取 contributions
watch(plugins, (list) => {
  for (const p of list) loadContributions(p.pluginId)
})

const hasDataSource = computed(() => dataSource !== null)
</script>

<template>
  <div data-testid="plugin-settings-page" class="flex flex-col gap-4 p-4">
    <template v-if="hasDataSource">
      <!-- 插件列表 -->
      <div
        v-for="plugin in plugins"
        :key="plugin.pluginId"
        data-testid="plugin-card"
        class="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
      >
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-foreground">{{ plugin.displayName }}</span>
          <span
            data-testid="plugin-version"
            class="rounded-sm bg-surface-2 px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            v{{ plugin.version }}
          </span>
          <span
            data-testid="plugin-enabled"
            class="rounded-sm px-1.5 py-0.5 text-xs"
            :class="plugin.enabled ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted-foreground'"
          >
            {{ plugin.enabled ? '已启用' : '已禁用' }}
          </span>
          <span
            data-testid="plugin-trust"
            class="rounded-sm bg-surface-2 px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            {{ plugin.trustLevel === 'trusted' ? '受信任' : '沙箱' }}
          </span>
        </div>

        <!-- contributions -->
        <div class="flex flex-col gap-1 pl-1">
          <template v-if="contributionsByPlugin[plugin.pluginId]?.length">
            <div
              v-for="contribution in contributionsByPlugin[plugin.pluginId]"
              :key="contribution.id"
              :data-testid="contribution.available ? 'contribution-item' : 'contribution-unavailable'"
              class="flex items-center gap-2 rounded-sm px-2 py-1 text-xs"
              :class="contribution.available ? 'text-muted-foreground' : 'is-unavailable text-muted-foreground/60'"
            >
              <span>{{ contribution.type }}</span>
              <span v-if="!contribution.available" class="text-muted-foreground/50">
                {{ contribution.reason ?? UNAVAILABLE_REASON }}
              </span>
            </div>
          </template>
          <div v-else class="px-2 py-1 text-xs text-muted-foreground/50">无贡献</div>
        </div>
      </div>

      <div v-if="plugins.length === 0" class="py-8 text-center text-sm text-muted-foreground">
        未发现已安装插件
      </div>
    </template>

    <div v-else class="py-8 text-center text-sm text-muted-foreground">
      插件数据源未注入
    </div>
  </div>
</template>
