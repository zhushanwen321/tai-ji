/**
 * provider-edit-reconcile —— 「广播 × 用户编辑并发」对齐规则纯核（[C4] 自 use-provider-edit.ts
 * 的 D8 deep watch 执行序中提炼）。
 *
 * 背景（D8）：编辑弹窗打开期间外部广播可能整体替换 settingsStore.providers（onProviders 整体
 * 推回），弹窗表单不刷新会覆盖并发变更。原实现把对齐规则埋在 `watch(providers, { deep: true })`
 * 的执行序里（dirty 单字段例外 / 非 dirty 整体重拍快照），interface 无法测试——本文件把规则
 * 提成**纯函数** `reconcileBroadcast`，deep watch 退化为它的一个调用点（provider-edit-form.ts），
 * 并发规则从此接口级可测（行为矩阵见 provider-edit-reconcile.test.ts）。
 *
 * 三条分支语义（逐字保持原执行序语义，含 S8 的 authMethod 单字段例外）：
 * ① 非 dirty（用户未手动改）→ 整体重拍：form 全部字段 + localModels 对齐 fresh，随后重捕获快照
 *    （新基线，避免下次广播触发不必要的「dirty」）。快照对齐一处 = 本文件 + applyDecision 调用点。
 * ② dirty + authMethod 例外（BL round1 S4 / S8）：用户未手动切换凭证形态（draft.authMethod 仍
 *    等于快照位）而广播携带新形态（编辑体内发起 OAuth 授权 → 父组件 setProvider authMethod='oauth'
 *    回推）→ 只对齐该字段并单独重拍快照的 authMethod 位，否则后续 save 会用本地旧形态覆写刚写入
 *    的 oauth 标注（apiKey 有值还会覆写凭证）。其余字段保持用户未保存编辑。
 * ③ dirty 且无例外 → 不动（用户改动优先）。
 *
 * 纯度约定：本函数不触碰任何 ref/reactive——decision 携带全部待应用值，快照 authMethod 位的
 * 「手改快照」动作由调用点执行（decision.authMethod 即写入值）。
 */
import type { ProviderInfo } from '@taiji/shared'
import type { FormSnapshot } from './provider-edit-types'
import { toEditableModels, type LocalModel } from './provider-edit-models'

/**
 * provider → 编辑表单的字段映射（load 与 D8 整体重拍共用同一份映射，快照对齐一处）。
 *
 * 映射语义（原 watch 两处手写赋值的字面归一）：
 * - name 原样；api 缺省回退 'anthropic-messages'（三值 Select 历史兜底）；baseUrl 缺省回退 ''
 * - headers 整对象浅拷贝（缺省 = 空对象）；authHeader 缺省 false；authMethod 原样（可 undefined）
 * - **不含 apiKey**：apiKey 是用户草稿（明文/env 引用/清除哨兵），load 时另行重置为空
 *   （=「不变」），广播重拍时绝不触碰（不能让广播抹掉用户已输入的 key）。
 */
export interface ProviderFormPatch {
  name: string
  api: string
  baseUrl: string
  headers: Record<string, string>
  authHeader: boolean
  authMethod: ProviderInfo['authMethod']
}

/** provider → 表单字段映射（纯）。p = null 时返回新增态的空表单默认值。 */
export function formPatchFromProvider(p: ProviderInfo | null): ProviderFormPatch {
  if (!p) {
    return { name: '', api: 'anthropic-messages', baseUrl: '', headers: {}, authHeader: false, authMethod: undefined }
  }
  return {
    name: p.name,
    api: p.api ?? 'anthropic-messages',
    baseUrl: p.baseUrl ?? '',
    headers: p.headers ? { ...p.headers } : {},
    authHeader: p.authHeader ?? false,
    authMethod: p.authMethod,
  }
}

/** reconcile 裁决（调用点按 action 机械执行；repaint 携带完整待应用值） */
export type BroadcastReconcileDecision =
  /** 分支③：dirty 且无 authMethod 例外——用户改动优先，什么都不动 */
  | { action: 'ignore' }
  /** 分支②：dirty 单字段例外——只对齐 authMethod（form 与快照 authMethod 位同值重拍） */
  | { action: 'align-auth-method'; authMethod: ProviderInfo['authMethod'] }
  /** 分支①：非 dirty 整体重拍——应用 form patch + models 后重捕获快照 */
  | { action: 'repaint'; form: ProviderFormPatch; models: LocalModel[] }

/**
 * 广播与用户编辑并发的对齐规则（纯）。
 *
 * @param fresh 本次广播携带的同 provider 最新数据（调用点已按编辑目标 id 定位）
 * @param draft 当前表单草稿（只读 authMethod 位——S8 例外判据需要区分「用户手动切换过形态」）
 * @param isDirty form 相对打开时快照是否有变更（D13 判定，form module 派生）
 * @param snapshot 打开时快照（null = 未初始化；此时 isDirty 恒 false，走分支①）
 */
export function reconcileBroadcast(
  fresh: ProviderInfo,
  draft: { authMethod: ProviderInfo['authMethod'] },
  isDirty: boolean,
  snapshot: FormSnapshot | null,
): BroadcastReconcileDecision {
  if (!isDirty) {
    return { action: 'repaint', form: formPatchFromProvider(fresh), models: toEditableModels(fresh) }
  }
  // [BL round1 S4] dirty 单字段例外：用户未手动切换凭证形态（draft.authMethod 仍等于快照值）
  // 而广播携带新形态 → 强制对齐该字段（快照 authMethod 位同值重拍，调用点执行「手改快照」）。
  // 用户已手动切换（pending 未保存）则不对齐——本地切换意图优先。
  if (snapshot && draft.authMethod === snapshot.authMethod && draft.authMethod !== fresh.authMethod) {
    return { action: 'align-auth-method', authMethod: fresh.authMethod }
  }
  return { action: 'ignore' }
}
