/**
 * existsSync 静默跳过族 warn-once 回归（code-harden RT-8#11）。
 *
 * 覆盖三处「缺失/不可读即跳过、零日志零标记」的降级点——共同症状是「防线从未生效」
 * 却不可观测（配置的扫描目录失效 = 无 skill/agent 被发现；半损坏 SKILL.md = 该 skill
 * 从列表无声消失；clone 出的扩展目录无 package.json = 依赖静默不装）：
 * 1. scanner-base forEachScannedDir：扫描源目录不存在 → warn-once 含路径 + 恢复动作；
 * 2. skill-scanner loadSkillFromDir：SKILL.md 读取失败 → null + warn-once 含文件路径；
 * 3. npm-installer installDependencies：无 package.json → 合法 no-op（空 failed，RT-8#4
 *    审查 D 口径）但 warn-once 留痕（与「确实无依赖」不再完全不可区分）。
 *
 * fixture 全部 mkdtempSync 自建自删（fs-guard 红线：不触碰真实数据目录）。
 *
 * 测试框架：vitest。运行：cd packages/runtime &&
 *   npx vitest run src/services/scanners/__tests__/scanner-degraded-warn.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forEachScannedDir } from '../scanner-base.js'
import { loadSkillFromDir } from '../skill-scanner.js'
import { installDependencies } from '../../../infra/installers/npm-installer.js'
import { _resetWarnOnceForTest } from '../../../utils/warn-once.js'

let tmpDir: string | null = null
let warnSpy: ReturnType<typeof vi.spyOn>

function makeTmpDir(prefix: string): string {
  tmpDir = mkdtempSync(join(tmpdir(), prefix))
  return tmpDir
}

beforeEach(() => {
  _resetWarnOnceForTest()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  _resetWarnOnceForTest()
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    tmpDir = null
  }
})

describe('RT-8#11 scanner-base：扫描源目录不存在 → warn-once（含路径 + 恢复动作）', () => {
  it('缺失的扫描源不静默跳过：warn 含目录绝对路径与「恢复动作」指引，onDir 不被调用', () => {
    const dir = makeTmpDir('scanner-missing-src-')
    const missing = join(dir, 'not-created-skills')
    const onDir = vi.fn()

    forEachScannedDir([missing], onDir)

    expect(onDir).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const warned = String(warnSpy.mock.calls[0]![0])
    expect(warned).toContain(missing)
    expect(warned).toContain('恢复动作')
  })

  it('同一路径重复扫描只 warn 一次（热路径防刷屏）', () => {
    const dir = makeTmpDir('scanner-missing-src-')
    const missing = join(dir, 'gone')

    forEachScannedDir([missing], () => {})
    forEachScannedDir([missing], () => {})

    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('存在的扫描源正常遍历且零 warn（无误报）', () => {
    const dir = makeTmpDir('scanner-ok-src-')
    const skillDir = join(dir, 'my-skill')
    mkdirSync(skillDir, { recursive: true })
    const onDir = vi.fn()

    forEachScannedDir([dir], onDir)

    expect(onDir).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('RT-8#11 skill-scanner：SKILL.md 读取失败 → null + warn-once 含文件路径', () => {
  it('目录无 SKILL.md（读失败）→ 返回 null 且 warn 指明该 skill 不会出现在列表', () => {
    const dir = makeTmpDir('skill-md-missing-')
    const skillDir = join(dir, 'broken-skill')
    mkdirSync(skillDir, { recursive: true })

    const result = loadSkillFromDir(skillDir)

    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const warned = String(warnSpy.mock.calls[0]![0])
    expect(warned).toContain(join(skillDir, 'SKILL.md'))
    expect(warned).toContain('恢复动作')
  })

  it('畸形 SKILL.md（frontmatter 解析抛错）同样留痕（半损坏清单不再无声消失）', () => {
    const dir = makeTmpDir('skill-md-corrupt-')
    const skillDir = join(dir, 'corrupt-skill')
    mkdirSync(skillDir, { recursive: true })
    // 以目录形式占位 SKILL.md 路径 → readFileSync 抛 EISDIR，走 catch 降级分支
    mkdirSync(join(skillDir, 'SKILL.md'), { recursive: true })

    expect(loadSkillFromDir(skillDir)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('SKILL.md')
  })
})

describe('RT-8#11 npm-installer：无 package.json 的依赖安装 → 空 failed + warn-once', () => {
  it('无 package.json = 合法 no-op（failed 空，不进失败类）但 warn-once 含路径与指引', async () => {
    const dir = makeTmpDir('npm-install-deps-noop-')

    const result = await installDependencies(dir)

    expect(result.failed).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const warned = String(warnSpy.mock.calls[0]![0])
    expect(warned).toContain(join(dir, 'package.json'))
    expect(warned).toContain('恢复动作')
  })

  it('有 package.json 时零 warn（无依赖声明也属合法，不误报）', async () => {
    const dir = makeTmpDir('npm-install-deps-ok-')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }), 'utf-8')

    const result = await installDependencies(dir)

    expect(result.failed).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
