/**
 * use-provider-edit —— Provider 编辑会话装配（[C4] 由 779 行巨石拆分为 3 组 module 后的薄 facade）。
 *
 * 拆分落点（按既有裂缝，各 module 文件头注释含职责全集）：
 * - provider-edit-form.ts     表单草稿 + dirty/快照 + save 持久化（含 D8 对齐调用点）
 * - provider-edit-discover.ts test / discover 探活编排
 * - provider-edit-models.ts   模型清单 CRUD（localModels 合并、builtin∪override 回传规则）
 * - provider-edit-reconcile.ts 广播 × 用户编辑并发对齐纯核（D8 + S8 规则，接口级可测）
 * - provider-edit-types.ts    跨 module 共享类型
 *
 * 本 facade 只做两件事：① 三 module 装配（互相依赖的注入面在此接线）② provider 变化时的
 * 重置序（载入 → 瞬态重置 → 快照捕获，原 watch(props.provider) 的执行序逐字保持）。
 * 返回面收敛为 3 组子 interface（form / discover / models），调用方按组消费。
 *
 * 历史导出面（CONTEXT_OPTIONS / THINKING_STRATEGIES / API_KEY_CLEAR_SENTINEL / LocalModel /
 * ThinkingStrategy / DiscoverAction 等）已归位各 module，经 settings 域 barrel（index.ts）
 * 统一导出，消费方 import 源不变（'@taiji/core' / '@taiji/core/domain/settings'）。
 *
 * 零 '@/' import（core 零 renderer 依赖铁律）。
 */
import { watch, type Ref } from 'vue'
import type { ProviderInfo } from '@taiji/shared'
import { getSettingsStore } from './settings-store'
import type { ProviderEditDeps } from './provider-edit-types'
import type { ProviderEditFormModule } from './provider-edit-form'
import { createProviderEditForm } from './provider-edit-form'
import type { ProviderEditDiscoverModule } from './provider-edit-discover'
import { createProviderEditDiscover } from './provider-edit-discover'
import type { ProviderEditModelsModule } from './provider-edit-models'
import { createProviderEditModels } from './provider-edit-models'

/**
 * Provider 编辑会话 —— 3 组子 interface（原 31 成员扁平返回面的收敛形态）：
 * - form     表单草稿 / dirty / headers CRUD / save
 * - discover test / discover 探活
 * - models   模型清单 CRUD
 */
export interface ProviderEditSession {
  form: ProviderEditFormModule
  discover: ProviderEditDiscoverModule
  models: ProviderEditModelsModule
}

/**
 * @param providerRef 当前编辑的 provider（null = 弹窗关闭/新增态）。变化时重置全部编辑态。
 * @param deps TC4 注入：t（i18n 翻译函数，壳侧传 vue-i18n 的 global.t）。
 */
export function useProviderEdit(providerRef: Ref<ProviderInfo | null>, deps: ProviderEditDeps): ProviderEditSession {
  const { t } = deps

  const models = createProviderEditModels({ t })
  const form = createProviderEditForm({
    providerRef,
    providers: getSettingsStore().providers,
    models,
    t,
  })
  const discover = createProviderEditDiscover({
    providerRef,
    draft: form.draft,
    actionError: form.actionError,
    models,
    t,
  })

  // provider 同步：打开/切换 provider 时重置编辑态（原 watch(props.provider) 执行序逐字保持：
  // 表单载入 → 瞬态态重置 → 模型清单载入 → 记录初始快照。快照最后捕获，确保覆盖全部编辑态）。
  watch(
    () => providerRef.value,
    (p) => {
      form.applyProvider(p)
      models.applyProvider(p)
      form.resetTransient()
      discover.resetTransient()
      models.resetTransient()
      // 记录初始快照（isDirty 对比基线）。重置后立即捕获，确保用户首次输入才变 dirty。
      form.captureSnapshot()
    },
    { immediate: true },
  )

  return { form, discover, models }
}
