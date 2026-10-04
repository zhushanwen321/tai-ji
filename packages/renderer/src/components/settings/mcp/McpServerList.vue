<template>
  <div data-testid="mcp-server-list">
    <!-- 空清单与「文件存在但无条目」同形态（§3.1） -->
    <div
      v-if="servers.length === 0"
      class="flex flex-col items-center gap-1.5 px-4 py-10 text-center"
      data-testid="mcp-list-empty"
    >
      <ServerOff class="size-6 text-neutral-dim" />
      <p class="text-[13px] text-neutral-fg">{{ t('settings.mcp.empty') }}</p>
      <p class="text-[11px] text-neutral-mid">{{ t('settings.mcp.emptyHint') }}</p>
    </div>

    <div v-else class="flex flex-col">
      <div
        v-for="(entry, i) in servers"
        :key="entry.name"
        class="flex items-center gap-3 px-1 py-3"
        :class="i > 0 ? 'border-t border-border' : ''"
        :data-testid="`mcp-row-${entry.name}`"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-[13px] font-medium text-neutral-fg" :data-testid="`mcp-row-name-${entry.name}`">{{ entry.name }}</span>
            <span class="shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-[10px] text-neutral-mid">{{ transportLabel(entry.value) }}</span>
          </div>
          <p v-if="entry.value.description" class="mt-0.5 truncate text-[11px] text-neutral-mid">{{ entry.value.description }}</p>
          <!-- 状态徽标（D8 三类来源，只显示可探明的状态；测试时刻快照语义见页头） -->
          <div class="mt-1 flex items-center gap-2">
            <span
              v-if="entry.configError"
              class="inline-flex shrink-0 items-center gap-1 rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-medium text-warn"
              :data-testid="`mcp-badge-config-${entry.name}`"
              :title="entry.configError"
            >
              <AlertTriangle class="size-3 shrink-0" />
              {{ t('settings.mcp.badgeConfigError') }}
            </span>
            <span v-if="entry.configError" class="min-w-0 truncate text-[11px] text-warn" :data-testid="`mcp-config-error-${entry.name}`">{{ entry.configError }}</span>
            <template v-else>
              <span
                class="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                :class="badgeClass(entry.name)"
                :data-testid="`mcp-badge-${entry.name}`"
                :title="badgeTitle(entry.name)"
              >
                <Loader2 v-if="badgeState(entry.name) === 'testing'" class="size-3 shrink-0 animate-spin" />
                {{ badgeText(entry.name) }}
              </span>
              <!-- 上次成功测试结果保留展示（D3 超时语义：整体无本次结果，标注上次结果） -->
              <span
                v-if="isTimeoutWithLast(entry.name)"
                class="min-w-0 truncate text-[10px] text-neutral-mid"
                :data-testid="`mcp-badge-last-${entry.name}`"
              >{{ t('settings.mcp.badgeTimeoutLast', { result: lastProbeText(entry.name) }) }}</span>
              <!-- 连接失败完整错误详情展开（D8①：详情入口展开 error 全文） -->
              <Button
                v-if="failedDetailOf(entry.name)"
                variant="ghost"
                size="sm"
                class="h-5 shrink-0 px-1.5 text-[10px] text-muted hover:text-fg"
                :data-testid="`mcp-error-detail-toggle-${entry.name}`"
                @click="toggleDetail(entry.name)"
              >
                {{ expanded.has(entry.name) ? t('settings.mcp.errorDetailHide') : t('settings.mcp.errorDetailShow') }}
              </Button>
            </template>
          </div>
          <pre
            v-if="expanded.has(entry.name) && failedDetailOf(entry.name)"
            class="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface-2 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-neutral-mid"
            :data-testid="`mcp-error-detail-${entry.name}`"
          >{{ failedDetailOf(entry.name) }}</pre>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <Switch
            :model-value="entry.value.enabled !== false"
            :disabled="busyName !== null"
            :aria-label="t('settings.mcp.enabledLabel')"
            :data-testid="`mcp-toggle-${entry.name}`"
            @update:model-value="(v) => emit('toggle', entry, v === true)"
          />
          <Button
            variant="ghost"
            size="sm"
            class="h-7 gap-1 px-2 text-[11px] text-muted hover:text-fg"
            :disabled="busyName !== null || isTesting(entry.name)"
            :data-testid="`mcp-test-${entry.name}`"
            @click="emit('test', entry.name)"
          >
            <PlugZap class="size-3" />
            {{ isTesting(entry.name) ? t('settings.mcp.testing') : t('settings.mcp.testConnection') }}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="h-7 gap-1 px-2 text-[11px] text-muted hover:text-fg"
            :disabled="busyName !== null"
            :data-testid="`mcp-edit-${entry.name}`"
            @click="emit('edit', entry)"
          >
            <Pencil class="size-3" />
            {{ t('settings.mcp.edit') }}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="h-7 gap-1 px-2 text-[11px] text-muted hover:text-danger"
            :disabled="busyName !== null"
            :data-testid="`mcp-remove-${entry.name}`"
            @click="emit('remove', entry.name)"
          >
            <Trash2 class="size-3" />
            {{ t('settings.mcp.delete') }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * MCP 服务器清单行渲染（pi-mcp-management U3，D8 状态徽标体系）。
 *
 * 徽标优先级：配置有误（读侧校验探明，D8③，附错误摘要）> 测试状态（D8① pi 实测 /
 * D8② UI 本地过程态，缺省「未测试」）。连接失败徽标附详情入口，展开连接测试结果自身的
 * error 全文（含 stderr 尾部——pi 会话内 toast 只含首行）；「测试超时」保留并标注上次
 * 成功测试结果（D3 超时语义：整体无本次结果）。行内动作（启停 / 测试 / 编辑 / 删除）全部
 * emit 冒泡，协议调用归 McpSection 编排（本组件不含业务规则，§2.4 表现层定位）。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Loader2, Pencil, PlugZap, ServerOff, Trash2 } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import type { McpServerEntry, McpServerEntryValue, McpServerStatusBadge } from '@taiji/shared'

