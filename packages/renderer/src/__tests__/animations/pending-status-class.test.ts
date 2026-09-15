import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Plan 06 — pending 状态死类 animate-bounce-small 修复回归测试。
 * 源码字符串断言：pending 改用既有 animate-pulse-strong（TC1）+ 死类零残留（TC2）
 * + 其他状态 animation 不受影响（TC3，边界）。
 */
const rendererSrc = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(resolve(rendererSrc, rel), 'utf-8')

const sessionStatus = read('src/composables/logic/sessionStatus.ts')
const tailwindConfig = read('tailwind.config.ts')
const styleCss = read('src/style.css')

describe('plan 06 pending 死类修复', () => {
  it('TC1: pending 改用 animate-pulse-strong', () => {
    expect(sessionStatus).toContain(
      "pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-pulse-strong' }",
    )
  })

  it('TC2: 死类 animate-bounce-small 零残留（生产源码不含）', () => {
    expect(sessionStatus).not.toContain('animate-bounce-small')
  })

  it('TC3 边界: 其他状态 animation 字段不受影响', () => {
    // streaming/compacting/working 的 spin 保留
    expect(sessionStatus).toContain("streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    expect(sessionStatus).toContain("compacting: { icon: 'Hourglass', color: 'text-accent', animation: 'animate-spin' }")
    expect(sessionStatus).toContain("working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    // retrying 的 pulse-strong 保留
    expect(sessionStatus).toContain("retrying: { icon: 'Zap', color: 'text-warn', animation: 'animate-pulse-strong' }")
    // waiting 保持 ''（wave4 改动不得回退）
    expect(sessionStatus).toContain("waiting: { icon: 'Wrench', color: 'text-warn', animation: '' }")
    // 不新增 bounce-small 定义
    expect(tailwindConfig).not.toContain('bounce-small')
    expect(styleCss).not.toContain('bounce-small')
  })
})
