/**
 * provider-edit 共享类型 —— 三个编辑 module（form / discover / models）+ 纯 reconcile 核
 * 共用的最小契约面（[C4] 拆分自 use-provider-edit.ts）。
 *
 * 只放跨 module 的类型/别名，不含实现（实现分布见各 module 文件头注释）：
 * - provider-edit-form.ts     表单草稿 + dirty/快照 + save 持久化
 * - provider-edit-discover.ts test/discover 探活编排
 * - provider-edit-models.ts   模型清单 CRUD（localModels 合并、builtin∪override 回传规则）
 * - provider-edit-reconcile.ts 广播 × 用户编辑并发对齐纯核（D8 + S8）
 */
import type { ProviderInfo } from '@taiji/shared'

/** i18n 翻译函数（TC4 注入：壳侧传 vue-i18n 的 global.t 的最小结构类型）。 */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** useProviderEdit 的 deps（TC4 注入）。 */
export interface ProviderEditDeps {
  t: Translate
}

/**
 * save 结果：ok=是否成功；wroteApiKey=本次是否写入了非空 apiKey（明文/env 引用，
 * 哨兵清空与「不变」均 false）；quotaAutoEnabled=setProvider reply（新建分支自动开启
 * coding-plan 额度显示写成功，供父组件 toast）。
 */
export interface SaveResult {
  ok: boolean
  wroteApiKey: boolean
  quotaAutoEnabled?: boolean
}

/**
 * 打开时的初始快照（用于 isDirty 对比，D13 取消确认）。
 * 每次 provider 变化重置编辑态后记录；手动改 form/localModels 后 isDirty=true。
 */
export interface FormSnapshot {
  name: string
  api: string
  baseUrl: string
  /** apiKey 是否被「清除」（哨兵态或用户输入了值都算 dirty） */
  apiKeyChanged: boolean
  /** models 整体序列化（增删 + 内部字段如 compat/thinkingLevelMap/contextWindow/input 改都触发 dirty） */
  modelsJson: string
  /** provider 级 authHeader（W3 D7） */
  authHeader: boolean
  /** provider 级 headers 序列化（W3 D7：JSON 串对比，键值任一变更即 dirty） */
  headersJson: string
  /** 凭证形态（B-1：形态切换即 dirty；D8/S8 并发对齐也读写本位） */
  authMethod: ProviderInfo['authMethod']
}
