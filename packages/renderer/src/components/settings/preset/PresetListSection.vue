<!--
  Settings · Pi 预设列表区（PresetListSection）。
  预设卡片列表（内置 + 自定义）+ 展开态 + 折叠摘要 + 操作按钮（设为默认/恢复/删除）。
  数据来自 props（容器注入），本组件只做渲染 + 事件 emit。
  详情编辑区（name/id/desc + 工具/扩展黑白名单）在 PresetDetailSection。
-->
<template>
  <GroupCard :title="t('settings.preset.groupTitle')">
    <!-- 空态 -->
    <div v-if="!presets.length" class="py-8 text-center text-[12px] text-neutral-mid">
      {{ t('settings.preset.empty') }}
    </div>

    <!-- 预设列表（每个卡片独立折叠：自定义默认展开便于编辑，内置默认折叠便于扫视） -->
    <!-- 卡片层叠：GroupCard 提供 bg-card 容器，单个预设用 bg-bg + border 浮起分层（v6 §5.8） -->
    <Collapsible
      v-for="p in presets"
      :key="p.id"
      :open="isExpanded(p.id)"
      class="rounded border border-border bg-bg"
      :class="isExpanded(p.id) ? 'border-border-strong' : ''"
      @update:open="(v) => toggleExpanded(p.id, v)"
    >
      <!-- 预设头部：CollapsibleTrigger as-child 包 Button，构成全宽点击区。
           操作按钮组（设为默认/恢复/删除）放 Trigger 外的同级 div，避免点操作也触发展开。 -->
      <div class="flex items-center gap-3 px-3 py-2.5">
        <CollapsibleTrigger as-child>
          <Button
            variant="ghost"
            class="h-auto flex-1 justify-start gap-2 rounded-sm px-2 text-neutral-fg hover:bg-surface"
            :title="isExpanded(p.id) ? t('settings.preset.collapse') : t('settings.preset.expand')"
          >
            <ChevronDown
              class="size-3.5 shrink-0 text-neutral-dim transition-transform duration-[var(--duration)] ease-[var(--ease)]"
              :class="isExpanded(p.id) ? 'rotate-180' : ''"
            />
            <div class="min-w-0 flex-1 flex flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span class="truncate text-[13px] font-medium">{{ p.name }}</span>
                <span
                  v-if="p.builtin"
                  class="rounded-sm bg-surface px-1.5 py-0.5 text-[11px] text-neutral-dim"
                >{{ t('settings.preset.builtin') }}</span>
                <span
                  v-if="p.id === defaultPresetId"
                  class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent"
                >{{ t('settings.preset.default') }}</span>
              </div>
              <!-- 折叠态摘要行：一行 mode 概览（如「工具访问策略: 全部可用 · 扩展访问策略: 白名单 3 项」） -->
              <span class="truncate text-[11px] text-neutral-mid">{{ summaryText(p) }}</span>
              <!-- 展开态额外显示描述（折叠态由摘要代替，避免行数过多） -->
              <span v-if="p.description && isExpanded(p.id)" class="truncate text-[11px] text-neutral-dim">{{ p.description }}</span>
            </div>
          </Button>
        </CollapsibleTrigger>
        <div class="flex items-center gap-1">
          <!-- 设为默认 -->
          <Button
            v-if="p.id !== defaultPresetId"
            variant="ghost"
            size="dense"
            class="rounded-sm text-[11px] text-neutral-dim hover:text-neutral-fg"
            @click="emit('set-default', p.id)"
          >
            <Star class="size-3.5" />
            {{ t('settings.preset.setDefault') }}
          </Button>
          <!-- 恢复默认（仅内置） -->
          <Button
            v-if="p.builtin"
            variant="ghost"
            size="dense"
            class="rounded-sm text-[11px] text-neutral-dim hover:text-neutral-fg"
            :disabled="restoring.has(p.id)"
            @click="emit('restore', p)"
          >
            <RotateCcw class="size-3.5" />
            {{ t('settings.preset.restore') }}
          </Button>
          <!-- 删除（仅自定义） -->
          <Button
            v-if="!p.builtin"
            variant="ghost"
            size="dense"
            class="rounded-sm text-[11px] text-neutral-dim hover:text-danger"
            @click="emit('delete', p.id)"
          >
            <Trash2 class="size-3.5" />
          </Button>
        </div>
      </div>

      <!-- 详情编辑区（仅展开时渲染，内容组件见 PresetDetailSection） -->
      <CollapsibleContent class="border-t border-border">
        <slot :preset="p" :disabled="p.builtin" />
      </CollapsibleContent>
    </Collapsible>

    <!-- 3 个内置扩展提示 -->
    <p v-if="presets.length" class="text-[11px] text-neutral-dim">
      {{ t('settings.preset.builtinExtensionHint') }}
    </p>
  </GroupCard>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Star, Trash2, RotateCcw, ChevronDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { GroupCard } from '@taiji/ui/features/settings'
