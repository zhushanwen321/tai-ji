/**
 * listBuiltinProviders 双源拼接的 id 去重判据测试（dmg-r3-4）。
 *
 * 返回列表 = pi catalog 快照段 ∪ taiji 远程清单段，判据 = id 唯一。远程条目带
 * remoteSource 标记（「参与远程模型热更新」的唯一判据），复用 pi catalog id 会让该
 * catalog provider 被误标 remoteSource、模型被远程清单覆盖，且模板选择器渲染出同 id
 * 两张卡片（data-testid 撞名）——属配置错误，必须跳过并 warn 留痕而非静默重复。
 *
 * 远程清单读侧整体 mock（vi.hoisted 可变形状），不影响同源其他用例。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/provider-config-helper-remote-dedupe.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listBuiltinProviders } from '../provider-config-helper.js'

const builtinMock = vi.hoisted(() => ({
  providers: [] as unknown,
}))
vi.mock('../../generated/builtin-providers.json', () => ({ default: builtinMock }))

const remoteMock = vi.hoisted(() => ({
  templates: [] as Array<{ id: string; name: string; remoteSource?: string }>,
}))
vi.mock('../remote-config/remote-provider-templates.js', () => ({
  listRemoteProviderTemplates: () => remoteMock.templates,
}))

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listBuiltinProviders 远程段拼接 id 去重', () => {
  it('远程条目复用 pi catalog id → 该 id 只出现一次（保留 catalog 段条目）+ warn 留痕', () => {
    builtinMock.providers = [
      { id: 'opencode-go', name: 'OpenCode Go', api: 'opencode' },
      { id: 'zhipu', name: 'Zhipu' },
    ]
    remoteMock.templates = [
      { id: 'opencode-go', name: 'Remote Hijack', remoteSource: 'opencode-go' },
      { id: 'taiji-relay', name: 'Relay', remoteSource: 'taiji-relay' },
    ]

    const list = listBuiltinProviders()

    expect(list.map((p) => p.id)).toEqual(['opencode-go', 'zhipu', 'taiji-relay'])
    // 保留的是 catalog 段条目：不带 remoteSource 标记，不参与热更新
    expect(list.find((p) => p.id === 'opencode-go')).toMatchObject({ name: 'OpenCode Go' })
    expect(list.find((p) => p.id === 'opencode-go')).not.toHaveProperty('remoteSource')
    expect(console.warn).toHaveBeenCalledWith(
      '[config-service] remote provider template id "opencode-go" collides with an already-listed builtin provider id, skipping the remote entry',
    )
  })

  it('远程清单内部自重复 id → 只保留首条 + warn 留痕', () => {
    builtinMock.providers = [{ id: 'zhipu', name: 'Zhipu' }]
    remoteMock.templates = [
      { id: 'taiji-relay', name: 'Relay A', remoteSource: 'taiji-relay' },
      { id: 'taiji-relay', name: 'Relay B', remoteSource: 'taiji-relay' },
    ]

    const list = listBuiltinProviders()

    expect(list.map((p) => p.id)).toEqual(['zhipu', 'taiji-relay'])
    expect(list.find((p) => p.id === 'taiji-relay')).toMatchObject({ name: 'Relay A' })
    expect(console.warn).toHaveBeenCalledWith(
      '[config-service] remote provider template id "taiji-relay" collides with an already-listed builtin provider id, skipping the remote entry',
    )
  })

  it('远程条目 id 全部不冲突 → 原样追加且不 warn（对照：判据不误伤合法远程清单）', () => {
    const valid = [{ id: 'zhipu', name: 'Zhipu' }]
    builtinMock.providers = valid
    remoteMock.templates = [{ id: 'taiji-relay', name: 'Relay', remoteSource: 'taiji-relay' }]

    const list = listBuiltinProviders()

    expect(list.map((p) => p.id)).toEqual(['zhipu', 'taiji-relay'])
    expect(list[1]).toMatchObject({ id: 'taiji-relay', remoteSource: 'taiji-relay' })
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('远程清单为空 → 原样返回 catalog 段（对照：空段不改变既有行为）', () => {
    const valid = [{ id: 'zhipu', name: 'Zhipu' }]
    builtinMock.providers = valid
    remoteMock.templates = []

    expect(listBuiltinProviders()).toEqual(valid)
    expect(console.warn).not.toHaveBeenCalled()
  })
})
