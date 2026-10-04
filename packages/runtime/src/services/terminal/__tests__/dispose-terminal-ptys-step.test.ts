/**
 * dispose-terminal-ptys 步骤单测（shutdown 链孤儿 shell 加固③的单步语义锁定）。
 *
 * index.ts 组合根 import 即执行 main() 不可直测——步骤本体提取在
 * dispose-terminal-ptys-step.ts，此处锁定：① 先打点（shutdownStep('dispose-terminal-ptys')）
 * 再 destroyAllPties 的顺序契约；② destroyAllPties 不在本层吞错（shutdown 外层 catch
 * 统一记日志，错误路径语义不因提取改变）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/terminal/__tests__/dispose-terminal-ptys-step.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import type { ShutdownStepName } from '../../session/rolling-restart.js'
import { disposeTerminalPtysStep } from '../dispose-terminal-ptys-step.js'

describe('disposeTerminalPtysStep（shutdown 链 dispose-terminal-ptys 步骤本体）', () => {
  it('先打点再 destroyAllPties（顺序契约：可观测打点在资源收口之前）', () => {
    const order: string[] = []
    const destroyAllPties = vi.fn(() => { order.push('destroyAllPties') })
    const shutdownStep = vi.fn((name: ShutdownStepName) => { order.push(name) })
    disposeTerminalPtysStep({ destroyAllPties }, shutdownStep)
    expect(shutdownStep).toHaveBeenCalledExactlyOnceWith('dispose-terminal-ptys')
    expect(order).toEqual(['dispose-terminal-ptys', 'destroyAllPties'])
  })

  it('destroyAllPties 抛错不在此层吞（shutdown 外层 catch 统一记日志，错误路径语义不变）', () => {
    const destroyAllPties = vi.fn(() => { throw new Error('boom') })
    expect(() => disposeTerminalPtysStep({ destroyAllPties }, () => {})).toThrow('boom')
  })
})