import type { PiLaunchPreset, ToolMode, ExtensionMode } from '@taiji/shared'

const props = defineProps<{
  presets: PiLaunchPreset[]
  defaultPresetId: string
  restoring: Set<string>
}>()

const emit = defineEmits<{
  'set-default': [presetId: string]
  restore: [preset: PiLaunchPreset]
  delete: [presetId: string]
}>()

const { t } = useI18n()

/**
 * expandedIds —— 每个预设卡片的展开态（id → 是否展开）。
 *
 * 初始化为空 Set，由下方 watch(presets) 在预设加载/新增时按 builtin 决定初始态：
 * 自定义预设默认展开（用户要编辑），内置预设默认折叠（当作文档扫视）。
 * 不能在 setup eager 初始化（此时 presets 为空，loadPresets 在 onMounted 异步跑），
 * 否则 expandedIds 永远空 → 生产环境自定义预设也折叠（与设计意图相反）。
 * 用户手动折叠/展开后，对应 id 的态被记住，不被 watch 覆盖（watch 只处理未见过的 id）。
 *
 * 删除预设时 stale id 残留：无害（isExpanded 只对当前渲染的预设调用），不专门清理。
 */
const expandedIds = ref<Set<string>>(new Set())
function isExpanded(id: string): boolean {
  return expandedIds.value.has(id)
}
function toggleExpanded(id: string, open: boolean): void {
  const next = new Set(expandedIds.value)
  if (open) next.add(id)
  else next.delete(id)
  expandedIds.value = next
}

/**
 * watch presets —— 新预设出现时按 builtin 决定初始展开态。
 *
 * 只处理「未见过的 id」（expandedIds 里没有的），避免覆盖用户手动操作过的态。
 * immediate: true 覆盖首屏 store 已有数据的情况（页面挂载前 store 可能已被
 * 其他入口预加载）；非 immediate 路径覆盖 onMounted loadPresets 后异步到达的情况。
 */
watch(
  () => props.presets,
  (next) => {
    const nextSet = new Set(expandedIds.value)
    for (const p of next) {
      if (!nextSet.has(p.id) && !p.builtin) {
        nextSet.add(p.id)
      }
    }
    expandedIds.value = nextSet
  },
  { immediate: true },
)

/**
 * 单个 mode 的小标题：生成如「全部可用」/「白名单 3 项」。
 *
 * allowlist 看的是 allowedTools/allowedExtensions（被显式授权的数量），
 * denylist 看的是 deniedTools/deniedExtensions（被显式禁用的数量）——
 * 即「用户特殊配置了几项」。由调用方传入对应模式的 list。
 */
function modeSummary(mode: ToolMode | ExtensionMode, list: string[] | undefined): string {
  switch (mode) {
    case 'all':
      return t('settings.preset.summaryAll')
    case 'none':
      return t('settings.preset.summaryNone')
    case 'allowlist':
      return t('settings.preset.summaryAllowlist', { count: list?.length ?? 0 })
    case 'denylist':
      return t('settings.preset.summaryDenylist', { count: list?.length ?? 0 })
    default:
      // 未来 ToolMode/ExtensionMode 加枚举值时兜底返回空，避免静默返回 undefined
      return ''
  }
}

/**
 * 折叠态摘要行：拼接「工具访问策略: xxx · 扩展访问策略: yyy」一行 mode 概览。
 * 让用户在折叠态即可扫视每个预设的访问策略，无需展开。
 */
function summaryText(p: PiLaunchPreset): string {
  const toolList = p.toolMode === 'allowlist' ? p.allowedTools : p.deniedTools
  const extList = p.extensionMode === 'allowlist' ? p.allowedExtensions : p.deniedExtensions
  const tool = `${t('settings.preset.toolMode')}: ${modeSummary(p.toolMode, toolList)}`
  const ext = `${t('settings.preset.extensionMode')}: ${modeSummary(p.extensionMode, extList)}`
  return tool + t('settings.preset.summarySeparator') + ext
}
</script>
