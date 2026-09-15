/**
 * W3 TDD 测试：platform-updater（三平台升级器）。
 *
 * 覆盖场景 W3TC5-7：
 *   W3TC5 MacUpdater：prepareUpdate → spawn detached bash + unref + 返回 detached-script
 *   W3TC6 WinUpdater（u2a）：写盘 updater.cmd + cmd /c detached spawn + detached-script；
 *         缺 sha256 → throw（RM4/m5）
 *   W3TC7 LinuxAppImageUpdater：APPIMAGE 存在 → detached-script；APPIMAGE 缺失 → UpdateUnsupportedError
 *
 * Mock 策略：vi.hoisted + vi.mock('node:child_process') + vi.mock('electron')。
 *   - spawn 返回带 unref 的假 ChildProcess
 *   - app.isPackaged / process.execPath 注入桩
 *   - fs 用真实 fs（tmp 目录）+ mkdirSync/writeFileSync/chmodSync 真实执行
 *
 * 运行：cd apps/electron/main && npx vitest run test/platform-updater.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── 必须在 import constants（间接被 platform-updater import）前设 ────
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'w3-platform-'))
process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR

// ── vi.hoisted：稳定的 mock 引用（vi.mock factory 在 hoist 后执行）────
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}))
const electronMocks = vi.hoisted(() => ({
  isPackaged: true,
  execPath: '/Applications/TaiJi.app/Contents/MacOS/TaiJi',
}))

vi.mock('node:child_process', () => ({
  spawn: childProcessMocks.spawn,
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() { return electronMocks.isPackaged },
    get execPath() { return electronMocks.execPath }, // 注：实际用 process.execPath，这里 mock app 仅为守卫
  },
}))

// 动态 import：env 已设 + mock 已注册
async function loadModule() {
  return await import('../update/platform-updater.js')
}

/** LatestReleaseInfo fixture（mac asset 带 sha256） */
const MAC_RELEASE = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '',
  publishedAt: '',
  htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
  assets: {
    macArm64Dmg: {
      name: 'TaiJi-mac-arm64.dmg',
      downloadUrl: 'https://example.com/mac.dmg',
      size: 1000,
      sha256: 'a'.repeat(64),
    },
  },
}

const WIN_RELEASE = {
  ...MAC_RELEASE,
  assets: {
    winX64Exe: {
      name: 'TaiJi-setup-x64.exe',
      downloadUrl: 'https://example.com/setup.exe',
      size: 2000,
      sha256: 'c'.repeat(64),
    },
  },
}

const LINUX_RELEASE = {
  ...MAC_RELEASE,
  htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
  assets: {
    linuxX64AppImage: {
      name: 'TaiJi-x86_64.AppImage',
      downloadUrl: 'https://example.com/appimage',
      size: 3000,
      sha256: 'a'.repeat(64),
    },
  },
}

