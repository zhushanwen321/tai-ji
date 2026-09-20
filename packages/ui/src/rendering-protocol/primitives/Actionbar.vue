<script setup lang="ts">
/**
 * 操作按钮栏（AP-3）——GuiComponent 协议首个交互原语。
 *
 * 交互契约（设计 §3.3 D2）：点击不复用 tab-bar 的「本地索引」语义，而是经
 * ACTION_EXECUTOR_KEY 注入的宿主执行器走既有命令链（commandRegistry.execute →
 * WS plugin.executeCommand），协议不新增回调通道。执行器由壳层 provide 真实
 * 实现；本组件只定义最小结构接口（ActionExecutor，key 权威在 action-executor-key.ts）。
 *
 * item 三态（设计 AP-3）：
 * - 按钮（有 commandId）：复用 @taiji/ui Button（ghost 档；kind:'danger' 走 danger
 *   档——确认闸是插件侧产品判断，宿主不擅自加闸，点击即执行）。disabled=true 或
 *   执行器缺位 → Button 禁用（视觉禁用 + 组件内 guard 双重拦截，不依赖宿主对
 *   disabled button 吞事件的浏览器行为）。
 * - 纯展示（commandId 缺省）：span 弱化文本，非按钮语义、不可点。
 *
 * 执行器缺位（standalone 挂载 / 壳层未 provide）：带 commandId 的项禁用 + warn 一次
 * （对齐 TabBar 降级出声范式——降级 ≠ 吞错）；纯展示项本就不需要执行器，不出声。
 *
 * 降级契约（D8）：未含本 type 的旧宿主由 core resolveComponent 降级 ansi-text
 * （label 经 JSON 序列化保留可读，P5 断言），本组件不参与降级决策。
 */
import { computed, inject, watch } from 'vue'
import type { GuiComponentProps } from '@zhushanwen/extension-protocol'
import Button from '../../primitives/button/Button.vue'
import { ACTION_EXECUTOR_KEY } from '../action-executor-key'

type ActionBarItem = GuiComponentProps['action-bar']['items'][number]

const props = defineProps<{
  items: GuiComponentProps['action-bar']['items']
}>()

/** 宿主执行器（壳层 provide）；显式 undefined 默认值 = 抑制「injection not found」
 *  dev 警告（纯展示场景零噪音），缺位退化由下方 warn 承担（TabBar 同款范式）。 */
const executor = inject(ACTION_EXECUTOR_KEY, undefined)

const hasCommand = (item: ActionBarItem): boolean =>
  typeof item.commandId === 'string' && item.commandId !== ''

/** 点击：组件内 guard 是唯一权威防线（不依赖宿主对 disabled button 吞事件的浏览器行为），
 *  与 :disabled 属性双重一致。args 原样透传（协议层只许标量，校验在协议入口）。 */
const activate = (item: ActionBarItem): void => {
  if (executor === undefined) return
  const commandId = item.commandId
  if (typeof commandId !== 'string' || commandId === '' || item.disabled === true) return
  executor.execute(commandId, item.args)
}

/** 降级出声：存在 commandId 项但执行器缺位 → warn 一次（防每次推送刷屏） */
const hasExecutableItem = computed(() => props.items.some(hasCommand))
let warnedNoExecutor = false
watch(hasExecutableItem, (has) => {
  if (!has || executor !== undefined) {
    warnedNoExecutor = false
    return
  }
  if (warnedNoExecutor) return
  warnedNoExecutor = true
  console.warn(
    '[gui-action-bar] items 含 commandId 但 ACTION_EXECUTOR_KEY 未注入，交互项已禁用。修复：宿主壳层 provide ACTION_EXECUTOR_KEY（@taiji/ui/rendering-protocol/action-executor-key）',
  )
}, { immediate: true })
</script>

<template>
  <div class="action-bar flex flex-wrap items-center gap-2" data-testid="gui-action-bar">
    <template v-for="item in items" :key="item.id">
      <!-- 按钮（有 commandId）：danger 档走 Button 危险样式；执行器缺位禁用 -->
      <Button
        v-if="hasCommand(item)"
        size="dense"
        :variant="item.kind === 'danger' ? 'danger' : 'ghost'"
        :disabled="item.disabled === true || executor === undefined"
        :data-testid="`gui-action-bar-item-${item.id}`"
        @click="activate(item)"
      >
        {{ item.label }}
      </Button>
      <!-- 纯展示（commandId 缺省）：span 弱化文本，非按钮语义、天然不可点 -->
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
