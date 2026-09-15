/**
 * PS-02 / PS-12 探针：思考能力两级门控 + 档位钳制就近回落（pi 语义依赖机器守卫，D6 探针层）。
 *
 * 登记条目（docs/pi-semantics.json）：
 * - PS-02「!model.reasoning（含 undefined）→ ["off"]，thinkingLevelMap 仅在开关打开后生效」
 * - PS-12「clampThinkingLevel 就近回落（mimo 族 max → high）；xhigh/max 仅显式映射可用」
 *
 * 断言方式（同源函数直调，强于代码形态）：动态 import @earendil-works/pi-ai 根入口，
 * 直接调 pi 自己的 getSupportedThinkingLevels / clampThinkingLevel——pi 升级改门控/
 * 钳制语义时本文件即红。包不可达（极端环境）时 skip 而非 fail。
 * 注意：pi 系包目前声明在仓库根 package.json（runtime 依赖由 U5 添加），node_modules
 * 上溯解析可达；vitest 主池可跑（无 pi 子进程、无 LLM），不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-thinking-gating.test.ts
 */
import { describe, it, expect } from 'vitest'

/** pi-ai 根入口形态（只声明消费到的两个函数；import 失败 = null → skip）。 */
type PiAiModule = {
  getSupportedThinkingLevels?: (model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }) => string[]
  clampThinkingLevel?: (model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }, level: string) => string
}
const piAi: PiAiModule | null = await (async () => {
  try {
    // 经 unknown 收窄：pi-ai 的正式签名要求完整 Model<TApi>，探针只构造最小字段
    //（两函数实读仅 reasoning + thinkingLevelMap）；运行时 guard 见下方 READY 判定
    return (await import('@earendil-works/pi-ai')) as unknown as PiAiModule
  } catch {
    return null
  }
})()
const SKIP_REASON = piAi
  ? ''
  : '@earendil-works/pi-ai 不可达（node_modules 上溯未命中）'
if (!piAi) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
const READY = Boolean(piAi?.getSupportedThinkingLevels && piAi?.clampThinkingLevel)

/** 最小模型对象：两函数只读 reasoning + thinkingLevelMap（pi-ai dist/models.js 实读核实）。 */
const model = (overrides: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }) => ({
  id: 'probe-model',
  reasoning: undefined,
  ...overrides,
})

describe.skipIf(!READY)(
  `PS-02 探针：思考能力两级门控（pi-ai 同源函数直调${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const levels = piAi!.getSupportedThinkingLevels!

    it('reasoning undefined（GUI 手加模型未写该字段的形态）→ ["off"]', () => {
      expect(levels(model({}))).toEqual(['off'])
    })

    it('reasoning: false → ["off"]（第一关不过任何档位钳回 off）', () => {
      expect(levels(model({ reasoning: false, thinkingLevelMap: { high: 'high', max: 'max' } }))).toEqual(['off'])
    })

    it('reasoning: true 且无 thinkingLevelMap → 标准五档（xhigh/max 需显式映射）', () => {
      expect(levels(model({ reasoning: true }))).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    })

    it('thinkingLevelMap 的 null 显式排除档位；undefined 的 xhigh/max 不出现', () => {
      const got = levels(model({ reasoning: true, thinkingLevelMap: { off: 'off', high: 'high', max: null } }))
      expect(got).toContain('high')
      expect(got).not.toContain('max')
      expect(got).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    })
  },
)

describe.skipIf(!READY)(
  `PS-12 探针：档位钳制就近回落（pi-ai 同源函数直调${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const clamp = piAi!.clampThinkingLevel!

    /** mimo 族形态：支持止于 high（xhigh/max 无显式映射）。 */
    const mimoLike = () => model({ reasoning: true, thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high' } })

    it('mimo 族设 max → 就近回落 high（事故 B 钳制复现）', () => {
      expect(clamp(mimoLike(), 'max')).toBe('high')
    })

    it('受支持档位原样放行（钳制不碰合法值）', () => {
      expect(clamp(mimoLike(), 'medium')).toBe('medium')
      expect(clamp(mimoLike(), 'high')).toBe('high')
    })

    it('就近向上回退优先于向下（支持 xhigh 的族，max → xhigh 而非 high）', () => {
      const withXhigh = model({
        reasoning: true,
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
      })
      expect(clamp(withXhigh, 'max')).toBe('xhigh')
    })

    it('未知请求档位 → 首个可用档兜底（requestedIndex=-1 路径）', () => {
      expect(clamp(mimoLike(), 'bogus-level')).toBe('off')
    })
  },
)
