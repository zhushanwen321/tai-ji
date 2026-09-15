/**
 * PS-01 探针：--model pattern 匹配语义（pi 语义依赖机器守卫，pi-boundary-reliability D6 探针层）。
 *
 * 登记条目：docs/pi-semantics.json PS-01——「--model 是 pattern 非精确 ID：
 * findExactModelReferenceMatch 的 id 匹配为 toLowerCase 相等（canonical 双命中判歧义作废）；
 * 无 exact 命中时 contains 模糊 + localeCompare 降序取最大」。
 *
 * P-D1 降级说明（实施期门）：匹配流程的「contains 模糊 → localeCompare 取最大」链路只能
 * 静态断言代码形态（锚点存在性 + 关键代码片段正则，失真即红）；findExactModelReferenceMatch
 * 是纯函数且可动态 import，故 exact 段升级为行为级断言（双命中作废 / toLowerCase 全等放行）。
 *
 * 范式：仿 pi-paths-config-dir-contract.test.ts——静态直读 node_modules 内 pi dist；
 * pi 包不可达的环境 skip 而非 fail；不进 vitest.config.ts REAL_PI_TESTS 分池（无真实
 * pi 子进程、无 LLM 调用）。pi 升级后本文件红 = PS-01 语义漂移，先复核
 * docs/pi-semantics.json 锚点再决定 verifiedWith 是否更新。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-model-resolution.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { locatePiCodingAgentDist } from './helpers/pi-semantics-probe.js'

const PI_DIST = locatePiCodingAgentDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const readDistFile = (rel: string): string => readFileSync(join(PI_DIST as string, rel), 'utf-8')

/** 行为级断言用：动态 import dist/core/model-resolver.js（纯函数，依赖 chalk/pi-ai 均可解析）。 */
type ModelResolverModule = {
  findExactModelReferenceMatch?: (ref: string, models: Array<{ id: string; provider?: string }>) => unknown
}
const modelResolver: ModelResolverModule | null = await (async () => {
  if (!PI_DIST) return null
  try {
    return (await import(pathToFileURL(join(PI_DIST, 'core', 'model-resolver.js')).href)) as ModelResolverModule
  } catch {
    return null
  }
})()

describe.skipIf(!PI_DIST)(
  `PS-01 探针：--model pattern 匹配语义（代码形态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('args.js 声明 --model 为 pattern（非精确 ID）', () => {
      const args = readDistFile(join('cli', 'args.js'))
      expect(
        args.includes('--model <pattern>'),
        'PS-01 漂移：args.js 不再以 <pattern> 语义声明 --model（改回精确 ID？）——复核 docs/pi-semantics.json PS-01 锚点 dist/cli/args.js',
      ).toBe(true)
    })

    it('exact 匹配 = id toLowerCase 全等 + 双命中判歧义作废（length===1 才放行）', () => {
      const resolver = readDistFile(join('core', 'model-resolver.js'))
      expect(
        resolver.includes('function findExactModelReferenceMatch'),
        'PS-01 漂移：findExactModelReferenceMatch 函数消失/改名——复核 PS-01 锚点 dist/core/model-resolver.js',
      ).toBe(true)
      expect(
        resolver.includes('.toLowerCase() === normalizedReference'),
        'PS-01 漂移：exact 匹配不再是 toLowerCase 相等——大小写语义变化，复核 PS-01（事故 A 根因 F1）',
      ).toBe(true)
      expect(
        resolver.includes('idMatches.length === 1 ? idMatches[0] : undefined'),
        'PS-01 漂移：canonical 双命中不再判歧义作废——孪生条目将静默命中其一，复核 PS-01 与切片 1 孪生守卫',
      ).toBe(true)
    })

    it('无 exact 命中时 contains 模糊 → isAlias 分桶 → localeCompare 降序取最大', () => {
      const resolver = readDistFile(join('core', 'model-resolver.js'))
      expect(
        resolver.includes('.id.toLowerCase().includes(modelPattern.toLowerCase())'),
        'PS-01 漂移：contains 模糊匹配形态消失——匹配规则改形，复核 PS-01',
      ).toBe(true)
      expect(
        resolver.includes('aliases.sort((a, b) => b.id.localeCompare(a.id))') &&
          resolver.includes('datedVersions.sort((a, b) => b.id.localeCompare(a.id))'),
        'PS-01 漂移：localeCompare 取最大形态消失——「选哪个」规则改形（事故 A 的 429 根因），复核 PS-01',
      ).toBe(true)
    })
  },
)

describe.skipIf(!PI_DIST || !modelResolver?.findExactModelReferenceMatch)(
  'PS-01 探针：findExactModelReferenceMatch 行为断言（动态 import dist/core/model-resolver.js）',
  () => {
    const fn = modelResolver!.findExactModelReferenceMatch!
    const mk = (id: string) => [{ id, provider: 'p', name: id }]

    it('大小写不敏感全等放行（请求小写命中大写 id）', () => {
      expect(fn('glm-5.3', mk('GLM-5.3'))).toMatchObject({ id: 'GLM-5.3' })
    })

    it('canonical 双命中判歧义作废（大小写孪生条目 → undefined，不静默选边）', () => {
      const twins = [...mk('GLM-5.3'), ...mk('glm-5.3')]
      expect(fn('glm-5.3', twins)).toBeUndefined()
      expect(fn('GLM-5.3', twins)).toBeUndefined()
    })

    it('无命中 → undefined（exact 段不模糊）', () => {
      expect(fn('no-such-model', mk('GLM-5.3'))).toBeUndefined()
    })
  },
)
