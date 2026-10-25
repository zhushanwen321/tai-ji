<script setup lang="ts">
/**
 * 操作按钮栏（AP-3）——GuiComponent 协议首个交互原语。
 *
 * 交互契约（设计 §3.3 D2 + 容器扩展点统一 §6.4）：点击走两条宿主执行路径——
 * commandId 经 ACTION_EXECUTOR_KEY 注入的命令执行器走既有命令链（commandRegistry.execute →
 * WS plugin.executeCommand）；hostAction 经 CONTAINER_NAVIGATION_KEY 注入的容器导航执行器
 * 请求宿主打开容器（校验与状态写入在 core 执行器，两 key 均由壳层 provide 真实实现）。
 * 两者并存时 commandId 优先（分派单点 = dispatchTreeInteraction，与 ListTree 同源）。
 *
 * item 三态：
 * - 按钮（有 commandId 或 hostAction）：复用 @taiji/ui Button（ghost 档；kind:'danger' 走 danger
 *   档——确认闸是插件侧产品判断，宿主不擅自加闸，点击即执行）。disabled=true 或所需执行器
 *   缺位 → Button 禁用（视觉禁用 + 组件内 guard 双重拦截，不依赖宿主对 disabled button 吞
 *   事件的浏览器行为）。
 * - 纯展示（两字段缺省）：span 弱化文本，非按钮语义、不可点。
 *
 * 执行器缺位（standalone 挂载 / 壳层未 provide）：所需执行器缺位的交互项禁用 + warn 一次
 * （对齐 TabBar 降级出声范式——降级 ≠ 吞错）；纯展示项本就不需要执行器，不出声。
 *
 * 降级契约（D8）：未含本 type 的旧宿主由 core resolveComponent 降级 ansi-text
 * （label 经 JSON 序列化保留可读，P5 断言），本组件不参与降级决策。
 */
import { computed, inject, watch } from 'vue'
import type { GuiComponentProps } from '@zhushanwen/extension-protocol'
import Button from '../../primitives/button/Button.vue'
import { ACTION_EXECUTOR_KEY } from '../action-executor-key'
import {
  CONTAINER_NAVIGATION_KEY,
  VIEW_SCOPE_SESSION_KEY,
  dispatchTreeInteraction,
} from '../container-navigation-key'

type ActionBarItem = GuiComponentProps['action-bar']['items'][number]

const props = defineProps<{
  items: GuiComponentProps['action-bar']['items']
}>()

/** 宿主执行器（壳层 provide）；显式 undefined 默认值 = 抑制「injection not found」
 *  dev 警告（纯展示场景零噪音），缺位退化由下方 warn 承担（TabBar 同款范式）。 */
const commandExecutor = inject(ACTION_EXECUTOR_KEY, undefined)
const navigationExecutor = inject(CONTAINER_NAVIGATION_KEY, undefined)
/** 组件树所属视图的会话（ViewHost provide；无宿主 = undefined → 执行器回退焦点会话）。 */
const viewSessionId = inject(VIEW_SCOPE_SESSION_KEY, undefined)

const hasCommand = (item: ActionBarItem): boolean =>
  typeof item.commandId === 'string' && item.commandId !== ''
const hasHostAction = (item: ActionBarItem): boolean => item.hostAction !== undefined
const isExecutable = (item: ActionBarItem): boolean => hasCommand(item) || hasHostAction(item)

/** 所需执行器是否齐备：commandId 项要命令执行器；仅 hostAction 项要导航执行器
 *  （并存时按 commandId 优先分派，hostAction 为冗余声明，只要求命令执行器）。 */
const executorReady = (item: ActionBarItem): boolean => {
  if (hasCommand(item)) return commandExecutor !== undefined
  return navigationExecutor !== undefined
}

/** 点击：组件内 guard 是唯一权威防线（不依赖宿主对 disabled button 吞事件的浏览器行为），
 *  与 :disabled 属性双重一致。args 原样透传（协议层只许标量，校验在协议入口）。 */
const activate = (item: ActionBarItem): void => {
  if (item.disabled === true || !isExecutable(item) || !executorReady(item)) return
  dispatchTreeInteraction({
    commandId: item.commandId,
    args: item.args,
    hostAction: item.hostAction,
    commandExecutor,
    navigationExecutor,
    viewSessionId,
  })
}

/** 降级出声：存在所需执行器缺位的交互项 → warn 一次（防每次推送刷屏） */
const hasBlockedExecutableItem = computed(() => props.items.some((i) => isExecutable(i) && !executorReady(i)))
let warnedNoExecutor = false
watch(hasBlockedExecutableItem, (has) => {
  if (!has) {
    warnedNoExecutor = false
    return
  }
  if (warnedNoExecutor) return
  warnedNoExecutor = true
  console.warn(
    '[gui-action-bar] items 含 commandId/hostAction 但所需执行器未注入（命令链 ACTION_EXECUTOR_KEY / 容器导航 CONTAINER_NAVIGATION_KEY），交互项已禁用。修复：宿主壳层 provide 对应 key（@taiji/ui/rendering-protocol）',
  )
}, { immediate: true })
</script>

<template>
  <div class="action-bar flex flex-wrap items-center gap-2" data-testid="gui-action-bar">
    <template v-for="item in items" :key="item.id">
      <!-- 按钮（有 commandId 或 hostAction）：danger 档走 Button 危险样式；所需执行器缺位禁用 -->
      <Button
        v-if="isExecutable(item)"
        size="dense"
        :variant="item.kind === 'danger' ? 'danger' : 'ghost'"
        :disabled="item.disabled === true || !executorReady(item)"
        :data-testid="`gui-action-bar-item-${item.id}`"
        @click="activate(item)"
      >
        {{ item.label }}
      </Button>
      <!-- 纯展示（两字段缺省）：span 弱化文本，非按钮语义、天然不可点 -->
      <span
        v-else
        class="text-sm text-neutral-dim"
        :data-testid="`gui-action-bar-item-${item.id}`"
      >
        {{ item.label }}
      </span>
    </template>
  </div>
</template>
