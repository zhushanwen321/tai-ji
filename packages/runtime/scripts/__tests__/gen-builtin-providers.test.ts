// vitest 测试：校验 generateBuiltinProviders 提取的内置 provider 元数据结构 + 磁盘快照自包含指纹。
// 测试框架 vitest（禁 node:test / tsx --test）。
import { describe, it, expect } from 'vitest'
import { generateBuiltinProviders, readPiAiVersion } from '../gen-builtin-providers.mjs'
import snapshot from '../../src/generated/builtin-providers.json'

describe('gen-builtin-providers', () => {
  const providers = generateBuiltinProviders()

  it('t1: 生成 39 个内置 provider', () => {
    expect(providers).toHaveLength(39)
  })

  it('t2: openai envVars 含 OPENAI_API_KEY 且 authMode===api_key', () => {
    const openai = providers.find((p) => p.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai.envVars).toContain('OPENAI_API_KEY')
    expect(openai.authMode).toBe('api_key')
  })

  it('t2b: google-vertex envVars 含 GOOGLE_CLOUD_API_KEY（镜像表漏配回归，M-1）', () => {
    const gv = providers.find((p) => p.id === 'google-vertex')
    expect(gv).toBeDefined()
    expect(gv.envVars).toContain('GOOGLE_CLOUD_API_KEY')
    // 显式 key 路径与 ambient 主凭证并存：authMode 仍为 ambient
    expect(gv.authMode).toBe('ambient')
  })

  it('t3: anthropic authMode===both 且 envVars 含 ANTHROPIC_API_KEY', () => {
    const anthropic = providers.find((p) => p.id === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic.authMode).toBe('both')
    expect(anthropic.envVars).toContain('ANTHROPIC_API_KEY')
  })

  it('t4: openai-codex authMode===oauth 且 oauthSupported===true', () => {
    const codex = providers.find((p) => p.id === 'openai-codex')
    expect(codex).toBeDefined()
    expect(codex.authMode).toBe('oauth')
    expect(codex.oauthSupported).toBe(true)
  })

  it('t5: 排除 radius（dynamic provider 无静态 catalog）', () => {
    const radius = providers.find((p) => p.id === 'radius')
    expect(radius).toBeUndefined()
  })

  it('t6: provider id 唯一（无重复）', () => {
    const ids = providers.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('t7: 非 ambient provider models 非空（排除 google-vertex/amazon-bedrock）', () => {
    const ambient = new Set(['google-vertex', 'amazon-bedrock'])
    const nonAmbient = providers.filter((p) => !ambient.has(p.id))
    // 39 - 2 ambient = 37 个，每个 modelCount > 0
    expect(nonAmbient).toHaveLength(37)
    for (const p of nonAmbient) {
      expect(p.modelCount, `${p.id} modelCount 应 > 0`).toBeGreaterThan(0)
      expect(p.models.length, `${p.id} models 数组应非空`).toBeGreaterThan(0)
    }
  })

  it('t8: findEnvKeys 同步校验通过（镜像表与 pi-ai 一致，无 exit 1）', async () => {
    // 直接 import findEnvKeys 对几个代表 provider 传 {[envVar]:'x'} 验证
    // （gen-builtin-providers.mjs 的 verifyEnvVars() 做全量双向校验，这里抽样验证 import 链路可用）
    const { findEnvKeys } = await import('@earendil-works/pi-ai/compat')
    const checks = [
      { id: 'openai', envVar: 'OPENAI_API_KEY' },
      { id: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
      { id: 'deepseek', envVar: 'DEEPSEEK_API_KEY' },
      { id: 'github-copilot', envVar: 'COPILOT_GITHUB_TOKEN' },
      { id: 'google-vertex', envVar: 'GOOGLE_CLOUD_API_KEY' },
    ]
    for (const { id, envVar } of checks) {
      const got = findEnvKeys(id, { [envVar]: 'x' })
      expect(got, `${id} findEnvKeys 应识别 ${envVar}`).toContain(envVar)
    }
    // 确认生成的 providers 里对应 envVars 字段也一致
    for (const { id, envVar } of checks) {
      const p = providers.find((x) => x.id === id)
      expect(p.envVars, `${id} 生成结果 envVars 应含 ${envVar}`).toContain(envVar)
    }
  })

  it('t9: model 摘要含全部 11 字段（id/name/api/baseUrl/reasoning/input/cost/contextWindow/maxTokens/thinkingLevelMap/compat）', () => {
    const ALL_11 = ['id', 'name', 'api', 'baseUrl', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat']
    for (const p of providers) {
      expect(p.models.length).toBeGreaterThan(0)
      for (const m of p.models) {
        for (const key of ALL_11) {
          expect(m, `${p.id} model ${m.id} 应含字段 ${key}`).toHaveProperty(key)
        }
      }
    }
    // 抽查：anthropic 首个 model 有真实 thinkingLevelMap/compat（非 null 值）
    const anthropic = providers.find((p) => p.id === 'anthropic')
    const claude = anthropic.models.find((m) => m.id === 'claude-fable-5')
    expect(claude).toBeDefined()
    expect(claude.thinkingLevelMap).not.toBeNull()
    expect(claude.compat).not.toBeNull()
    expect(typeof claude.cost).toBe('object')
    expect(typeof claude.maxTokens).toBe('number')
  })

  it('t10: 快照自包含指纹（D3）——header 指纹 == providers 内容 + piAiVersion == 实装 + 快照 == 提取函数输出', () => {
    // 自包含断言替代手写基线数字（旧基线 1220 在 pi 0.84.1→0.84.4 升级时失守，守卫自身成为
    // 需要人工同步的第三份数据）。pi 升级后只需重跑 gen 重生成快照即自洽；model 级内容漂移的
    // 人工核对面（升级 PR 的快照 diff）归 check-pi-sync 守卫的快照新鲜度检查。
    // ① header 指纹 == 快照 providers 实际内容（生成端与产物端的自洽契约）
    expect(snapshot.providerCount).toBe(snapshot.providers.length)
    const totalModels = snapshot.providers.reduce((s, p) => s + p.models.length, 0)
    expect(snapshot.totalModels).toBe(totalModels)
    // ② 磁盘快照 == 当前代码 + 当前实装 pi-ai 的提取输出：快照过期（pi 升级未重生成）
    //    或 gen 脚本提取逻辑变更未重生成时在此暴露
    expect(snapshot.providers).toEqual(providers)
    // ③ 快照 piAiVersion == node_modules 实装版本——与 check-pi-sync 守卫矩阵第 3 项构成
    //    刻意双通道：本条在测试期跑（CI test 路径），守卫在提交期跑（pre-commit + CI invariants）
    expect(snapshot.piAiVersion).toBe(readPiAiVersion())
  })
})