const props = defineProps<{
  servers: McpServerEntry[]
  /** 条目当前展示徽标（缺省 = 「未测试」）；configError 徽标优先于本表 */
  badges: Record<string, McpServerStatusBadge>
  /** 最近一次 probe 终态徽标（「测试超时」时保留展示其内容，D3） */
  lastProbe: Record<string, McpServerStatusBadge>
  /** 协议操作进行中的条目名（该行操作禁用防并发） */
  busyName: string | null
}>()

const emit = defineEmits<{
  toggle: [entry: McpServerEntry, enabled: boolean]
  test: [name: string]
  edit: [entry: McpServerEntry]
  remove: [name: string]
}>()

const { t } = useI18n()

const expanded = ref<Set<string>>(new Set())

function transportLabel(value: McpServerEntryValue): string {
  if (value.command) return t('settings.mcp.transportStdio')
  if (value.url) return t('settings.mcp.transportHttp')
  return t('settings.mcp.transportUnknown')
}

function badgeOf(name: string): McpServerStatusBadge | undefined {
  return props.badges[name]
}

function badgeState(name: string): string {
  const badge = badgeOf(name)
  if (!badge || badge.source === 'config') return 'untested'
  return badge.state
}

function isTesting(name: string): boolean {
  const badge = badgeOf(name)
  return badge?.source === 'ui-local' && badge.state === 'testing'
}

function isTimeoutWithLast(name: string): boolean {
  const badge = badgeOf(name)
  return badge?.source === 'ui-local' && badge.state === 'timeout' && props.lastProbe[name] !== undefined
}

/** probe 徽标文案（D8①：已连接（N 个工具）/ 连接失败 / 需要登录 / 已停用 + 其余实测态） */
function badgeText(name: string): string {
  const badge = badgeOf(name)
  if (!badge) return t('settings.mcp.badgeUntested')
  if (badge.source === 'ui-local') {
    if (badge.state === 'testing') return t('settings.mcp.testing')
    if (badge.state === 'timeout') return t('settings.mcp.badgeTimeout')
    return t('settings.mcp.badgeUntested')
  }
  if (badge.source === 'config') return t('settings.mcp.badgeConfigError')
  switch (badge.state) {
    case 'connected': return t('settings.mcp.badgeConnected', { count: badge.toolCount ?? 0 })
    case 'failed': return t('settings.mcp.badgeFailed')
    case 'needs-auth': return t('settings.mcp.badgeNeedsAuth')
    case 'disabled': return t('settings.mcp.badgeDisabled')
    case 'connecting': return t('settings.mcp.badgeConnecting')
    case 'disconnected': return t('settings.mcp.badgeDisconnected')
    case 'closed': return t('settings.mcp.badgeClosed')
    default: return t('settings.mcp.badgeUntested')
  }
}

function badgeClass(name: string): string {
  const badge = badgeOf(name)
  if (!badge) return 'bg-surface text-neutral-mid'
  if (badge.source === 'ui-local') {
    if (badge.state === 'testing') return 'bg-accent-soft text-accent'
    if (badge.state === 'timeout') return 'bg-warn-soft text-warn'
    return 'bg-surface text-neutral-mid'
  }
  if (badge.source === 'config') return 'bg-warn-soft text-warn'
  switch (badge.state) {
    case 'connected': return 'bg-success-soft text-success'
    case 'failed': return 'bg-danger-soft text-danger'
    case 'needs-auth': return 'bg-warn-soft text-warn'
    case 'disabled': return 'bg-surface text-neutral-mid'
    default: return 'bg-surface text-neutral-mid'
  }
}

function badgeTitle(name: string): string {
  const badge = badgeOf(name)
  if (!badge) return ''
  if (badge.source === 'probe') {
    return t('settings.mcp.testedAt', { time: new Date(badge.testedAt).toLocaleString() })
  }
  return ''
}

function failedDetailOf(name: string): string | null {
  const badge = badgeOf(name)
  if (badge?.source === 'probe' && badge.state === 'failed' && badge.errorDetail) return badge.errorDetail
  return null
}

function toggleDetail(name: string): void {
  const next = new Set(expanded.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expanded.value = next
}

function lastProbeText(name: string): string {
  const badge = props.lastProbe[name]
  if (!badge) return ''
  if (badge.source === 'probe' && badge.state === 'connected') {
    return t('settings.mcp.badgeConnected', { count: badge.toolCount ?? 0 })
  }
  return badgeTextOf(badge)
}

function badgeTextOf(badge: McpServerStatusBadge): string {
  if (badge.source === 'probe') {
    switch (badge.state) {
      case 'connected': return t('settings.mcp.badgeConnected', { count: badge.toolCount ?? 0 })
      case 'failed': return t('settings.mcp.badgeFailed')
      case 'needs-auth': return t('settings.mcp.badgeNeedsAuth')
      case 'disabled': return t('settings.mcp.badgeDisabled')
      case 'connecting': return t('settings.mcp.badgeConnecting')
      case 'disconnected': return t('settings.mcp.badgeDisconnected')
      case 'closed': return t('settings.mcp.badgeClosed')
      default: return t('settings.mcp.badgeUntested')
    }
  }
  if (badge.source === 'config') return t('settings.mcp.badgeConfigError')
  if (badge.state === 'timeout') return t('settings.mcp.badgeTimeout')
  if (badge.state === 'testing') return t('settings.mcp.testing')
  return t('settings.mcp.badgeUntested')
}
</script>
