/**
 * check-guide-contract-projection.mjs 守卫自身测试（2026-09-20 R1 评审补：同族 17 守卫
 * 均有测试，本守卫已接线 pre-commit 而无测试——失效即假绿放行指南漂移）。
 *
 * 模式 = check-thinking-levels.test.mjs 同款「tmp mirror + spawnSync」：守卫以
 * `dirname(import.meta.url)/..` 求 ROOT，把脚本复制进 <tmp>/scripts/ 后 ROOT 即 <tmp>，
 * 指南与三份源码词表全部落 fixture（mkdtemp 自建自删，同 scripts/__tests__ 既有惯例，
 * 不触真实仓库文件）。锁定行为：
 *   R1 四面对账一致 → exit 0
 *   R2 源码词表加码指南未同步 → exit 1 + 缺码定位 + 计数失同步 + 恢复动作
 *   R3 manifest 能力值三面漂移 → exit 1 + 三面不一致定位
 *   R4 书写契约破坏（指南词表行被删）→ exit 1 + 形态缺失定位
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-guide-contract-projection.mjs')

const ERRORS_TS = (codes) =>
  `export const ENGINE_ERROR_CODES = [${codes.map((c) => `"${c}"`).join(', ')}] as const\n`

const SDK_TS = (codes) =>
  `export const ENGINE_PROTOCOL_ERROR_CODES = [${codes.map((c) => `"${c}"`).join(', ')}] as const\n`

const MANIFEST_TS = (keys) =>
  `const CAPABILITY_ENUMS: Record<string, readonly string[]> = {\n${keys
    .map((k) => `  ${k}: ["native", "emulated"],`)
    .join('\n')}\n}\n`

const ENGINE_TS = (caps) => `class Engine {
  capabilities(): EngineCapabilities {
    return {
${caps.map(([k, v]) => `      ${k}: ${typeof v === 'boolean' ? v : `"${v}"`},`).join('\n')}
    }
  }
}
`

const GUIDE_MD = ({ hostCodes, sdkCount, capKeys, capValues, hostLine }) => {
  const host = hostLine ?? `封闭枚举 ${hostCodes.length} 条——${hostCodes.map((c) => `\`${c}\``).join(' / ')}`
  const capsJson = Object.entries(capValues)
    .map(([k, v]) => `    "${k}": ${typeof v === 'boolean' ? v : `"${v}"`}`)
    .join(',\n')
  return `# guide

## §3 能力位
能力位全集 ${capKeys.length} 位：

| 能力位 | 取值 |
|---|---|
${capKeys.map((k) => `| \`${k}\` | ... |`).join('\n')}

## §4 错误码
宿主词表${host}。

SDK 侧 \`ENGINE_PROTOCOL_ERROR_CODES\` ${sdkCount} 条固定词表。
`
    .concat(`

## §1 manifest 完整示例

\`\`\`json
{
  "taiji": {
    "subagentEngine": {
      "capabilities": {
${capsJson}
      }
    }
  }
}
\`\`\`
`)
}

/** 组装 tmp mirror：<tmp>/scripts/ 放守卫脚本本体（ROOT 解析即 <tmp>），其余为 fixture。
 *  漂移注入只动单面（hostCodes / pkgCapValues / guideOverride），指南与 engine.ts 恒按
 *  基准形态生成——否则漂移被 fixture 自身「同步」掉，守卫恒绿。 */
function makeFixture({ hostCodes = ['err_a', 'err_b'], sdkCodes = ['p_x', 'p_y', 'p_z'], capKeys = ['capsA'], pkgCapValues, guideOverride } = {}) {
  const baseValues = { capsA: 'mode-x', maxTurns: false }
  const root = mkdtempSync(join(tmpdir(), 'gcp-guard-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT_SRC, join(root, 'scripts', 'check-guide-contract-projection.mjs'))
  const errorsFile = join(root, 'packages/subagent-core/src/execution/engine/common')
  const sdkFile = join(root, 'packages/subagent-engine-sdk/src/protocol')
  const manifestFile = join(root, 'packages/subagent-core/src/execution/engine')
  const engineDir = join(root, 'packages/zcode-subagent-cli/src')
  const guideDir = join(root, 'docs/extensions/subagents')
  for (const d of [errorsFile, sdkFile, manifestFile, engineDir, guideDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(errorsFile, 'errors.ts'), ERRORS_TS(hostCodes))
  writeFileSync(join(sdkFile, 'error-codes.ts'), SDK_TS(sdkCodes))
  writeFileSync(join(manifestFile, 'engine-manifest.ts'), MANIFEST_TS(capKeys))
  writeFileSync(
    join(root, 'packages/zcode-subagent-cli/package.json'),
    JSON.stringify({ taiji: { subagentEngine: { capabilities: pkgCapValues ?? baseValues } } }),
  )
  writeFileSync(join(engineDir, 'zcode-engine.ts'), ENGINE_TS(Object.entries(baseValues)))
  writeFileSync(
    join(guideDir, 'engine-development-guide.md'),
    guideOverride ??
      GUIDE_MD({
        hostCodes: ['err_a', 'err_b'],
        sdkCount: 3,
        capKeys: [...capKeys, 'maxTurns'],
        capValues: baseValues,
      }),
  )
  const run = () => spawnSync(process.execPath, [join(root, 'scripts', 'check-guide-contract-projection.mjs')], { encoding: 'utf-8' })
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }
}

describe('check-guide-contract-projection（tmp mirror × spawnSync）', () => {
  it('R1 四面对账一致 → exit 0 + OK 汇总', () => {
    const fx = makeFixture()
    try {
      const r = fx.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('OK')
      expect(r.stdout).toContain('宿主词表 2 条')
    } finally {
      fx.cleanup()
    }
  })

  it('R2 源码词表加码指南未同步 → exit 1 + 缺码 + 计数失同步 + 恢复动作', () => {
    const fx = makeFixture({ hostCodes: ['err_a', 'err_b', 'err_c'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('err_c')
      expect(r.stdout).toContain('计数失同步')
      expect(r.stdout).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('R3 manifest 能力值三面漂移（package.json 单面改值）→ exit 1 + 三面不一致定位', () => {
    const fx = makeFixture({ pkgCapValues: { capsA: 'mode-y', maxTurns: false } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('capsA')
      expect(r.stdout).toContain('三面不一致')
    } finally {
      fx.cleanup()
    }
  })

  it('R4 书写契约破坏（指南词表行被删）→ exit 1 + 形态缺失定位', () => {
    const fx = makeFixture({ guideOverride: GUIDE_MD({ hostCodes: ['err_a', 'err_b'], sdkCount: 3, capKeys: ['capsA', 'maxTurns'], capValues: { capsA: 'mode-x', maxTurns: false }, hostLine: '（词表行已被删除）' }) })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('找不到宿主词表行')
    } finally {
      fx.cleanup()
    }
  })
})
