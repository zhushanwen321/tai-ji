/**
 * useWoolEntries —— ProviderPage 羊毛条目区编排（wool-provider D6 ③/条目徽标消费侧）。
 *
 * 职责：向导入口开关 + 已接入家族条目列表（adopted 过滤）+ 条目动作编排
 * （刷新 = status+refresh 双拉取 / 一键签到 / running 态防抖重复点击）。
 * 快照数据源 = useWool（设置域全局态单例）；本 composable 是实例级编排态
 * （ProviderPage 单页消费，随页面生命周期）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { WoolActionType, WoolFamilyState } from '@taiji/shared'
import { useWool } from './useWool'

/** useWoolEntries 返回形态（类型别名：多行字面量签名触发 indent lint）。 */
export type UseWoolEntriesReturn = {
  /** 向导弹层开关（ProviderPage 入口按钮 → WoolWizard open prop）。 */
  wizardOpen: Ref<boolean>
  /** 已接入家族（adopted=true；条目区渲染清单）。 */
  adoptedFamilies: ComputedRef<WoolFamilyState[]>
  /** 动作运行中集合（family 维度；刷新/签到按钮 disabled 判定）。 */
  runningActions: Ref<Set<string>>
  /** 条目刷新（status 拉账号 + refresh 拉目录；两动作串行，失败不中断页面）。 */
  refreshEntry: (family: WoolFamilyState['family']) => Promise<void>
  /** 一键签到（checkin 动作；D5 手动形态）。 */
  checkin: (family: WoolFamilyState['family']) => Promise<void>
}

export function useWoolEntries(): UseWoolEntriesReturn {
  const wool = useWool()
  const wizardOpen = ref(false)
  const runningActions = ref(new Set<string>())

  const adoptedFamilies = computed(() => wool.families.value.filter((f) => f.adopted))

  /** 动作互斥护栏：同 family 动作进行中时按钮 disabled（防重复点击并发编排）。 */
  async function runGuarded(family: WoolFamilyState['family'], actions: Array<[WoolActionType, WoolActionRequestParams?]>) : Promise<void> {
    if (runningActions.value.has(family)) return
    runningActions.value.add(family)
    try {
      for (const [action, params] of actions) {
        // 顺序执行（status → refresh / 单 checkin）；失败继续下一动作——条目区刷新是
        // 辅助链（部分失败由快照呈现已成功的部分，页面不因单动作失败中断）。
        await wool.runAction({ action, family, ...(params !== undefined ? { params } : {}) })
      }
    } finally {
      runningActions.value.delete(family)
    }
  }

  async function refreshEntry(family: WoolFamilyState['family']): Promise<void> {
    await runGuarded(family, [['status'], ['refresh']])
  }

  async function checkin(family: WoolFamilyState['family']): Promise<void> {
    await runGuarded(family, [['checkin']])
  }

  return { wizardOpen, adoptedFamilies, runningActions, refreshEntry, checkin }
}

/** 动作参数形态别名（setAutoCheckin 的 { enabled }；其余动作无参）。 */
type WoolActionRequestParams = { enabled?: boolean }
