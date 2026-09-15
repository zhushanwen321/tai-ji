import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'

/**
 * S1-W4（D3 信任级判定权回收）安全回归测试。
 *
 * 覆盖四条新语义：
 *   1. external 插件 manifest 自报 trusted → 强制 sandbox + warning
 *   2. built-in source 一律 trusted（manifest 声明也不参与判定）
 *   3. --builtin-plugins-dir 显式指定时不做 cwd 探测（防 repo 预置目录注入）
 *   4. 缺失该参数时回退 cwd 探测 + warning（dev 直跑/测试兼容，fail-visible）
 * 外加 electron 主进程 spawn 侧参数注入的源码级断言（vitest 到不了 electron 主进程）。
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
/** worktree 根（test/ → packages/runtime → packages → root），statusline 真实 built-in 目录在 <root>/resources/plugins */
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
/** electron 主进程 spawn 源文件（代码审查级断言用） */
const PROCESS_CONTROL_SRC = resolve(REPO_ROOT, 'apps', 'electron', 'main', 'supervisor', 'process-control.ts')

let tmpDir: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-registry-trust-'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  warnSpy.mockRestore()
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 在 <base>/<...segments>/ 下写入一个最小插件目录（package.json + manifest 合并字段） */
async function writePlugin(base: string, segments: string[], name: string, manifestExtra: Record<string, unknown> = {}): Promise<string> {
  const pluginDir = join(base, ...segments, name)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    taijiPlugin: { manifestVersion: 1, main: 'index.js', activationEvents: ['onStartupFinished'], ...manifestExtra },
  }), 'utf-8')
  return pluginDir
}

/** 断言 warn spy 收到过一条含所有给定片段的消息 */
function warnMessages(): string[] {
  return warnSpy.mock.calls.map((c: unknown[]) => c.join(' '))
}

function expectWarnedContaining(...fragments: string[]): void {
  expect(warnMessages().some((msg: string) => fragments.every(f => msg.includes(f)))).toBe(true)
}

