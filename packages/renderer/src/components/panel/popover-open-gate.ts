import { computed, ref } from 'vue'

/**
 * U4「切换中」单飞锁的 popover 开合门禁：switching 期间忽略开合请求（一律置关），
 * 禁止切换中重复开合/点选（并发两条切换 RPC 会让回执乱序与 session 双写竞争）。
 *
 * 以 composable 持有而非给通用 popover 原语 / ui 包 PopoverTriggerButton 加 props——
 * 锁语义归 composer 的 U4 切换锁，原语保持无感知。ModelSelectPopover /
 * ThinkingLevelPopover（Composer 展开态两触发器）共用；聚合页 ModelThinkingAggregate
 * 不锁开合、只锁 emit（切换中浮层仍可开，点击仅关浮层），故不使用本门禁。
 */
export function useSwitchingGatedPopoverOpen(isSwitching: () => boolean) {
  const open = ref(false)
  const canOpen = computed({
    get: () => open.value,
    set: (v: boolean) => { open.value = isSwitching() ? false : v },
  })
  return { open, canOpen }
}
