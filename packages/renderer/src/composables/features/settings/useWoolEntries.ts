/**
 * useWoolEntries —— ProviderPage 羊毛条目区编排（wool-provider D6 ③/条目徽标消费侧）。
 *
 * 职责：向导入口开关 + 已接入家族条目列表（adopted 过滤）+ 条目动作编排
 * （刷新 = status+refresh 双拉取 / 一键签到 / 更新（D2 显式触发 install 钉版本升级）/
 * 失效重授权（401 分类命中后重跑 authorize/extract，凭据通道 D2）/ 卸载（D3 编排，
 * 残留提示按回执呈现）/ running 态防抖重复点击）。
 * 快照数据源 = useWool（设置域全局态单例）；本 composable 是实例级编排态
 * （ProviderPage 单页消费，随页面生命周期）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { WoolActionType, WoolFamilyState } from '@taiji/shared'
import { useToast } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import { useWool } from './useWool'

/** useWoolEntries 返回形态（类型别名：多行字面量签名触发 indent lint）。 */
export type UseWoolEntriesReturn = {
  /** 向导弹层开关（ProviderPage 入口按钮 → WoolWizard open prop）。 */
  wizardOpen: Ref<boolean>
  /** 已接入家族（adopted=true；条目区渲染清单）。 */
  adoptedFamilies: ComputedRef<WoolFamilyState[]>
  /** 动作运行中集合（family 维度；刷新/签到按钮 disabled 判定）。 */
  runningActions: Ref<Set<string>>
  /** 卸载进行中集合（family 维度；卸载按钮 disabled 判定）。 */
  uninstallingActions: Ref<Set<string>>
  /** 条目刷新（status 拉账号 + refresh 拉目录；两动作串行，失败不中断页面）。 */
  refreshEntry: (family: WoolFamilyState['family']) => Promise<void>
  /** 一键签到（checkin 动作；D5 手动形态）。 */
  checkin: (family: WoolFamilyState['family']) => Promise<void>
  /** 显式更新（install 动作重跑 = 按清单钉版本升级；D2 更新角标点击）。 */
  updateEntry: (family: WoolFamilyState['family']) => Promise<void>
  /**
   * 失效重授权（401 词界分类命中后的恢复入口，凭据通道 D2）：oauth 家族重跑 authorize
   * （重开浮层授权页）、提取族重跑 extract——凭据重新落 models.json 羊毛条目，成功后
   * 账号态经 wool.state 广播回推（失效徽标自动回落）。
   */
  reauthorize: (family: WoolFamilyState['family']) => Promise<void>
  /**
   * 卸载（D3 编排：扩展侧 clear → models.json 凭据条目删除 → 包卸载 → 羊毛域清除）。
   * credentialsCleared=false（models.json 删除被拒）时按 residualHint 弹残留提示
   * toast（不静默残留——hint 含修复指引）。
   */
  uninstall: (family: WoolFamilyState['family']) => Promise<void>
  /** 卸载确认目标（null = 无弹窗；template 赋值触发弹窗）。 */
  uninstallTarget: Ref<WoolFamilyState['family'] | null>
  /** 卸载确认弹窗开关（关闭即清目标）。 */
  uninstallDialogOpen: Ref<boolean>
  /** 卸载确认弹窗名称（目标家族显示名，无目标为空串）。 */
  uninstallName: ComputedRef<string>
  /** 确认卸载（清目标 + 触发三步编排）。 */
  confirmUninstall: () => void
}

export function useWoolEntries(): UseWoolEntriesReturn {
  const wool = useWool()
  const wizardOpen = ref(false)
  const runningActions = ref(new Set<string>())
  const uninstallingActions = ref(new Set<string>())
  const toast = useToast()
  const { t } = useI18n()

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

  async function updateEntry(family: WoolFamilyState['family']): Promise<void> {
    await runGuarded(family, [['install'], ['refresh']])
  }

  async function reauthorize(family: WoolFamilyState['family']): Promise<void> {
    const action: WoolActionType = wool.familyOf(family)?.credentialsSource === 'oauth' ? 'authorize' : 'extract'
    await runGuarded(family, [[action]])
  }

  async function uninstall(family: WoolFamilyState['family']): Promise<void> {
    if (uninstallingActions.value.has(family)) return
    uninstallingActions.value.add(family)
    try {
      const reply = await wool.runAction({ action: 'uninstall', family })
      if (reply.ok && reply.data !== undefined) {
        const result = reply.data as { credentialsCleared?: boolean; residualHint?: string }
        if (result.credentialsCleared === false) {
          // D3 降级形态：auth.json 清除通道缺失 → 残留提示显式上呈（warning 8s，需用户行动）。
          toast.warning(result.residualHint ?? t('wool.uninstallResidualFallback'))
        }
      }
      // ok=false 的领域错误信封经快照呈现（条目仍在/故障态），此处不重复弹错。
    } finally {
      uninstallingActions.value.delete(family)
    }
  }

  /** 卸载确认目标与弹窗派生（D3 三步编排的破坏性动作拦截；ExtensionActions 卸载确认同款形态）。 */
  const uninstallTarget = ref<WoolFamilyState['family'] | null>(null)
  const uninstallDialogOpen = computed({
    get: () => uninstallTarget.value !== null,
    set: (open: boolean) => {
      if (!open) uninstallTarget.value = null
    },
  })
  const uninstallName = computed(() => {
    const target = uninstallTarget.value
    return target !== null ? (adoptedFamilies.value.find((f) => f.family === target)?.displayName ?? target) : ''
  })
  function confirmUninstall(): void {
    const target = uninstallTarget.value
    if (target === null) return
    uninstallTarget.value = null
    void uninstall(target)
  }

  return { wizardOpen, adoptedFamilies, runningActions, uninstallingActions, refreshEntry, checkin, updateEntry, reauthorize, uninstall, uninstallTarget, uninstallDialogOpen, uninstallName, confirmUninstall }
}

/** 动作参数形态别名（setAutoCheckin 的 { enabled }；authorizeSignal 的 { status }；其余动作无参）。 */
type WoolActionRequestParams = { enabled?: boolean; status?: 'done' | 'cancel' }
