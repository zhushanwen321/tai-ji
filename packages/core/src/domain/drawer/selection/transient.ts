/**
 * 瞬时参数（selectedCommandName / detailFilePath）——display-containers §6.6②：从全局单例
 * 改为按会话分区（W0 还债）。解决「跨会话劫持首次打开」：A 会话的链接点击不再被 B 会话的
 * 旧参数污染（改前全局单例 = 跨会话串写）。「切回 A 恢复 A 的文件详情」不在 W0 承诺内——
 * detail 展示链另有 fileTreeStore.selectedPath 全局单值与 DetailPane 单实例态两个全局点，
 * 由 W3 的 useDetailPane 单值→map 改造顺带解决（§7.1 瞬时参数范围说明）。
 *
 * 语义（迁移保持）：打开时写入、按消费语义清除——selectedCommandName 是 CommandDocPanel
 * 的活数据源（连续 computed 读取、不清空）；detailFilePath 由 useDetailPane watch 消费后
 * 置 null（避免残留导致下次打开 detail tab 被旧值劫持）。
 *
 * 读取面 = 可写 computed（名字沿用旧全局 ref：selectedCommandName / detailFilePath），
 * 既有消费方（useSideDrawer 兼容层 / CommandDocPanel / useDetailPane）`.value` 读写零改动。
 */
import { computed, reactive } from 'vue'
import type { WritableComputedRef } from 'vue'
import { useSessionScopedState } from '../../../foundation/use-session-scoped-state'
import { drawerSessionKey } from '../control'

/** 瞬时参数分区（per-session，useSessionScopedState，ADR-0049） */
export interface TransientParamsState { // oe-exempt:20261003:framework:类型契约先行——selection 分区契约，renderer 消费面即本批 D1 单元
  /** Doc tab 当前展示的命令名（如 '/commit'，点击用户气泡 slash chip 时设置） */
  selectedCommandName: string | null
  /** Detail tab 打开时立即展示的文件路径（变更集卡等非文件树入口设置，useDetailPane 消费后清空） */
  detailFilePath: string | null
}

function createDefaultTransientParams(): TransientParamsState {
  // reactive 容器契约（ADR-0049 W2 教训）：plain object 的 mutate 不触发下游重算
  return reactive({
    selectedCommandName: null,
    detailFilePath: null,
  })
}

const params = useSessionScopedState<TransientParamsState>(
  drawerSessionKey,
  createDefaultTransientParams,
)

/**
 * Doc tab 当前展示的命令名（可写 computed：读当前会话分区，写落当前会话分区）。
 * 点击用户气泡 slash chip 时经 coordination.openDrawerTab('doc', { commandName }) 写入。
 */
export const selectedCommandName: WritableComputedRef<string | null> = computed({
  get: () => params.current.value.selectedCommandName,
  set: (v) => {
    params.current.value.selectedCommandName = v
  },
})

/**
 * Detail tab 打开时立即展示的文件路径（可写 computed，同上分区语义）。
 * 由变更集卡等非文件树入口经 openDrawerTab('detail', { filePath }) 设置；useDetailPane
 * watch 它并强制 diff 模式，用完置 null（消费后清空，防残留劫持下次打开）。
 */
export const detailFilePath: WritableComputedRef<string | null> = computed({
  get: () => params.current.value.detailFilePath,
  set: (v) => {
    params.current.value.detailFilePath = v
  },
})

/** 清空瞬时参数分区（测试隔离用）。生产代码禁止调用。 */
export function _resetTransientParamsForTest(): void {
  params._clearAllForTest()
}
