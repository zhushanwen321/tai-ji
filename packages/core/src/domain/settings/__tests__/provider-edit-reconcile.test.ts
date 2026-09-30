/**
 * provider-edit-reconcile 纯核行为矩阵（[C4] 并发规则接口级测试——原 D8 deep watch 执行序
 * 不可测的替代面）。
 *
 * 覆盖三分支语义全集（规则 SSOT = provider-edit-reconcile.ts 文件头注释）：
 * ① 非 dirty → 整体重拍（form patch 逐字段映射 + models 过滤 + 快照重捕获由调用点执行）
 * ② dirty + authMethod 单字段例外（BL round1 S4 / S8）→ 只对齐 authMethod
 * ③ dirty 且无例外 → ignore（用户改动优先）
 *
 * 纯函数测试：无 Vue watch / 无时序伪造——每条裁决直接断言 decision 形状。
 */
import { describe, it, expect } from 'vitest'
import { reconcileBroadcast, formPatchFromProvider, type BroadcastReconcileDecision } from '../provider-edit-reconcile'
import type { FormSnapshot } from '../provider-edit-types'
import type { ProviderInfo } from '@taiji/shared'
// provider fixture 工厂迁 ./helpers/provider-edit-testbed（长版，与其他 provider-edit 系测试同源）
import { makeProvider } from './helpers/provider-edit-testbed'

/** 快照 fixture（authMethod 可指定——S8 例外判据读它） */
function makeSnapshot(overrides: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    name: 'P1',
    api: 'anthropic-messages',
    baseUrl: 'https://api.example.com',
    apiKeyChanged: false,
    modelsJson: '[]',
    authHeader: false,
    headersJson: '{}',
    authMethod: undefined,
    ...overrides,
  }
}

/**
 * 分支① repaint 裁决获取（models 两用例共用）：非 dirty + 已初始化快照基线，
 * 非 repaint 即抛错（原用例内守卫同语义，类型收窄使 .models 直接可达）。
 */
function repaintDecision(fresh: ProviderInfo): Extract<BroadcastReconcileDecision, { action: 'repaint' }> {
  const d = reconcileBroadcast(fresh, { authMethod: undefined }, false, makeSnapshot())
  if (d.action !== 'repaint') throw new Error('unexpected decision')
  return d
}

describe('分支①：非 dirty → 整体重拍（repaint）', () => {
  it('裁决携带 form patch：逐字段对齐 fresh（name/api/baseUrl/headers/authHeader/authMethod）', () => {
    const fresh = makeProvider({
      name: 'P1-broadcast',
      api: 'openai-completions',
      baseUrl: 'https://gw.example.com',
      headers: { 'X-New': 'v2' },
      authHeader: true,
      authMethod: 'oauth',
    })
    const d = reconcileBroadcast(fresh, { authMethod: undefined }, false, makeSnapshot())
    expect(d.action).toBe('repaint')
    if (d.action !== 'repaint') throw new Error('unexpected decision')
    // 深拷贝语义：headers 不共享引用（调用点直接替换 form.headers）
    expect(d.form).toEqual({
      name: 'P1-broadcast',
      api: 'openai-completions',
      baseUrl: 'https://gw.example.com',
      headers: { 'X-New': 'v2' },
      authHeader: true,
      authMethod: 'oauth',
    })
    expect(d.form.headers).not.toBe(fresh.headers)
  })

  it('缺省回退：api → anthropic-messages、baseUrl → \'\'、headers → {}、authHeader → false', () => {
    const fresh = makeProvider({ api: undefined, baseUrl: undefined, headers: undefined, authHeader: undefined })
    const d = reconcileBroadcast(fresh, { authMethod: undefined }, false, null)
    if (d.action !== 'repaint') throw new Error('unexpected decision')
    expect(d.form.api).toBe('anthropic-messages')
    expect(d.form.baseUrl).toBe('')
    expect(d.form.headers).toEqual({})
    expect(d.form.authHeader).toBe(false)
  })

  it('repaint 的 models = toEditableModels：catalog 过滤 builtin 条目（B-2），override/旧数据保留', () => {
    const d = repaintDecision(makeProvider({
      kind: 'catalog',
      models: [
        { id: 'b1', name: 'B1', source: 'builtin' },
        { id: 'o1', name: 'O1', source: 'override' },
        { id: 'legacy', name: 'Legacy' },
      ],
    }))
    expect(d.models.map((m) => m.id)).toEqual(['o1', 'legacy'])
  })

  it('repaint 的 models：custom（kind 缺失同）全量保留不过滤', () => {
    const d = repaintDecision(makeProvider({
      models: [
        { id: 'm1', name: 'M1' },
        { id: 'm2', name: 'M2', source: 'builtin' },
      ],
    }))
    expect(d.models.map((m) => m.id)).toEqual(['m1', 'm2'])
    // B-4b 透传位随 spread 进编辑副本（load 侧接线）
    expect(d.models[0]).toEqual({ id: 'm1', name: 'M1' })
  })

  it('formPatchFromProvider(null) → 新增态空表单默认值（load 与重拍共用同一映射）', () => {
    expect(formPatchFromProvider(null)).toEqual({
      name: '',
      api: 'anthropic-messages',
      baseUrl: '',
      headers: {},
      authHeader: false,
      authMethod: undefined,
    })
  })
})

