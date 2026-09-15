/**
 * useSearchModal 单测（IF6，core 版）。
 *
 * 覆盖 plan TC-13：open 设 isOpen+query、open(initialQuery) 预填、close 复位、
 * toggle 开关切换、resetSearchModal 全重置。
 * 模块级单例状态跨调用共享，beforeEach resetSearchModal 隔离。
 * 环境：vitest node。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useSearchModal, resetSearchModal } from '../search-modal'

describe('useSearchModal', () => {
  beforeEach(() => {
    resetSearchModal()
  })

  it('TC-13a: open 设 isOpen=true + query（无 initialQuery 不清 query）', () => {
    const { isOpen, query, open } = useSearchModal()
    open()
    expect(isOpen.value).toBe(true)
    expect(query.value).toBe('')
  })

  it('TC-13b: open(initialQuery) 预填搜索词', () => {
    const { isOpen, query, open } = useSearchModal()
    open('src/main.ts')
    expect(isOpen.value).toBe(true)
    expect(query.value).toBe('src/main.ts')
  })

  it('TC-13c: close 复位（isOpen=false + query 清空）', () => {
    const { isOpen, query, open, close } = useSearchModal()
    open('x')
    close()
    expect(isOpen.value).toBe(false)
    expect(query.value).toBe('')
  })

  it('TC-13d: toggle 开关切换', () => {
    const { isOpen, toggle } = useSearchModal()
    toggle()
    expect(isOpen.value).toBe(true)
    toggle()
    expect(isOpen.value).toBe(false)
  })

  it('TC-13e: resetSearchModal 全重置（测试隔离）', () => {
    const { isOpen, query, open } = useSearchModal()
    open('y')
    resetSearchModal()
    expect(isOpen.value).toBe(false)
    expect(query.value).toBe('')
  })
})
