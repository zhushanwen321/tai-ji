/**
 * ConfigService config.json 字段访问器族单元测试。
 *
 * 覆盖 worktree 配置（getWorktreeRootDir / setWorktreeRootDir / getSetupScript /
 * setSetupScript）与对话流式空闲超时（getStreamingIdleTimeout /
 * setStreamingIdleTimeout，自 streaming-idle-config.test.ts 归并），
 * 走 config.json 的 AppConfig 结构（与 toolPermissions 同级）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfigService } from '../config-service.js'
import type { IConfigStore } from '../ports/config.js'
import * as fsUtils from '../../utils/fs-utils.js'

// mock atomicWrite 避免真实磁盘写入
vi.mock('../../utils/fs-utils.js', () => ({
  atomicWrite: vi.fn(),
}))

// mock fs 模块，控制 existsSync / readFileSync / mkdirSync
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
  }
})

function createMockConfigStore(overrides: Partial<IConfigStore> = {}): IConfigStore {
  return {
    getDefaultModel: vi.fn(() => null),
    setDefaultModel: vi.fn(),
    readModels: vi.fn(() => ({ providers: {} })),
    getProviderConfig: vi.fn(() => undefined),
    upsertProvider: vi.fn(() => ({})),
    removeProvider: vi.fn(() => ({ removed: false })),
    applyTypeTranslation: vi.fn((t: string) => t),
    addSkillPath: vi.fn(),
    removeSkillPath: vi.fn(),
    setSkillPaths: vi.fn(),
    getSkillPaths: vi.fn(() => []),
    getSkillPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
    getAgentDirs: vi.fn(() => []),
    getAgentPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
    setAgentDirs: vi.fn(),
    getExtensionDirs: vi.fn(() => []),
    getExtensionPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
    setExtensionDirs: vi.fn(),
    listAgentFiles: vi.fn(() => []),
    writeAgentFile: vi.fn(),
    deleteAgentFile: vi.fn(),
    migrateSettingsSkillsToDiscovery: vi.fn(),
    getPiAgentDir: vi.fn(() => '/tmp/pi-agent'),
    getConfigDir: vi.fn(() => '/tmp/test-config'),
    ...overrides,
  } as IConfigStore
}

describe('ConfigService worktree config', () => {
  let configService: ConfigService
  let mockStore: IConfigStore
  let fs: typeof import('node:fs')
  let writtenConfig: Record<string, unknown> | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    fs = await import('node:fs')
    writtenConfig = undefined
    // atomicWrite 捕获写入内容
    vi.mocked(fsUtils.atomicWrite).mockImplementation((_path, data) => {
      writtenConfig = JSON.parse(data as string)
    })
    // existsSync 默认返回 true（config.json 存在）
    vi.mocked(fs.existsSync).mockReturnValue(true)
    // readFileSync 默认返回空对象
    vi.mocked(fs.readFileSync).mockReturnValue('{}')
    mockStore = createMockConfigStore()
    configService = new ConfigService('/tmp/project', mockStore)
  })

  describe('getWorktreeRootDir', () => {
    it('返回默认值 ~/worktrees（config.json 无该字段）', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      expect(configService.getWorktreeRootDir()).toBe('~/worktrees')
    })

    it('返回 config.json 中的 worktreeRootDir 值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ worktreeRootDir: '/custom/path' }))
      expect(configService.getWorktreeRootDir()).toBe('/custom/path')
    })

    it('worktreeRootDir 非 string 时返回默认值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ worktreeRootDir: 123 }))
      expect(configService.getWorktreeRootDir()).toBe('~/worktrees')
    })
  })

  describe('setWorktreeRootDir', () => {
    it('写入 worktreeRootDir 到 config.json', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ toolPermissions: { bash: 'allow' } }))
      configService.setWorktreeRootDir('/new/worktree/dir')
      expect(writtenConfig).toEqual({
        toolPermissions: { bash: 'allow' },
        worktreeRootDir: '/new/worktree/dir',
      })
    })

    it('不覆盖已有的其他字段', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ worktreeRootDir: '/old', setupScript: 'my-script.sh' }))
      configService.setWorktreeRootDir('/updated')
      expect(writtenConfig).toEqual({
        worktreeRootDir: '/updated',
        setupScript: 'my-script.sh',
      })
    })
  })

  describe('getSetupScript', () => {
    it('返回默认值 custom-hooks/setup-worktree.sh（config.json 无该字段）', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      expect(configService.getSetupScript()).toBe('custom-hooks/setup-worktree.sh')
    })

    it('返回 config.json 中的 setupScript 值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ setupScript: 'my-setup.sh' }))
      expect(configService.getSetupScript()).toBe('my-setup.sh')
    })

    it('setupScript 非 string 时返回默认值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ setupScript: null }))
      expect(configService.getSetupScript()).toBe('custom-hooks/setup-worktree.sh')
    })
  })

  describe('setSetupScript', () => {
    it('写入 setupScript 到 config.json', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      configService.setSetupScript('custom-setup.sh')
      expect(writtenConfig).toEqual({ setupScript: 'custom-setup.sh' })
    })

    it('不覆盖已有的其他字段', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ worktreeRootDir: '/dir', toolPermissions: { bash: 'allow' } }))
      configService.setSetupScript('new-script.sh')
      expect(writtenConfig).toEqual({
        worktreeRootDir: '/dir',
        toolPermissions: { bash: 'allow' },
        setupScript: 'new-script.sh',
      })
    })
  })
})

describe('ConfigService streaming idle timeout（§5.3 D3，自 streaming-idle-config.test.ts 归并）', () => {
  let configService: ConfigService
  let mockStore: IConfigStore
  let fs: typeof import('node:fs')
  let writtenConfig: Record<string, unknown> | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    fs = await import('node:fs')
    writtenConfig = undefined
    vi.mocked(fsUtils.atomicWrite).mockImplementation((_path, data) => {
      writtenConfig = JSON.parse(data as string)
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('{}')
    mockStore = createMockConfigStore()
    configService = new ConfigService('/tmp/project', mockStore)
  })

  describe('getStreamingIdleTimeout', () => {
    it('config.json 无该字段时返回默认 1800 秒', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      expect(configService.getStreamingIdleTimeout()).toBe(1800)
    })

    it('返回 config.json 中的 streamingIdleTimeout 值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: 300 }))
      expect(configService.getStreamingIdleTimeout()).toBe(300)
    })

    it('字段非 number 时返回默认值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: '300' }))
      expect(configService.getStreamingIdleTimeout()).toBe(1800)
    })

    it('存量脏数据越界时读侧 clamp（下界）', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: 5 }))
      expect(configService.getStreamingIdleTimeout()).toBe(60)
    })

    it('存量脏数据越界时读侧 clamp（上界）', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: 9999 }))
      expect(configService.getStreamingIdleTimeout()).toBe(3600)
    })
  })

  describe('setStreamingIdleTimeout', () => {
    it('写入 streamingIdleTimeout 到 config.json 并返回生效值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ toolPermissions: { bash: 'allow' } }))
      const effective = configService.setStreamingIdleTimeout(300)
      expect(effective).toBe(300)
      expect(writtenConfig).toEqual({
        toolPermissions: { bash: 'allow' },
        streamingIdleTimeout: 300,
      })
    })

    it('不覆盖 config.json 已有其他字段', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: 1800, defaultBaseBranch: 'origin/main' }))
      configService.setStreamingIdleTimeout(600)
      expect(writtenConfig).toEqual({
        streamingIdleTimeout: 600,
        defaultBaseBranch: 'origin/main',
      })
    })

    it('低于下界 clamp 到 60 秒（返回生效值，不 throw）', () => {
      const effective = configService.setStreamingIdleTimeout(10)
      expect(effective).toBe(60)
      expect(writtenConfig?.['streamingIdleTimeout']).toBe(60)
    })

    it('高于上界 clamp 到 3600 秒（返回生效值，不 throw）', () => {
      const effective = configService.setStreamingIdleTimeout(7200)
      expect(effective).toBe(3600)
      expect(writtenConfig?.['streamingIdleTimeout']).toBe(3600)
    })

    it('边界值 60 / 3600 原样接受', () => {
      expect(configService.setStreamingIdleTimeout(60)).toBe(60)
      expect(configService.setStreamingIdleTimeout(3600)).toBe(3600)
    })

    it('NaN 等非有限值回默认 1800（clamp 对 NaN 无意义，宁取默认不落脏数据）', () => {
      const effective = configService.setStreamingIdleTimeout(Number.NaN)
      expect(effective).toBe(1800)
      expect(writtenConfig?.['streamingIdleTimeout']).toBe(1800)
    })
  })
})