describe('W3: platform-updater (W3TC5-7)', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let originalExecPath: string
  let originalAppImage: string | undefined

  beforeEach(async () => {
    // 保存 process.platform / execPath / APPIMAGE 原值
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    originalExecPath = process.execPath
    originalAppImage = process.env.APPIMAGE

    // 清理 mock 调用记录（spawn 计数等），但保留 mockReturnValue 实现
    vi.clearAllMocks()
    // spawn 返回带 unref 的假 ChildProcess
    childProcessMocks.spawn.mockReturnValue({ unref: vi.fn() })
    electronMocks.isPackaged = true

    await loadModule() // 触发 module load（mock 已生效）
  })

  afterEach(() => {
    // 还原 process 字段
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    vi.restoreAllMocks()
    delete process.env.APPIMAGE
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 设置 process.platform + execPath 桩 */
  function setPlatform(platform: string, execPath: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true })
  }

  // ── W3TC5：MacUpdater ──────────────────────────────────────────
  it('W3TC5: MacUpdater.prepareUpdate → spawn detached bash + 返回 detached-script', async () => {
    setPlatform('darwin', '/Applications/TaiJi.app/Contents/MacOS/TaiJi')
    const { MacUpdater } = await loadModule()
    const updater = new MacUpdater()

    const ref = updater.prepareUpdate('/tmp/downloaded.dmg', MAC_RELEASE as never)

    expect(ref.kind).toBe('detached-script')
    expect(ref).toMatchObject({ kind: 'detached-script', scriptPath: expect.stringContaining('updater.sh') })
    // spawn 被调：bash + 脚本路径 + detached
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = childProcessMocks.spawn.mock.calls[0]
    expect(cmd).toBe('bash')
    expect(args[0]).toMatch(/updater\.sh$/)
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    // 脚本已写盘且占位符全替换
    const scriptContent = readFileSync(ref.kind === 'detached-script' ? ref.scriptPath : '', 'utf-8')
    expect(scriptContent).not.toMatch(/\{\{[^}]+\}\}/)
    expect(scriptContent).toContain('a'.repeat(64)) // sha256 注入
    // PARENT_PID 注入（u1b 契约）：脚本等待的父 PID = 当前 main 进程实际 pid
    expect(scriptContent, 'mac 脚本应注入 PARENT_PID').toContain(`PARENT_PID="${process.pid}"`)
    expect(scriptContent, 'mac 脚本应为 PID 制等待（kill -0）').toContain('kill -0 "$PARENT_PID"')
  })

  it('W3TC5b: dev 模式（!isPackaged）→ 抛 UpdateError', async () => {
    setPlatform('darwin', '/Applications/TaiJi.app/Contents/MacOS/TaiJi')
    electronMocks.isPackaged = false
    const { MacUpdater } = await loadModule()
    const updater = new MacUpdater()

    expect(() => updater.prepareUpdate('/tmp/dl.dmg', MAC_RELEASE as never)).toThrow(/dev mode/)
    expect(childProcessMocks.spawn).not.toHaveBeenCalled()
  })

  it('W3TC5c: mac asset 缺 sha256 → 抛 UpdateError', async () => {
    setPlatform('darwin', '/Applications/TaiJi.app/Contents/MacOS/TaiJi')
    const { MacUpdater } = await loadModule()
    const updater = new MacUpdater()
    const releaseNoSha = {
      ...MAC_RELEASE,
      assets: { macArm64Dmg: { name: 'mac.dmg', downloadUrl: 'x', size: 1 /* 无 sha256 */ } },
    }

    expect(() => updater.prepareUpdate('/tmp/dl.dmg', releaseNoSha as never)).toThrow(/missing sha256/)
  })

  // ── W3TC6：WinUpdater（u2a 改造：cmd wrapper 写盘 + detached spawn）──
  it('W3TC6: WinUpdater.prepareUpdate → 写盘 updater.cmd + cmd /c detached spawn + 返回 detached-script', async () => {
    // 注意：测试在 mac/linux 上跑，path.dirname 用 POSIX 分隔符；故 execPath 用正斜杠模拟。
    // 实际 win 上 path.dirname 会用 win32 分隔符（\\），不影响生产正确性。
    setPlatform('win32', 'C:/Program Files/taiji/TaiJi.exe')
    const { WinUpdater } = await loadModule()
    const updater = new WinUpdater()

    const ref = updater.prepareUpdate('C:/tmp/downloaded.exe', WIN_RELEASE as never)

    // 三平台统一 detached-script 语义（§3.4：行为前移自 orchestrator 延迟分支）
    expect(ref.kind).toBe('detached-script')
    expect(ref).toMatchObject({ kind: 'detached-script', scriptPath: expect.stringContaining('updater.cmd') })
    // wrapper 在 prepareUpdate 内 cmd /c detached spawn（Node 侧延迟 spawn 不可信）
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = childProcessMocks.spawn.mock.calls[0]
    expect(cmd).toBe('cmd')
    expect(args[0]).toBe('/c')
    expect(args[1]).toMatch(/updater\.cmd$/)
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })

    // 脚本已写盘：占位符全替换 + PARENT_PID/sha256/version 注入 + /D= 不加引号
    const scriptContent = readFileSync(ref.kind === 'detached-script' ? ref.scriptPath : '', 'utf-8')
    expect(scriptContent).not.toMatch(/\{\{[^}]+\}\}/)
    expect(scriptContent, 'win 脚本应注入 PARENT_PID（u1b 同契约）').toContain(`set "PARENT_PID=${process.pid}"`)
    expect(scriptContent, 'win 脚本应注入 sha256（certutil 复验用）').toContain('c'.repeat(64))
    expect(scriptContent, 'version 注入').toContain('set "VERSION=0.9.0"')
    expect(scriptContent, 'installDir 注入').toContain('set "INSTALL_DIR=C:/Program Files/taiji"')
    expect(scriptContent, '/D= 值不加引号（NSIS 约定，m16）').toContain('/D=%INSTALL_DIR%')
    expect(scriptContent, '/D= 值不得加引号').not.toContain('/D="')
  })

  it('W3TC6b: win asset 缺 sha256 → 抛 UpdateError（RM4/m5 强制，对齐 mac/linux）', async () => {
    setPlatform('win32', 'C:/Program Files/taiji/TaiJi.exe')
    const { WinUpdater } = await loadModule()
    const updater = new WinUpdater()
    const releaseNoSha = {
      ...WIN_RELEASE,
      assets: { winX64Exe: { name: 'setup.exe', downloadUrl: 'x', size: 1 /* 无 sha256 */ } },
    }

    expect(() => updater.prepareUpdate('C:/tmp/dl.exe', releaseNoSha as never)).toThrow(/missing sha256/)
    // 缺 sha 在生成/写盘/spawn 之前拒绝
    expect(childProcessMocks.spawn).not.toHaveBeenCalled()
  })

  // ── W3TC7：LinuxAppImageUpdater ────────────────────────────────
  it('W3TC7a: APPIMAGE 存在 → detached-script + spawn', async () => {
    setPlatform('linux', '/home/test/TaiJi-x86_64.AppImage')
    process.env.APPIMAGE = '/home/test/TaiJi-x86_64.AppImage'
    const { LinuxAppImageUpdater } = await loadModule()
    const updater = new LinuxAppImageUpdater()

    const ref = updater.prepareUpdate('/tmp/new.AppImage', LINUX_RELEASE as never)

    expect(ref.kind).toBe('detached-script')
    expect(ref).toMatchObject({ kind: 'detached-script', scriptPath: expect.stringContaining('updater-linux.sh') })
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1)
    const [, args] = childProcessMocks.spawn.mock.calls[0]
    expect(args[0]).toMatch(/updater-linux\.sh$/)
    // 脚本占位符替换
    const scriptContent = readFileSync(ref.kind === 'detached-script' ? ref.scriptPath : '', 'utf-8')
    expect(scriptContent).not.toMatch(/\{\{[^}]+\}\}/)
    // PARENT_PID 注入（u1b 契约，与 mac 同语义）：linux 脚本同样 PID 制等待
    expect(scriptContent, 'linux 脚本应注入 PARENT_PID').toContain(`PARENT_PID="${process.pid}"`)
    expect(scriptContent, 'linux 脚本应为 PID 制等待（kill -0）').toContain('kill -0 "$PARENT_PID"')
  })

  it('W3TC7b: APPIMAGE 缺失（deb 包）→ 抛 UpdateUnsupportedError + fallbackUrl', async () => {
    setPlatform('linux', '/usr/bin/taiji')
    delete process.env.APPIMAGE
    const { LinuxAppImageUpdater } = await loadModule()
    const updater = new LinuxAppImageUpdater()

    expect(() => updater.prepareUpdate('/tmp/new.AppImage', LINUX_RELEASE as never)).toThrow(
      /deb package does not support self-update/,
    )
    // 未 spawn
    expect(childProcessMocks.spawn).not.toHaveBeenCalled()
  })

  // ── W3TC8：createPlatformUpdater 工厂 ───────────────────────────
  it('W3TC8: createPlatformUpdater 按平台返回对应 Updater', async () => {
    const { createPlatformUpdater, MacUpdater, WinUpdater, LinuxAppImageUpdater } = await loadModule()

    setPlatform('darwin', '/x/y/z')
    expect(createPlatformUpdater()).toBeInstanceOf(MacUpdater)

    setPlatform('win32', 'C:\\x')
    expect(createPlatformUpdater()).toBeInstanceOf(WinUpdater)

    setPlatform('linux', '/x')
    expect(createPlatformUpdater()).toBeInstanceOf(LinuxAppImageUpdater)

    // 未知平台抛错
    setPlatform('freebsd', '/x')
    expect(() => createPlatformUpdater()).toThrow(/unsupported platform/)
  })
})
