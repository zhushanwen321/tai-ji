<!--
  TerminalInstanceBar —— 终端面板头部实例切换条（head 一行形态，三卡化 2026-10-04）。

  一行 = 实例 tab 条（左，flex-1 可横向滚动）+ 右簇（「+」新建、收起按钮，恒在可视区）。
  原「第二行工具栏（清屏/终止）」随 head 一行化删除（终止与 tab 关闭叉同义；清屏功能随之
  移除，用户裁决）；「收起」= 收起整个终端区（收起语义非销毁——实例保留，重开走对账恢复）。

  纯展示组件（props in / emits out）：不持终端域状态、不碰 useTerminal / store / WS——
  实例清单与当前实例由父组件（u2 接线）注入，交互只上抛 select / create / close / collapse。

  契约（u2 直接消费）：
  - props.instances：每个终端实例一条，`seq` 为序号（**由父组件派生，组件内不自行分配**，
    显示名 = 「终端 <seq>」经 i18n）；`alive` 供父级/验收探针读取（组件仅透传到 data-alive）。
  - props.activeTerminalId：当前显示实例编号；null = 无激活（空态/未选中）。
  - emits：select(terminalId) / create() / close(terminalId) / collapse()。

  tab 范式（DESIGN §3.4 tab 型统一 + 实例 tab 条范式，2026-10-04）：
  - 非激活 bg-input + border-border；激活 bg-elevated + border-strong + neutral-fg；
  - 关闭叉**常驻**（旧「hover 才显现」形态因可发现性差被用户裁决推翻），命中 20px；
  - 最后实例关闭禁用：灰置 + tooltip 明示（不再半透明伪装可点）——UI 供养规则而非域不变量；
  - tab 条 overflow-x-auto：多实例不把右簇挤出可视区（对齐 detail 文件 tab 条既有行为）。
-->
<template>
  <div data-testid="terminal-instance-bar" class="flex items-center gap-1 px-2 py-1">
    <!-- 空态：实例集归零是合法状态（唯一实例自然退出），占位提示 + 常驻「+」引导 -->
    <p
      v-if="instances.length === 0"
      data-testid="terminal-instance-empty"
      class="select-none px-1 text-[length:var(--text-2xs)] text-neutral-dim"
    >
      {{ t('panel.terminal.instanceEmpty') }}
    </p>
    <!-- tab 条：overflow-x-auto 承多实例；min-w-0 防把右簇挤出 flex 行 -->
    <div v-else class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      <div
        v-for="inst in instances"
        :key="inst.terminalId"
        class="group flex shrink-0 items-center gap-0.5 rounded-sm border transition-colors"
        :class="
          isActive(inst)
            ? 'border-border-strong bg-bg-elevated'
            : 'border-border bg-bg-input hover:bg-surface-2'
        "
      >
        <Button
          variant="ghost"
          class="h-5 max-w-[160px] gap-1 rounded-sm px-1.5 text-[length:var(--text-2xs)]"
          :class="
            isActive(inst)
              ? 'text-neutral-fg hover:bg-transparent'
              : 'text-neutral-mid hover:bg-transparent hover:text-neutral-fg'
          "
          data-testid="terminal-instance-item"
          :data-terminal-id="inst.terminalId"
          :data-active="isActive(inst) ? 'true' : 'false'"
          :data-alive="inst.alive ? 'true' : 'false'"
          :aria-current="isActive(inst) ? 'true' : undefined"
          :title="labelFor(inst)"
          @click="onSelect(inst.terminalId)"
        >
          <span class="truncate">{{ labelFor(inst) }}</span>
        </Button>
        <!-- 关闭叉常驻（可发现性）；最后实例灰置禁用并明示不可关 -->
        <Button
          variant="ghost"
          class="mr-0.5 size-5 shrink-0 rounded-sm p-0"
          :class="
            closeDisabled
              ? 'text-neutral-faint opacity-40'
              : 'text-neutral-dim hover:bg-danger-soft hover:text-danger'
          "
          :disabled="closeDisabled"
          data-testid="terminal-instance-close"
          :data-terminal-id="inst.terminalId"
          :aria-label="closeDisabled ? t('panel.terminal.instanceCloseDisabled') : t('panel.terminal.instanceClose')"
          :title="closeDisabled ? t('panel.terminal.instanceCloseDisabled') : t('panel.terminal.instanceClose')"
          @click.stop="onClose(inst.terminalId)"
        >
          <X class="size-3" />
        </Button>
      </div>
    </div>
    <!-- 右簇：「+」新建 + 收起整个终端区（shrink-0 恒在可视区） -->
    <div class="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0 text-neutral-mid hover:text-neutral-fg"
        data-testid="terminal-instance-create"
        :aria-label="t('panel.terminal.instanceCreate')"
        :title="t('panel.terminal.instanceCreate')"
        @click="onCreate"
      >
        <Plus class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0 text-neutral-mid hover:text-neutral-fg"
        data-testid="terminal-collapse"
        :aria-label="t('panel.terminal.collapse')"
        :title="t('panel.terminal.collapse')"
        @click="emit('collapse')"
      >
        <ChevronDown class="size-3.5" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Plus, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { instanceLabel } from '@/composables/features/terminal/terminal-instance-registry'

/**
 * 切换条条目（u2 契约）：terminalId 为实例编号 `term:<sid>:<seq>`；seq 由父组件从编号派生
 * 或按 runtime 分配结果登记，**组件内不自行分配序号**（避免刷新/重连后界面与后台撞号）。
 */
export interface TerminalInstanceBarItem {
  terminalId: string
  seq: number
  alive: boolean
}

const props = defineProps<{
  instances: TerminalInstanceBarItem[]
  activeTerminalId: string | null
}>()

const emit = defineEmits<{
  (e: 'select', terminalId: string): void
  (e: 'create'): void
  (e: 'close', terminalId: string): void
  (e: 'collapse'): void
}>()

const { t } = useI18n()

/** 最后一个实例禁用关闭（UI 供养规则，设计 §3.1）——实例集允许为空但不可被 UI 误触归零 */
const closeDisabled = computed(() => props.instances.length <= 1)

function isActive(inst: TerminalInstanceBarItem): boolean {
  return inst.terminalId === props.activeTerminalId
}

/** 默认实例名「终端 <seq>」（i18n 双侧，registry 单一源）；重命名设计明示后置，本单元不做 */
function labelFor(inst: TerminalInstanceBarItem): string {
  return instanceLabel(inst.terminalId)
}

function onSelect(terminalId: string): void {
  emit('select', terminalId)
}

function onCreate(): void {
  emit('create')
}

function onClose(terminalId: string): void {
  // 双保险：disabled 之外再守卫一次（合成点击事件在无激活语义的环境下仍可能派发到 handler）
  if (closeDisabled.value) return
  emit('close', terminalId)
}
</script>
