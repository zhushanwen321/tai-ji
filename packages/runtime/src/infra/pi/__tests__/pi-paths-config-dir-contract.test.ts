/**
 * pi 不扫描 agent/config/ 子目录——providers.json 落点安全性契约守卫
 * （PR #187 round1 data-governance MF4，ADR-0063 I4 机器防线）。
 *
 * 背景：`getProviderExtrasPath()` 把 taiji 扩展域 providers.json 放在
 * `<piAgentDir>/config/` 子目录，前提是 pi 对该子目录零扫描零引用。该前提是
 * pi 行为断言（人工锚点记录见 pi-paths.ts getProviderExtrasPath 注释）：
 * - 实装 0.84.1（权威源）：dist 全部 JS 的 `join(getAgentDir(), ...)` 家族全集
 *   11 项无 config 子目录、`join(getAgentDir(), "config")` 零命中、
 *   dist/migrations.js migrateSessionsFromAgentRoot 的 readdir 仅 filter 顶层 `.jsonl`；
 * - clone TS 参照：pi-mono 496185f6 coding-agent/src/config.ts + migrations.ts 同语义。
 *
 * 本测试把锚点变成机器防线：pi 升级（node_modules 实装版变更）后重跑本文件，
 * 若 pi 引入 agent/config/ 占用（新路径派生 / 字符串拼接 / agentDir 目录扫描
 * 改形），先行红并提示复核 pi-paths.ts 锚点——而非 providers.json 被 pi 静默
 * 吞掉后才被发现。
 *
 * 测试框架：vitest（禁 node:test）。纯静态读 dist，无真实 pi 子进程（不进
 * vitest.config.ts REAL_PI_TESTS 分池）。pi 包不可达的环境 skip 而非 fail
 * （skip-if 约定对齐 equivalence/pi-fixture.ts 文件头）。
 *
 * 运行命令：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-paths-config-dir-contract.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { getPiAgentDir, getProviderExtrasPath } from '../pi-paths.js'

/**
 * 定位实装 pi 包 dist 目录：从 cwd 逐级上溯找
 * node_modules/@earendil-works/pi-coding-agent/dist/config.js。
 * pnpm workspace 下声明在仓库根 package.json（非 runtime 包依赖，测试不可
 * import——只静态读文件）；vitest 从 packages/runtime 运行时上溯 1 级命中。
 */
function locatePiDist(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
    if (existsSync(join(candidate, 'config.js'))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

const PI_DIST = locatePiDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!PI_DIST) {
  console.warn(`[pi-paths-contract] skip：${SKIP_REASON}`)
}

/** dist 全部打包产物 .js 的源文本（文件名 → 内容；排除 .d.ts / sourcemap / 目录）。 */
function readDistJs(distDir: string): Map<string, string> {
  const sources = new Map<string, string>()
  for (const name of readdirSync(distDir)) {
    if (!name.endsWith('.js')) continue
    sources.set(name, readFileSync(join(distDir, name), 'utf-8'))
  }
  return sources
}

/** join(getAgentDir(), <引号字面量/模板串>) 调用点提取：返回 [首段, 文件名] 列表。 */
function extractAgentDirJoinFirstSegments(sources: Map<string, string>): Array<[string, string]> {
  const hits: Array<[string, string]> = []
  // 匹配 join(getAgentDir(), 'x') / "x" / `x` 三种引号形态；模板串（如 `${APP_NAME}-debug.log`）整段捕获
  const pattern = /join\(getAgentDir\(\),\s*(['"`])([^'"`\n]*?)\1/g
  for (const [file, text] of sources) {
    for (const match of text.matchAll(pattern)) {
      const literal = match[2]
      // 首段 = 字面量第一个路径段（`config/...` 形态首段即 'config'；纯文件名首段是自身）
      hits.push([literal.split('/')[0], file])
    }
  }
  return hits
}

// ── 第一部分：taiji 侧路径结构断言（无条件跑，不依赖 pi 包）─────────────────────

describe('getProviderExtrasPath 路径结构（pi 不扫描子目录落点）', () => {
  it('providers.json 派生自 <piAgentDir>/config/providers.json——首段 config，不在 pi agentDir 顶层扫描面', () => {
    const path = getProviderExtrasPath()
    expect(isAbsolute(path)).toBe(true)
    const segments = relative(getPiAgentDir(), path).split(sep)
    // agentDir 顶层是 pi 的扫描面（models.json / settings.json / auth.json / themes/...）；
    // taiji 扩展域必须落在 config/ 子目录（pi 零引用，见第二部分守卫）而非顶层
    expect(segments).toEqual(['config', 'providers.json'])
  })
})

// ── 第二部分：pi dist 静态守卫（pi 包可达才跑；升级引入占用时红 = 提示复核锚点）──

describe.skipIf(!PI_DIST)(
  `pi dist 对 agent/config/ 零引用契约（ADR-0063 I4 锚点机器防线${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('join(getAgentDir(), …) 家族无 config 子目录（含模板串形态）', () => {
      const dist = PI_DIST as string
      const hits = extractAgentDirJoinFirstSegments(readDistJs(dist))

      // 空集守卫（防正则失配导致 vacuous pass）：pi agentDir 核心三文件必在家族内，
      // 提取不到 = pi 改了路径派生形态 → 本守卫失效，须复核 pi-paths.ts 锚点
      const uniqueFirsts = new Set(hits.map(([first]) => first))
      for (const core of ['models.json', 'settings.json', 'auth.json']) {
        expect(uniqueFirsts, `提取空集守卫失败：${core} 未命中（pi 路径派生改形，复核锚点）`).toContain(core)
      }

      const configHits = hits.filter(([first]) => first === 'config')
      expect(
        configHits,
        'pi 引入了 agent/config/ 子目录引用（升级引入占用）——providers.json 落点前提被打破，' +
        '复核 pi-paths.ts getProviderExtrasPath 锚点并迁移 taiji 扩展域路径',
      ).toEqual([])

      // 字符串拼接变体：getAgentDir() + "/config" 形态零命中
      for (const [file, text] of readDistJs(dist)) {
        const concatHits = [...text.matchAll(/getAgentDir\(\)\s*\+\s*(['"`])\/?config\1/g)]
        expect(
          concatHits,
          `${file} 出现 getAgentDir() + config 拼接形态——同属 config 子目录占用，复核锚点`,
        ).toEqual([])
      }
    })

    it('migrations 对 agentDir 的 readdir 仅扫顶层 .jsonl（不进 config/ 等子目录）', () => {
      const dist = PI_DIST as string
      const migrations = readFileSync(join(dist, 'migrations.js'), 'utf-8')
      const idx = migrations.indexOf('readdirSync(agentDir')
      // 条件守卫：pi 未来删除 migrateSessionsFromAgentRoot（顶层 .jsonl 一次性迁移代码）
      // 不算漂移；保留时必须伴随顶层 .jsonl filter（0.84.1 形态：filter((f) => f.endsWith(".jsonl"))）
      if (idx === -1) return
      const window = migrations.slice(idx, idx + 300)
      expect(
        window.includes('.jsonl'),
        'migrations.js 的 readdirSync(agentDir) 不再伴随 .jsonl filter——pi 改变 agentDir 扫描形态，复核 pi-paths.ts 锚点',
      ).toBe(true)
    })
  },
)
