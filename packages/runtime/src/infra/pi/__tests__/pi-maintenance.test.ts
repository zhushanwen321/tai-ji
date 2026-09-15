/**
 * pi-maintenance 单元测试：
 * - getPiGlobalAgentDir 从 getDataDir() 起推导（dataDir 的兄弟 .pi/agent，不再锚定
 *   getPiAgentDir 的 pi/agent 子树层数——SSOT 切 <dataDir>/agent 后向上 3 层会多走一层）
 * - syncBundledResources 导出可用（非打包环境 no-op 不抛错）
 *
 * 写删目标全部 mkdtempSync 自建自删（fs-guard 白名单 = os.tmpdir()），不触碰真实数据目录。
 *
 * 运行命令：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-maintenance.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve as pathResolve } from 'node:path'
import { tmpdir } from 'node:os'
import { getPiGlobalAgentDir, syncBundledResources } from '../pi-maintenance.js'

/** 建临时数据目录并在测试结束后删除（写删目标限 os.tmpdir()，fs-guard 白名单内）。 */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return dir
}

describe('getPiGlobalAgentDir 推导（从 getDataDir() 起）', () => {
  const savedEnv = process.env.TAIJI_AGENT_DATA_DIR

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  })

  it('= <dataDir> 兄弟 .pi/agent（向上 1 层，不随 getPiAgentDir 内部层数漂移）', () => {
    const dataDir = makeTempDir('pi-maintenance-data-')
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    try {
      expect(getPiGlobalAgentDir()).toBe(pathResolve(dataDir, '..', '.pi', 'agent'))
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('推导与 dataDir 嵌套深度无关（tmp 深层 dataDir 仍得兄弟 .pi/agent）', () => {
    const outer = makeTempDir('pi-maintenance-outer-')
    const dataDir = join(outer, 'deep', 'nested', 'taiji-data')
    mkdirSync(dataDir, { recursive: true })
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    try {
      expect(getPiGlobalAgentDir()).toBe(pathResolve(dataDir, '..', '.pi', 'agent'))
    } finally {
      rmSync(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('syncBundledResources 导出可用', () => {
  const savedFlag = process.env.TAIJI_AGENT_PACKAGED

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.TAIJI_AGENT_PACKAGED
    else process.env.TAIJI_AGENT_PACKAGED = savedFlag
  })

  it('函数已导出可调用；非打包环境（未设 TAIJI_AGENT_PACKAGED）no-op 不抛错', () => {
    expect(typeof syncBundledResources).toBe('function')
    delete process.env.TAIJI_AGENT_PACKAGED
    expect(() => syncBundledResources()).not.toThrow()
  })
})

// ── 打包态分支（R3 S-1 补测：isPackaged 门控内在 vitest 下恒 false，打包态分支体此前零覆盖；
//    迁移后 builtin 扩展缺失属项目事故最高发族，回归只在打包产物启动时显形）──────────
//
// 打包态从 env（TAIJI_AGENT_PACKAGED=1）进入；bundled 源根 = process.cwd()/pi/agent（app
// 资源布局），用 vi.spyOn(process, 'cwd') 指向 mkdtemp 自建 appRoot——写删目标全部
// mkdtempSync 自建自删（fs-guard 白名单 = os.tmpdir()），严禁触碰真实 dataDir。
describe('syncBundledResources 打包态同步（bundled extensions/skills → 数据目录）', () => {
  const savedFlag = process.env.TAIJI_AGENT_PACKAGED
  const savedDataDir = process.env.TAIJI_AGENT_DATA_DIR

  let appRoot: string
  let dataDir: string
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let cwdSpy: { mockRestore: () => void; mockReturnValue: (v: string) => void }

  /** 建 app 资源布局 fixture：<appRoot>/pi/agent/{extensions/my-ext,skills/my-skill}。 */
  function makeBundledSources(): void {
    mkdirSync(join(appRoot, 'pi', 'agent', 'extensions', 'my-ext'), { recursive: true })
    mkdirSync(join(appRoot, 'pi', 'agent', 'skills', 'my-skill'), { recursive: true })
    writeFileSync(join(appRoot, 'pi', 'agent', 'extensions', 'my-ext', 'index.js'), 'export {}')
    writeFileSync(join(appRoot, 'pi', 'agent', 'extensions', 'my-ext', 'package.json'), '{"name":"my-ext"}')
    writeFileSync(join(appRoot, 'pi', 'agent', 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---')
  }

  beforeEach(() => {
    appRoot = makeTempDir('pi-maintenance-approot-')
    dataDir = makeTempDir('pi-maintenance-packaged-')
    process.env.TAIJI_AGENT_PACKAGED = '1'
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // bundled 源根 = join(process.cwd(), 'pi', 'agent')：cwd spy 指向自建 appRoot
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(appRoot)
  })

  afterEach(() => {
    cwdSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
    errorSpy.mockRestore()
    if (savedFlag === undefined) delete process.env.TAIJI_AGENT_PACKAGED
    else process.env.TAIJI_AGENT_PACKAGED = savedFlag
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    for (const dir of [appRoot, dataDir]) {
      // 复制失败用例曾把 dataDir chmod 0o555：先恢复权限再删（rmSync 对只读父目录 EACCES）
      try { chmodSync(dir, 0o755) } catch { /* 已删或本就无 chmod */ }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('打包态：extensions → <dataDir>/extensions（根层）、skills → <dataDir>/agent/skills 递归复制，成功 log 出声', () => {
    makeBundledSources()
    expect(() => syncBundledResources()).not.toThrow()

    // extensions 落 dataDir 根层（迁出 agent/ 子树后的现行布局）
    expect(existsSync(join(dataDir, 'extensions', 'my-ext', 'index.js'))).toBe(true)
    expect(readFileSync(join(dataDir, 'extensions', 'my-ext', 'package.json'), 'utf-8')).toContain('my-ext')
    // skills 仍在 pi/agent/skills（bundled pi 自带 skill）
    expect(existsSync(join(dataDir, 'agent', 'skills', 'my-skill', 'SKILL.md'))).toBe(true)

    const logs = logSpy.mock.calls.map(String).join(' ')
    expect(logs).toContain('synced bundled extensions')
    expect(logs).toContain('synced bundled skills')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('打包态：bundled 源缺失 → warn 出声并跳过该子目录，另一子目录照常同步（打包链断裂可观测）', () => {
    mkdirSync(join(appRoot, 'pi', 'agent', 'skills', 'my-skill'), { recursive: true })
    writeFileSync(join(appRoot, 'pi', 'agent', 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---')
    // extensions 源目录缺失（不建）
    expect(() => syncBundledResources()).not.toThrow()

    const warns = warnSpy.mock.calls.map(String).join(' ')
    expect(warns).toContain('bundled source missing, skip sync')
    expect(warns).toContain(join(appRoot, 'pi', 'agent', 'extensions'))
    // skills 照常同步
    expect(existsSync(join(dataDir, 'agent', 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dataDir, 'extensions'))).toBe(false)
  })

  it('打包态：复制失败（目标父目录只读）→ console.error 出声不抛错（非致命，启动不中断）', () => {
    makeBundledSources()
    // dataDir 只读 → cpSync 建目标目录 EACCES（写删目标仍在 fs-guard 白名单 tmp 内）
    chmodSync(dataDir, 0o555)
    try {
      expect(() => syncBundledResources()).not.toThrow()
    } finally {
      chmodSync(dataDir, 0o755)
    }
    const errors = errorSpy.mock.calls.map(String).join(' ')
    expect(errors).toContain('failed to sync bundled')
    expect(existsSync(join(dataDir, 'extensions'))).toBe(false)
  })
})
