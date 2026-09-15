import { describe, it, expect } from 'vitest'
import { BRIDGE_MARKER, BRIDGE_METHODS } from './marker'
import { SESSION_MANAGER_MARKER } from '../session-manager/marker'
import { ASK_USER_MARKER } from '../ask-user/marker'

/**
 * marker 精确值 + NUL 前缀 + method 集合：形状是 SSOT 契约，
 * pi 侧 bridge extension 与 runtime event-adapter 两侧都按此
 * 序列化/识别通道帧（值漂移 = 通道静默失联，此层测试在漂移时早炸）。
 */
describe('plugin-bridge marker 精确值 + method 集合', () => {
  it('BRIDGE_MARKER 精确值为 \\x00TAIJI_BRIDGE', () => {
    expect(BRIDGE_MARKER).toBe('\x00TAIJI_BRIDGE')
  })

  it('BRIDGE_MARKER 以 NUL 字符开头', () => {
    expect(BRIDGE_MARKER.charCodeAt(0)).toBe(0)
  })

  it('BRIDGE_MARKER 不与其他 select 通道 marker 冲突', () => {
    expect(BRIDGE_MARKER).not.toBe(SESSION_MANAGER_MARKER)
    expect(BRIDGE_MARKER).not.toBe(ASK_USER_MARKER)
  })

  it('BRIDGE_METHODS 恰为协议 v2 的 4 个 method', () => {
    expect([...BRIDGE_METHODS]).toEqual(['bridge:sync', 'bridge:tool_execute', 'bridge:event', 'bridge:intercept'])
  })
})
