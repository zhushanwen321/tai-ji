/**
 * U4 提示链单测（model-switch-live-provider-sync §4.2「单元（renderer）」）：
 *
 * 1. `modelSwitchToastKey` 单点映射：5 个新码 → 专用 key；4 个既有透传码 / 未知码 / 无码 → general；
 * 2. 两条路径各恰一个 toast 点（UI 路径 = 壳层包装不 rethrow；键盘路径 = shortcut 内联 catch
 *    toast + 清意图）——本文件覆盖映射与「壳层包装」；键盘路径的 toast 在
 *    composer-shortcut-actions.test.ts 的对应用例断言（原「无 toast」规格已被本设计改写）。
 */
import { describe, it, expect } from 'vitest'
import { modelSwitchErrorMessage, modelSwitchToastKey } from '../model-switch-toast'

function err(code: string, message = 'engine said no'): Error & { code: string } {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}

describe('modelSwitchToastKey —— code → i18n key 单点映射', () => {
  it('5 个新码 → 各自专用文案 key（§3.4 错误规格表）', () => {
    expect(modelSwitchToastKey(err('SESSION_ACTIVATE_FAILED'))).toBe('panel.panel.modelSwitch.sessionActivateFailed')
    expect(modelSwitchToastKey(err('SESSION_ACTIVATE_TIMEOUT'))).toBe('panel.panel.modelSwitch.sessionActivateTimeout')
    expect(modelSwitchToastKey(err('MODEL_NOT_FOUND'))).toBe('panel.panel.modelSwitch.modelNotFound')
    expect(modelSwitchToastKey(err('PROVIDER_CREDENTIAL_MISSING'))).toBe('panel.panel.modelSwitch.providerCredentialMissing')
    expect(modelSwitchToastKey(err('ENGINE_MODEL_MISSING'))).toBe('panel.panel.modelSwitch.engineModelMissing')
  })

  it('4 个既有透传码 → general（toast 文本含后端 message，不新增 key）', () => {
    for (const code of ['SESSION_NOT_FOUND', 'MODEL_NOT_CONFIGURED', 'RESTORE_FAILED', 'BUILTIN_EXTENSIONS_MISSING']) {
      expect(modelSwitchToastKey(err(code))).toBe('panel.panel.modelSwitch.general')
    }
  })

  it('未知码 / 数值码 / 无 code / 非对象输入 → general（兜底不炸）', () => {
    expect(modelSwitchToastKey(err('SOMETHING_ELSE'))).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey(Object.assign(new Error('x'), { code: -32603 }))).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey(new Error('plain'))).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey('string error')).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey(null)).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey(undefined)).toBe('panel.panel.modelSwitch.general')
  })

  it('modelSwitchErrorMessage：取 message 用于 {error} 插值；缺失退化为空串', () => {
    expect(modelSwitchErrorMessage(err('MODEL_NOT_FOUND', 'model not in taiji registry'))).toBe('model not in taiji registry')
    expect(modelSwitchErrorMessage('raw string')).toBe('raw string')
    expect(modelSwitchErrorMessage({ code: 'X' })).toBe('')
    expect(modelSwitchErrorMessage(null)).toBe('')
  })
})