describe('PluginRegistry trust boundary (S1-W4 / D3)', () => {
  it('SEC-U1 external: manifest self-declared trustLevel "trusted" is forced to sandbox with warning', async () => {
    await writePlugin(tmpDir, ['.taiji', 'plugins'], 'evil-trusted', { trustLevel: 'trusted' })

    const registry = new PluginRegistry(tmpDir, tmpDir)
    const descriptors = await registry.scan()

    const desc = descriptors.find(d => d.pluginId === 'evil-trusted')
    expect(desc).toBeTruthy()
    expect(desc!.source).toBe('external')
    // 核心：自报 trusted 被宿主强制覆盖为 sandbox
    expect(desc!.trustLevel).toBe('sandbox')
    // fail-visible：落 warning，含插件 id 与被忽略的声明值
    expectWarnedContaining('evil-trusted', 'trusted', 'sandbox')
  })

  it('SEC-U1 external: manifest declaring sandbox or omitting trustLevel stays sandbox without warning', async () => {
    await writePlugin(tmpDir, ['.taiji', 'plugins'], 'honest-sandbox', { trustLevel: 'sandbox' })
    await writePlugin(tmpDir, ['.taiji', 'plugins'], 'no-declaration', {})

    const registry = new PluginRegistry(tmpDir, tmpDir)
    const descriptors = await registry.scan()

    expect(descriptors.find(d => d.pluginId === 'honest-sandbox')!.trustLevel).toBe('sandbox')
    expect(descriptors.find(d => d.pluginId === 'no-declaration')!.trustLevel).toBe('sandbox')
    // 声明值与强制值一致（sandbox/缺省）时无「ignored and forced」warning
    expect(warnMessages().some((msg: string) => msg.includes('ignored and forced'))).toBe(false)
  })

  it('SEC-U1 builtin: built-in source plugins are always trusted even when manifest declares sandbox', async () => {
    const builtinDir = join(tmpDir, 'explicit-builtin')
    // manifest 自降 sandbox 也无效：source=built-in 一律 trusted（宿主判定权）
    await writePlugin(builtinDir, [], 'builtin-sandbox-declared', { trustLevel: 'sandbox' })
    await writePlugin(builtinDir, [], 'builtin-no-declaration', {})

    const registry = new PluginRegistry(tmpDir, join(tmpDir, 'config'), builtinDir)
    const descriptors = await registry.scan()

    expect(descriptors.find(d => d.pluginId === 'builtin-sandbox-declared')!.trustLevel).toBe('trusted')
    expect(descriptors.find(d => d.pluginId === 'builtin-no-declaration')!.trustLevel).toBe('trusted')
  })

  it('SEC-U1 builtin dir: explicit --builtin-plugins-dir path is used exclusively, no cwd probing', async () => {
    // 模拟 pnpm dev 的 runtime cwd：<root>/apps/electron（仓库根在其上两层）
    const projectRoot = join(tmpDir, 'apps', 'electron')
    await mkdir(projectRoot, { recursive: true })

    // cwd 探测链的两个候选位置各放一个「恶意预置」插件（供应链攻击面）
    await writePlugin(projectRoot, ['resources', 'plugins'], 'local-rogue-builtin')
    await writePlugin(tmpDir, ['resources', 'plugins'], 'up-level-rogue-builtin')

    // 显式注入目录放合法 built-in
    const explicitDir = join(tmpDir, 'explicit-builtin-dir')
    await writePlugin(explicitDir, [], 'legit-builtin')

    const registry = new PluginRegistry(projectRoot, join(tmpDir, 'config'), explicitDir)
    const descriptors = await registry.scan()

    const ids = descriptors.map(d => d.pluginId)
    // 显式路径唯一优先：合法 built-in 可见
    expect(ids).toContain('legit-builtin')
    // cwd 两个候选位置的插件都不得被发现（不做探测）
    expect(ids).not.toContain('local-rogue-builtin')
    expect(ids).not.toContain('up-level-rogue-builtin')
    // 显式指定时不落回退 warning
    expect(warnMessages().some((msg: string) => msg.includes('falling back'))).toBe(false)
  })

  it('SEC-U1 builtin dir: explicit path wins even when it does not exist (no downgrade to cwd probing)', async () => {
    const projectRoot = join(tmpDir, 'apps', 'electron')
    await mkdir(projectRoot, { recursive: true })
    // cwd 候选位置存在恶意预置插件，显式路径却不存在
    await writePlugin(tmpDir, ['resources', 'plugins'], 'rogue-when-missing')

    const registry = new PluginRegistry(projectRoot, join(tmpDir, 'config'), join(tmpDir, 'missing-builtin-dir'))
    const descriptors = await registry.scan()

    // 显式路径缺失 → built-in 扫描为空（readdir 失败静默跳过），绝不降级捡 cwd 目录
    expect(descriptors.map(d => d.pluginId)).not.toContain('rogue-when-missing')
  })

  it('SEC-U1 fallback: missing --builtin-plugins-dir falls back to cwd probing with warning', async () => {
    // 不传第三参（模拟 dev 直跑 / vitest / e2e 脚本起 runtime 无主进程）
    const projectRoot = join(tmpDir, 'apps', 'electron')
    await mkdir(projectRoot, { recursive: true })
    await writePlugin(tmpDir, ['resources', 'plugins'], 'fallback-builtin')

    const registry = new PluginRegistry(projectRoot, join(tmpDir, 'config'))
    const descriptors = await registry.scan()

    // 回退探测仍可用（测试环境 built-in 可见性）
    const desc = descriptors.find(d => d.pluginId === 'fallback-builtin')
    expect(desc).toBeTruthy()
    expect(desc!.source).toBe('built-in')
    expect(desc!.trustLevel).toBe('trusted')
    // fail-visible：使用回退时落 warning
    expectWarnedContaining('--builtin-plugins-dir', 'falling back')
  })

  it('SEC-U1 statusline regression: the only built-in plugin stays trusted and discoverable under new rules', async () => {
    // 用真实 worktree 的 resources/plugins（statusline 所在）+ 显式注入目录形态验证：
    // 主进程总是显式传参的生产路径下，statusline source=built-in、trustLevel=trusted、入口可解析
    const builtinDir = join(REPO_ROOT, 'resources', 'plugins')
    expect(existsSync(join(builtinDir, 'statusline'))).toBe(true)

    const registry = new PluginRegistry(tmpDir, tmpDir, builtinDir)
    const descriptors = await registry.scan()

    const desc = descriptors.find(d => d.pluginId === 'statusline')
    expect(desc).toBeTruthy()
    expect(desc!.source).toBe('built-in')
    expect(desc!.trustLevel).toBe('trusted')
    expect(desc!.pluginPath).toBe(join(builtinDir, 'statusline', 'index.js'))
  })

  it('SEC-U1 electron: process-control.ts injects --builtin-plugins-dir in both packaged and dev spawn forms', async () => {
    // vitest 到不了 electron 主进程，做源码级断言（代码审查自动化）
    const src = await readFile(PROCESS_CONTROL_SRC, 'utf-8')

    // 两种 spawn 形态（打包 process.execPath / dev node+tsx）各注入一次
    const injections = src.match(/--builtin-plugins-dir=/g) ?? []
    expect(injections.length).toBeGreaterThanOrEqual(2)
    // 打包形态：process.resourcesPath + resources/plugins（extraResources 拷贝目标）
    expect(src).toContain("path.join(process.resourcesPath, 'resources', 'plugins')")
    // dev 形态：repo 根 resources/plugins
    expect(src).toContain("path.join(repoRoot, 'resources', 'plugins')")
  })
})
