import builtinData from '../../../generated/builtin-providers.json';
import { AuthStorage } from '../../../services/auth/auth-storage.js';
import { ProviderCredentialResolver } from '../../../services/auth/provider-credential-resolver.js';
import { ConfigService } from '../../../services/config-service.js';
import { JsonStore } from '../../../utils/json-store.js';
import { logger } from '../../logger.js';
import { deleteAgentFile, listAgentFiles, writeAgentFile } from '../agent-crud.js';
import { invalidateDiscoveryCache, setDiscoveryPath } from '../discovery-store.js';
import { CODEMODE_DEFAULT_ENTRY, CODEMODE_DISABLE_ENTRY, PI_DEFAULT_TOOL_NAMES, PiCodemodeSettings, TOOL_SEARCH_DEFAULT_ENTRY, ensureCodemodeDefaultEntry, ensureToolSearchDefaultEntry, isCodemodeActive, resolveDefaultToolSet, runCodemodeStartupMigration, setCodemodeEntry } from '../pi-codemode-settings.js';
import { PiConfigStore } from '../pi-config-store.js';
import { PiExtensionSettings } from '../pi-extension-settings.js';
import { getPiGlobalAgentDir, syncBundledResources } from '../pi-maintenance.js';
import { DEFAULT_PROBE_TIMEOUT_MS, type McpProbeOptions, type McpProbeResult } from '../pi-mcp-probe.js';
import { PiMcpServers } from '../pi-mcp-servers.js';
import { McpStoreError, addMcpServer, mcpServerNamespace, readMcpServers, removeMcpServer, setMcpServerEnabled, setMcpStorePathForTest, type McpFormFields, updateMcpServer, validateMcpEntryForRead, validateMcpEntryForSave } from '../pi-mcp-store.js';
import { getAgentsDir, getPiAgentDir, getProviderExtrasPath } from '../pi-paths.js';
import { extractExtensionCommandNames, matchCommandName } from '../pi-protocol.js';
import { clearProviderApiKey, findValidDefaultModel, getProviderConfig, initProviderCredentialResolver, readModels, sanitizeInvalidProviders, setModelsPath } from '../pi-provider-store.js';
import { PiRetrySettings } from '../pi-retry-settings.js';
import { SettingsCorruptedError, SettingsWriteRejectedError, getActiveSettingsPath, getSettingsCorruption, invalidateSettingsCache, readSettings, setSettingsPath, type SettingsCorruption, updateSettingsFields } from '../pi-settings-store.js';
import { getSkillPaths, setSkillPaths } from '../pi-skill-paths.js';
import type { McpServerEntryValue } from '@taiji/shared';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve as pathResolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← agent-crud-path-escape.test.ts
// ======================================================================

let dataDir: string

let savedEnv: string | undefined


function agentsDir(): string {
  return getAgentsDir()
}


function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('agent-crud-path-escape', () => {
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agent-crud-escape-'))
  mkdirSync(join(dataDir, 'agent', 'agents'), { recursive: true })
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  vi.restoreAllMocks()
})
describe('RT-3#11: writeAgentFile 单段校验（越界名抛错且不产生越界文件）', () => {
  it.each([
    ['../evil', '相对上跳'],
    ['../../deeper-evil', '多级上跳'],
    ['sub/evil', '子目录形态'],
    ['..', '纯上跳段'],
    ['evil\\name', '反斜杠分隔'],
    ['../evil.md', '带 .md 后缀的上跳'],
  ])('name = %s（%s）：抛错 + 越界位置无文件产生', (name) => {
    expect(() => writeAgentFile(name, 'content')).toThrow(/非法的 agent 名称/)
    expect(() => writeAgentFile(name, 'content')).toThrow(/单段文件名/)
    // 越界写未发生：agents 目录本身、其父层（agent/）、数据根均无 evil*.md
    expect(existsSync(join(dataDir, 'agent', 'evil.md'))).toBe(false)
    expect(existsSync(join(dataDir, 'evil.md'))).toBe(false)
    expect(readdirSync(agentsDir())).toHaveLength(0)
  })

  it('合法名正常写入 agents 目录（检查不误伤正常路径）', () => {
    writeAgentFile('my-agent', '---\ndescription: x\n---\nbody')
    expect(existsSync(join(agentsDir(), 'my-agent.md'))).toBe(true)
    // 带后缀名也照常（fileName 不重复拼接）
    writeAgentFile('typed.md', 'body')
    expect(existsSync(join(agentsDir(), 'typed.md'))).toBe(true)
  })
})
describe('RT-3#11: deleteAgentFile 单段校验（删除向量对称检查）', () => {
  it.each([
    ['../evil', '相对上跳'],
    ['sub/evil', '子目录形态'],
  ])('name = %s（%s）：抛错（不静默返回 false 掩盖越界删除）', (name) => {
    expect(() => deleteAgentFile(name)).toThrow(/非法的 agent 名称/)
  })

  it('不存在的合法名：安静返回 false（保留原语义）', () => {
    expect(deleteAgentFile('nonexistent')).toBe(false)
  })

  it('存在的合法名：删除成功返回 true', () => {
    writeAgentFile('gone', 'body')
    expect(deleteAgentFile('gone')).toBe(true)
    expect(existsSync(join(agentsDir(), 'gone.md'))).toBe(false)
  })

  it('unlink 非 ENOENT 失败：warn 留痕（含路径与原因）+ 返回 false，与「不存在」可区分', async () => {
    writeAgentFile('victim', 'body')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const victimPath = join(agentsDir(), 'victim.md')
    const fs = await import('node:fs')
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw errnoError('EACCES: permission denied, unlink', 'EACCES')
    })

    expect(deleteAgentFile('victim')).toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('[agent-crud] failed to delete agent file')
    expect(warnSpy.mock.calls[0]![1]).toMatchObject({ file: victimPath })
    expect(existsSync(victimPath)).toBe(true)
  })

  it('unlink ENOENT 竞态：保持安静返回 false（不 warn）', async () => {
    writeAgentFile('raced', 'body')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fs = await import('node:fs')
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw errnoError('ENOENT: no such file or directory', 'ENOENT')
    })

    expect(deleteAgentFile('raced')).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
describe('RT-3#11: listAgentFiles 读侧静默失败收尾', () => {
  it('readdir 非 ENOENT 失败：warn 含目录路径与原因，返回空列表不抛', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fs = await import('node:fs')
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw errnoError('EACCES: permission denied, scandir', 'EACCES')
    })

    const result = listAgentFiles()
    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('failed to read agent directory')
    expect(warnSpy.mock.calls[0]![1]).toMatchObject({ dir: agentsDir() })
  })

  it('readdir ENOENT（existsSync 后目录被移走竞态）：保持安静', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fs = await import('node:fs')
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw errnoError('ENOENT: no such file or directory', 'ENOENT')
    })

    expect(listAgentFiles()).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('单文件读失败：跳过该文件、其余正常返回，非 ENOENT 时 warn 含文件路径', async () => {
    writeFileSync(join(agentsDir(), 'good.md'), 'good content', 'utf-8')
    writeFileSync(join(agentsDir(), 'bad.md'), 'bad content', 'utf-8')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fs = await import('node:fs')
    // 选择性故障：bad.md 抛错，其余路径返回占位内容（mock 内不回调真实实现，防递归）
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('bad.md')) {
        throw errnoError('EISDIR: illegal operation on a directory', 'EISDIR')
      }
      return 'stub-content'
    }) as typeof fs.readFileSync)

    const entries = listAgentFiles()
    expect(entries.map(e => e.name)).toEqual(['good'])
    expect(entries[0]!.content).toBe('stub-content')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('failed to read agent file')
    expect(warnSpy.mock.calls[0]![1]).toMatchObject({ file: join(agentsDir(), 'bad.md') })
  })
})
});


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/infra/pi/__tests__/pi-provider-store.test.ts
// ======================================================================

let dir: string


let agentDir: string


/** 真实结构：<dataDir>/agent/（getPiAgentDir = getConfigDir()/agent） */
function realAgentDir(): string {
  return join(dir, 'agent')
}


function writeModels(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}


function writeSettings(defaultProvider?: string, defaultModel?: string): void {
  const s: Record<string, unknown> = {}
  if (defaultProvider) s.defaultProvider = defaultProvider
  if (defaultModel) s.defaultModel = defaultModel
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(s, null, 2))
}


function writeAuth(credentials: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify(credentials, null, 2))
}


/**
 * 注入链 3 的生产形态 resolver（M2c）：auth.json 经真实 AuthStorage（无缓存，写文件后
 * 立即可读），models.json 经本模块 readModels/getProviderConfig（与消费点共享同一缓存）。
 * 自 M2c 起 findValidDefaultModel 的凭据判定只走注入的 resolver——原私有裸读（直读 auth.json）
 * 已删除，未注入时 resolver 缺失 → 视为无凭据（安全降级）。
 */
function initResolver(): void {
  initProviderCredentialResolver(new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: new AuthStorage(join(agentDir, 'auth.json')),
    configStore: { readModels, getProviderConfig },
  }))
}


// ══ D2 存量清洗（catalog-provider-field-authority v3.3 §3.3 D2）══════════════
//
// 清洗顺序契约：① 空串键剥除 → ② catalog 条目的 provider 级键处置（api 一律剥 /
// baseUrl 按 extras gatewayBaseUrl 标记，仅存在性判定）→ 既有空壳判定/修复（MF-5 语义不变）。
// 标记读取经注入的 getExtrasSync（infra 层不 import services 实现，C-comm-03）。

/** 读盘上的 providers 对象（断言真实落盘内容，而非内存模型）。 */
function readProvidersFromDisk(): Record<string, Record<string, unknown>> {
  return (JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8')) as {
    providers: Record<string, Record<string, unknown>>
  }).providers
}


/** 注入标记读取原语（仅存在性语义）。 */
function markerReader(marked: string[]) {
  return { getExtrasSync: (id: string) => (marked.includes(id) ? { gatewayBaseUrl: 'https://gw.example' } : undefined) }
}


// ======================================================================
// ← src/infra/pi/__tests__/pi-provider-store-finddefault.test.ts
// ======================================================================

let dir_m2_m2_m2_m2_m2_m2_m2: string


let agentDir_m2_m2: string


/** 真实结构：<dataDir>/agent/（getPiAgentDir = getConfigDir()/agent） */
function realAgentDir_m2(): string {
  return join(dir_m2_m2_m2_m2_m2_m2_m2, 'agent')
}


function writeModels_m2(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir_m2_m2, 'models.json'), JSON.stringify({ providers }, null, 2))
}


/**
 * 写 settings.json，含可选 defaultProvider/defaultModel/enabledModels。
 * enabledModels 是 wave2 DM3 的 provider 启用白名单源。
 */
function writeSettings_m2(opts: { defaultProvider?: string; defaultModel?: string; enabledModels?: string[] } = {}): void {
  const s: Record<string, unknown> = {}
  if (opts.defaultProvider) s.defaultProvider = opts.defaultProvider
  if (opts.defaultModel) s.defaultModel = opts.defaultModel
  if (opts.enabledModels) s.enabledModels = opts.enabledModels
  writeFileSync(join(agentDir_m2_m2, 'settings.json'), JSON.stringify(s, null, 2))
}


function writeAuth_m2(credentials: Record<string, unknown>): void {
  writeFileSync(join(agentDir_m2_m2, 'auth.json'), JSON.stringify(credentials, null, 2))
}


/** 注入链 3 生产形态 resolver（M2c）：auth.json 经真实 AuthStorage（无缓存，读实时文件）。 */
function initResolver_m2(): void {
  initProviderCredentialResolver(new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: new AuthStorage(join(agentDir_m2_m2, 'auth.json')),
    configStore: { readModels, getProviderConfig },
  }))
}


// ======================================================================
// ← src/infra/pi/__tests__/pi-mcp-store.test.ts
// ======================================================================

/**
 * 定位实装 pi 包 dist（先例：pi-paths-config-dir-contract.test.ts——cwd 上溯找
 * node_modules 实体；runtime 直接依赖 pi 包，vitest 从 packages/runtime 运行时
 * 上溯 1 级命中）。
 */
function locatePiDist(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
    if (existsSync(join(candidate, 'core', 'mcp-servers.js'))) return candidate
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


/** 实装版 validateMcpServerConfig（pi exports 不开放 dist 子路径，file:// 绕行）。 */
const piValidate = PI_DIST
  ? ((await import(pathToFileURL(join(PI_DIST!, 'core', 'mcp-servers.js')).href)) as {
      validateMcpServerConfig: (name: string, raw: unknown) => unknown
    }).validateMcpServerConfig
  : null


let tmpDir: string


let mcpPath: string


/** 每用例独立文件 + 路径重定向（fs-guard 白名单内 mkdtemp）。 */
function useFile(preset?: unknown): void {
  if (preset !== undefined) {
    writeFileSync(mcpPath, `${JSON.stringify(preset, null, 2)}\n`, 'utf-8')
  }
  setMcpStorePathForTest(mcpPath)
}


function expectStoreError(code: string, fn: () => void): McpStoreError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(McpStoreError)
    const err = e as McpStoreError
    expect(err.code).toBe(code)
    return err
  }
  throw new Error(`期望抛出 McpStoreError(${code})，但调用成功`)
}


/** 表单模式 stdio 快捷输入（name 默认 's'，add 直用时省写）。 */
function stdio(command: string, extra: Partial<McpFormFields> = {}, name = 's'): { mode: 'form'; name: string; fields: McpFormFields } {
  return { mode: 'form', name, fields: { transport: 'stdio', command, ...extra } }
}


/** 表单模式 http 快捷输入（name 默认 's'，add 直用时省写）。 */
function http(url: string, extra: Partial<McpFormFields> = {}, name = 's'): { mode: 'form'; name: string; fields: McpFormFields } {
  return { mode: 'form', name, fields: { transport: 'http', url, ...extra } }
}


// ======================================================================
// ← src/infra/pi/__tests__/pi-mcp-servers.test.ts
// ======================================================================

let tmpDir_m2: string


let mcpPath_m2: string


/** fake probeRunner（ok 空结果；按用例覆写）。返回类型保留 vi.fn 推导（断言 .mock 用）。 */
function makeProbeRunner(result: McpProbeResult = { kind: 'ok', exitCode: 0, servers: [], configErrors: [] }) {
  return vi.fn(async (_options: McpProbeOptions): Promise<McpProbeResult> => result)
}


function makeServers(probeResult?: McpProbeResult): { servers: PiMcpServers; runner: ReturnType<typeof makeProbeRunner> } {
  const runner = makeProbeRunner(probeResult)
  return { servers: new PiMcpServers({ probeRunner: runner }), runner }
}


function writeRaw(content: string): void {
  writeFileSync(mcpPath_m2, content, 'utf-8')
}


const STDIO_ENTRY: McpServerEntryValue = { command: 'npx', args: ['-y', 'server-filesystem', '.'] }


// ======================================================================
// ← src/infra/pi/__tests__/pi-maintenance.test.ts
// ======================================================================

/** 建临时数据目录并在测试结束后删除（写删目标限 os.tmpdir()，fs-guard 白名单内）。 */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return dir
}


// ======================================================================
// ← src/infra/pi/__tests__/pi-codemode-settings.test.ts
// ======================================================================

let dir_m2_m2_m2_m2_m2_m2_m2_d1: string


let settingsPath: string


/** ISO 压缩时间戳形态（json-store quarantineCorruptFile 同款：去冒号/点号）。 */
const corruptCopyName = (iso: string): string => `.corrupt-${iso.replace(/[:.]/g, '')}`


/** 摆盘 defaultTools（可带其他字段）并失效缓存。raw === undefined 表示字段不写（缺失）。 */
function seed(defaultTools: unknown, extra: Record<string, unknown> = {}): void {
  const body: Record<string, unknown> = { ...extra }
  if (defaultTools !== undefined) body.defaultTools = defaultTools
  writeFileSync(settingsPath, JSON.stringify(body, null, 2), 'utf-8')
  invalidateSettingsCache()
}


function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
}


// ======================================================================
// ← src/infra/pi/__tests__/pi-retry-settings.test.ts
// ======================================================================

let dir_m2_m2_m2_m2_m2: string


let settingsPath_m2_m2_m2_m2: string


let retrySettings: PiRetrySettings


/**
 * 先摆盘再重定向再构造：RT-3#12 起构造函数不再调用 setSettingsPath（去全局化——
 * 模块级写入目标不被最后构造者决定），测试显式注入 settings 路径（全仓惯例）。
 */
function seedFile(retryValue: unknown, extra: Record<string, unknown> = {}): void {
  writeFileSync(settingsPath_m2_m2_m2_m2, JSON.stringify({ ...extra, retry: retryValue }, null, 2), 'utf-8')
  invalidateSettingsCache()
  retrySettings = new PiRetrySettings()
}


function readRetryFromDisk(): unknown {
  return JSON.parse(readFileSync(settingsPath_m2_m2_m2_m2, 'utf-8'))['retry']
}


const VALID = { enabled: true, maxRetries: 2, baseDelayMs: 3000 }


// ======================================================================
// ← src/infra/pi/__tests__/pi-settings-deglobalize.test.ts
// ======================================================================

let dir_m2_m2_m2_m2_m2_d1: string


let dirA: string


let dirB: string


// ======================================================================
// ← src/infra/pi/__tests__/pi-settings-store-corruption.test.ts
// ======================================================================

let dir_m2_m2: string


let settingsPath_m2_m2_m2_m2_d1: string


/** 目录内 `.corrupt-` 副本清单（隔离退役断言用：损坏读取后必须恒空）。 */
function corruptCopies(): string[] {
  return readdirSync(dir_m2_m2).filter(name => name.includes('.corrupt-'))
}


// ======================================================================
// ← src/infra/pi/__tests__/pi-paths-config-dir-contract.test.ts
// ======================================================================

/**
 * 定位实装 pi 包 dist 目录：从 cwd 逐级上溯找
 * node_modules/@earendil-works/pi-coding-agent/dist/config.js。
 * pnpm workspace 下声明在仓库根 package.json（非 runtime 包依赖，测试不可
 * import——只静态读文件）；vitest 从 packages/runtime 运行时上溯 1 级命中。
 */
