<!--
  TerminalInstanceBar —— 终端面板顶部实例切换条（terminal-multi-instance 设计 §3.1 / §3.3「切换条交互」）。

  纯展示组件（props in / emits out）：不持终端域状态、不碰 useTerminal / store / WS——
  实例清单与当前实例由父组件（u2 接线）注入，交互只上抛 select / create / close 三个事件。

  契约（u2 直接消费）：
  - props.instances：每个终端实例一条，`seq` 为序号（**由父组件派生，组件内不自行分配**，
    显示名 = 「终端 <seq>」经 i18n）；`alive` 供父级/验收探针读取（组件仅透传到 data-alive）。
  - props.activeTerminalId：当前显示实例编号；null = 无激活（空态/未选中）。
  - emits：select(terminalId) / create() / close(terminalId)。

  UI 规则（设计 §3.1「空态保护」+ §3.3「切换条交互」）：
  - 「+」常驻（空态亦可点）→ create；
  - 条目点击 → select；悬停条目才显关闭按钮 → close；
  - **最后一个实例的关闭按钮禁用**（disabled 且守卫不 emit）——防误触破坏性关闭，
    这是 UI 供养规则而非域不变量（实例集允许为空）；
  - 空态（实例数 0，唯一实例自然退出即归零）：占位提示 + 「+」引导；
  - 键盘切换键位不在本单元（设计明示为实施期细化项）。

  视觉：drawer 深底上的 tab 条，选中态取 DESIGN §3.4「drawer L1 icon tab」例外范式
  （`bg-surface-hover` + accent 蓝字，非 bg-elevated——drawer 与 main 同 surface，elevated 过亮）。
  颜色/圆角全部走 CSS 变量与 Tailwind token，无硬编码色值。
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
    <div
      v-for="inst in instances"
      :key="inst.terminalId"
      class="group flex items-center rounded-sm transition-colors"
      :class="isActive(inst) ? 'bg-surface-hover' : 'hover:bg-surface-2'"
    >
      <Button
        variant="ghost"
        class="h-6 max-w-[160px] gap-1 rounded-sm px-2 text-[length:var(--text-2xs)]"
        :class="
          isActive(inst)
            ? 'text-accent hover:bg-transparent'
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
      <!-- 悬停/键盘聚焦才显关闭按钮；最后实例保持禁用态可见（dim）以明示不可关闭 -->
      <span
        class="flex items-center pr-0.5 transition-opacity"
        :class="
          closeDisabled
            ? 'opacity-0 group-hover:opacity-60 group-focus-within:opacity-60'
            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
        "
      >
        <Button
          variant="ghost"
          class="size-5 shrink-0 p-0 text-neutral-dim hover:bg-danger-soft hover:text-danger"
          :disabled="closeDisabled"
          data-testid="terminal-instance-close"
          :data-terminal-id="inst.terminalId"
          :aria-label="t('panel.terminal.instanceClose')"
          :title="t('panel.terminal.instanceClose')"
          @click.stop="onClose(inst.terminalId)"
        >
          <X class="size-3" />
        </Button>
      </span>
    </div>
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
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'

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
}>()

const { t } = useI18n()

/** 最后一个实例禁用关闭（UI 供养规则，设计 §3.1）——实例集允许为空但不可被 UI 误触归零 */
const closeDisabled = computed(() => props.instances.length <= 1)

function isActive(inst: TerminalInstanceBarItem): boolean {
  return inst.terminalId === props.activeTerminalId
}

/** 默认实例名「终端 <seq>」（i18n 双侧）；重命名设计明示后置，本单元不做 */
function labelFor(inst: TerminalInstanceBarItem): string {
  return t('panel.terminal.instanceName', { seq: inst.seq })
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