describe('分支②：dirty + authMethod 单字段例外 → align-auth-method', () => {
  it('用户未手动切换形态（draft.authMethod 与快照位相等）+ 广播携带新形态 → 只对齐 authMethod', () => {
    const fresh = makeProvider({ name: 'P1-broadcast', authMethod: 'oauth' })
    const d = reconcileBroadcast(fresh, { authMethod: 'api_key' }, true, makeSnapshot({ authMethod: 'api_key' }))
    expect(d).toEqual({ action: 'align-auth-method', authMethod: 'oauth' })
  })

  it('例外裁决只携带 authMethod——不带 form patch / models（其余字段不得被广播覆盖）', () => {
    const fresh = makeProvider({ authMethod: 'oauth' })
    const d = reconcileBroadcast(fresh, { authMethod: undefined }, true, makeSnapshot({ authMethod: undefined }))
    expect(Object.keys(d)).toEqual(['action', 'authMethod'])
  })

  it('authMethod 位语义：undefined 快照位 + undefined 草稿位相等 → 例外同样适用（「未标注」→oauth 回推）', () => {
    const fresh = makeProvider({ authMethod: 'oauth' })
    const d = reconcileBroadcast(fresh, { authMethod: undefined }, true, makeSnapshot({ authMethod: undefined }))
    expect(d.action).toBe('align-auth-method')
  })
})

describe('分支③：dirty 且无例外 → ignore（用户改动优先）', () => {
  it('用户已手动切换形态（draft.authMethod ≠ 快照位，pending 未保存）→ 本地切换意图优先', () => {
    const fresh = makeProvider({ authMethod: 'oauth' })
    const d = reconcileBroadcast(fresh, { authMethod: 'api_key' }, true, makeSnapshot({ authMethod: 'oauth' }))
    expect(d).toEqual({ action: 'ignore' })
  })

  it('广播携带同形态（draft.authMethod === fresh.authMethod）→ 例外判据不成立', () => {
    const fresh = makeProvider({ authMethod: 'oauth' })
    const d = reconcileBroadcast(fresh, { authMethod: 'oauth' }, true, makeSnapshot({ authMethod: 'oauth' }))
    expect(d).toEqual({ action: 'ignore' })
  })

  it('快照未初始化（null）→ 无例外可言（原实现 if (s && …) 同语义）', () => {
    const fresh = makeProvider({ authMethod: 'oauth' })
    const d = reconcileBroadcast(fresh, { authMethod: 'api_key' }, true, null)
    expect(d).toEqual({ action: 'ignore' })
  })
})