function locatePiDist_m2(): string | null {
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


const PI_DIST_m2 = locatePiDist_m2()


const SKIP_REASON_m2 = PI_DIST_m2
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


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


// ======================================================================
// ← src/infra/pi/__tests__/pi-skill-paths-rollback.test.ts
// ======================================================================

let dir_m2_m2_d1: string


let agentDir_m2_m2_d1: string


let readonlyDir: string


// ======================================================================
// ← src/infra/pi/__tests__/pi-protocol-commands.test.ts
// ======================================================================

/** get_commands 响应形态（P5 已核实：extension/prompt/skill 三类条目）。 */
function responseOf(commands: unknown[]): { data: { commands: unknown[] } } {
  return { data: { commands } }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-store-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-provider-store', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-store-'))
  agentDir = realAgentDir()
  mkdirSync(agentDir, { recursive: true })
  // auth.json 经注入的 AuthStorage（路径 = agentDir/auth.json）；models/settings 经 setPath 注入
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  // 清空 auth.json 并注入 resolver（生产组合根 init 装配的等价形态）
  writeAuth({})
  initResolver()
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('findValidDefaultModel catalog 兜底（凭据校验）', () => {
  it('回归：无凭据时返回 null，不选 ambient 的 amazon-bedrock（曾被写进 settings.json 污染）', () => {
    writeModels({})
    writeSettings('amazon-bedrock', 'amazon.nova-2-lite-v1:0')  // 被污染的 default（无凭据）
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
    expect(r.wasFixed).toBe(false)
  })

  it('修复：auth.json 有 api_key 凭据的 catalog provider 被选中（zai-coding-cn）', () => {
    writeModels({ zai: { name: 'zai', apiKey: undefined, models: [] } })
    writeAuth({ 'zai-coding-cn': { type: 'api_key', key: 'k1' } })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('zai-coding-cn')
    expect(r.result!.modelId).toBeTruthy()
    expect(r.wasFixed).toBe(false)  // 兜底不写回 settings.json
  })

  it('修复：models.json 有 apiKey 的 catalog provider 被选中（凭据校验含 models.json apiKey）', () => {
    writeModels({ anthropic: { name: 'Anthropic', apiKey: 'sk-x', models: [] } })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('anthropic')
    expect(r.wasFixed).toBe(false)
  })

  it('修复：无凭据的 catalog provider 全部跳过 → 返回 null（amazon-bedrock 不可选）', () => {
    writeModels({})
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })

  it('既有行为：models.json 有 models 数组的 provider 优先（不触发 catalog 兜底）', () => {
    writeModels({ 'my-router': { name: 'router', apiKey: 'k', models: [{ id: 'm1' }] } })
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'my-router', modelId: 'm1' })
    expect(r.wasFixed).toBe(true)  // 数据修复语义保留
  })

  it('既有行为：settings 显式 default 有效时直接返回（wasFixed=false）', () => {
    writeModels({ openai: { name: 'OpenAI', apiKey: 'k', models: [{ id: 'gpt-4' }] } })
    writeSettings('openai', 'gpt-4')
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'openai', modelId: 'gpt-4' })
    expect(r.wasFixed).toBe(false)
  })

  it('auth.json 损坏 → 不抛错，按无凭据处理（兜底 best-effort）', () => {
    writeModels({})
    writeFileSync(join(agentDir, 'auth.json'), '{ not valid json')
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })
})
// ══ M2c 链 3（D3）：凭据判定经注入 resolver sync 版 + clearProviderApiKey 落盘语义 ══════
describe('M2c 链 3：catalog 凭据判定经注入 resolver（无私有裸读）', () => {
  it('catalog 兜底遍历经 resolver 批量 sync 版判定（单次调用，spy），判定结果决定候选', () => {
    writeModels({})
    const hasProviderCredential = vi.fn(() => true)
    const listCredentialBackedProviderIds = vi.fn(() => new Set(['openai']))
    initProviderCredentialResolver({
      hasProviderCredential,
      listCredentialBackedProviderIds,
      resolveProviderCredential: async () => undefined,
      resolveProviderApiKeyRaw: async () => undefined,
      resolveProviderBaseUrl: () => undefined,
    })

    const r = findValidDefaultModel()

    // 批量形态单次调用（39 个 builtin 候选不做 N 次读盘）
    expect(listCredentialBackedProviderIds).toHaveBeenCalledTimes(1)
    expect(r.result?.provider).toBe('openai')
    // resolver 的批量输出是唯一凭据来源——逐个 hasProviderCredential 不在遍历路径上
    expect(hasProviderCredential).not.toHaveBeenCalled()
  })

  it('同一数据下 resolver 批量结果为空 → 返回 null（凭据判定唯一来源是 resolver，不走内联裸读）', () => {
    writeModels({})
    // auth.json 文件里明明有凭据：若仍存在旧的内联裸读，此用例会选出 provider 而非 null
    writeAuth({ openai: { type: 'api_key', key: 'ko' } })
    initProviderCredentialResolver({
      hasProviderCredential: () => false,
      listCredentialBackedProviderIds: () => new Set<string>(),
      resolveProviderCredential: async () => undefined,
      resolveProviderApiKeyRaw: async () => undefined,
      resolveProviderBaseUrl: () => undefined,
    })

    expect(findValidDefaultModel().result).toBeNull()
  })
})
describe('M2c clearProviderApiKey（I9 清理②）：纯删键 RMW，不写空串', () => {
  const modelsPath = (): string => join(agentDir, 'models.json')

  it('条目含 apiKey → 键被删除（盘上无 apiKey 键、无空串值），其余字段原样', () => {
    writeModels({ p1: { name: 'P1', apiKey: 'sk-live', enabled: true, models: [{ id: 'm1' }] } })

    clearProviderApiKey('p1')

    const raw = JSON.parse(readFileSync(modelsPath(), 'utf-8')) as { providers: Record<string, Record<string, unknown>> }
    expect(raw.providers.p1).not.toHaveProperty('apiKey')
    expect(raw.providers.p1.name).toBe('P1')
    expect(raw.providers.p1.models).toEqual([{ id: 'm1' }])
    const text = readFileSync(modelsPath(), 'utf-8')
    expect(text).not.toContain('"apiKey"')
    // 空串是 pi schema 违规值（拒载整个 models.json）——清除语义绝不落空串
    expect(text).not.toMatch(/:\s*""/)
  })

  it('条目不存在 / 条目无 apiKey 键 → no-op 不写盘（逐字节 + mtime 不变）', () => {
    writeModels({ p1: { name: 'P1', models: [{ id: 'm1' }] } })
    const before = readFileSync(modelsPath(), 'utf-8')
    const mtimeBefore = statSync(modelsPath()).mtimeMs

    clearProviderApiKey('p1')
    clearProviderApiKey('missing-provider')

    expect(readFileSync(modelsPath(), 'utf-8')).toBe(before)
    expect(statSync(modelsPath()).mtimeMs).toBe(mtimeBefore)
  })
})
describe('sanitizeInvalidProviders — D2 空串剥键 + catalog provider 级键处置', () => {
  it('D2①: pi minLength:1 空串全集剥键矩阵（provider 4 字段 + 模型级 name/api/baseUrl + modelOverrides name）', () => {
    writeModels({
      // 非 catalog id（避开 ② 的 provider 级键处置），headers 保证剥完后仍是合法条目
      'my-custom-llm': {
        name: '',
        baseUrl: '   ',
        apiKey: '',
        api: '',
        headers: { 'X-Test': '1' },
        models: [
          { id: 'm1', name: '', api: '  ', baseUrl: '' },
          { id: 'm2', name: 'M2' },
        ],
        modelOverrides: { 'gpt-4': { name: '' } },
      },
    })

    const outcome = sanitizeInvalidProviders()

    expect(outcome.removed).toEqual([])
    expect(outcome.staleGatewayMarkers).toEqual([])
    const cfg = readProvidersFromDisk()['my-custom-llm']
    // provider 级 4 字段（空串 + 纯空白 trim 同视）全部剥除
    for (const key of ['name', 'baseUrl', 'apiKey', 'api']) expect(cfg).not.toHaveProperty(key)
    // 模型级 name/api/baseUrl 剥除；未受影响的模型零改动
    expect(cfg.models).toEqual([{ id: 'm1' }, { id: 'm2', name: 'M2' }])
    // modelOverrides 级 name 剥除（条目本身保留）
    expect(cfg.modelOverrides).toEqual({ 'gpt-4': {} })
    // 盘上无任何空串值（空串键落盘会让 pi 拒载整个 models.json）
    expect(readFileSync(join(agentDir, 'models.json'), 'utf-8')).not.toMatch(/:\s*""/)
  })

  it('D2①: 模型级空串 id → 该模型整条被丢弃（不是只删键）', () => {
    writeModels({
      'my-custom-llm': {
        headers: { 'X-Test': '1' },
        models: [
          { id: 'ok', name: 'OK' },
          { id: '', name: 'Empty', baseUrl: 'https://x.example' },
          { id: '  ', name: 'Blank' },
        ],
      },
    })

    sanitizeInvalidProviders()

    // 空 id 模型无有效标识（id 是 pi 必需字段）——整条丢弃，不留下无 id/空 id 条目
    expect(readProvidersFromDisk()['my-custom-llm'].models).toEqual([{ id: 'ok', name: 'OK' }])
  })

  it('D2①: 非对象模型条目（null/原始值/数组）原样保留，不归本清洗段管（pi schema 层拒绝）；合法模型照常剥键（R3 S-3 补测）', () => {
    writeModels({
      'my-custom-llm': {
        headers: { 'X-Test': '1' },
        models: [null, 'poison-string', 42, [], { id: 'm1', name: '' }],
      },
    })

    const outcome = sanitizeInvalidProviders()

    // 非对象条目 kept.push 原样透传（不删除、不包裹、不剥键），清洗不报错不丢 provider
    expect(outcome.removed).toEqual([])
    const cfg = readProvidersFromDisk()['my-custom-llm']
    expect(cfg.models).toEqual([null, 'poison-string', 42, [], { id: 'm1' }])
  })

  it('D2②: catalog 条目 api 一律剥除，baseUrl 无标记剥除 / 有标记保留（三对照）', () => {
    writeModels({
      // 无标记：provider 级 api + baseUrl 都是冻结 artifact → 全剥
      opencode: { name: 'OpenCode', headers: { A: '1' }, api: 'anthropic-messages', baseUrl: 'https://frozen.example' },
      // 有标记：用户网关 → baseUrl 保留，api 仍一律剥除
      'opencode-go': { name: 'OpenCode Go', headers: { A: '1' }, api: 'openai-completions', baseUrl: 'https://gw.example' },
    })

    const outcome = sanitizeInvalidProviders(markerReader(['opencode-go']))

    expect(outcome.removed).toEqual([])
    expect(outcome.staleGatewayMarkers).toEqual([])
    const providers = readProvidersFromDisk()
    expect(providers.opencode).not.toHaveProperty('api')
    expect(providers.opencode).not.toHaveProperty('baseUrl')
    expect(providers['opencode-go']).not.toHaveProperty('api')
    expect(providers['opencode-go'].baseUrl).toBe('https://gw.example')
  })

  it('D2②: 写读错位（extras 有标记、models.json 无 baseUrl 键）→ 产出待清清单且不在同步清洗段写盘', () => {
    writeModels({ opencode: { name: 'OpenCode', headers: { A: '1' } } })
    const rawBefore = readFileSync(join(agentDir, 'models.json'), 'utf-8')
    const mtimeBefore = statSync(join(agentDir, 'models.json')).mtimeMs

    const outcome = sanitizeInvalidProviders(markerReader(['opencode']))

    // 待清清单产出（清标记的 async 锁内写由调用方编排——不在同步清洗段执行）
    expect(outcome.staleGatewayMarkers).toEqual(['opencode'])
    // 无剥除、无空壳 → 同步清洗段零写盘，条目逐字节原样
    expect(outcome.removed).toEqual([])
    expect(outcome.repaired).toEqual([])
    expect(statSync(join(agentDir, 'models.json')).mtimeMs).toBe(mtimeBefore)
    expect(readFileSync(join(agentDir, 'models.json'), 'utf-8')).toBe(rawBefore)
  })

  it('D2 顺序契约: 剥键（含丢弃空 id 模型）先于既有空壳判定——剥完只剩 name 的 catalog 条目走既有 MF-5 修复分支', () => {
    writeModels({
      // ① 剥掉空串 baseUrl/api 后只剩 name → 既有八字段全缺判定接管
      'opencode-go': { name: 'OpenCode Go', baseUrl: '', api: '' },
      // ① 丢弃唯一（空 id）模型后 models 变空 → 同样落回既有判定；
      // 若顺序相反（先判定后剥键），该条目会以 models:[] 形态留在盘上，得不到修复
      opencode: { models: [{ id: '' }] },
    })

    const outcome = sanitizeInvalidProviders()

    expect(outcome.removed).toEqual([])
    expect(outcome.repaired.sort()).toEqual(['opencode', 'opencode-go'])
    const providers = readProvidersFromDisk()
    // 剥除先于修复：修复产物不含空串键；name 等既有字段保留；models 从快照合并
    expect(providers['opencode-go'].name).toBe('OpenCode Go')
    expect(providers['opencode-go']).not.toHaveProperty('baseUrl')
    expect(providers['opencode-go']).not.toHaveProperty('api')
    expect((providers['opencode-go'].models as unknown[]).length).toBeGreaterThan(0)
    expect((providers.opencode.models as unknown[]).length).toBeGreaterThan(0)
    // 幂等：第二次调用无剥除/修复（已是合法条目）
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    expect(second.repaired).toEqual([])
  })

  it('D2: 合法条目零触碰（干净文件跑清洗后盘上内容逐字节不变）', () => {
    writeModels({
      opencode: { name: 'OpenCode', baseUrl: 'https://gw.example', headers: { A: '1' } },
      'my-custom-llm': { name: 'Custom', apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
    })
    const rawBefore = readFileSync(join(agentDir, 'models.json'), 'utf-8')

    const outcome = sanitizeInvalidProviders(markerReader(['opencode']))

    expect(outcome.staleGatewayMarkers).toEqual([])
    expect(outcome.removed).toEqual([])
    expect(outcome.repaired).toEqual([])
    expect(readFileSync(join(agentDir, 'models.json'), 'utf-8')).toBe(rawBefore)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-provider-store-finddefault', () => {
beforeEach(() => {
  dir_m2_m2_m2_m2_m2_m2_m2 = mkdtempSync(join(tmpdir(), 'provider-store-finddefault-'))
  agentDir_m2_m2 = realAgentDir_m2()
  mkdirSync(agentDir_m2_m2, { recursive: true })
  // auth.json 经注入的 AuthStorage（路径 = agentDir_m2_m2/auth.json）；models/settings 经 setPath 注入
  process.env.TAIJI_AGENT_DATA_DIR = dir_m2_m2_m2_m2_m2_m2_m2
  setModelsPath(join(agentDir_m2_m2, 'models.json'))
  setSettingsPath(join(agentDir_m2_m2, 'settings.json'))
  invalidateSettingsCache()
  writeAuth_m2({})
  // 生产组合根 init 装配的等价形态：装配完成先于任何 findValidDefaultModel 调用
  initResolver_m2()
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir_m2_m2_m2_m2_m2_m2_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('TC6: findValidDefaultModel catalog 兜底过滤 enabledModels（ES3）', () => {
  it('被禁用的 catalog provider 不作 default——选有凭据且启用的', () => {
    // models.json 无可用 provider → 触发 catalog 兜底
    writeModels_m2({})
    // 只有 anthropic 启用（openai 被禁用）
    writeSettings_m2({ enabledModels: ['anthropic/*'] })
    // auth.json 两者都有凭据
    writeAuth_m2({
      openai: { type: 'api_key', key: 'ko' },
      anthropic: { type: 'api_key', key: 'ka' },
    })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('anthropic')
    // wasFixed=false：兜底是临时展示，不写回 settings.json（不污染用户配置）
    expect(r.wasFixed).toBe(false)
  })

  it('有凭据的 provider 全被禁用时 → 返回 null（不选被禁用的）', () => {
    writeModels_m2({})
    // 只有 anthropic 启用
    writeSettings_m2({ enabledModels: ['anthropic/*'] })
    // 但 auth.json 只有 openai 凭据（被禁用）→ 无可用
    writeAuth_m2({ openai: { type: 'api_key', key: 'ko' } })
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })

  it('对照：enabledModels 空 → 有凭据的 catalog provider 可作 default（过滤不影响）', () => {
    writeModels_m2({})
    // 空 = 全启用（pi 白名单语义，DM3）
    writeSettings_m2({ enabledModels: [] })
    writeAuth_m2({ openai: { type: 'api_key', key: 'ko' } })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('openai')
  })

  it('对照：enabledModels 未设置（undefined）→ 全启用，有凭据即可作 default', () => {
    writeModels_m2({})
    // 不写 enabledModels（settings.json 无此字段 → readSettings().enabledModels ?? []）
    writeSettings_m2({})
    writeAuth_m2({ openai: { type: 'api_key', key: 'ko' } })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('openai')
  })

  it('model 级 pattern（<id>/<model>）视为该 provider 已启用', () => {
    writeModels_m2({})
    // model 级 pattern：openai/gpt-4 → openai 启用
    writeSettings_m2({ enabledModels: ['openai/gpt-4', 'anthropic/*'] })
    writeAuth_m2({
      openai: { type: 'api_key', key: 'ko' },
      anthropic: { type: 'api_key', key: 'ka' },
    })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    // anthropic 字母序在 openai 前，且两者都启用（openai 经 model 级 pattern 启用）
    expect(['anthropic', 'openai']).toContain(r.result!.provider)
  })

  it('回归：无凭据时返回 null，不选 ambient 的 amazon-bedrock（沿用既有保护）', () => {
    writeModels_m2({})
    writeSettings_m2({ enabledModels: [] })
    writeAuth_m2({})
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })
})
describe('A8: findValidDefaultModel 主路径 enabledModels 过滤', () => {
  // 主路径：defaultProvider+defaultModel 在 models.json 有效时直接返回。A8 加 enabledModels 检查——
  // 被禁用的 default 不走主路径，fall through 到 fallback（pickFirstModelProvider 同样过滤 enabled）。
  it('default provider 被 enabledModels 禁用 → 主路径跳过，fallback 重选到启用的 provider', () => {
    writeModels_m2({
      'custom-a': { models: [{ id: 'm-a' }] },
      'custom-b': { models: [{ id: 'm-b' }] },
    })
    // default 指向 custom-a，但白名单只启用 custom-b
    writeSettings_m2({ defaultProvider: 'custom-a', defaultModel: 'm-a', enabledModels: ['custom-b/*'] })
    writeAuth_m2({})
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('custom-b')
    expect(r.result!.modelId).toBe('m-b')
    // fallback 重选 → wasFixed=true（getDefaultModel 会写回 settings.json）
    expect(r.wasFixed).toBe(true)
  })

  it('对照：default provider 启用 → 主路径直接返回（wasFixed=false，不写回）', () => {
    writeModels_m2({
      'custom-a': { models: [{ id: 'm-a' }] },
    })
    // enabledModels 空 = 全启用
    writeSettings_m2({ defaultProvider: 'custom-a', defaultModel: 'm-a', enabledModels: [] })
    writeAuth_m2({})
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'custom-a', modelId: 'm-a' })
    expect(r.wasFixed).toBe(false)
  })

  it('主路径 model 重选不受 A8 检查影响：default 启用但 defaultModel 无效 → 仍走 provider 内重选', () => {
    writeModels_m2({
      'custom-a': { models: [{ id: 'm-a' }, { id: 'm-a2' }] },
    })
    // defaultModel='gone' 不在 provider models → 主路径内重选 models[0]
    writeSettings_m2({ defaultProvider: 'custom-a', defaultModel: 'gone', enabledModels: [] })
    writeAuth_m2({})
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'custom-a', modelId: 'm-a' })
    expect(r.wasFixed).toBe(true)
  })

  it('default 被禁用 + models.json 无其他启用 provider → fallback 返回 undefined，走 catalog 兜底', () => {
    // 仅 custom-a（被禁用），无其他启用 provider → pickFirstModelProvider 返回 undefined
    writeModels_m2({
      'custom-a': { models: [{ id: 'm-a' }] },
    })
    writeSettings_m2({ defaultProvider: 'custom-a', defaultModel: 'm-a', enabledModels: ['custom-x/*'] })
    // auth.json 无凭据 → catalog 兜底也找不到 → null
    writeAuth_m2({})
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })
})
// ══════════════════════════════════════════════════════════════════
// A6（S3，scoped-model design D3 修复）：findValidDefaultModel 对 auth.json-only
// catalog provider（OAuth 形态常态：models.json 无条目、auth.json 有凭据）。
// D3 修复前主路径查 models.json 失败即 fallback 重选/写回，污染用户配置。
// ══════════════════════════════════════════════════════════════════
describe('A6: findValidDefaultModel 对 auth.json-only catalog provider（D3 修复）', () => {
  // builtin 模型集从 generated JSON 动态取（不 hardcode 具体 model id，随 catalog 演进稳定）
  const zaiModels = (builtinData.providers ?? []).find(p => p.id === 'zai-coding-cn')?.models ?? []
  const firstZaiModelId = zaiModels[0]?.id as string

  it('A6 default 指向 auth.json-only catalog provider 且 defaultModel ∈ builtin 集 → 直接返回不 fallback，wasFixed=false', () => {
    // models.json 放无关 custom provider 作 fallback 诱饵：D3 生效时不应被选中
    writeModels_m2({ 'custom-x': { models: [{ id: 'm-x' }] } })
    writeSettings_m2({ defaultProvider: 'zai-coding-cn', defaultModel: firstZaiModelId, enabledModels: [] })
    writeAuth_m2({ 'zai-coding-cn': { type: 'api_key', key: 'kz' } })

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: 'zai-coding-cn', modelId: firstZaiModelId })
    expect(r.wasFixed).toBe(false)
  })

  it('D5 态 3 演进：defaultModel 不在快照集且 overlay 从未见过 → pass-through 不改写（原「重选 builtin 第一个」被 D5 取代）', () => {
    writeModels_m2({ 'custom-x': { models: [{ id: 'm-x' }] } })
    writeSettings_m2({ defaultProvider: 'zai-coding-cn', defaultModel: 'nonexistent-model', enabledModels: [] })
    writeAuth_m2({ 'zai-coding-cn': { type: 'api_key', key: 'kz' } })
    // 未写任何 overlay 文件 → zai-coding-cn 处于 never-seen 态。D5 裁定：pass-through
    // 不判定有效性、不 auto-fix（垃圾模型名直传 pi 报错，优于静默改写用户配置）。
    // 旧行为（wasFixed:true 重选 builtin 第一个）正是设计文档「失败模式 A」同族：静默改写。

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: 'zai-coding-cn', modelId: 'nonexistent-model' })
    expect(r.wasFixed).toBe(false)
  })

  it('A6 对照：无凭据时 D3 不生效 → fallback 到 models.json 其他 provider', () => {
    writeModels_m2({ 'custom-x': { models: [{ id: 'm-x' }] } })
    writeSettings_m2({ defaultProvider: 'zai-coding-cn', defaultModel: firstZaiModelId, enabledModels: [] })
    // auth.json 无 zai 凭据：D3 的 hasCredential 不满足 → 走 fallback 重选
    writeAuth_m2({})

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: 'custom-x', modelId: 'm-x' })
    expect(r.wasFixed).toBe(true)
  })
})
// ══════════════════════════════════════════════════════════════════
// M2c（D3 链 3 接线 / 检查点 5）：模块级 init 注入 + 装配序契约。
// 「装配完成先于任何 findValidDefaultModel 调用」在组合根由 index.ts 的调用位置保证；
// 本组用例锁定两侧行为契约：未注入 = 安全降级（视为无凭据，不抛错），注入后同一数据生效。
// ══════════════════════════════════════════════════════════════════
describe('M2c 装配序：init 注入先于 findValidDefaultModel 的行为差异', () => {
  const zaiModels = (builtinData.providers ?? []).find(p => p.id === 'zai-coding-cn')?.models ?? []
  const firstZaiModelId = zaiModels[0]?.id as string

  it('未注入（init 前）：凭据不可见 → catalog 兜底返回 null，不抛错（安全降级的差异侧）', () => {
    // 模拟「装配未完成就调用」：清空注入，auth.json 中明明有凭据也不参与判定
    initProviderCredentialResolver(undefined)
    writeModels_m2({})
    writeSettings_m2({ enabledModels: [] })
    writeAuth_m2({ openai: { type: 'api_key', key: 'ko' } })

    let r: ReturnType<typeof findValidDefaultModel> | undefined
    expect(() => { r = findValidDefaultModel() }).not.toThrow()
    expect(r!.result).toBeNull()
  })

  it('RT-3#5：未注入首次打一行 warn（带 context）且一次性——返回语义不变，重复调用不刷屏', () => {
    initProviderCredentialResolver(undefined)
    writeModels_m2({})
    writeSettings_m2({ enabledModels: [] })
    writeAuth_m2({})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      // 第一次调用：catalog 兜底路径触发 warn（pickCredentialBackedCatalogProvider context）
      findValidDefaultModel()
      const firstWarns = warnSpy.mock.calls.filter(c => String(c[0]).includes('credential resolver not injected'))
      expect(firstWarns).toHaveLength(1)
      expect(String(firstWarns[0]![0])).toContain('context: pickCredentialBackedCatalogProvider')

      // 第二次调用：计数去重，不再重复 warn
      findValidDefaultModel()
      expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('credential resolver not injected'))).toHaveLength(1)

      // (re)注入后重置：再清空可再报（装配序回归场景可观测）
      initResolver_m2()
      initProviderCredentialResolver(undefined)
      findValidDefaultModel()
      expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('credential resolver not injected'))).toHaveLength(2)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('对照（注入后）：同一份数据可选出 catalog provider——差异即装配序契约的语义后果', () => {
    writeModels_m2({})
    writeSettings_m2({ enabledModels: [] })
    writeAuth_m2({ openai: { type: 'api_key', key: 'ko' } })
    initResolver_m2()

    const r = findValidDefaultModel()

    expect(r.result?.provider).toBe('openai')
  })

  it('副路径（auth.json-only catalog provider）经 resolver.hasProviderCredential 判定（spy 命中）', () => {
    writeModels_m2({ 'custom-x': { models: [{ id: 'm-x' }] } })
    writeSettings_m2({ defaultProvider: 'zai-coding-cn', defaultModel: firstZaiModelId, enabledModels: [] })
    writeAuth_m2({})
    const hasProviderCredential = vi.fn((id: string) => id === 'zai-coding-cn')
    initProviderCredentialResolver({
      hasProviderCredential,
      listCredentialBackedProviderIds: () => new Set<string>(),
      resolveProviderCredential: async () => undefined,
      resolveProviderApiKeyRaw: async () => undefined,
      resolveProviderBaseUrl: () => undefined,
    })

    const r = findValidDefaultModel()

    expect(hasProviderCredential).toHaveBeenCalledWith('zai-coding-cn')
    expect(r.result).toEqual({ provider: 'zai-coding-cn', modelId: firstZaiModelId })
    expect(r.wasFixed).toBe(false)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-mcp-store', () => {
if (!PI_DIST) {
  console.warn(`[pi-mcp-store] pi 等价性断言 skip：${SKIP_REASON}`)
}
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pi-mcp-store-'))
  mcpPath = join(tmpDir, 'mcp.json')
})
afterEach(() => {
  setMcpStorePathForTest(null)
  rmSync(mcpPath, { force: true })
})
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
// ─────────────────────────────────────────────────────────────────────────────
// 不变量 1：名称字符集与全局唯一
// ─────────────────────────────────────────────────────────────────────────────

