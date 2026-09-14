/**
 * createSessionRenamedHandler 单元测试（rename-session-three-modes 设计 D4）。
 *
 * 覆盖（双断言）：
 * - 得名事件：setLabelCache(sid, name) 后触发整表广播（broadcastSessionList 被调），
 *   且先写后广播——整表广播现算直读内存 label，顺序错会广播旧名
 * - 清名事件（name undefined）：label 回落 basename(cwd) 派生而非空串（与 scanner
 *   兜底 s.name ?? basename(s.cwd) 同语义——空串会以内存真值形态盖掉 basename，
 *   重启后 scanner 又变回 basename，破坏 live ≡ reload）
 * - 接线（组合根同形态）：真实 EventInterpreter + 本工厂 handler → session-renamed
 *   事件 → setLabelCache + 整表广播双达
 * - P3 单测级（回调内调用安全性）：broadcastSessionList 抛错被 interpret() 的
 *   per-event try/catch（W1 隔离）吞掉，批次内后续事件照常处理——事件流主链不受
 *   广播失败影响（真实 WS 帧序核对归 Gate B V4/V5）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-rename-fanout.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { createSessionRenamedHandler } from '../services/session/session-rename-fanout.js'
import { EventInterpreter } from '../services/session/event-interpreter.js'
import type { ServerMessage } from '@xyz-agent/shared'

/** 组合根注入形态的 deps 桩（sessionService.setLabelCache / getSessionCwd / server.broadcastSessionList）。 */
function makeDeps(cwd = '/tmp/proj-x') {
  return {
    setLabelCache: vi.fn(),
    getSessionCwd: vi.fn((): string | undefined => cwd),
    broadcastSessionList: vi.fn(),
  }
}

describe('createSessionRenamedHandler（D4 扇出）', () => {
  it('TC1: 得名事件 → setLabelCache(sid, name) + broadcastSessionList 各一次，先写后广播', () => {
    const deps = makeDeps()
    const handler = createSessionRenamedHandler(deps)

    handler('s1', '重构配置加载')

    expect(deps.setLabelCache).toHaveBeenCalledTimes(1)
    expect(deps.setLabelCache).toHaveBeenCalledWith('s1', '重构配置加载')
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1)
    // 顺序契约：label 先落内存，广播后现算（buildSessionListMsg 直读 session.label）
    expect(deps.setLabelCache.mock.invocationCallOrder[0])
      .toBeLessThan(deps.broadcastSessionList.mock.invocationCallOrder[0])
  })

  it('TC2: 清名事件（name undefined）→ label 回落 basename(cwd) 派生而非空串', () => {
    const deps = makeDeps('/tmp/feat-rename-session-mode')
    const handler = createSessionRenamedHandler(deps)

    handler('s1', undefined)

    expect(deps.getSessionCwd).toHaveBeenCalledWith('s1')
    expect(deps.setLabelCache).toHaveBeenCalledTimes(1)
    expect(deps.setLabelCache).toHaveBeenCalledWith('s1', 'feat-rename-session-mode')
    // 显式负断言（V9 回归钉）：不写空串
    expect(deps.setLabelCache.mock.calls[0][1]).not.toBe('')
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('TC2b: 空串 name（≠ undefined）原样透传——回落只针对清名事件形态，不静默改写', () => {
    const deps = makeDeps()
    const handler = createSessionRenamedHandler(deps)

    handler('s1', '')

    // '' ?? basename(...) === ''：pi trim 归一后本不该出现，但若出现不做译码改写
    expect(deps.setLabelCache).toHaveBeenCalledWith('s1', '')
  })

  it('TC2c: cwd 缺失（session 已不在内存 Map）→ 不抛错（setLabelCache 侧自身 no-op）', () => {
    const deps = makeDeps()
    deps.getSessionCwd = vi.fn(() => undefined)
    const handler = createSessionRenamedHandler(deps)

    expect(() => handler('s-gone', undefined)).not.toThrow()
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1)
  })
})

describe('session-renamed 接线（interpreter + handler，组合根 index.ts 同形态）', () => {
  it('TC3: session-renamed 事件 → onSessionRenamed 回调触发整表广播', () => {
    const deps = makeDeps()
    const handler = createSessionRenamedHandler(deps)
    const sent: ServerMessage[] = []
    const interp = new EventInterpreter('s1', { send: (m) => { sent.push(m) }, onSessionRenamed: handler })

    interp.interpret([{ kind: 'session-renamed', name: 'agent 起的名字' }])

    expect(deps.setLabelCache).toHaveBeenCalledWith('s1', 'agent 起的名字')
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('TC4 (P3 单测级): broadcastSessionList 抛错 → interpret 批次继续，后续事件照常处理', () => {
    const deps = makeDeps()
    deps.broadcastSessionList = vi.fn(() => { throw new Error('ws send exploded') })
    const handler = createSessionRenamedHandler(deps)
    const sent: ServerMessage[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const interp = new EventInterpreter('s1', { send: (m) => { sent.push(m) }, onSessionRenamed: handler })

      expect(() => interp.interpret([
        { kind: 'session-renamed', name: 'n' },
        { kind: 'message', message: { type: 'message.text_delta', payload: { sessionId: 's1', delta: 'x' } } },
      ])).not.toThrow()

      // 后续事件未被广播失败吞掉（W1 per-event 隔离：隔离日志留痕，批次继续）
      expect(sent.some((m) => m.type === 'message.text_delta')).toBe(true)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
