/**
 * check-thinking-levels.mjs 单测（review round1 MUST_FIX：守卫自身假绿——提取正则失效仍放行——
 * 正是守卫测试该拦的漂移；此前仅有人肉 --self-test，无自动化回归）。
 *
 * 组织方式照同辈 check-publish-surface.test.mjs 惯例：纯函数直测 + tmpdir fixture，
 * 不依赖/不修改真实仓库词表文件。CLI 集成用例把守卫脚本复制到 tmp mirror 运行：
 * - 权威源（pi-ai dist/types.d.ts）经 node_modules symlink 指向真实实装包——import.meta.resolve
 *   默认 realpath 解析，脚本向上爬包根的逻辑与真实仓库运行完全同构；
 * - 两个比对面词表（宿主侧 subagent-core THINKING_ORDER + 前端派生源 shared
 *   PI_THINKING_LEVELS）是测试生成的 fixture（成员集从真实权威源动态提取，pi 升级不破测试）：
 *   绿 = fixture 与权威源一致；红 = 篡改 fixture 成员（多出/缺失）跑出 exit 1——
 *   「篡改即红、还原即绿」在同一 tmpdir 内构成差分，证明守卫非恒绿（不触碰真实源文件，
 *   无需还原动作）。
 *
 * 运行：cd <repo-root> && pnpm exec vitest run scripts/__tests__/check-thinking-levels.test.mjs
 * （ci.yml「Test - scripts guards」逐文件列举同款口径。）
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, symlinkSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractModelThinkingLevel,
  extractConstListMembers,
  resolvePiAiRoot,
} from '../check-thinking-levels.mjs'
import { setDiff } from '../lib/guard-report.mjs'
import { createMirrorRoot, installGuardIntoMirror } from './helpers/guard-mirror.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-thinking-levels.mjs')

// ── 权威源实装读取（真实 pi-ai；resolvePiAiRoot 失败 = 环境缺 pnpm install，直接红）──

const PI_AI_ROOT = (() => {
  const r = resolvePiAiRoot()
  if (r.error) throw new Error(`pi-ai 不可解析（先 pnpm install）：${r.error}`)
  return r.root
})()
const REAL_MEMBERS = (() => {
  const dts = readFileSync(join(PI_AI_ROOT, 'dist', 'types.d.ts'), 'utf-8')
  const extracted = extractModelThinkingLevel(dts)
  if (extracted.error) throw new Error(`权威源提取失败：${extracted.error}`)
  return extracted.values
})()

describe('extractModelThinkingLevel（联合提取 + 别名递归展开）', () => {
  it('pi-ai 0.84.4 实装形态：引用同文件类型别名，递归展开为成员集', () => {
    const dts =
      'export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";\n' +
      'export type ModelThinkingLevel = "off" | ThinkingLevel;'
    expect(extractModelThinkingLevel(dts).values).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('完整字面量联合直取（pi-ai 未来改形态仍可提取）', () => {
    const dts = 'export type ModelThinkingLevel = "off" | "low" | "max";'
    expect(extractModelThinkingLevel(dts).values).toEqual(['off', 'low', 'max'])
  })

  it('多级别名递归展开（保持声明顺序）', () => {
    const dts =
      'export type A = "x" | "y";\nexport type B = "z" | A;\nexport type ModelThinkingLevel = "off" | B;'
    expect(extractModelThinkingLevel(dts).values).toEqual(['off', 'z', 'x', 'y'])
  })

  it('缺 ModelThinkingLevel 定义 → error（宁可误报不可漏报）', () => {
    expect(extractModelThinkingLevel('export type KnownApi = "a";').error).toBeDefined()
  })

  it('类型别名循环引用 → error（不悬挂）', () => {
    const dts = 'export type A = A;\nexport type ModelThinkingLevel = A;'
    expect(extractModelThinkingLevel(dts).error).toBeDefined()
  })

  it('空联合（提取不到字符串字面量）→ error', () => {
    expect(extractModelThinkingLevel('export type ModelThinkingLevel = ;').error).toBeDefined()
  })
})

describe('extractConstListMembers（真实词表形态 + 历史副本形态一条正则覆盖）', () => {
  it('历史 llm-shared 副本形态：类型标注 + new Set 多行（提取器对 Set 形态仍兼容）', () => {
    const src = 'const THINKING_LEVELS: ReadonlySet<string> = new Set([\n\t"off",\n\t"max",\n]);'
    expect(extractConstListMembers(src, 'THINKING_LEVELS').values).toEqual(['off', 'max'])
  })

  it('历史 pi-rpc 副本形态：类型标注 + 数组单行单引号（提取器对带标注数组仍兼容）', () => {
    const src = "const THINKING_LEVELS: readonly string[] = ['off', 'max']"
    expect(extractConstListMembers(src, 'THINKING_LEVELS').values).toEqual(['off', 'max'])
  })

  it('subagent-core 形态：无类型标注 + as const（D6 适配：标注可选）', () => {
    const src = 'export const THINKING_ORDER = ["off", "minimal", "max"] as const;'
    expect(extractConstListMembers(src, 'THINKING_ORDER').values).toEqual(['off', 'minimal', 'max'])
  })

  it('shared 形态：PI_THINKING_LEVELS 无类型标注 + as const（T4 比对面实装形态）', () => {
    const src = "export const PI_THINKING_LEVELS = ['off', 'minimal', 'max'] as const"
    expect(extractConstListMembers(src, 'PI_THINKING_LEVELS').values).toEqual(['off', 'minimal', 'max'])
  })

  it('常量缺失/改名 → error', () => {
    expect(extractConstListMembers('const OTHER = 1;', 'THINKING_LEVELS').error).toBeDefined()
  })

  it('列表存在但无字符串字面量 → error', () => {
    expect(extractConstListMembers('const THINKING_LEVELS = [1, 2];', 'THINKING_LEVELS').error).toBeDefined()
  })
})

describe('setDiff（双向集合差异）', () => {
  it('extra = a 有 b 无；missing = b 有 a 无', () => {
    expect(setDiff(['a', 'b'], ['b', 'c'])).toEqual({ extra: ['a'], missing: ['c'] })
  })
  it('一致集 → 双空', () => {
    expect(setDiff(['x'], ['x'])).toEqual({ extra: [], missing: [] })
  })
})

describe('resolvePiAiRoot（触发路径解析：入口爬包根 + name 校验）', () => {
  it('真实实装：定位到包根，package.json name 命中且 dist/types.d.ts 存在', () => {
    expect(resolvePiAiRoot()).toEqual({ root: PI_AI_ROOT })
    expect(JSON.parse(readFileSync(join(PI_AI_ROOT, 'package.json'), 'utf-8')).name).toBe('@earendil-works/pi-ai')
    expect(existsSync(join(PI_AI_ROOT, 'dist', 'types.d.ts'))).toBe(true)
  })
})

// ── CLI 集成（tmp mirror：守卫脚本 + fixture 副本 + 真实 pi-ai symlink）────────

/** 两个比对面词表 fixture 的真实文件形态（成员集动态取自权威源，pi 升级不破）。 */
const subagentCoreModelRefSrc = (members) =>
  `export const THINKING_ORDER = [${members.map((m) => `"${m}"`).join(', ')}] as const;\n`
