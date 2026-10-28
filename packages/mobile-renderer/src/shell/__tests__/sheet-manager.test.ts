// Sheet 单例互斥单测（remote-use-mobile-v2 §6.13 验收条款 3：打开新的先关旧的；
// spec §4.3 浮层互斥 / A36 同一时刻最多一个 Sheet）。
//
// 纯逻辑单测（manager 槽位状态机）；壳级 Sheet 挂载消费归 u-sheets 按契约接线后由其
// 交付 DOM 断言——本单元锁 manager 自身契约（单槽覆盖语义 + 封闭词表 + 幂等）。
import { describe, expect, it, beforeEach } from 'vitest'
import {
  activeSheet,
  closeSheet,
  openSheet,
  resetSheetManagerForTesting,
  type SheetName,
} from '../sheet-manager'

describe('Sheet 单例互斥（§6.13）', () => {
  beforeEach(() => {
    resetSheetManagerForTesting()
  })

  it('初始全关（null）；打开即活动槽位', () => {
    expect(activeSheet.value).toBeNull()
    openSheet('form')
    expect(activeSheet.value).toBe('form')
  })

  it('打开新的先关旧的（单槽覆盖：旧 Sheet 不残留）', () => {
    openSheet('sessionActions')
    expect(activeSheet.value).toBe('sessionActions')
    openSheet('model')
    expect(activeSheet.value).toBe('model')
    openSheet('newTask')
    expect(activeSheet.value).toBe('newTask')
  })

  it('closeSheet 归 null；null 态调用幂等', () => {
    openSheet('permission')
    closeSheet()
    expect(activeSheet.value).toBeNull()
    expect(() => closeSheet()).not.toThrow()
    expect(activeSheet.value).toBeNull()
  })

  it('同名词重复打开幂等（不翻转、不闪烁）', () => {
    openSheet('subagentList')
    openSheet('subagentList')
    expect(activeSheet.value).toBe('subagentList')
  })

  it('Sheet 名词表封闭（§6.13 八名；新增 Sheet 先扩表）', () => {
    const all: SheetName[] = [
      'newTask',
      'sessionActions',
      'form',
      'permission',
      'model',
      'command',
      'subagentList',
      'subagentDetail',
    ]
    expect(all).toHaveLength(8)
  })
})
