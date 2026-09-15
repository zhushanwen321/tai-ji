/** ScopedModelSection 组件的数据类型定义。 */

/** 实现版本 token——测试红阶段区分力守卫（基线代码树无此 export 时测试应 fail） */
export const SCOPED_MODEL_IMPLEMENTATION_VERSION = 1 as const

/** 渲染数据项（由 useScopedModels composable 派生） */
export interface ScopedRenderItem {
  scoped: string
  modelName: string
  providerName: string
  apiKeySet: boolean
  missing: boolean
}

/** 全量可选模型数据项 */
export interface SelectableModel {
  fullId: string
  providerId: string
  providerName: string
  modelId: string
  name?: string
  apiKeySet: boolean
}