const sharedPiPresetSrc = (members) =>
  `export const PI_THINKING_LEVELS = [${members.map((m) => `'${m}'`).join(', ')}] as const\n`

/**
 * tmp mirror 工厂：目录布局对齐守卫的 ROOT 相对路径（packages/subagent-core/src/shared、
 * packages/shared/src），node_modules/@earendil-works/pi-ai
 * symlink 到真实实装包根（import.meta.resolve realpath 后向上爬包根与真实运行同构）。
 * overrides 可按比对面覆盖成员集（漂移注入点），missing 指定不落盘的比对面路径。
 * root/落盘/清理/守卫副本装置见 guard-mirror.mjs。
 */
function makeMirror({ thinkingOrder, piPresetLevels, missing = [] } = {}) {
  const { root, writeAt, cleanup } = createMirrorRoot('thinking-levels-fx-')
  const files = {
    'packages/subagent-core/src/shared/model-ref.ts': subagentCoreModelRefSrc(thinkingOrder ?? REAL_MEMBERS),
    'packages/shared/src/pi-preset.ts': sharedPiPresetSrc(piPresetLevels ?? REAL_MEMBERS),
  }
  for (const [rel, content] of Object.entries(files)) {
    if (missing.includes(rel)) continue
    writeAt(rel, content)
  }
  const run = installGuardIntoMirror(root, SCRIPT)
  const linkDir = join(root, 'node_modules', '@earendil-works')
  mkdirSync(linkDir, { recursive: true })
  symlinkSync(PI_AI_ROOT, join(linkDir, 'pi-ai'), 'dir')
  return { root, run, cleanup }
}

describe('CLI 集成（守卫脚本 × tmp mirror）', () => {
  it('词表一致 → exit 0，两个比对面逐一报一致', () => {
    const fx = makeMirror()
    try {
      const r = fx.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('✓ thinking-levels 守卫通过')
      for (const label of ['T3 subagent-core THINKING_ORDER', 'T4 shared PI_THINKING_LEVELS']) {
        expect(r.stdout).toContain(`${label} 与 pi-ai`)
        expect(r.stdout).toContain(`一致（${REAL_MEMBERS.length} 值）`)
      }
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（T3 THINKING_ORDER 缺档位）→ exit 1，报缺失成员与 D6 恢复指引', () => {
    const fx = makeMirror({ thinkingOrder: REAL_MEMBERS.slice(0, -1) })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('T3 subagent-core THINKING_ORDER')
      expect(r.stderr).toContain(`副本缺失: ${REAL_MEMBERS[REAL_MEMBERS.length - 1]}`)
      expect(r.stderr).toContain('THINKING_ORDER 与 docs/architecture/ext-simplify-18-shared-adoption.md D6')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（T4 shared PI_THINKING_LEVELS 多出档位）→ exit 1，报漂移明细与恢复动作（差分证明 shared 面非恒绿）', () => {
    const fx = makeMirror({ piPresetLevels: [...REAL_MEMBERS, 'bogus-tier'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('T4 shared PI_THINKING_LEVELS')
      expect(r.stderr).toContain('副本多出: bogus-tier')
      expect(r.stderr).toContain('恢复动作')
      expect(r.stderr).toContain('thinking-levels 守卫未通过')
    } finally {
      fx.cleanup()
    }
  })

  it('比对面文件缺失 → exit 1，报缺失路径与迁移同步指引（提取失败一律 fail）', () => {
    const fx = makeMirror({ missing: ['packages/shared/src/pi-preset.ts'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('T4 shared pi-preset.ts 缺失')
    } finally {
      fx.cleanup()
    }
  })
})
