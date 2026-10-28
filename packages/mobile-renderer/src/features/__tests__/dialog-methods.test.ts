// dialog-methods 放行词表单测（remote-use-mobile-v2 §6.5 放行词表单一来源约束；验收条款 1）。
//
// 锁定：词表 = shared ExtensionInteractMethod 全集的双向往照（satisfies 正向 + 编译锁
// 反向）——本文件把「无手写字面量漂移」扩展为运行时断言：词表键集 ≡ 类型全集（对照
// shared 权威类型可达集），FormSheet 分发面只认这四型。
import { describe, expect, it } from 'vitest'
import { DIALOG_METHODS, DIALOG_METHODS_COVERAGE_LOCK, isDialogMethod } from '../dialog-methods'

describe('dialog 放行词表（§6.5 单一来源）', () => {
  it('词表 = 四型全集（confirm/select/input/editor），顺序即分发呈现序', () => {
    expect([...DIALOG_METHODS]).toEqual(['confirm', 'select', 'input', 'editor'])
  })

  it('编译锁在位（shared 扩型时反向穷举检查编译红——运行时锚定其存在防误删）', () => {
    expect(DIALOG_METHODS_COVERAGE_LOCK).toBe(true)
  })

  it('isDialogMethod：四型放行、其余拒收（ERR3 只读降级分支判据）', () => {
    for (const m of DIALOG_METHODS) {
      expect(isDialogMethod(m)).toBe(true)
    }
    expect(isDialogMethod('wizard')).toBe(false)
    expect(isDialogMethod('')).toBe(false)
    expect(isDialogMethod(42)).toBe(false)
    expect(isDialogMethod(undefined)).toBe(false)
  })
})
