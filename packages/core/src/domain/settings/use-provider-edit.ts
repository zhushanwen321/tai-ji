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
 * 本 facade 只做两件事：① 三 module 装配（互相依赖的注入点在此接线）② provider 变化统一经
 * form.reconcile 分流后的重置序编排（id 变化：载入 → 瞬态重置 → 快照捕获，执行序逐字保持；
 * 同 id 刷新由 form module 的 applyReconcile 承接——保留编辑态刷新数据，SG-8 契约见
 * ProviderEditFormModule.reconcile JSDoc）。返回结构收敛为 3 组子 interface（form / discover
 * / models），调用方按组消费。
 *
 * 历史导出清单（CONTEXT_OPTIONS / THINKING_STRATEGIES / API_KEY_CLEAR_SENTINEL / LocalModel /
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
import { createProviderEditForm, resolveApiKeyForSave } from './provider-edit-form'
import type { ProviderEditDiscoverModule } from './provider-edit-discover'
import { createProviderEditDiscover } from './provider-edit-discover'
import type { ProviderEditModelsModule } from './provider-edit-models'
import { createProviderEditModels } from './provider-edit-models'

/**
 * Provider 编辑会话 —— 3 组子 interface（原 31 成员扁平返回结构的收敛形态）：
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
 * @param providerRef 当前编辑的 provider（null = 弹窗关闭/新增态）。变化统一经
 *   form.reconcile 分流（SG-8）：**id 变化**（含打开/关闭/切换）重置全部编辑态；
 *   **同 id 新对象**保留编辑态、按广播对齐规则刷新（applyReconcile）——无论新引用来自
 *   settings store 列表元素替换还是独立构造的 prop。取自 store 列表时与 form module 的
 *   watch(providers) 广播对齐共享同一数据源（同 id 场景两条路径重复处理幂等），但不再是
 *   硬性契约——分流判据在 form module 内（已载入 id），不依赖调用方数据源形态。
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
    // discover 的 apiKey 取「真实未保存草稿」同源判据（MF-1-1）：回显值 = 所存值，不发 payload
    // 键（runtime 走 resolver 才能展开 $ENV / 走 auth.json 优先链）；哨兵 → '' 清除语义保留。
    pendingApiKey: () => resolveApiKeyForSave(form.apiKeyPendingDraft.value),
    // 动作错误写通道（MF-1-7）：discover 侧写入统一落 source='discover' 标签，
    // 错误归属由 form module 按 source 判定（不比对展示文案）
    reportActionError: (message) => form.setActionError('discover', message),
    clearActionError: () => form.clearActionError(),
    models,
    t,
  })

  // provider 同步（SG-8）：providerRef 变化统一经 form.reconcile 分流——id 变化（含打开/
  // 关闭/切换）→ 'reset'，facade 编排跨 module 重置序（原执行序逐字保持：表单载入（reconcile
  // 内 applyProvider）→ 瞬态态重置 → 模型清单载入 → 记录初始快照，快照最后捕获确保覆盖全部
  // 编辑态）；同 id 新对象 → 'refreshed'，保留编辑态按广播对齐规则刷新（applyReconcile，
  // 与 form module 的 watch(providers) 同一处理路径，幂等——不在这里重复重置）。
  watch(
    () => providerRef.value,
    (p) => {
      if (form.reconcile(p) !== 'reset') return
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