describe('不变量 1 · 名称字符集（复刻 pi SERVER_NAME）', () => {
  it.each([
    ['a', true],
    ['Z', true],
    ['0', true],
    ['_', true],
    ['-', true],
    ['A-z_9-0', true],
    ['my server', false], // 空格
    ['服务器', false], // 非 ASCII
    ['a.b', false], // 点
    ['a/b', false], // 斜杠（路径注入点）
    ['a:b', false], // 冒号
    ['', false], // 空串
  ])('名称 %j 合法性 = %j', (name, valid) => {
    useFile()
    const run = () => addMcpServer({ mode: 'form', name, fields: { transport: 'stdio', command: 'x' } })
    if (valid) {
      expect(() => run()).not.toThrow()
    } else {
      const err = expectStoreError('name_invalid', run)
      expect(err.message).toContain('字母、数字、下划线、连字符')
    }
  })

  it('save 校验与读侧标注对同一字符集（读侧返回错误摘要不抛错）', () => {
    expect(validateMcpEntryForRead('my server', { command: 'x' })).toContain('非法字符')
    expect(validateMcpEntryForRead('ok-name', { command: 'x' })).toBeNull()
    expect(() => validateMcpEntryForSave('my server', { command: 'x' })).toThrow(McpStoreError)
  })
})
describe('不变量 1 · 全局唯一（重名拦截，D4 不替换）', () => {
  it('添加精确同名拦截，文案指引「编辑该条目」', () => {
    useFile({ mcpServers: { existing: { command: 'x' } } })
    const err = expectStoreError('name_conflict', () =>
      addMcpServer({ mode: 'form', name: 'existing', fields: { transport: 'stdio', command: 'y' } }),
    )
    expect(err.message).toContain('已存在同名服务器')
    expect(err.message).toContain('请编辑该条目')
    // 不替换：原条目原样
    const snap = readMcpServers()
    expect(snap.servers).toHaveLength(1)
    expect(snap.servers[0]).toMatchObject({ name: 'existing', config: { command: 'x' }, error: null })
  })

  it('添加归并同名（-/_ 不同）拦截（命名空间冲突）', () => {
    useFile({ mcpServers: { 'a-b': { command: 'x' } } })
    const err = expectStoreError('namespace_conflict', () =>
      addMcpServer({ mode: 'form', name: 'a_b', fields: { transport: 'stdio', command: 'y' } }),
    )
    expect(err.message).toContain('a-b')
    // 反向同样拦截
    rmSync(mcpPath, { force: true })
    useFile({ mcpServers: { a_b: { command: 'x' } } })
    expectStoreError('namespace_conflict', () =>
      addMcpServer({ mode: 'form', name: 'a-b', fields: { transport: 'stdio', command: 'y' } }),
    )
  })

  it('归并对既有条目无碰撞时不误拦（外部已存在的 a-b / a_b 冲突不阻塞无关新增）', () => {
    useFile({ mcpServers: { 'a-b': { command: 'x' }, a_b: { command: 'y' } } })
    expect(() => addMcpServer({ mode: 'form', name: 'other', fields: { transport: 'stdio', command: 'z' } })).not.toThrow()
  })
})
describe('-/_ 归并同名（mcpServerNamespace 复刻）', () => {
  it('复刻 pi mcpNamespace：连字符替换为下划线', () => {
    expect(mcpServerNamespace('a-b')).toBe('mcp__a_b')
    expect(mcpServerNamespace('a_b')).toBe('mcp__a_b')
    expect(mcpServerNamespace('a')).toBe('mcp__a')
  })

  it('读侧标注：归并同名先入者胜，后入者标注冲突（对齐 pi loadMcpConfig clash 检测）', () => {
    useFile({ mcpServers: { 'a-b': { command: 'x1' }, a_b: { command: 'x2' } } })
    const snap = readMcpServers()
    expect(snap.servers[0]).toMatchObject({ name: 'a-b', error: null, config: { command: 'x1' } })
    expect(snap.servers[1]!.name).toBe('a_b')
    expect(snap.servers[1]!.error).toContain('a-b')
    // 后入者条目照原样保留（不丢、不修复）
    expect(snap.servers[1]!.config).toEqual({ command: 'x2' })

    // 键序反转：先入者变为 a_b
    rmSync(mcpPath, { force: true })
    useFile({ mcpServers: { a_b: { command: 'x2' }, 'a-b': { command: 'x1' } } })
    const snap2 = readMcpServers()
    expect(snap2.servers[0]).toMatchObject({ name: 'a_b', error: null })
    expect(snap2.servers[1]!.error).toContain('a_b')
  })

  it('读侧归并检测只对三不变量通过的条目（对齐 pi：校验失败条目不参与 clash）', () => {
    // "bad name" 名称非法，不进比对集——后续 b 合法条目不应被它影响
    useFile({ mcpServers: { 'bad name': { command: 'x' }, b: { command: 'y' } } })
    const snap = readMcpServers()
    expect(snap.servers[0]!.error).toContain('非法字符')
    expect(snap.servers[1]).toMatchObject({ name: 'b', error: null })
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// 不变量 2：command / url 至少其一 + 互斥收紧
// ─────────────────────────────────────────────────────────────────────────────

describe('不变量 2 · 传输字段存在性（缺两者拦截）', () => {
  it.each([
    ['form stdio 缺 command', () => {
      useFile()
      addMcpServer({ mode: 'form', name: 's', fields: { transport: 'stdio' } })
    }],
    ['form http 缺 url', () => {
      useFile()
      addMcpServer({ mode: 'form', name: 's', fields: { transport: 'http' } })
    }],
    ['code 空对象', () => {
      useFile()
      addMcpServer({ mode: 'code', parsed: { s: {} } })
    }],
    ['update 后产物缺传输（清空必填 = 拦截，不是删条目）', () => {
      useFile({ mcpServers: { s: { command: 'x' } } })
      updateMcpServer('s', { mode: 'form', fields: { transport: 'stdio' } })
    }],
  ])('%s → transport_missing', (_label: string, run: () => void) => {
    const err = expectStoreError('transport_missing', run)
    expect(err.message).toContain('command')
    expect(err.message).toContain('url')
  })

  it('command 非 string 视同缺失（对齐 pi needs either 分支条件）', () => {
    useFile()
    expectStoreError('transport_missing', () => addMcpServer({ mode: 'code', parsed: { s: { command: 123 } } }))
  })
})
describe('command+url 互斥拦截（D4 taiji 有意收紧；pi 实装 url 优先静默忽略）', () => {
  it('save 档：混填拦截', () => {
    const err = expectStoreError('transport_conflict', () =>
      validateMcpEntryForSave('s', { command: 'x', url: 'https://y' }),
    )
    expect(err.message).toContain('不能同时填写')
  })

  it('读侧档：混填不标注（pi 静默按 http 处理，误标会引导误删合法条目）', () => {
    expect(validateMcpEntryForRead('s', { command: 'x', url: 'https://y' })).toBeNull()
  })

  it('端到端：form 编辑混填既有条目 → 键级清理后产物单类型、保存成功', () => {
    useFile({ mcpServers: { s: { command: 'x', url: 'https://y' } } })
    expect(() => updateMcpServer('s', http('https://z'))).not.toThrow()
    const snap = readMcpServers()
    expect(snap.servers[0]!.config).toEqual({ url: 'https://z' })
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// 不变量 3：文件整体 JSON 合法 + 坏条目不阻塞（S6 fail-fast 契约）
// ─────────────────────────────────────────────────────────────────────────────

describe('不变量 3 · 文件损坏 fail-fast（S6）', () => {
  it('JSON 语法错误：读侧 corrupted + 损坏提示；三个写操作全部拒入且不落盘', () => {
    writeFileSync(mcpPath, '{ not valid json', 'utf-8')
    setMcpStorePathForTest(mcpPath)
    const snap = readMcpServers()
    expect(snap.corrupted).toBe(true)
    expect(snap.corruptedReason).toContain('JSON 语法错误')
    expect(snap.servers).toEqual([])

    expectStoreError('store_corrupted', () => addMcpServer(stdio('x')))
    expectStoreError('store_corrupted', () => updateMcpServer('a', stdio('x')))
    expectStoreError('store_corrupted', () => removeMcpServer('a'))
    // 拒入不改文件（不覆盖外部手编内容）
    expect(readFileSync(mcpPath, 'utf-8')).toBe('{ not valid json')
  })

  it('mcpServers 非对象按损坏处理；mcpServers 缺失按空清单', () => {
    useFile({ mcpServers: [] })
    expect(readMcpServers().corrupted).toBe(true)

    rmSync(mcpPath, { force: true })
    useFile({ otherKey: 1 })
    const snap = readMcpServers()
    expect(snap.corrupted).toBe(false)
    expect(snap.servers).toEqual([])
  })

  it('顶层非对象按损坏处理', () => {
    writeFileSync(mcpPath, '[1,2]', 'utf-8')
    setMcpStorePathForTest(mcpPath)
    expect(readMcpServers().corrupted).toBe(true)
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// 既有坏条目保留与合并（D4：文件中已存在非法条目照原样保留，不阻塞保存）
// ─────────────────────────────────────────────────────────────────────────────

describe('既有坏条目保留与合并', () => {
  it('坏条目读侧标注 + 原样保留；保存其他条目后坏条目仍在（不清理不修复）', () => {
    useFile({
      mcpServers: {
        good: { command: 'g' },
        'bad name': { command: 'x' }, // 名称非法
        noop: {}, // 缺传输
        scalar: 'oops', // 非对象
      },
    })
    const snap = readMcpServers()
    expect(snap.corrupted).toBe(false)
    const byName = Object.fromEntries(snap.servers.map((s) => [s.name, s]))
    expect(byName['good']).toMatchObject({ error: null })
    expect(byName['bad name']!.error).toContain('非法字符')
    expect(byName['bad name']!.config).toEqual({ command: 'x' })
    expect(byName['noop']!.error).toContain('缺少传输参数')
    expect(byName['scalar']!.error).toContain('必须是对象')
    expect(byName['scalar']!.config).toBe('oops')

    // 保存：坏条目不阻塞，且保存后原样保留
    expect(() => addMcpServer({ mode: 'form', name: 'newer', fields: { transport: 'stdio', command: 'n' } })).not.toThrow()
    const after = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(after.mcpServers['bad name']).toEqual({ command: 'x' })
    expect(after.mcpServers['noop']).toEqual({})
    expect(after.mcpServers['scalar']).toBe('oops')
    expect(after.mcpServers['newer']).toEqual({ command: 'n' })
  })

  it('record 形坏条目（缺传输但有外键）经表单编辑补全后外键保留（合并底生效）', () => {
    useFile({ mcpServers: { broken: { timeout: 5 } } })
    expect(() => updateMcpServer('broken', stdio('fixed', { description: 'repaired' }))).not.toThrow()
    const snap = readMcpServers()
    expect(snap.servers[0]!.config).toEqual({ timeout: 5, command: 'fixed', description: 'repaired' })
  })

  it('非 record 坏条目经表单编辑 = 以空为底重建（修复坏条目的正当通道）', () => {
    useFile({ mcpServers: { weird: 'oops' } })
    expect(() => updateMcpServer('weird', stdio('fixed'))).not.toThrow()
    const snap = readMcpServers()
    expect(snap.servers[0]!.config).toEqual({ command: 'fixed' })
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// RMW 合并不丢外部条目（D2：锁内重读磁盘最新内容再合并写入）
// ─────────────────────────────────────────────────────────────────────────────

describe('RMW 合并不丢外部条目', () => {
  it('外部手编追加的条目在 taiji 后续保存后仍在', () => {
    useFile({ mcpServers: { mine: { command: 'm' } } })
    // 外部写方不认锁：直接改文件（模拟终端 pi mcp add / 手编）
    const external = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    external.mcpServers['external-cli'] = { url: 'https://ext.example/mcp' }
    writeFileSync(mcpPath, `${JSON.stringify(external, null, 2)}\n`, 'utf-8')

    // taiji 保存（锁内重读 → 合并 → 写）
    expect(() => addMcpServer({ mode: 'form', name: 'added-later', fields: { transport: 'stdio', command: 'a' } })).not.toThrow()

    const after = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(Object.keys(after.mcpServers).sort()).toEqual(['added-later', 'external-cli', 'mine'])
  })

  it('合并底 = 锁内最新读：外部刚加的外键在 taiji 表单保存后保留（窗口收窄语义）', () => {
    useFile({ mcpServers: { s: { command: 'x' } } })
    // 外部给该条目追加 oauth（taiji 启动后的快照里没有）
    const external = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    external.mcpServers.s.oauth = { clientId: 'later-added' }
    writeFileSync(mcpPath, `${JSON.stringify(external, null, 2)}\n`, 'utf-8')

    updateMcpServer('s', { mode: 'form', fields: { transport: 'stdio', command: 'x', description: 'd' } })
    const snap = readMcpServers()
    expect(snap.servers[0]!.config).toEqual({ command: 'x', description: 'd', oauth: { clientId: 'later-added' } })
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// 顶层键保留与缩进保持（D4：对齐 pi editMcpServers「Other content is kept」）
// ─────────────────────────────────────────────────────────────────────────────

describe('写回保留文件结构', () => {
  it('mcpServers 之外顶层键在 add/update/remove 后原样保留', () => {
    useFile({
      mcpServers: { s: { command: 'x' } },
      autoEnableCodemode: false,
      customTopKey: { keep: [1, 2] },
    })
    updateMcpServer('s', stdio('y'))
    addMcpServer({ mode: 'form', name: 't', fields: { transport: 'stdio', command: 't' } })
    removeMcpServer('t')
    const after = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(after.autoEnableCodemode).toBe(false)
    expect(after.customTopKey).toEqual({ keep: [1, 2] })
    expect(after.mcpServers).toEqual({ s: { command: 'y' } })
  })

  it('缩进保持（对齐 pi：rewritten with its indentation）', () => {
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { s: { command: 'x' } } }, null, 4) + '\n', 'utf-8')
    setMcpStorePathForTest(mcpPath)
    updateMcpServer('s', stdio('y'))
    const raw = readFileSync(mcpPath, 'utf-8')
    expect(raw).toContain('    "mcpServers"')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('文件不存在：读 = 空清单；add 创建文件', () => {
    useFile()
    const snap = readMcpServers()
    expect(snap).toMatchObject({ corrupted: false, corruptedReason: null, servers: [] })
    expect(snap.filePath).toBe(mcpPath)

    addMcpServer({ mode: 'form', name: 'first', fields: { transport: 'stdio', command: 'x' } })
    const created = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(created.mcpServers).toEqual({ first: { command: 'x' } })
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// type 三值闭集与形态一致性（D4 例外条款；表单产物无 type → 空转）
// ─────────────────────────────────────────────────────────────────────────────

describe('type 校验（D4 例外条款）', () => {
  it('"sse" 显式拒绝并指引改用 streamable HTTP 地址', () => {
    const err = expectStoreError('type_sse', () => validateMcpEntryForSave('s', { type: 'sse', url: 'https://x' }))
    expect(err.message).toContain('SSE')
    expect(err.message).toContain('url')
  })

  it.each(['websocket', 'SSE', 'stdio2', 42, null])('未知 type 值 %j 报错（闭集 = stdio/http/streamable-http）', (type) => {
    expectStoreError('type_unknown', () => validateMcpEntryForSave('s', { type, url: 'https://x' }))
  })

  it('streamable-http 旧称放行（其他客户端迁移片段可遇，不得误拦）', () => {
    expect(() => validateMcpEntryForSave('s', { type: 'streamable-http', url: 'https://x' })).not.toThrow()
    expect(() => validateMcpEntryForSave('s', { type: 'http', url: 'https://x' })).not.toThrow()
    expect(() => validateMcpEntryForSave('s', { type: 'stdio', command: 'x' })).not.toThrow()
  })

  it.each([
    ['type stdio + url', { type: 'stdio', url: 'https://x' }],
    ['type http + command', { type: 'http', command: 'x' }],
    ['type streamable-http + command', { type: 'streamable-http', command: 'x' }],
  ])('形态不符拦截：%s（pi 加载期整条拒载且文案与病因错位，保存当场拦）', (_label: string, config: unknown) => {
    expectStoreError('type_transport_mismatch', () => validateMcpEntryForSave('s', config))
  })

  it('表单路径产物无 type 键，type 校验空转（D4 管线顺序）', () => {
    useFile({ mcpServers: { s: { type: 'http', url: 'https://old' } } })
    // 携带显式 type 的既有条目经表单切换为 stdio：剥离先于校验，不因中间态误拦
    expect(() => updateMcpServer('s', stdio('npx'))).not.toThrow()
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// §4 补充断言 ①-⑤（设计文档验收条款，逐条落测）
// ─────────────────────────────────────────────────────────────────────────────

describe('§4 断言① · type 剥离 + 切换键级清理 + 产物可被 pi 校验接受', () => {
  it('携带 type:"http" 的条目经表单切换为 stdio 后保存：产物无 type、url/headers 已删、pi 校验通过', () => {
    useFile({
      mcpServers: {
        s: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer t' }, timeout: 30 },
      },
    })
    updateMcpServer('s', stdio('npx', { args: ['-y', 'pkg'] }))

    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect('type' in produced).toBe(false)
    expect('url' in produced).toBe(false)
    expect('headers' in produced).toBe(false)
    expect(produced).toEqual({ timeout: 30, command: 'npx', args: ['-y', 'pkg'] })

    // 条目可被 pi 校验接受（实装版直接断言，锁 taiji 复刻与 pi 实装不漂移；包不可达时跳过）
    if (piValidate) expect(piValidate('s', produced)).toEqual(produced)
  })

  it('反向切换（stdio 既有条目切 http）：command/args/env/cwd 已删', () => {
    useFile({ mcpServers: { s: { command: 'x', args: ['a'], env: { K: 'v' }, cwd: '/w' } } })
    updateMcpServer('s', http('https://y', { headers: { 'X-A': 'b' } }))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced).toEqual({ url: 'https://y', headers: { 'X-A': 'b' } })
  })
})
describe('§4 断言② · 代码模式添加 streamable-http 旧称条目成功', () => {
  it('包装形态粘贴 type:"streamable-http" + url → 保存成功且原样落盘', () => {
    useFile()
    addMcpServer({ mode: 'code', parsed: { legacy: { type: 'streamable-http', url: 'https://old-name.example/mcp' } } })
    const snap = readMcpServers()
    expect(snap.servers[0]).toMatchObject({
      name: 'legacy',
      error: null,
      config: { type: 'streamable-http', url: 'https://old-name.example/mcp' },
    })
  })
})
describe('§4 断言③ · 编辑流代码模式改名拦截', () => {
  it('包装键名与被编辑条目名不一致 → 拦截，文案含「改名 = 删除后重建」指引', () => {
    useFile({ mcpServers: { original: { command: 'x' } } })
    const err = expectStoreError('rename_not_allowed', () =>
      updateMcpServer('original', { mode: 'code', parsed: { renamed: { command: 'y' } } }),
    )
    expect(err.message).toContain('original')
    expect(err.message).toContain('删除后重建')
    // 未落盘
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers).toEqual({ original: { command: 'x' } })
  })

  it('包装键名与被编辑条目名一致 → 按包装形态取内层值', () => {
    useFile({ mcpServers: { s: { command: 'old' } } })
    updateMcpServer('s', { mode: 'code', parsed: { s: { command: 'new' } } })
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s).toEqual({ command: 'new' })
  })

  it('裸条目值对象形态（编辑流）→ 整体作为条目值（外键随 textarea 内容替换，无静默丢失通道）', () => {
    useFile({ mcpServers: { s: { command: 'x', timeout: 5 } } })
    updateMcpServer('s', { mode: 'code', parsed: { command: 'y', timeout: 99 } })
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s).toEqual({ command: 'y', timeout: 99 })
  })
})
describe('§4 断言④ · 表单清空可选字段 = 删键（封死浅合并）', () => {
  it('既有带 args/env/cwd/description 的条目，表单只填 command 保存 → 产物不含这些键', () => {
    useFile({ mcpServers: { s: { command: 'x', args: ['a'], env: { K: 'v' }, cwd: '/w', description: 'd' } } })
    updateMcpServer('s', stdio('y'))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced).toEqual({ command: 'y' })
  })

  it('清空 description / env 空对象 / args 空数组同理删键', () => {
    useFile({ mcpServers: { s: { command: 'x', description: 'old', env: { K: 'v' } } } })
    updateMcpServer('s', stdio('y', { description: '  ', args: [], env: {} }))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect('description' in produced).toBe(false)
    expect('env' in produced).toBe(false)
    expect('args' in produced).toBe(false)
  })
})
describe('§4 断言⑤ · 添加流代码模式裸形态拦截', () => {
  it('裸条目值对象（无包装键名）→ 拦截，文案含包装形态指引', () => {
    useFile()
    const err = expectStoreError('code_entry_form_invalid', () =>
      addMcpServer({ mode: 'code', parsed: { command: 'x', args: ['a'] } }),
    )
    expect(err.message).toContain('包装形态')
    // 不落盘
    expect(readMcpServers().servers).toEqual([])
  })

  it('多键包装 → 单条目形态拦截', () => {
    useFile()
    const err = expectStoreError('code_single_entry', () =>
      addMcpServer({ mode: 'code', parsed: { a: { command: 'x' }, b: { command: 'y' } } }),
    )
    expect(err.message).toContain('一个服务器')
  })

  it('包装形态（添加流）名称自动取键名', () => {
    useFile()
    addMcpServer({ mode: 'code', parsed: { wrapped: { command: 'x' } } })
    expect(readMcpServers().servers[0]).toMatchObject({ name: 'wrapped', error: null })
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// 启停专用操作（§3.1「写入 enabled 字段」最小语义：仅翻转 enabled 键）
// ─────────────────────────────────────────────────────────────────────────────

describe('setMcpServerEnabled · 启停专用操作（仅翻转 enabled 键，其余键不触）', () => {
  it('禁用：enabled:false 落键，其余键（含表单外键）原样保留', () => {
    useFile({
      mcpServers: {
        s: { command: 'npx', args: ['-y', 'pkg'], timeout: 30, oauth: { clientId: 'c1' }, description: 'd' },
      },
    })
    setMcpServerEnabled('s', false)
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced).toEqual({
      command: 'npx', args: ['-y', 'pkg'], timeout: 30, oauth: { clientId: 'c1' }, description: 'd', enabled: false,
    })
  })

  it('启用：enabled 键删除（缺省启用，对齐 pi 写路径语义）', () => {
    useFile({ mcpServers: { s: { command: 'npx', enabled: false, description: 'd' } } })
    setMcpServerEnabled('s', true)
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced).toEqual({ command: 'npx', description: 'd' })
    expect(produced.enabled).toBeUndefined()
  })

  it('吃进锁内最新磁盘内容：外部并发改动（新字段/新条目）不被清单旧派生视图覆盖（D2）', () => {
    useFile({ mcpServers: { s: { command: 'npx' }, other: { url: 'https://x' } } })
    // 模拟清单打开后外部手编改动
    writeFileSync(
      mcpPath,
      `${JSON.stringify({ mcpServers: { s: { command: 'node', description: 'external' }, other: { url: 'https://x' }, fresh: { command: 'new' } } }, null, 2)}\n`,
      'utf-8',
    )
    setMcpServerEnabled('s', false)
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers
    expect(produced.s).toEqual({ command: 'node', description: 'external', enabled: false })
    expect(produced.other).toEqual({ url: 'https://x' })
    expect(produced.fresh).toEqual({ command: 'new' })
  })

  it('混填条目启停不被规范化改写（command/url 原样保留，D4 互斥只拦写路径新产物）', () => {
    useFile({ mcpServers: { mixed: { command: 'npx', url: 'https://example.com' } } })
    setMcpServerEnabled('mixed', false)
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.mixed)
      .toEqual({ command: 'npx', url: 'https://example.com', enabled: false })
  })

  it('条目不存在 → not_found；坏条目（非对象）→ entry_not_object', () => {
    useFile({ mcpServers: { s: { command: 'npx' }, weird: 'just a string' } })
    expectStoreError('not_found', () => setMcpServerEnabled('ghost', false))
    expectStoreError('entry_not_object', () => setMcpServerEnabled('weird', false))
    // 拒绝后文件原样
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s).toEqual({ command: 'npx' })
  })

  it('损坏拒入：损坏期间启停被拒且文件原样（S6，与全部写操作同口径）', () => {
    useFile()
    writeFileSync(mcpPath, '{ broken', 'utf-8')
    expectStoreError('store_corrupted', () => setMcpServerEnabled('s', false))
    expect(readFileSync(mcpPath, 'utf-8')).toBe('{ broken')
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// 编辑写回契约 · 表单外键原样保留（D7 禁按表单字段集全量替换）
// ─────────────────────────────────────────────────────────────────────────────

describe('表单外键原样保留（D7 核心承诺）', () => {
  it('携带 oauth/timeout/toolExposure/auth 的条目经表单编辑描述与 URL 后全部保留', () => {
    useFile({
      mcpServers: {
        s: {
          url: 'https://old',
          oauth: { clientId: 'cid', callbackPort: 8899 },
          timeout: 30,
          toolExposure: { secret_tool: 'hidden' },
          auth: { provider: 'zai' },
        },
      },
    })
    updateMcpServer('s', http('https://new', { description: 'edited' }))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced.oauth).toEqual({ clientId: 'cid', callbackPort: 8899 })
    expect(produced.timeout).toBe(30)
    expect(produced.toolExposure).toEqual({ secret_tool: 'hidden' })
    expect(produced.auth).toEqual({ provider: 'zai' })
    expect(produced.url).toBe('https://new')
    expect(produced.description).toBe('edited')
  })

  it('type 是外键原样保留的唯一例外：表单模式保存一律剥离（无论是否切换过传输类型）', () => {
    useFile({ mcpServers: { s: { type: 'http', url: 'https://x', timeout: 9 } } })
    // 未切换传输类型（仍 http），仅改描述——type 同样剥离
    updateMcpServer('s', http('https://x', { description: 'same-transport-edit' }))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect('type' in produced).toBe(false)
    expect(produced.timeout).toBe(9)
  })

  it('exposure = codemode 缺省化（对齐 pi 写路径语义）；其他档位落键；enabled 仅 false 落键', () => {
    useFile({ mcpServers: { s: { command: 'x', exposure: 'direct', enabled: false } } })
    updateMcpServer('s', stdio('y', { exposure: 'codemode', enabled: true }))
    let produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect('exposure' in produced).toBe(false)
    expect('enabled' in produced).toBe(false)

    updateMcpServer('s', stdio('y', { exposure: 'direct', enabled: false }))
    produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced.exposure).toBe('direct')
    expect(produced.enabled).toBe(false)
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// remove / not_found / pi 实装等价性
// ─────────────────────────────────────────────────────────────────────────────

describe('removeMcpServer', () => {
  it('删除存在的条目：true + 条目消失 + 顶层键保留', () => {
    useFile({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } }, autoEnableCodemode: true })
    expect(removeMcpServer('a')).toBe(true)
    const after = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(after.mcpServers).toEqual({ b: { command: 'y' } })
    expect(after.autoEnableCodemode).toBe(true)
  })

  it('删除不存在的条目：false（幂等意图，对齐 pi removeMcpServerConfig 返回语义）', () => {
    useFile({ mcpServers: { a: { command: 'x' } } })
    expect(removeMcpServer('nope')).toBe(false)
  })
})
describe('updateMcpServer / addMcpServer 边界', () => {
  it('update 不存在的条目 → not_found', () => {
    useFile()
    const err = expectStoreError('not_found', () => updateMcpServer('ghost', stdio('x')))
    expect(err.message).toContain('不存在')
  })

  it('add code 模式顶层非对象（数组/标量）→ 形态拦截', () => {
    useFile()
    expectStoreError('code_entry_form_invalid', () => addMcpServer({ mode: 'code', parsed: [1, 2] }))
    expectStoreError('code_entry_form_invalid', () => addMcpServer({ mode: 'code', parsed: 'oops' }))
  })
})
describe.skipIf(!piValidate)(
  `pi 实装等价性（产物喂实装 validateMcpServerConfig${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('表单产物（stdio/http）与代码模式合法粘贴均被 pi 校验器接受', () => {
      useFile()
      addMcpServer({ mode: 'form', name: 'f_stdio', fields: { transport: 'stdio', command: 'npx', args: ['-y', 'p'] } })
      addMcpServer({ mode: 'form', name: 'f_http', fields: { transport: 'http', url: 'https://x/mcp' } })
      addMcpServer({ mode: 'code', parsed: { c_code: { type: 'streamable-http', url: 'https://y' } } })

      const servers = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers
      for (const [name, config] of Object.entries(servers)) {
        const validated = piValidate!(name, config)
        expect(typeof validated).not.toBe('string')
        expect(validated).toEqual(config)
      }
    })

    it('taiji 拦截形态与 pi 实装报错对齐（混填 pi 放行 url 分支、type 错配 pi 报 needs either）', () => {
      // pi 对混填放行（taiji 有意收紧的实装证据）
      expect(piValidate!('s', { command: 'x', url: 'https://y' })).toEqual({ command: 'x', url: 'https://y' })
      // pi 对 type 错配的报错文案与病因错位（D4 例外条款实证）
      expect(piValidate!('s', { type: 'http', command: 'x' })).toBe(
        'server "s" needs either "command" (stdio) or "url" (streamable HTTP)',
      )
    })

    it('§4 断言①产物（type 剥离后）被 pi 校验器接受（无 type 条目按传输字段归类）', () => {
      expect(piValidate!('s', { command: 'npx', args: ['-y', 'pkg'], timeout: 30 })).toEqual({
        command: 'npx',
        args: ['-y', 'pkg'],
        timeout: 30,
      })
    })
  },
)
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-mcp-servers', () => {
beforeEach(() => {
  tmpDir_m2 = mkdtempSync(join(tmpdir(), 'pi-mcp-servers-'))
  mcpPath_m2 = join(tmpDir_m2, 'mcp.json')
  mkdirSync(tmpDir_m2, { recursive: true })
  setMcpStorePathForTest(mcpPath_m2)
})
afterEach(() => {
  setMcpStorePathForTest(null)
  rmSync(tmpDir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('PiMcpServers.list（读派生视图）', () => {
  it('文件不存在 = 空清单 + corruption null（与「文件存在但无条目」同形态，§3.1）', () => {
    const { servers, runner } = makeServers()
    expect(servers.list()).toEqual({ servers: [], corruption: null, agentDir: getPiAgentDir() })
  })

  it('正常条目派生视图：name + value 原样 + 无 configError；filePath 来自 activePath', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY } }))
    const { servers, runner } = makeServers()
    const result = servers.list()
    expect(result.corruption).toBeNull()
    expect(result.servers).toEqual([{ name: 'fs', value: STDIO_ENTRY }])
  })

  it('文件损坏 = servers 空 + corruption 有值（S6 读侧错误态，filePath = 修复入口）', () => {
    writeRaw('{ broken json')
    const { servers, runner } = makeServers()
    const result = servers.list()
    expect(result.servers).toEqual([])
    expect(result.corruption?.filePath).toBe(mcpPath_m2)
    expect(result.corruption?.corruptCopyPath).toBeNull()
  })

  it('坏条目照原样映射 + configError 标注（D4 不阻塞其余条目管理，D8③）', () => {
    writeRaw(JSON.stringify({ mcpServers: { ok: STDIO_ENTRY, bad: { description: 'no transport' } } }))
    const { servers, runner } = makeServers()
    const result = servers.list()
    expect(result.servers).toHaveLength(2)
    const bad = result.servers.find((s) => s.name === 'bad')
    expect(bad?.value).toEqual({ description: 'no transport' })
    expect(bad?.configError).toContain('bad')
    const ok = result.servers.find((s) => s.name === 'ok')
    expect(ok?.configError).toBeUndefined()
  })

  it('非对象坏条目映射为空对象 + configError 标注（协议对象类型边界，值以标注承载）', () => {
    writeRaw(JSON.stringify({ mcpServers: { weird: 'just a string' } }))
    const { servers, runner } = makeServers()
    const result = servers.list()
    expect(result.servers[0]).toMatchObject({ name: 'weird', value: {}, configError: expect.any(String) })
  })
})
describe('PiMcpServers.add（ADR-0065 verbatim 原样写入）', () => {
  it('正常：原样落盘 + reply entry = 写后落盘终态（回读）', () => {
    const { servers, runner } = makeServers()
    const result = servers.add('fs', STDIO_ENTRY)
    expect(result).toEqual({ ok: true, entry: { name: 'fs', value: STDIO_ENTRY } })
    const onDisk = JSON.parse(readFileSync(mcpPath_m2, 'utf-8'))
    expect(onDisk.mcpServers.fs).toEqual(STDIO_ENTRY)
  })

  it('显式 type:"streamable-http" + url 原样落盘（§4 断言②：旧称闭集内不误拦）', () => {
    const { servers, runner } = makeServers()
    const entry: McpServerEntryValue = { url: 'https://example.com/mcp', type: 'streamable-http' }
    const result = servers.add('legacy', entry)
    expect(result.ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(mcpPath_m2, 'utf-8'))
    expect(onDisk.mcpServers.legacy).toEqual(entry)
  })

  it('重名拦截：ok:false 信封报「已存在同名服务器，请编辑该条目」（不采用替换语义，D4）', () => {
    const { servers, runner } = makeServers()
    expect(servers.add('fs', STDIO_ENTRY).ok).toBe(true)
    const result = servers.add('fs', { command: 'other' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('已存在同名服务器')
    expect(result.corruption).toBeUndefined()
  })

  it('归并同名拦截（-/_ 视为同名，不变量 1 归并条款）', () => {
    const { servers, runner } = makeServers()
    expect(servers.add('a-b', STDIO_ENTRY).ok).toBe(true)
    const result = servers.add('a_b', { command: 'other' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('a-b')
  })

  it('名称非法拦截信封（name_invalid，D4 三不变量）', () => {
    const { servers, runner } = makeServers()
    const result = servers.add('my server', STDIO_ENTRY)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('非法字符')
  })

  it('command+url 混填拦截信封（transport_conflict——taiji 有意收紧，D4；code 原样路径校验生效）', () => {
    const { servers, runner } = makeServers()
    const result = servers.add('mixed', { command: 'npx', url: 'https://example.com' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('不能同时填写')
  })

  it('损坏拒入信封：ok:false + corruption 携带（S6 fail-fast，不覆盖外部手编内容）', () => {
    writeRaw('{ broken')
    const { servers, runner } = makeServers()
    const result = servers.add('fs', STDIO_ENTRY)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption?.filePath).toBe(mcpPath_m2)
    expect(result.error).toContain('请先修复文件')
    // 拒入后文件原样（外部手编内容未被覆盖）
    expect(readFileSync(mcpPath_m2, 'utf-8')).toBe('{ broken')
  })
})
describe('PiMcpServers.update（外键判别分叉两语义，ADR-0065 transformable）', () => {
  it('无外键 entry = form 合并语义：底外键原样保留 + 清空删键（D7 编辑写回契约）', () => {
    writeRaw(JSON.stringify({
      mcpServers: { fs: { ...STDIO_ENTRY, timeout: 30, oauth: { clientId: 'c1' }, description: 'old' } },
    }))
    const { servers, runner } = makeServers()
    // 表单产物：只改 description + command；timeout/oauth 是外键必须保留；args 清空 = 删键
    const result = servers.update('fs', { command: 'node', description: 'new' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ command: 'node', timeout: 30, oauth: { clientId: 'c1' }, description: 'new' })
  })

  it('无外键 entry = form 合并语义：type 键无条件剥离（D7，stale type 坏形态封死）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: { url: 'https://example.com', type: 'http', timeout: 5 } } }))
    const { servers, runner } = makeServers()
    // 表单模式切换传输类型：url 侧字段清空 → stdio 侧 command 回填；type 剥离；timeout 外键保留
    const result = servers.update('fs', { command: 'npx' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ command: 'npx', timeout: 5 })
    expect(result.entry.value.type).toBeUndefined()
  })

  it('含外键 entry = code 整体替换语义：外键以 entry 为准（含外键派生视图回写/代码模式）', () => {
    writeRaw(JSON.stringify({
      mcpServers: { fs: { ...STDIO_ENTRY, timeout: 30, oauth: { clientId: 'old' } } },
    }))
    const { servers, runner } = makeServers()
    // 代码模式产物：entry 整体作为条目值（底 oauth 不保留——textarea 所见即落盘）
    const result = servers.update('fs', { command: 'node', timeout: 60 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ command: 'node', timeout: 60 })
  })

  it('code 路径 verbatim：enabled 键随 entry 整体落盘（代码模式可见可改，非启停通道）', () => {
    writeRaw(JSON.stringify({
      mcpServers: { fs: { url: 'https://example.com', type: 'http', timeout: 5 } },
    }))
    const { servers, runner } = makeServers()
    const result = servers.update('fs', { url: 'https://example.com', type: 'http', timeout: 5, enabled: false })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ url: 'https://example.com', type: 'http', timeout: 5, enabled: false })
  })

  it('条目不存在 = ok:false 信封（修复动作指向清单刷新）', () => {
    const { servers, runner } = makeServers()
    const result = servers.update('ghost', { command: 'npx' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('不存在')
  })

  it('form 语义校验失败信封：清空传输字段 → transport_missing（D4 三不变量，不落盘）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY } }))
    const { servers, runner } = makeServers()
    const result = servers.update('fs', { description: 'no transport fields' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('缺少传输参数')
    // 校验不过不落盘（fail-fast）
    expect(JSON.parse(readFileSync(mcpPath_m2, 'utf-8')).mcpServers.fs).toEqual(STDIO_ENTRY)
  })
})
describe('PiMcpServers.setEnabled（启停专用操作，§3.1「写入 enabled 字段」最小语义）', () => {
  it('禁用：仅翻转 enabled 键（enabled:false 落键），其余键不触——外部并发形态保持', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: { ...STDIO_ENTRY, description: 'kept' } } }))
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('fs', false)
    expect(result).toEqual({ ok: true, entry: { name: 'fs', value: { ...STDIO_ENTRY, description: 'kept', enabled: false } } })
    expect(JSON.parse(readFileSync(mcpPath_m2, 'utf-8')).mcpServers.fs).toEqual({
      ...STDIO_ENTRY, description: 'kept', enabled: false,
    })
  })

  it('启用：enabled 键删除（缺省启用，对齐 pi 写路径语义）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: { ...STDIO_ENTRY, enabled: false } } }))
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('fs', true)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value.enabled).toBeUndefined()
    expect(JSON.parse(readFileSync(mcpPath_m2, 'utf-8')).mcpServers.fs).toEqual(STDIO_ENTRY)
  })

  it('带外键条目：外键原样保留（以锁内最新读为底，非清单旧派生视图）', () => {
    writeRaw(JSON.stringify({
      mcpServers: { fs: { url: 'https://example.com', type: 'http', timeout: 5, oauth: { clientId: 'c1' } } },
    }))
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('fs', false)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({
      url: 'https://example.com', type: 'http', timeout: 5, oauth: { clientId: 'c1' }, enabled: false,
    })
  })

  it('混填条目启停不被规范化改写（command/url 原样保留——互斥收紧只拦写路径新产物，D4）', () => {
    writeRaw(JSON.stringify({ mcpServers: { mixed: { command: 'npx', url: 'https://example.com' } } }))
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('mixed', false)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ command: 'npx', url: 'https://example.com', enabled: false })
  })

  it('启停吃进锁内最新磁盘内容：清单打开后外部新增字段不被覆盖（D2 并发契约）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY } }))
    const { servers, runner } = makeServers()
    // 模拟「清单打开后外部（终端/手编）改动」：直接改文件
    writeRaw(JSON.stringify({ mcpServers: { fs: { ...STDIO_ENTRY, description: 'external edit' } } }))
    const result = servers.setEnabled('fs', false)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ ...STDIO_ENTRY, description: 'external edit', enabled: false })
  })

  it('条目不存在 = ok:false 信封（修复动作指向清单刷新）', () => {
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('ghost', false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('不存在')
  })

  it('损坏拒入信封：不触发写路径（S6，外部手编内容不被触碰）', () => {
    writeRaw('{ broken')
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('fs', false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption?.filePath).toBe(mcpPath_m2)
    expect(readFileSync(mcpPath_m2, 'utf-8')).toBe('{ broken')
  })
})
describe('PiMcpServers.remove（删除前值回显）', () => {
  it('正常：entry = 被删条目删除前落盘值（port 契约回显）+ 文件已删该键', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY, keep: { command: 'x' } } }))
    const { servers, runner } = makeServers()
    const result = servers.remove('fs')
    expect(result).toEqual({ ok: true, entry: { name: 'fs', value: STDIO_ENTRY } })
    const onDisk = JSON.parse(readFileSync(mcpPath_m2, 'utf-8'))
    expect(onDisk.mcpServers.fs).toBeUndefined()
    expect(onDisk.mcpServers.keep).toEqual({ command: 'x' })
  })

  it('条目不存在 = ok:false 信封（不抛错，幂等意图由信封表达）', () => {
    const { servers, runner } = makeServers()
    const result = servers.remove('ghost')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('不存在')
  })

  it('损坏拒入信封：不触发删除（S6，外部手编内容不被触碰）', () => {
    writeRaw('{ broken')
    const { servers, runner } = makeServers()
    const result = servers.remove('fs')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption?.filePath).toBe(mcpPath_m2)
    expect(readFileSync(mcpPath_m2, 'utf-8')).toBe('{ broken')
  })
})
describe('PiMcpServers.test（D3 异步任务形态 + 墙钟公式）', () => {
  it('句柄立即返回（testId 形状）+ probeRunner 同步段被触发', async () => {
    const { servers, runner } = makeServers()
    const handle = servers.test('fs')
    expect(handle.testId).toMatch(/^mcp-test-\d+$/)
    expect(runner).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(runner.mock.results[0]?.value).resolves.toBeTruthy(), { interval: 1 })
  })

  it('无显式 timeout = 默认墙钟下限 150 秒（D3 量级依据）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY } }))
    const { servers, runner } = makeServers()
    servers.test('fs')
    expect(runner.mock.calls[0]?.[0]?.timeoutMs).toBe(DEFAULT_PROBE_TIMEOUT_MS)
  })

  it('最大显式 timeout 放大墙钟：2 × timeout + 30 秒余量（D3 公式）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY, slow: { command: 'x', timeout: 120 } } }))
    const { servers, runner } = makeServers()
    servers.test('fs')
    expect(runner.mock.calls[0]?.[0]?.timeoutMs).toBe(120 * 2 * 1000 + 30_000)
  })

  it('timeout 坏值（负数/非数字）不参与放大（pi 加载期是值域权威）', () => {
    writeRaw(JSON.stringify({ mcpServers: { a: { command: 'x', timeout: -5 }, b: { command: 'y', timeout: 'fast' } } }))
    const { servers, runner } = makeServers()
    servers.test('a')
    expect(runner.mock.calls[0]?.[0]?.timeoutMs).toBe(DEFAULT_PROBE_TIMEOUT_MS)
  })
})
describe('PiMcpServers.testCancel（D3「取消」按钮——等价于超时到点杀进程的主动形态）', () => {
  /**
   * fake runner 复刻真 runMcpProbe 的登记缝时序：同步段调用 options.onStarted 登记
   * 取消函数，登记后 probe 挂起（Promise 不 resolve），取消函数被调时以 cancelled 终态收敛。
   */
  function makeHangingRunner() {
    let resolveProbe: ((r: McpProbeResult) => void) | null = null
    const runner = vi.fn((options: McpProbeOptions): Promise<McpProbeResult> => new Promise((resolve) => {
      resolveProbe = resolve
      options.onStarted?.(() => {
        resolveProbe?.({ kind: 'cancelled' })
        return true
      })
    }))
    return { runner }
  }

  it('取消生效：testCancel 返回 true，probe 以 cancelled 终态收敛且不回填徽标', async () => {
    const events: unknown[] = []
    const { runner } = makeHangingRunner()
    const servers = new PiMcpServers({ probeRunner: runner, onTestResult: (e) => events.push(e) })
    const handle = servers.test('fs')
    expect(servers.testCancel(handle.testId)).toBe(true)
    await vi.waitFor(() => expect(runner.mock.results[0]?.value).resolves.toEqual({ kind: 'cancelled' }), { interval: 1 })
    // 收敛后微任务排空仍无徽标回填（cancelled 不广播——renderer 已在取消分支恢复原徽标）
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toHaveLength(0)
    // 句柄清退：重复取消返回 false
    expect(servers.testCancel(handle.testId)).toBe(false)
  })

  it('任务自然收敛后取消晚到：testCancel 返回 false，结果徽标照常回填', async () => {
    const events: unknown[] = []
    const runner = makeProbeRunner({ kind: 'ok', exitCode: 0, servers: [], configErrors: [] })
    const servers = new PiMcpServers({ probeRunner: runner, onTestResult: (e) => events.push(e) })
    const handle = servers.test('fs')
    await vi.waitFor(() => expect(runner.mock.results[0]?.value).resolves.toBeTruthy(), { interval: 1 })
    expect(servers.testCancel(handle.testId)).toBe(false)
    expect(events).toHaveLength(1)
  })

  it('testId 不存在：返回 false（fake runner 未触发 onStarted 的存量装配形态同样安全）', () => {
    const { servers } = makeServers()
    expect(servers.testCancel('mcp-test-999')).toBe(false)
  })
})
describe('PiMcpServers.onTestResult（probe 终态回填回调，u5b 打回接线）', () => {
  /** 构造带回调的实例（probeRunner fake 固定返回传入结果）。 */
  function makeServersWithCallback(probeResult: McpProbeResult) {
    const events: unknown[] = []
    const runner = makeProbeRunner(probeResult)
    const servers = new PiMcpServers({ probeRunner: runner, onTestResult: (e) => events.push(e) })
    return { servers, events }
  }

  it('probe ok + 条目 connected → 回调携带 D8① probe 徽标（state/toolCount/testedAt）', async () => {
    const { servers, events } = makeServersWithCallback({
      kind: 'ok',
      exitCode: 0,
      configErrors: [],
      servers: [
        { name: 'fs', scope: 'user', exposure: 'direct', transport: 'npx', status: { kind: 'connected', toolsCount: 3, toolNames: ['a', 'b', 'c'] } },
      ],
    })
    const handle = servers.test('fs')
    await vi.waitFor(() => expect(events).toHaveLength(1), { interval: 1 })
    expect(events[0]).toMatchObject({
      name: 'fs',
      testId: handle.testId,
      badge: { source: 'probe', state: 'connected', toolCount: 3 },
    })
    expect((events[0] as { badge: { testedAt: number } }).badge.testedAt).toBeGreaterThan(0)
  })

  it('probe ok + 条目 failed → 徽标携带 pi 原始 state 与 errorDetail 全文（D8① 失败详情）', async () => {
    const { servers, events } = makeServersWithCallback({
      kind: 'ok',
      exitCode: 1,
      configErrors: [],
      servers: [
        { name: 'broken', scope: 'user', exposure: 'codemode', transport: 'x', status: { kind: 'failed', state: 'failed', errorDetail: 'spawn /nonexistent ENOENT' } },
      ],
    })
    servers.test('broken')
    await vi.waitFor(() => expect(events).toHaveLength(1), { interval: 1 })
    expect(events[0]).toMatchObject({
      name: 'broken',
      badge: { source: 'probe', state: 'failed', errorDetail: 'spawn /nonexistent ENOENT' },
    })
  })

  it('触发条目不在结果内（外部删除窗口）→ 其余条目照常逐条回填 + 触发行补 ui-local timeout（D3 本次无结果语义）', async () => {
    const { servers, events } = makeServersWithCallback({
      kind: 'ok',
      exitCode: 0,
      configErrors: [],
      servers: [
        { name: 'other', scope: 'user', exposure: 'codemode', transport: 'x', status: { kind: 'connected', toolsCount: 1, toolNames: ['t'] } },
      ],
    })
    servers.test('gone')
    await vi.waitFor(() => expect(events).toHaveLength(2), { interval: 1 })
    expect(events[0]).toMatchObject({ name: 'other', badge: { source: 'probe', state: 'connected', toolCount: 1 } })
    expect(events[1]).toMatchObject({ name: 'gone', badge: { source: 'ui-local', state: 'timeout' } })
  })

  it('probe ok 全清单回填（§3.1）：全部条目各发一帧（同一 testId），无须逐行触发', async () => {
    const { servers, events } = makeServersWithCallback({
      kind: 'ok',
      exitCode: 1,
      configErrors: [],
      servers: [
        { name: 'fs', scope: 'user', exposure: 'codemode', transport: 'npx', status: { kind: 'connected', toolsCount: 3, toolNames: ['a', 'b', 'c'] } },
        { name: 'broken', scope: 'user', exposure: 'codemode', transport: 'x', status: { kind: 'failed', state: 'failed', errorDetail: 'spawn ENOENT' } },
      ],
    })
    const handle = servers.test('fs')
    await vi.waitFor(() => expect(events).toHaveLength(2), { interval: 1 })
    for (const event of events) {
      expect(event).toMatchObject({ testId: handle.testId })
    }
    expect(events[0]).toMatchObject({ name: 'fs', badge: { source: 'probe', state: 'connected', toolCount: 3 } })
    expect(events[1]).toMatchObject({ name: 'broken', badge: { source: 'probe', state: 'failed', errorDetail: 'spawn ENOENT' } })
  })

  it('probe 整体超时 → ui-local timeout 徽标（D3 整体无本次结果）', async () => {
    const { servers, events } = makeServersWithCallback({ kind: 'timeout', timeoutMs: 150_000 })
    servers.test('fs')
    await vi.waitFor(() => expect(events).toHaveLength(1), { interval: 1 })
    expect(events[0]).toMatchObject({ badge: { source: 'ui-local', state: 'timeout' } })
  })

  it('probe spawn-failed → failed 徽标携带降级原因全文', async () => {
    const { servers, events } = makeServersWithCallback({ kind: 'spawn-failed', message: 'pi 可执行文件定位失败' })
    servers.test('fs')
    await vi.waitFor(() => expect(events).toHaveLength(1), { interval: 1 })
    expect(events[0]).toMatchObject({
      badge: { source: 'probe', state: 'failed', errorDetail: 'pi 可执行文件定位失败' },
    })
  })

  it('未注入回调（存量测试装配）→ 不炸、行为退回仅日志留痕', async () => {
    const { servers } = makeServers({ kind: 'ok', exitCode: 0, configErrors: [], servers: [] })
    expect(() => servers.test('fs')).not.toThrow()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-maintenance', () => {
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
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-codemode-settings', () => {
beforeEach(() => {
  dir_m2_m2_m2_m2_m2_m2_m2_d1 = mkdtempSync(join(tmpdir(), 'pi-codemode-settings-'))
  settingsPath = join(dir_m2_m2_m2_m2_m2_m2_m2_d1, 'settings.json')
  setSettingsPath(settingsPath)
})
afterEach(() => {
  vi.restoreAllMocks()
  invalidateSettingsCache()
  rmSync(dir_m2_m2_m2_m2_m2_m2_m2_d1, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
// ── 1. 激活集解析（目标 1：复刻 pi 实装语义，前提 12）────────────────────────

describe('resolveDefaultToolSet · pi 1.0.0 实装语义表（探针结论固化）', () => {
  it.each([
    // [label, raw, 期望激活集]
    ['字段缺失（undefined）→ 空集（pi 回落默认集，对 codemode 判定等价）', undefined, []],
    ['null → 空激活集（pi getDefaultTools 非数组分支）', null, []],
    ['非数组字符串 → 空激活集', 'bad', []],
    ['非数组数字 → 空激活集', 42, []],
    ['非数组对象 → 空激活集', {}, []],
    ['["+"] 追加 → 默认集 + codemode', ['+codemode'], ['read', 'bash', 'edit', 'write', 'codemode']],
    ['["codemode"] 纯名 → 整体替换默认集', ['codemode'], ['codemode']],
    ['[] 空数组 → 空激活集（禁用全部默认工具）', [], []],
    ['["-codemode"] → 默认集（移除 no-op，不含 codemode）', ['-codemode'], ['read', 'bash', 'edit', 'write']],
    ['["-read","+codemode"] → 顺序应用', ['-read', '+codemode'], ['bash', 'edit', 'write', 'codemode']],
    ['["+codemode","-codemode"] → 后条目赢（不含）', ['+codemode', '-codemode'], ['read', 'bash', 'edit', 'write']],
    ['["-codemode","+codemode"] → 后条目赢（含）', ['-codemode', '+codemode'], ['read', 'bash', 'edit', 'write', 'codemode']],
    ['["codemode","read"] 混合纯名 → 整体替换为纯名集合', ['codemode', 'read'], ['codemode', 'read']],
    ['["codemode", 42] 坏值混入 → 非字符串被剥除后解析（探针：filter 在解析前）', ['codemode', 42], ['codemode']],
    ['[42, "+codemode"] 坏值混入 → 剥除后按 modifier 解析', [42, '+codemode'], ['read', 'bash', 'edit', 'write', 'codemode']],
    // ── 混合坏值矩阵（逐元素探针定案 2026-10-03，pi 1.0.0 实装 SettingsManager.getDefaultTools
    //    公共入口实测；mergeDefaultTools 合并层坏值行为见模块头/PS-70——taiji 单文件读写不复刻该层）──
    ['["read","bash",123,null,"edit",{},["nested"]] 纯名+坏值 → 剥除后整体替换默认集（write 随之丢失）', ['read', 'bash', 123, null, 'edit', {}, ['nested']], ['read', 'bash', 'edit']],
    ['["+codemode",123,"-read"] modifier+坏值 → 剥除后默认集起步、顺序应用不受坏值打断', ['+codemode', 123, '-read'], ['bash', 'edit', 'write', 'codemode']],
    ['[123,null,{},["nested"]] 全坏数组 → 空激活集', [123, null, {}, ['nested']], []],
    ['[0,false,"bash"] falsy 非字符串同样剥除（typeof 判定，与真值无关）', [0, false, 'bash'], ['bash']],
    ['["-"] 空 name modifier → no-op', ['+', '-'], ['read', 'bash', 'edit', 'write']],
    ['["+CODEMODE"] 大小写敏感（工具名精确匹配）', ['+CODEMODE'], ['read', 'bash', 'edit', 'write', 'CODEMODE']],
  ] as const)('%s', (_label, raw, expected) => {
    expect(resolveDefaultToolSet(raw)).toEqual(expected)
  })

  it('pi DEFAULT_TOOL_NAMES 同构常量（默认集漂移即测试红）', () => {
    expect([...PI_DEFAULT_TOOL_NAMES]).toEqual(['read', 'bash', 'edit', 'write'])
  })
})
describe('isCodemodeActive · 读侧显示判定', () => {
  it.each([
    ['["+codemode"] → 开', ['+codemode'], true],
    ['["codemode"] 纯名形态 → 开', ['codemode'], true],
    ['["-codemode"] → 关', ['-codemode'], false],
    ['字段缺失 → 关', undefined, false],
    ['[] → 关', [], false],
    ['非数组坏值 → 关（D2 读侧）', 'bad', false],
    ['null → 关', null, false],
    ['["+codemode", 42] 坏值混入 → 开（filter 后仍含）', ['+codemode', 42], true],
  ] as const)('%s', (_label, raw, expected) => {
    expect(isCodemodeActive(raw)).toBe(expected)
  })
})
// ── 2. 启动迁移（目标 2：幂等默认写入，D2 存在性判定）────────────────────────

describe('ensureCodemodeDefaultEntry · 字段存在性判定 + 幂等', () => {
  it.each([
    ['字段缺失 → 写 ["+codemode"]（S1 首次启动）', undefined, ['+codemode']],
    ['null = 未配置 → 写 ["+codemode"]（D2：undefined/null 同归未配置）', null, ['+codemode']],
  ] as const)('%s', (_label, seedValue, expected) => {
    seed(seedValue)
    ensureCodemodeDefaultEntry()
    expect(onDisk().defaultTools).toEqual(expected)
  })

  it.each([
    ['空数组 = 已配置 → 不碰（尊重）', []],
    ['["+codemode"] 已是默认 → 幂等不动', ['+codemode']],
    ['["-codemode"] 关闭态 → 不碰（关闭跨重启持久，S4 反向验证）', ['-codemode']],
    ['["codemode"] 危险纯名 → 不碰（不代偿，S6）', ['codemode']],
    ['坏值（字符串）→ 不碰（D2：字段存在即尊重）', 'bad'],
    ['坏值数组（含非字符串元素）→ 不碰', ['codemode', 42]],
    ['用户混合条目 → 不碰', ['-read', '+codemode']],
  ] as const)('%s', (_label, seedValue) => {
    seed(seedValue)
    ensureCodemodeDefaultEntry()
    expect(onDisk().defaultTools).toEqual(seedValue)
  })

  it('重复调用幂等（写后文件字节稳定）', () => {
    seed(undefined)
    ensureCodemodeDefaultEntry()
    const after1 = readFileSync(settingsPath, 'utf-8')
    ensureCodemodeDefaultEntry()
    expect(readFileSync(settingsPath, 'utf-8')).toBe(after1)
  })

  it('只动 tools 域：用户其他字段逐字节保留（字段域 merge）', () => {
    seed(undefined, { defaultModel: 'keep-me', packages: ['p1'], somePiField: { nested: true } })
    ensureCodemodeDefaultEntry()
    const disk = onDisk()
    expect(disk.defaultTools).toEqual(['+codemode'])
    expect(disk.defaultModel).toBe('keep-me')
    expect(disk.packages).toEqual(['p1'])
    expect(disk.somePiField).toEqual({ nested: true })
  })

  it('文件不存在（全新安装态）→ 建文件写 ["+codemode"]', () => {
    expect(existsSync(settingsPath)).toBe(false)
    ensureCodemodeDefaultEntry()
    expect(onDisk().defaultTools).toEqual(['+codemode'])
  })
})
// ── 2b. tool_search 启动迁移（tool-declaration-slimming D4：幂等追加，负条目视为已含）──

describe('ensureToolSearchDefaultEntry · D4 幂等追加（追加不覆盖 / 负条目不追加 / 已含不重复）', () => {
  it.each([
    // 追加分支：不含任何 tool_search 条目 → 追加，已有内容零覆盖
    ['字段缺失 → 写 ["+tool_search"]（D2 缺省写入同口径；生产路径 codemode 迁移在先走追加分支）', undefined, ['+tool_search']],
    ['null = 未配置 → 写 ["+tool_search"]', null, ['+tool_search']],
    ['[] 空数组 → 追加（D4：不复用「字段未设置才写」，空集实例同样激活）', [], ['+tool_search']],
    ['["+codemode"] → 追加到尾部（组合根常规形态：两系统级默认条目共存）', ['+codemode'], ['+codemode', '+tool_search']],
    ['["-read","+codemode"] 用户混合条目 → 追加不覆盖（用户条目原样保留、顺序不变）', ['-read', '+codemode'], ['-read', '+codemode', '+tool_search']],
    ['[42, "+codemode"] 坏值元素原样保留（不代偿用户数据，解析时才 filter）', [42, '+codemode'], [42, '+codemode', '+tool_search']],
    ['["+","-"] 单字符坏条目剥前缀后为空名，不命中 → 追加（hasToolSearchEntry：空名 modifier 不算已含）', ['+', '-'], ['+', '-', '+tool_search']],
  ] as const)('%s', (_label, seedValue, expected) => {
    seed(seedValue)
    ensureToolSearchDefaultEntry()
    expect(onDisk().defaultTools).toEqual(expected)
  })

  it.each([
    // 已含分支（D4 关键语义）：任一形态在场即不动
    ['["+tool_search"] 已含 → 不重复追加', ['+tool_search']],
    ['["tool_search"] 纯名已含 → 不重复追加（pi：任一纯名 = 整体替换默认集）', ['tool_search']],
    ['["+codemode","tool_search"] 混合含纯名 → 不追加', ['+codemode', 'tool_search']],
    ['["-tool_search"] 用户关闭态 → 不追加（关闭不被打回：追加到负条目尾部会覆盖关闭意图）', ['-tool_search']],
    ['["-tool_search","-read"] 混合负条目 → 不追加', ['-tool_search', '-read']],
    ['["+tool_search","-tool_search"] → 已含不追加（pi 按序解析后 tool_search 关，忠实用户落盘值）', ['+tool_search', '-tool_search']],
  ] as const)('%s', (_label, seedValue) => {
    seed(seedValue)
    ensureToolSearchDefaultEntry()
    expect(onDisk().defaultTools).toEqual(seedValue)
  })

  it('非数组坏值 → 不碰（尊重已配置，与 codemode 迁移同构）', () => {
    seed('bad')
    ensureToolSearchDefaultEntry()
    expect(onDisk().defaultTools).toBe('bad')
  })

  it('重复调用幂等（写后文件字节稳定）', () => {
    seed(['+codemode'])
    ensureToolSearchDefaultEntry()
    const after1 = readFileSync(settingsPath, 'utf-8')
    ensureToolSearchDefaultEntry()
    expect(readFileSync(settingsPath, 'utf-8')).toBe(after1)
  })

  it('只动 tools 域：用户其他字段逐字节保留（字段域 merge）', () => {
    seed(['+codemode'], { defaultModel: 'keep-me', packages: ['p1'] })
    ensureToolSearchDefaultEntry()
    const disk = onDisk()
    expect(disk.defaultTools).toEqual(['+codemode', '+tool_search'])
    expect(disk.defaultModel).toBe('keep-me')
    expect(disk.packages).toEqual(['p1'])
  })

  it('落盘值经 pi 解析语义激活 tool_search（落盘 ⇄ 解析闭环，P2 前提）', () => {
    seed(['+codemode'])
    ensureToolSearchDefaultEntry()
    expect(resolveDefaultToolSet(onDisk().defaultTools)).toContain('tool_search')
  })
})
// ── 3. 开关写入（目标 3：D2 开关打开/关闭语义表）─────────────────────────────

describe('setCodemodeEntry(true) · 开关打开', () => {
  it.each([
    ['字段缺失 → 写 ["+codemode"]', undefined, ['+codemode']],
    ['null 非法形态 → 规范化覆盖 ["+codemode"]', null, ['+codemode']],
    ['"bad" 非法形态 → 规范化覆盖 ["+codemode"]（D2：显式配置动作）', 'bad', ['+codemode']],
    ['42 非法形态 → 规范化覆盖 ["+codemode"]', 42, ['+codemode']],
    ['["+codemode"] → 幂等不动', ['+codemode'], ['+codemode']],
    ['["codemode"] 纯名已含 codemode → 幂等不动（D2：含纯名形态）', ['codemode'], ['codemode']],
    ['["-codemode"] → 移除负条目后空集 → 追加 ["+codemode"]', ['-codemode'], ['+codemode']],
    ['["-codemode","-read"] → 用户条目保留、追加到尾部（S5 预期形态）', ['-codemode', '-read'], ['-read', '+codemode']],
    ['["codemode","read"] 混合纯名已含 → 幂等不动', ['codemode', 'read'], ['codemode', 'read']],
    ['[42, "+codemode"] 坏值元素原样保留（不代偿用户数据，解析时才 filter）', [42, '+codemode'], [42, '+codemode']],
    ['[42, "-codemode"] → 剥负条目 + 追加，坏值元素保留', [42, '-codemode'], [42, '+codemode']],
  ] as const)('%s', (_label, seedValue, expected) => {
    seed(seedValue)
    setCodemodeEntry(true)
    expect(onDisk().defaultTools).toEqual(expected)
  })

  it('开启后落盘值经 pi 解析语义激活 codemode（落盘 ⇄ 解析闭环）', () => {
    seed('bad')
    setCodemodeEntry(true)
    expect(isCodemodeActive(onDisk().defaultTools)).toBe(true)
  })
})
describe('setCodemodeEntry(false) · 开关关闭（负条目占位 + 混合纯名边界）', () => {
  it.each([
    ['字段缺失 → 规范化覆盖 ["-codemode"]', undefined, ['-codemode']],
    ['null 非法形态 → 规范化覆盖 ["-codemode"]', null, ['-codemode']],
    ['"bad" 非法形态 → 规范化覆盖 ["-codemode"]', 'bad', ['-codemode']],
    ['["+codemode"] → 移除后空 → ["-codemode"] 占位（字段保留防启动写回，S4）', ['+codemode'], ['-codemode']],
    ['[] → 移除后空 → ["-codemode"] 占位（禁落空数组——pi 空数组 = 全禁默认工具）', [], ['-codemode']],
    ['["codemode"] → 移除纯名后空 → ["-codemode"] 占位（S6 规范化回落）', ['codemode'], ['-codemode']],
    ['["-codemode"] → 幂等（kept 非空保留，不重复追加）', ['-codemode'], ['-codemode']],
    ['["+codemode","-read"] → 移除后非空 → 保留 ["-read"] 不追加占位', ['+codemode', '-read'], ['-read']],
    ['["codemode","read"] 混合纯名边界 → 落盘 ["read"]（D2：纯名语义忠实结果）', ['codemode', 'read'], ['read']],
    ['["+codemode","codemode","-read"] → 正条目与纯名全移，用户条目保留', ['+codemode', 'codemode', '-read'], ['-read']],
    ['[42, "+codemode"] → 坏值元素原样保留', [42, '+codemode'], [42]],
  ] as const)('%s', (_label, seedValue, expected) => {
    seed(seedValue)
    setCodemodeEntry(false)
    expect(onDisk().defaultTools).toEqual(expected)
  })

  it.each([
    ['["+codemode"] → 占位后关闭', ['+codemode']],
    ['["codemode","read"] → 混合纯名移除后关闭', ['codemode', 'read']],
    ['[] → 占位后关闭', []],
  ] as const)('关闭后落盘值经 pi 解析语义不含 codemode（%s）', (_label, seedValue) => {
    seed(seedValue)
    setCodemodeEntry(false)
    expect(isCodemodeActive(onDisk().defaultTools)).toBe(false)
  })

  it('只动 tools 域：用户其他字段保留', () => {
    seed(['+codemode'], { defaultModel: 'keep-me' })
    setCodemodeEntry(false)
    const disk = onDisk()
    expect(disk.defaultTools).toEqual(['-codemode'])
    expect(disk.defaultModel).toBe('keep-me')
  })

  it('关→开→关往返：条目形态稳定（占位与默认条目互斥不堆积）', () => {
    seed(undefined)
    ensureCodemodeDefaultEntry() // ['+codemode']
    setCodemodeEntry(false)
    expect(onDisk().defaultTools).toEqual(['-codemode'])
    setCodemodeEntry(true)
    expect(onDisk().defaultTools).toEqual(['+codemode'])
    setCodemodeEntry(false)
    expect(onDisk().defaultTools).toEqual(['-codemode'])
  })
})
describe('开关写入常量契约', () => {
  it('默认条目为增量语法、占位为负条目（D2：增量条目，不整组覆盖）', () => {
    expect(CODEMODE_DEFAULT_ENTRY).toBe('+codemode')
    expect(CODEMODE_DISABLE_ENTRY).toBe('-codemode')
  })

  it('tool_search 迁移条目为增量语法（tool-declaration-slimming D4）', () => {
    expect(TOOL_SEARCH_DEFAULT_ENTRY).toBe('+tool_search')
  })
})
// ── 4. 损坏检测单点（A1：raw 预检 + .corrupt- 副本 + 每次现查）───────────────

describe('getSettingsCorruption · 两形态 + 每次现查 + 不触发隔离', () => {
  function expectNotCorrupted(r: SettingsCorruption, expectedPath = settingsPath): void {
    expect(r.corrupted).toBe(false)
    expect(r.corruptCopyPath).toBeNull()
    expect(r.filePath).toBe(expectedPath)
  }

  it('形态判定基线：好文件 / 文件不存在且无副本 → not corrupted', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'm' }), 'utf-8')
    expectNotCorrupted(getSettingsCorruption())
    rmSync(settingsPath)
    expectNotCorrupted(getSettingsCorruption()) // 全新安装正常态
  })

  it('形态①：原路径存在但 JSON 非法 → corrupted，无副本', () => {
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    const r = getSettingsCorruption()
    expect(r.corrupted).toBe(true)
    expect(r.filePath).toBe(settingsPath)
    expect(r.corruptCopyPath).toBeNull()
  })

  it('形态①延伸：原路径存在但不可读（EISDIR——readFileSync 目录）→ corrupted（fail-safe）', () => {
    // settingsPath 位置放一个目录：读错误 = EISDIR（非 ENOENT）——JsonStore 对该类
    // 读失败同样会走隔离，故 raw 预检按损坏拒入（无法证明 JSON 合法）
    rmSync(settingsPath, { force: true })
    mkdirSync(settingsPath)
    const r = getSettingsCorruption()
    expect(r.corrupted).toBe(true)
    expect(r.corruptCopyPath).toBeNull()
  })

  it('形态②：原路径不存在但存在 .corrupt-<时间戳> 副本 → corrupted + 副本路径', () => {
    writeFileSync(join(dir_m2_m2_m2_m2_m2_m2_m2_d1, `settings.json${corruptCopyName('2026-10-04T00:00:00.000Z')}`), '{ broken', 'utf-8')
    const r = getSettingsCorruption()
    expect(r.corrupted).toBe(true)
    expect(r.corruptCopyPath).toBe(join(dir_m2_m2_m2_m2_m2_m2_m2_d1, `settings.json${corruptCopyName('2026-10-04T00:00:00.000Z')}`))
    expect(r.filePath).toBe(settingsPath)
  })

  it('形态②多副本 → 报告最新一个（ISO 压缩时间戳字典序 = 时间序）', () => {
    writeFileSync(join(dir_m2_m2_m2_m2_m2_m2_m2_d1, `settings.json${corruptCopyName('2026-10-01T00:00:00.000Z')}`), '{}', 'utf-8')
    const latest = join(dir_m2_m2_m2_m2_m2_m2_m2_d1, `settings.json${corruptCopyName('2026-10-04T12:00:00.000Z')}`)
    writeFileSync(latest, '{ broken', 'utf-8')
    expect(getSettingsCorruption().corruptCopyPath).toBe(latest)
  })

  it('同名前缀但不匹配 .corrupt- 形态的文件不算副本（.conflict- / 无关文件）', () => {
    writeFileSync(join(dir_m2_m2_m2_m2_m2_m2_m2_d1, 'settings.json.conflict-20261004T000000000Z'), '{}', 'utf-8')
    writeFileSync(join(dir_m2_m2_m2_m2_m2_m2_m2_d1, 'settings.json.bak'), '{}', 'utf-8')
    expectNotCorrupted(getSettingsCorruption())
  })

  it('每次现查（结果不缓存）：好 → 坏 → 修复，三次查询结果如实翻转', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'm' }), 'utf-8')
    expect(getSettingsCorruption().corrupted).toBe(false)
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    expect(getSettingsCorruption().corrupted).toBe(true)
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'fixed' }), 'utf-8')
    expect(getSettingsCorruption().corrupted).toBe(false)
  })

  it('副本出现后现查可见：无 → 有', () => {
    expect(getSettingsCorruption().corrupted).toBe(false)
    writeFileSync(join(dir_m2_m2_m2_m2_m2_m2_m2_d1, `settings.json${corruptCopyName('2026-10-04T01:00:00.000Z')}`), '{', 'utf-8')
    expect(getSettingsCorruption().corrupted).toBe(true)
  })

  it('raw 预检不触发隔离改名：损坏文件原位原样、无新副本产生（A1 核心约束）', () => {
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    for (let i = 0; i < 3; i++) getSettingsCorruption()
    expect(existsSync(settingsPath)).toBe(true)
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken')
    expect(readdirSync(dir_m2_m2_m2_m2_m2_m2_m2_d1).filter(name => name.includes('.corrupt-'))).toEqual([])
  })

  it('filePath 跟随测试重定向路径（getActiveSettingsPath 单一来源）', () => {
    const otherPath = join(dir_m2_m2_m2_m2_m2_m2_m2_d1, 'other', 'settings.json')
    mkdirSync(join(dir_m2_m2_m2_m2_m2_m2_m2_d1, 'other'))
    setSettingsPath(otherPath)
    expect(getSettingsCorruption().filePath).toBe(otherPath)
  })
})
// ── 5. 组合根启动迁移入口（目标 5：损坏跳过 + 告警；未损坏写入）──────────────

describe('runCodemodeStartupMigration · 组合根启动序列编排（codemode 先、tool_search 后）', () => {
  it('未损坏 + 字段缺失 → codemode 默认条目 + tool_search 追加（顺序约束：反序则 codemode 的「字段存在即尊重」被挤占）', () => {
    seed(undefined)
    runCodemodeStartupMigration()
    expect(onDisk().defaultTools).toEqual(['+codemode', '+tool_search'])
  })

  it('未损坏 + codemode 关闭态 → codemode 不被打回；tool_search 照常追加', () => {
    seed(['-codemode'])
    runCodemodeStartupMigration()
    expect(onDisk().defaultTools).toEqual(['-codemode', '+tool_search'])
  })

  it('未损坏 + 用户已关闭 tool_search → 迁移不追加（负条目 = 已含）；codemode 迁移尊重已配置字段不碰', () => {
    seed(['-tool_search'])
    runCodemodeStartupMigration()
    expect(onDisk().defaultTools).toEqual(['-tool_search'])
  })

  it('未损坏 + 两默认条目已在场 → 全幂等不动', () => {
    seed(['+codemode', '+tool_search'])
    runCodemodeStartupMigration()
    expect(onDisk().defaultTools).toEqual(['+codemode', '+tool_search'])
  })

  it('损坏 → 跳过迁移（文件不被触碰）+ 结构化告警含路径与恢复指引', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    runCodemodeStartupMigration()
    // 文件原样：迁移没有经 JsonStore 触发隔离、也没有以空基线覆盖
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken')
    expect(existsSync(settingsPath)).toBe(true)
    const logged = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain(settingsPath)
    expect(logged).toContain('修复或删除该文件后重试')
  })

  it('损坏（副本形态）→ 告警含隔离副本路径', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const copyPath = join(dir_m2_m2_m2_m2_m2_m2_m2_d1, `settings.json${corruptCopyName('2026-10-04T02:00:00.000Z')}`)
    writeFileSync(copyPath, '{ broken', 'utf-8')
    runCodemodeStartupMigration()
    const logged = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain(copyPath)
    expect(logged).toContain('修复或删除该文件后重试')
  })

  it('迁移失败（写盘错误）不阻塞启动：warn 留痕不抛（ES1 风格）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 目录只读 → updateSettingsFields 取锁（mkdir lockfile）失败
    chmodSync(dir_m2_m2_m2_m2_m2_m2_m2_d1, 0o555)
    try {
      expect(() => runCodemodeStartupMigration()).not.toThrow()
      expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('启动迁移失败')
    } finally {
      chmodSync(dir_m2_m2_m2_m2_m2_m2_m2_d1, 0o755)
    }
  })
})
// ── 6. 写侧全局拒入（updateSettingsFields 锁内损坏预检——唯一写入口一处门禁覆盖全部域）──

describe('updateSettingsFields · 锁内损坏预检拒入（写侧全局防线）', () => {
  it.each([
    ['model'], ['skills'], ['extension'], ['retry'], ['tools'], ['full'],
  ] as const)('损坏文件 + %s 域写入 → 抛 SettingsWriteRejectedError，mutator 不执行，文件原样无隔离副本', (scope) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    expect(() =>
      updateSettingsFields(scope, () => {
        throw new Error('mutator must not run when corruption gate rejects')
      }),
    ).toThrow(SettingsWriteRejectedError)
    // 文件原样：预检先于锁内 JsonStore 读——不触发读时隔离改名、不产生空基线写回
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken')
    expect(readdirSync(dir_m2_m2_m2_m2_m2_m2_m2_d1).filter(name => name.includes('.corrupt-'))).toEqual([])
    // 结构化告警形状（对齐 codemode 域形态）：含路径、字段域、恢复指引
    const logged = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain(settingsPath)
    expect(logged).toContain(`字段域: ${scope}`)
    expect(logged).toContain('修复或删除该文件后重试')
  })

  it('竞态窗口语义（原锁外预检用例改写）：锁外观察为好 → 并发写坏 → 锁内写被拒且不合法化覆盖', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'keep-me', packages: ['p1'] }), 'utf-8')
    invalidateSettingsCache()
    // t0：锁外观察时刻（旧实现预检所在位置）——文件合法
    expect(getSettingsCorruption().corrupted).toBe(false)
    // t1：并发写方在预检之后、锁内读改写之前把文件改坏
    writeFileSync(settingsPath, '{ corrupted-by-race', 'utf-8')
    // t2：锁内预检命中 → 拒绝写入；用户字段不被空基线覆盖，坏文件原样保留
    expect(() =>
      updateSettingsFields('tools', s => { s.defaultTools = ['+codemode'] }),
    ).toThrow(SettingsWriteRejectedError)
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ corrupted-by-race')
    expect(readdirSync(dir_m2_m2_m2_m2_m2_m2_m2_d1).filter(name => name.includes('.corrupt-'))).toEqual([])
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0)
  })

  it('副本形态（原路径已被隔离）+ 写入 → 拒绝 + 错误载荷与告警含副本路径', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const copyPath = join(dir_m2_m2_m2_m2_m2_m2_m2_d1, `settings.json${corruptCopyName('2026-10-04T03:00:00.000Z')}`)
    writeFileSync(copyPath, '{ broken', 'utf-8')
    let caught: unknown
    try {
      updateSettingsFields('retry', () => {})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SettingsWriteRejectedError)
    const err = caught as SettingsWriteRejectedError
    expect(err.code).toBe('settings_write_rejected')
    expect(err.corruption.corrupted).toBe(true)
    expect(err.corruption.corruptCopyPath).toBe(copyPath)
    expect(err.message).toContain(copyPath)
    expect(err.message).toContain('修复或删除该文件后重试')
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain(copyPath)
  })

  it('未损坏 → 正常写入（门禁只拦坏文件，好文件行为不变）', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'm' }), 'utf-8')
    invalidateSettingsCache()
    updateSettingsFields('model', s => { s.defaultThinkingLevel = 'high' })
    const disk = onDisk()
    expect(disk.defaultThinkingLevel).toBe('high')
    expect(disk.defaultModel).toBe('m')
  })
})
// ── 7. setEnabled 结果转译（锁内拒入 → ok:false 信封）────────────────────────

describe('PiCodemodeSettings.setEnabled · 锁内拒入结果转译', () => {
  it('损坏 → ok:false + corruption 载荷（error 含路径与恢复指引），文件原样', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    const result = new PiCodemodeSettings().setEnabled(true)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: expected rejection')
    expect(result.corruption.filePath).toBe(settingsPath)
    expect(result.corruption.corruptCopyPath).toBeNull()
    expect(result.error).toContain(settingsPath)
    expect(result.error).toContain('修复或删除该文件后重试')
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken')
  })

  it('副本形态 → corruption.corruptCopyPath 有值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const copyPath = join(dir_m2_m2_m2_m2_m2_m2_m2_d1, `settings.json${corruptCopyName('2026-10-04T04:00:00.000Z')}`)
    writeFileSync(copyPath, '{ broken', 'utf-8')
    const result = new PiCodemodeSettings().setEnabled(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: expected rejection')
    expect(result.corruption.corruptCopyPath).toBe(copyPath)
  })

  it('未损坏 → 正常写入 ok:true（落盘终态）', () => {
    seed(undefined)
    const result = new PiCodemodeSettings().setEnabled(true)
    expect(result).toEqual({ ok: true, enabled: true })
    expect(onDisk().defaultTools).toEqual(['+codemode'])
  })
})
// ── 8. getEnabled 读侧归一（读侧统一阻断后 catch SettingsCorruptedError 单一路径）──

describe('PiCodemodeSettings.getEnabled · 读侧归一（损坏错误态经 SettingsCorruptedError 转译）', () => {
  it('损坏 → 错误态信封（enabled=false + corruption 载荷），文件原样无隔离副本', () => {
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    const result = new PiCodemodeSettings().getEnabled()
    expect(result.enabled).toBe(false)
    expect(result.corruption).toEqual({ filePath: settingsPath, corruptCopyPath: null })
    // 隔离退役：读侧归一后损坏读取仍零隔离、原文件字节原样
    expect(readdirSync(dir_m2_m2_m2_m2_m2_m2_m2_d1).filter(name => name.includes('.corrupt-'))).toEqual([])
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken')
  })

  it('副本形态 → corruption.corruptCopyPath 有值', () => {
    const copyPath = join(dir_m2_m2_m2_m2_m2_m2_m2_d1, `settings.json${corruptCopyName('2026-10-05T05:00:00.000Z')}`)
    writeFileSync(copyPath, '{ broken', 'utf-8')
    const result = new PiCodemodeSettings().getEnabled()
    expect(result.enabled).toBe(false)
    expect(result.corruption?.corruptCopyPath).toBe(copyPath)
  })

  it('未损坏 → 正常读取（开关真实终态 + corruption=null）；修复文件后无需失效动作即恢复', () => {
    seed(['+codemode'])
    expect(new PiCodemodeSettings().getEnabled()).toEqual({ enabled: true, corruption: null })

    // 损坏 → 错误态；修回合法（开关为关的终态）→ 读取恢复且判定为关
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    expect(new PiCodemodeSettings().getEnabled().enabled).toBe(false)
    writeFileSync(settingsPath, JSON.stringify({ defaultTools: ['-codemode'] }), 'utf-8')
    expect(new PiCodemodeSettings().getEnabled()).toEqual({ enabled: false, corruption: null })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-retry-settings', () => {
beforeEach(() => {
  dir_m2_m2_m2_m2_m2 = mkdtempSync(join(tmpdir(), 'pi-retry-settings-'))
  settingsPath_m2_m2_m2_m2 = join(dir_m2_m2_m2_m2_m2, 'settings.json')
  setSettingsPath(settingsPath_m2_m2_m2_m2)
  retrySettings = new PiRetrySettings()
})
afterEach(() => {
  invalidateSettingsCache()
  rmSync(dir_m2_m2_m2_m2_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('PiRetrySettings · getRetryConfig（D7 缺省合并 + configured 语义）', () => {
  it('文件缺失：全默认值 + configured=false', () => {
    const { config, configured } = retrySettings.getRetryConfig()
    expect(configured).toBe(false)
    expect(config).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
    })
    expect('timeoutMs' in config.provider!).toBe(false)
  })

  it('半配置（仅 provider.maxRetryDelayMs 一键）：configured=true 且其余键合并默认', () => {
    seedFile({ provider: { maxRetryDelayMs: 1800000 } })
    const { config, configured } = retrySettings.getRetryConfig()
    expect(configured).toBe(true)
    expect(config.enabled).toBe(true)
    expect(config.maxRetries).toBe(3)
    expect(config.provider!.maxRetryDelayMs).toBe(1800000)
  })

  it('键在值坏（maxRetries:"abc"）：configured=true 且该键回落默认 3（D7 坏值承接）', () => {
    seedFile({ maxRetries: 'abc' })
    const { config, configured } = retrySettings.getRetryConfig()
    expect(configured).toBe(true)
    expect(config.maxRetries).toBe(3)
  })

  it('顶层 retry 坏值（字符串）：configured=false + 全默认', () => {
    seedFile('abc')
    const { config, configured } = retrySettings.getRetryConfig()
    expect(configured).toBe(false)
    expect(config.enabled).toBe(true)
  })

  it('存量超域数值原样返回（不静默改写为默认）', () => {
    seedFile({ maxRetries: 50 })
    const { config } = retrySettings.getRetryConfig()
    expect(config.maxRetries).toBe(50)
  })
})
describe('PiRetrySettings · setRetryConfig（D3 嵌套 merge + 落盘）', () => {
  it('set 后文件实际落盘且写后立刻读一致（P2）', () => {
    const result = retrySettings.setRetryConfig({ ...VALID, provider: { timeoutMs: 30000, maxRetries: 1, maxRetryDelayMs: 60000 } })
    expect(result).toEqual({ ok: true })
    const onDisk = readRetryFromDisk() as Record<string, unknown>
    expect(onDisk).toEqual({
      enabled: true,
      maxRetries: 2,
      baseDelayMs: 3000,
      provider: { timeoutMs: 30000, maxRetries: 1, maxRetryDelayMs: 60000 },
    })
    // P2：写后立刻读（同一 store 实例，锁内 invalidate+重写缓存）应与落盘值一致
    const snapshot = retrySettings.getRetryConfig()
    expect(snapshot.configured).toBe(true)
    expect(snapshot.config.maxRetries).toBe(2)
    expect(snapshot.config.baseDelayMs).toBe(3000)
    expect(snapshot.config.provider!.timeoutMs).toBe(30000)
  })

  it('顶层 retry 坏值（字符串）：整体替换为合法对象，无索引键垃圾', () => {
    seedFile('abc')
    expect(retrySettings.setRetryConfig(VALID)).toEqual({ ok: true })
    const onDisk = readRetryFromDisk() as Record<string, unknown>
    expect(onDisk.enabled).toBe(true)
    expect(onDisk.maxRetries).toBe(2)
    expect(onDisk.baseDelayMs).toBe(3000)
    expect(Object.keys(onDisk).every(k => typeof k === 'string' && !/^\d+$/.test(k))).toBe(true)
  })

  it('provider 层坏值（字符串）：provider 整体替换，其余顶层键正常 merge', () => {
    seedFile({ enabled: false, maxRetries: 5, baseDelayMs: 1000, provider: 'abc' })
    expect(retrySettings.setRetryConfig({ ...VALID, provider: { maxRetries: 1 } })).toEqual({ ok: true })
    const onDisk = readRetryFromDisk() as Record<string, unknown>
    expect(onDisk.enabled).toBe(true)
    expect(onDisk.maxRetries).toBe(2)
    expect(onDisk.provider).toEqual({ maxRetries: 1 })
  })

  it('六键只 patch 已知键：pi 未知子字段（顶层+provider 层）原样保留', () => {
    seedFile(
      { enabled: false, maxRetries: 5, baseDelayMs: 1000, futureTop: 'keep', provider: { maxRetries: 2, futureSub: 9, maxRetryDelayMs: 0 } },
    )
    expect(retrySettings.setRetryConfig({ ...VALID, provider: { maxRetryDelayMs: 60000 } })).toEqual({ ok: true })
    const onDisk = readRetryFromDisk() as {
      futureTop: string
      provider: Record<string, unknown>
    }
    expect(onDisk.futureTop).toBe('keep')
    expect(onDisk.provider.futureSub).toBe(9)
    expect(onDisk.provider.maxRetries).toBeUndefined() // 入参未设 → 删键（pi 默认 0 语义）
    expect(onDisk.provider.maxRetryDelayMs).toBe(60000)
    expect(onDisk.provider.timeoutMs).toBeUndefined()
  })

  it('D8 越界：ok:false + error 信封，不落盘（文件保持原样）', () => {
    seedFile({ enabled: true })
    const result = retrySettings.setRetryConfig({ ...VALID, baseDelayMs: 99999000 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('baseDelayMs')
    expect(readRetryFromDisk()).toEqual({ enabled: true })
  })

  it('provider.timeoutMs=0 拒绝（0 会透传成 0ms 立即超时）', () => {
    const result = retrySettings.setRetryConfig({ ...VALID, provider: { timeoutMs: 0 } })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('provider.timeoutMs')
  })

  it('写路径 I/O 失败（锁目录创建被拒）→ D10 错误信封 ok:false + error，不抛、不落盘', () => {
    // settings 目录只读 → updateSettingsFields 取锁（mkdir lockfile）即 EACCES
    chmodSync(dir_m2_m2_m2_m2_m2, 0o555)
    try {
      const result = retrySettings.setRetryConfig(VALID)
      expect(result.ok).toBe(false)
      expect(typeof result.error).toBe('string')
      expect(result.error!.length).toBeGreaterThan(0)
      // 写失败无残留：settings.json 不被创建/改写
      expect(existsSync(settingsPath_m2_m2_m2_m2)).toBe(false)
    } finally {
      chmodSync(dir_m2_m2_m2_m2_m2, 0o755)
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-settings-deglobalize', () => {
beforeEach(() => {
  dir_m2_m2_m2_m2_m2_d1 = mkdtempSync(join(tmpdir(), 'settings-deglob-rt3-12-'))
  dirA = join(dir_m2_m2_m2_m2_m2_d1, 'agent-a')
  dirB = join(dir_m2_m2_m2_m2_m2_d1, 'agent-b')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir_m2_m2_m2_m2_m2_d1
  setSettingsPath(join(dirA, 'settings.json'))
  invalidateSettingsCache()
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir_m2_m2_m2_m2_m2_d1, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('RT-3#12 构造零全局副作用', () => {
  it('构造 PiExtensionSettings(dirB) / PiRetrySettings() 后，全局 settings 路径仍是 dirA', () => {
    expect(getActiveSettingsPath()).toBe(join(dirA, 'settings.json'))

    // 构造副作用断言本身就是用例主体（不使用产物实例）
    void new PiExtensionSettings(dirB)
    void new PiRetrySettings()

    expect(getActiveSettingsPath()).toBe(join(dirA, 'settings.json'))
    // dirB 不因构造被写 settings.json（旧实现会重建 store 触碰 dirB 路径语义）
    expect(join(dirB, 'settings.json')).not.toEqual(getActiveSettingsPath())
  })

  it('两实例互不干扰：extension 域（经全局 settings）+ 实例自有 store（各自目录）', async () => {
    writeFileSync(join(dirA, 'settings.json'), JSON.stringify({ packages: ['npm:x'] }), 'utf-8')
    const ext = new PiExtensionSettings(dirB)
    expect(ext.getPackages()).toEqual(['npm:x'])

    // 实例自有 store 落在构造参数目录（dirB），不落全局 settings 目录（dirA）
    await ext.setEnabled('npm:y', false)
    expect(readFileSync(join(dirB, 'disabled-packages.json'), 'utf-8')).toContain('npm:y')
    expect(ext.getDisabled()).toEqual(['npm:y'])

    const retry = new PiRetrySettings()
    const snapshot = retry.getRetryConfig()
    expect(snapshot.configured).toBe(false)
    expect(snapshot.config.enabled).toBe(true)
  })
})
describe('RT-3#12 读侧指纹可见性（不再读前 invalidate）', () => {
  it('外部直写 settings.json 后，getRetryConfig / getPackages 立即读到新值（无 invalidate）', () => {
    const settingsPath = join(dirA, 'settings.json')
    const ext = new PiExtensionSettings(dirB)
    const retry = new PiRetrySettings()

    // 首读建立缓存
    expect(ext.getPackages()).toEqual([])
    expect(retry.getRetryConfig().configured).toBe(false)

    // 外部写方（模拟 pi 子进程直接落盘）
    writeFileSync(settingsPath, JSON.stringify({ packages: ['npm:ext-1'], retry: { enabled: false } }), 'utf-8')

    // 无任何 invalidateSettingsCache 调用——指纹失配自动重读
    expect(ext.getPackages()).toEqual(['npm:ext-1'])
    expect(retry.getRetryConfig().configured).toBe(true)
    expect(retry.getRetryConfig().config.enabled).toBe(false)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-settings-store-corruption', () => {
beforeEach(() => {
  dir_m2_m2 = mkdtempSync(join(tmpdir(), 'pi-settings-store-corruption-'))
  settingsPath_m2_m2_m2_m2_d1 = join(dir_m2_m2, 'settings.json')
  setSettingsPath(settingsPath_m2_m2_m2_m2_d1)
})
afterEach(() => {
  vi.restoreAllMocks()
  invalidateSettingsCache()
  rmSync(dir_m2_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('readSettings · 读侧统一阻断（fail-fast）', () => {
  it('非法 JSON → 抛 SettingsCorruptedError（形状：code/载荷/message 含路径与指引），文件原样无隔离副本', () => {
    writeFileSync(settingsPath_m2_m2_m2_m2_d1, '{ broken', 'utf-8')
    let caught: unknown
    try {
      readSettings()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SettingsCorruptedError)
    const err = caught as SettingsCorruptedError
    expect(err.code).toBe('settings_corrupted')
    expect(err.name).toBe('SettingsCorruptedError')
    expect(err.corruption.corrupted).toBe(true)
    expect(err.corruption.filePath).toBe(settingsPath_m2_m2_m2_m2_d1)
    expect(err.corruption.corruptCopyPath).toBeNull()
    expect(err.message).toContain(settingsPath_m2_m2_m2_m2_d1)
    expect(err.message).toContain('修复或删除该文件后重试')
    expect(err.message).toContain('无需重启')
    // 隔离退役：损坏读取不产生隔离副本，原文件字节原样
    expect(corruptCopies()).toEqual([])
    expect(readFileSync(settingsPath_m2_m2_m2_m2_d1, 'utf-8')).toBe('{ broken')
  })

  it('不可读形态（路径指向目录，EISDIR）→ 抛 SettingsCorruptedError（fail-safe：读不出文本即按损坏阻断）', () => {
    rmSync(settingsPath_m2_m2_m2_m2_d1, { force: true })
    mkdirSync(settingsPath_m2_m2_m2_m2_d1) // settings.json 位置是一个目录 → readFileSync EISDIR
    expect(() => readSettings()).toThrow(SettingsCorruptedError)
    expect(corruptCopies()).toEqual([])
  })

  it('副本形态（原文件缺失 + .corrupt- 副本存在）→ 抛 + corruptCopyPath 有值（历史遗留副本只作损坏信号源）', () => {
    const copyPath = `${settingsPath_m2_m2_m2_m2_d1}.corrupt-20261005T000000000Z`
    writeFileSync(copyPath, '{ legacy-quarantine', 'utf-8')
    let caught: unknown
    try {
      readSettings()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SettingsCorruptedError)
    const err = caught as SettingsCorruptedError
    expect(err.corruption.corruptCopyPath).toBe(copyPath)
    expect(err.message).toContain(copyPath)
    expect(err.message).toContain('修复或删除该文件后重试')
  })

  it('好文件行为不变：未损坏 → 正常读取；文件不存在且无副本 → 空对象（全新安装正常态）', () => {
    writeFileSync(settingsPath_m2_m2_m2_m2_d1, JSON.stringify({ defaultModel: 'm1', packages: ['p1'] }), 'utf-8')
    invalidateSettingsCache()
    const settings = readSettings()
    expect(settings.defaultModel).toBe('m1')
    expect(settings.packages).toEqual(['p1'])

    rmSync(settingsPath_m2_m2_m2_m2_d1, { force: true })
    invalidateSettingsCache()
    expect(readSettings()).toEqual({})
  })

  it('损坏时不返回缓存旧值：合法读（入缓存）→ 文件被改坏 → 抛（缓存毒化不存在）', () => {
    writeFileSync(settingsPath_m2_m2_m2_m2_d1, JSON.stringify({ defaultModel: 'stale-but-valid' }), 'utf-8')
    invalidateSettingsCache()
    expect(readSettings().defaultModel).toBe('stale-but-valid') // 值入缓存

    writeFileSync(settingsPath_m2_m2_m2_m2_d1, '{ corrupted-after-cache', 'utf-8')
    expect(() => readSettings()).toThrow(SettingsCorruptedError)
    expect(corruptCopies()).toEqual([])
  })

  it('修复即恢复：损坏 → 抛 → 文件修回合法 → 读取成功（无任何失效动作，无需重启）', () => {
    writeFileSync(settingsPath_m2_m2_m2_m2_d1, '{ broken', 'utf-8')
    expect(() => readSettings()).toThrow(SettingsCorruptedError)

    writeFileSync(settingsPath_m2_m2_m2_m2_d1, JSON.stringify({ defaultModel: 'fixed' }), 'utf-8')
    expect(readSettings().defaultModel).toBe('fixed')
  })
})
describe('JsonStore corruptReadPolicy · settings 路径隔离退役机制层', () => {
  it("'throw'：parse 失败原样上抛（SyntaxError），不隔离、不回落默认值", () => {
    const path = join(dir_m2_m2, 'throw-store.json')
    writeFileSync(path, '{ broken', 'utf-8')
    const store = new JsonStore<{ v: string }>(path, { v: 'default' }, { corruptReadPolicy: 'throw' })
    expect(() => store.read()).toThrow(SyntaxError)
    // 无隔离副本、原文件原样、无缓存毒化（再读仍抛而非返回默认值）
    expect(corruptCopies()).toEqual([])
    expect(readFileSync(path, 'utf-8')).toBe('{ broken')
    expect(() => store.read()).toThrow(SyntaxError)
  })

  it("'throw'：非 ENOENT 读失败（路径指向目录）原样上抛", () => {
    const path = join(dir_m2_m2, 'throw-dir.json')
    mkdirSync(path)
    const store = new JsonStore<{ v: string }>(path, { v: 'default' }, { corruptReadPolicy: 'throw' })
    expect(() => store.read()).toThrow()
  })

  it("默认 'quarantine'：parse 失败 → 隔离副本 + 默认值回落（settings 之外的消费方语义零变化）", () => {
    const path = join(dir_m2_m2, 'quarantine-store.json')
    writeFileSync(path, '{ broken', 'utf-8')
    const store = new JsonStore<{ v: string }>(path, { v: 'default' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(store.read()).toEqual({ v: 'default' })
    expect(corruptCopies().length).toBe(1)
    // 原文件已被隔离移走（原路径不存在）
    expect(() => readFileSync(path, 'utf-8')).toThrow()
  })
})
describe('请求路径消费方 · 错误信封传导（WS RPC handler 系零改动核验）', () => {
  it('PiRetrySettings.getRetryConfig 真实损坏链 → SettingsCorruptedError 上抛（不吞、零回落）', () => {
    writeFileSync(settingsPath_m2_m2_m2_m2_d1, '{ broken', 'utf-8')
    let caught: unknown
    try {
      new PiRetrySettings().getRetryConfig()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SettingsCorruptedError)
    const err = caught as SettingsCorruptedError
    // server.handleMessage catch 的 code 透传依据（`e.code ?? 'handler_error'` →
    // sendError 错误信封）：code 必须携带，message 可直达前端
    expect(err.code).toBe('settings_corrupted')
    expect(err.message).toContain(settingsPath_m2_m2_m2_m2_d1)
    expect(corruptCopies()).toEqual([])
  })
})
describe('启动路径消费方 · 结构化告警（config-service.migrateSettingsSkillsToDiscovery）', () => {
  function makeService(): ConfigService {
    return new ConfigService('/tmp/project', new PiConfigStore())
  }

  it('损坏 → 结构化告警（路径 + 修复指引）、不抛不阻塞启动、无隔离副本', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(settingsPath_m2_m2_m2_m2_d1, '{ broken', 'utf-8')
    expect(() => makeService().migrateSettingsSkillsToDiscovery()).not.toThrow()
    const logged = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain(settingsPath_m2_m2_m2_m2_d1)
    expect(logged).toContain('修复或删除该文件后重试')
    expect(logged).toContain('无需重启')
    expect(corruptCopies()).toEqual([])
  })

  it('副本形态 → 告警含副本路径', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const copyPath = `${settingsPath_m2_m2_m2_m2_d1}.corrupt-20261005T010000000Z`
    writeFileSync(copyPath, '{ broken', 'utf-8')
    expect(() => makeService().migrateSettingsSkillsToDiscovery()).not.toThrow()
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain(copyPath)
  })

  it('非损坏错误不吞：configStore 抛普通错误 → 原样上抛', () => {
    // 无设置文件 + 无 discovery（全新安装）→ 迁移正常完成（对照组：不 warn 损坏）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => makeService().migrateSettingsSkillsToDiscovery()).not.toThrow()
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).not.toContain('已损坏')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-paths-config-dir-contract', () => {
if (!PI_DIST) {
  console.warn(`[pi-paths-contract] skip：${SKIP_REASON}`)
}
// ── 第一部分：taiji 侧路径结构断言（无条件跑，不依赖 pi 包）─────────────────────

describe('getProviderExtrasPath 路径结构（pi 不扫描子目录落点）', () => {
  it('providers.json 派生自 <piAgentDir>/config/providers.json——首段 config，不在 pi agentDir 顶层扫描范围', () => {
    const path = getProviderExtrasPath()
    expect(isAbsolute(path)).toBe(true)
    const segments = relative(getPiAgentDir(), path).split(sep)
    // agentDir 顶层是 pi 的扫描范围（models.json / settings.json / auth.json / themes/...）；
    // taiji 扩展域必须落在 config/ 子目录（pi 零引用，见第二部分检查）而非顶层
    expect(segments).toEqual(['config', 'providers.json'])
  })
})
// ── 第二部分：pi dist 静态检查（pi 包可达才跑；升级引入占用时红 = 提示复核锚点）──

describe.skipIf(!PI_DIST)(
  `pi dist 对 agent/config/ 零引用契约（ADR-0063 I4 锚点机器防线${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('join(getAgentDir(), …) 家族无 config 子目录（含模板串形态）', () => {
      const dist = PI_DIST as string
      const hits = extractAgentDirJoinFirstSegments(readDistJs(dist))

      // 空集检查（防正则失配导致 vacuous pass）：pi agentDir 核心三文件必在家族内，
      // 提取不到 = pi 改了路径派生形态 → 本检查失效，须复核 pi-paths.ts 锚点
      const uniqueFirsts = new Set(hits.map(([first]) => first))
      for (const core of ['models.json', 'settings.json', 'auth.json']) {
        expect(uniqueFirsts, `提取空集检查失败：${core} 未命中（pi 路径派生改形，复核锚点）`).toContain(core)
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
      const dist = PI_DIST_m2 as string
      const migrations = readFileSync(join(dist, 'migrations.js'), 'utf-8')
      const idx = migrations.indexOf('readdirSync(agentDir')
      // 条件检查：pi 未来删除 migrateSessionsFromAgentRoot（顶层 .jsonl 一次性迁移代码）
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
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-skill-paths-rollback', () => {
beforeEach(() => {
  dir_m2_m2_d1 = mkdtempSync(join(tmpdir(), 'skill-paths-rt3-8-'))
  agentDir_m2_m2_d1 = join(dir_m2_m2_d1, 'agent')
  readonlyDir = join(dir_m2_m2_d1, 'readonly-agent')
  mkdirSync(agentDir_m2_m2_d1, { recursive: true })
  mkdirSync(readonlyDir, { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir_m2_m2_d1
  setDiscoveryPath(join(agentDir_m2_m2_d1, 'discovery.json'))
  invalidateDiscoveryCache()
  setSettingsPath(join(readonlyDir, 'settings.json'))
  invalidateSettingsCache()
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir_m2_m2_d1, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('setSkillPaths · 两步写失败回滚（RT-3#8）', () => {
  it('settings 派生视图失败 → discovery 回滚为写前内容，错误上抛', () => {
    // 前置：discovery 已有一组路径（回滚目标）。路径必须真实存在——partitionByScope
    // 的脏数据过滤会剔除不存在的自定义绝对路径（ADR §5）， fixture 目录真建。
    const origDir = join(dir_m2_m2_d1, 'skills-orig')
    const newDir = join(dir_m2_m2_d1, 'skills-new')
    mkdirSync(origDir)
    mkdirSync(newDir)
    setSkillPaths([{ path: origDir, enabled: true, scope: 'global' }])
    const before = getSkillPaths()

    // settings 父目录只读 → 派生视图（updateSettingsFields 锁创建）失败
    chmodSync(readonlyDir, 0o555)
    try {
      expect(() => setSkillPaths([{ path: newDir, enabled: true, scope: 'global' }])).toThrow()
      // 回滚：discovery 恢复写前内容（磁盘 + 读侧一致）
      expect(getSkillPaths()).toEqual(before)
      const onDisk = JSON.parse(readFileSync(join(agentDir_m2_m2_d1, 'discovery.json'), 'utf-8'))
      expect(onDisk.skill.globalPaths).toContain(origDir)
      expect(onDisk.skill.globalPaths).not.toContain(newDir)
    } finally {
      chmodSync(readonlyDir, 0o755)
    }
  })

  it('正向对照：两步都成功 → discovery 与 settings.skills 同步', () => {
    // settings 指回可写目录；skill 目录真实存在（脏数据过滤，见上）
    setSettingsPath(join(agentDir_m2_m2_d1, 'settings.json'))
    invalidateSettingsCache()
    const okDir = join(dir_m2_m2_d1, 'skills-ok')
    mkdirSync(okDir)

    setSkillPaths([{ path: okDir, enabled: true, scope: 'global' }])

    expect(getSkillPaths()).toEqual([okDir])
    expect(readSettings().skills).toEqual([okDir])
    expect(existsSync(join(agentDir_m2_m2_d1, 'settings.json'))).toBe(true)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-protocol-commands', () => {
describe('extractExtensionCommandNames：source 过滤（D2①）', () => {
  it('extension 条目命中；skill / prompt 条目不进识别集（不属接管——skill/模板展开走正常回合）', () => {
    const names = extractExtensionCommandNames(
      responseOf([
        { name: 'plan', description: 'plan', source: 'extension', sourceInfo: { path: '/x' } },
        { name: 'skill:review', description: 'skill', source: 'skill' },
        { name: 'greet', description: 'template', source: 'prompt' },
        { name: 'todos', source: 'extension' },
      ]),
    )
    expect(names.has('plan')).toBe(true)
    expect(names.has('todos')).toBe(true)
    expect(names.has('skill:review')).toBe(false)
    expect(names.has('greet')).toBe(false)
    expect(names.size).toBe(2)
  })

  it('响应畸形（data.commands 非数组 / 缺 data）：空集——调用方按清单缺失兜底（分支 c）', () => {
    expect(extractExtensionCommandNames({ data: {} }).size).toBe(0)
    expect(extractExtensionCommandNames({ data: { commands: 'nope' } }).size).toBe(0)
    expect(extractExtensionCommandNames({}).size).toBe(0)
  })

  it('name 非字符串 / 空串条目跳过（防御畸形响应）', () => {
    const names = extractExtensionCommandNames(
      responseOf([
        { name: 42, source: 'extension' },
        { name: '', source: 'extension' },
        { source: 'extension' },
        { name: 'ok', source: 'extension' },
      ]),
    )
    expect([...names]).toEqual(['ok'])
  })
})
describe('matchCommandName：逐字精确匹配 + `:N` 消歧两类形态（D2①）', () => {
  // 入参 = extractExtensionCommandNames 的产物（source 过滤后）：extension 命令集
  const names = new Set(['plan', 'todos', 'cmd:1', 'cmd:2'])

  it('裸 name 命中：`/plan`、带参数 `/plan write xxx`（首空格前段）', () => {
    expect(matchCommandName('/plan', names)).toBe('plan')
    expect(matchCommandName('/plan write xxx', names)).toBe('plan')
    expect(matchCommandName('/todos', names)).toBe('todos')
  })

  it('`:N` 消歧后缀形态命中：同名扩展命令的 invocationName（`cmd:2`）逐字匹配', () => {
    expect(matchCommandName('/cmd:2', names)).toBe('cmd:2')
    expect(matchCommandName('/cmd:2 args', names)).toBe('cmd:2')
  })

  it('`:N` 消歧反向形态（两侧行为一致）：裸 name 未注册（pi 侧同样 miss）不命中', () => {
    // 清单只有 cmd:1/cmd:2（同名消歧产物）——用户输入裸 /cmd 时 pi 侧 getCommand('cmd')
    // 同样 miss，两侧行为一致：不命中 → 按普通消息带标记出站（D2① 尾附形态声明）
    expect(matchCommandName('/cmd', names)).toBeUndefined()
    expect(matchCommandName('/cmd:3', names)).toBeUndefined()
  })

  it('不命中形态：非 `/` 前缀、skill 条目经 source 过滤不在集内、大小写敏感', () => {
    expect(matchCommandName('plan', names)).toBeUndefined()
    expect(matchCommandName('/Plan', names)).toBeUndefined()
    expect(matchCommandName('/skill:review', names)).toBeUndefined() // source 过滤后不在集内
    expect(matchCommandName('/planx', names)).toBeUndefined() // 前缀不等于精确
  })

  it('剥斜杠口径与 pi 侧同构：首空格前段剥 `/` 后与 name 相等（含空前格边界）', () => {
    // pi 侧 spaceIndex === -1 时 slice(1)，有参数时 slice(1, spaceIndex)——同款
    expect(matchCommandName('/plan ', names)).toBe('plan')
    expect(matchCommandName('/', names)).toBeUndefined()
  })
})
});
});
