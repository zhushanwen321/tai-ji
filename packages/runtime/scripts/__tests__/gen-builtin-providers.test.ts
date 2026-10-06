// vitest 测试：校验 generateBuiltinProviders 提取的内置 provider 元数据结构 + 磁盘快照自包含指纹。
// 测试框架 vitest（禁 node:test / tsx --test）。
import { describe, it, expect } from 'vitest'
import { generateBuiltinProviders, readPiAiVersion } from '../gen-builtin-providers.mjs'
import snapshot from '../../src/generated/builtin-providers.json'

describe('gen-builtin-providers', () => {
  const providers = generateBuiltinProviders()

  // pi-ai 1.0.0 实装形态：typesafe 的 chat model 目录为空（typesafe.json 仅 classifier 目录，
  // models: Object.values(TYPESAFE_CLASSIFIER_MODELS) 拍平为空数组），modelCount === 0 是实装事实。
  const ZERO_MODEL_PROVIDERS = new Set(['typesafe'])

  it('t1: 生成 42 个内置 provider（pi-ai 1.0.0 catalog）', () => {
    expect(providers).toHaveLength(42)
  })

  it('t2: openai envVars 含 OPENAI_API_KEY 且 authMode===both（1.0.0 起新增 oauth）', () => {
    const openai = providers.find((p) => p.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai.envVars).toContain('OPENAI_API_KEY')
    expect(openai.authMode).toBe('both')
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

  it('t5: radius 在册（1.0.0 起进静态 catalog）且 authMode 推导为 both', () => {
    // 提取细节（clientId/flow/endpoints{}/scopes/callbackPort）归 scripts/gen-builtin-providers.test.ts
    // 的 radius 专测所有，此处只钉 authMode 推导在本层的独立信号
    const radius = providers.find((p) => p.id === 'radius')
    expect(radius).toBeDefined()
    expect(radius.authMode).toBe('both')
  })

  it('t6: provider id 唯一（无重复）', () => {
    const ids = providers.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('t7: 非 ambient provider 中 models 非空（排除 google-vertex/amazon-bedrock，typesafe 豁免）', () => {
    const ambient = new Set(['google-vertex', 'amazon-bedrock'])
    const nonAmbient = providers.filter((p) => !ambient.has(p.id))
    // 42 - 2 ambient = 40 个，除实装空目录的 typesafe 外每个 modelCount > 0
    expect(nonAmbient).toHaveLength(40)
    for (const p of nonAmbient) {
      if (ZERO_MODEL_PROVIDERS.has(p.id)) {
        expect(p.modelCount, `${p.id} modelCount 应为 0（实装空目录）`).toBe(0)
        continue
      }
      expect(p.modelCount, `${p.id} modelCount 应 > 0`).toBeGreaterThan(0)
      expect(p.models.length, `${p.id} models 数组应非空`).toBeGreaterThan(0)
    }
  })

  it('t8: 镜像表与 pi-ai 全量一致（verifyEnvVars 全量双向校验 + 孤儿条目检查）', async () => {
    // 名实相符改造（审查 2026-10-03）：旧写法是 5 个抽样 provider 的 findEnvKeys 直调
    //（测第三方库本身 + 名为全量实为抽样），全量一致性的真实防线本就是 verifyEnvVars()
    // 的全量双向校验（含镜像表孤儿条目检查）；此处作为 test 期通道真实调用它——
    // 不一致时它 console.error + process.exit(1)（worker 退出 = 本文件红）
    const { verifyEnvVars } = await import('../gen-builtin-providers.mjs')
    expect(() => verifyEnvVars()).not.toThrow()
  })

  it('t9: model 摘要含全部 11 字段（id/name/api/baseUrl/reasoning/input/cost/contextWindow/maxTokens/thinkingLevelMap/compat）', () => {
    const ALL_11 = ['id', 'name', 'api', 'baseUrl', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat']
    for (const p of providers) {
      if (ZERO_MODEL_PROVIDERS.has(p.id)) continue
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
    expect(claude.cost).toBeTypeOf('object')
    expect(claude.cost).not.toBeNull()
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
