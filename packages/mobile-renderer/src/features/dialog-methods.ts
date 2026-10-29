// dialog-methods.ts —— FormSheet dialog 型放行/分发词表（remote-use-mobile-v2 §6.5
// 放行词表单一来源约束）。
//
// **禁新写无类型对照的手写字面量表**（A-03 同族教训：pi 协议扩型时无类型对照的副本静默
// 落后、新型被 FormSheet 丢弃 → 请求方无限等待）。本词表自 shared `ExtensionInteractMethod`
// 类型双向往照：
// - 正向（satisfies）：每个字面量必须是合法 ExtensionInteractMethod 值——越界编译红；
// - 反向（编译锁）：词表必须覆盖类型全集——shared 扩型时 Exclude 元组检查失败编译红，
//   静默落后不可能（形态参照 SUBAGENT_STATUS_COVERAGE_LOCK 先例与 runtime
//   event-adapter.ts 的 `as const satisfies readonly ExtensionInteractMethod[]`）。
// 零跨包改动（不走 shell-adapters DIALOG_METHODS 复用 + export 增补路线，§6.5 备选 A）。
import type { ExtensionInteractMethod } from '@taiji/shared'

/** dialog 四型放行/分发词表（confirm=二选一 / select=单选 / input=单行 / editor=多行预填等宽） */
export const DIALOG_METHODS = ['confirm', 'select', 'input', 'editor'] as const satisfies readonly ExtensionInteractMethod[]

export type DialogMethod = (typeof DIALOG_METHODS)[number]

/**
 * 反向穷举编译锁：DIALOG_METHODS 元组 ⊇ ExtensionInteractMethod 全集。
 * shared 扩型（如新增 'wizard'）时 Exclude 产出非空元组，extends 检查失败 → 本常量类型
 * 变 never → 赋值语句 tsc 红，FormSheet 分发必须同步扩型。
 */
type _DialogMethodsCoversAll = [
  (typeof DIALOG_METHODS)[number],
  ...Exclude<ExtensionInteractMethod, (typeof DIALOG_METHODS)[number]>[]
] extends [ExtensionInteractMethod, ...ExtensionInteractMethod[]] ? true : never

/** 编译锁消费点（值恒 true 无运行期语义——类型才承重，shared/pi-preset SUBAGENT_STATUS_COVERAGE_LOCK 同款） */
export const DIALOG_METHODS_COVERAGE_LOCK: _DialogMethodsCoversAll = true

/** 未知 method 判定（FormSheet 只读降级分支判据，ERR3 语义：不白屏不崩溃不误提交） */
export function isDialogMethod(v: unknown): v is DialogMethod {
  return typeof v === 'string' && (DIALOG_METHODS as readonly string[]).includes(v)
}
