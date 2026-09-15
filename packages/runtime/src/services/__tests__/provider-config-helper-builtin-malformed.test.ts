/**
 * listBuiltinProviders 畸形快照降级分支测试（S-15 补口）。
 *
 * builtin-providers.json 是生成物（gen-builtin-providers.mjs），畸形（非数组 / 条目缺
 * id/name）= 全部内置 provider 静默消失的降级面——guard 必须返回空列表而非 throw
 * （内置模板是增强能力，坏了不能拖垮 Settings），且降级必须带 console.warn（静默消失
 * 不可排查）。
 *
 * JSON 模块整体 mock（vi.hoisted 可变形状），不影响同源其他用例。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/provider-config-helper-builtin-malformed.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listBuiltinProviders } from '../provider-config-helper.js'

const builtinMock = vi.hoisted(() => ({
  providers: [] as unknown,
}))
vi.mock('../../generated/builtin-providers.json', () => ({ default: builtinMock }))

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listBuiltinProviders 畸形快照降级（浅校验 guard）', () => {
  it('providers 非数组 → 返回空列表不抛 + warn 指明形态', () => {
    builtinMock.providers = { length: 3 } // 形似数组的对象（生成物损坏形态）
    expect(listBuiltinProviders()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(
      '[config-service] builtin-providers.json malformed (providers is not an array), falling back to empty list',
    )
  })

  it('条目缺 id/name → 返回空列表不抛 + warn 指明缺字段', () => {
    builtinMock.providers = [
      { id: 'ok-provider', name: 'OK' },
      { id: 'broken' }, // 缺 name
    ]
    expect(listBuiltinProviders()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(
      '[config-service] builtin-providers.json malformed (provider missing id/name), falling back to empty list',
    )
  })

  it('条目为 null（JSON 显式 null 元素）→ 同样降级空列表', () => {
    builtinMock.providers = [null]
    expect(listBuiltinProviders()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(
      '[config-service] builtin-providers.json malformed (provider missing id/name), falling back to empty list',
    )
  })

  it('正常数组 → 原样返回（对照：guard 不误伤合法快照）', () => {
    const valid = [
      { id: 'opencode-go', name: 'OpenCode Go', api: 'opencode' },
    ]
    builtinMock.providers = valid
    expect(listBuiltinProviders()).toEqual(valid)
    expect(console.warn).not.toHaveBeenCalled()
  })
})
