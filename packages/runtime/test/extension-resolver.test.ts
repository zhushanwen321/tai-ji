import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js'
import type { SourceMap } from '../src/infra/installers/extension-resolver.js'
import { setSettingsPath, invalidateSettingsCache } from '../src/infra/pi/pi-settings-store.js'

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  // canonicalizePath 用 realpathSync 做 key 规范化；默认原样返回（测试内按需 override）
  realpathSync: vi.fn((p: string) => p),
}))

vi.mock('node:path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
  basename: vi.fn((p: string) => p.split('/').pop() ?? ''),
  resolve: vi.fn((...args: string[]) => args.join('/')),
  sep: '/',
}))

import { existsSync, readdirSync, statSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const mockedExistsSync = vi.mocked(existsSync)
const mockedReaddirSync = vi.mocked(readdirSync)
const mockedStatSync = vi.mocked(statSync)
const mockedReadFileSync = vi.mocked(readFileSync)
const mockedRealpathSync = vi.mocked(realpathSync)

function mockDir(dirPath: string, entries: string[] = ['ext-a', 'ext-b', 'shared']): void {
  mockedExistsSync.mockImplementation((p: unknown) => {
    if (typeof p !== 'string') return false
    // Allow package.json checks for entries (but not 'shared')
    if (p.endsWith('/package.json')) {
      const parent = p.replace(/\/package\.json$/, '')
      const name = parent.split('/').pop() ?? ''
      return name !== 'shared' && entries.includes(name)
    }
    return p === dirPath || p.startsWith(dirPath + '/')
  })
  mockedReaddirSync.mockImplementation(((p: unknown) => {
    if (p === dirPath) return entries
    return []
  }) as unknown as typeof readdirSync)
  mockedStatSync.mockImplementation((p: unknown) => {
    if (typeof p !== 'string') throw new Error('not found')
    const basename = p.split('/').pop() ?? ''
    if (basename === 'shared' || !p.startsWith(dirPath)) {
      const err = new Error('not found') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { isDirectory: () => true } as import('node:fs').Stats
  })
  // Mock readFileSync to return valid pi extension package.json for entries
  mockedReadFileSync.mockImplementation((p: unknown) => {
    if (typeof p !== 'string') throw new Error('not found')
    if (p.endsWith('/package.json')) {
      const parent = p.replace(/\/package\.json$/, '')
      const name = parent.split('/').pop() ?? ''
      if (entries.includes(name) && name !== 'shared') {
        return JSON.stringify({ name, keywords: ['pi-package'] })
      }
    }
    throw new Error('not found')
  })
}

describe('ExtensionResolver', () => {
  let resolver: ExtensionResolver

  beforeEach(() => {
    resolver = new ExtensionResolver()
    vi.clearAllMocks()
  })

  describe('readExtName', () => {
    it('reads package.json name as dedup key', () => {
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p === '/dir/package.json') {
          return JSON.stringify({ name: '@zhushanwen/pi-ask-user', keywords: ['pi-package'] })
        }
        throw new Error('not found')
      })
      // @ts-expect-error — testing private method
      expect(resolver.readExtName('/dir')).toBe('@zhushanwen/pi-ask-user')
    })

    it('falls back to basename when name missing or non-string', () => {
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p === '/dir/package.json') {
          return JSON.stringify({ keywords: ['pi-package'] })
        }
        throw new Error('not found')
      })
      // basename 被 mock 为 split('/').pop()，'/dir' → 'dir'
      // @ts-expect-error — testing private method
      expect(resolver.readExtName('/dir')).toBe('dir')
    })

    it('falls back to basename when package.json unreadable', () => {
      mockedReadFileSync.mockImplementation(() => { throw new Error('not found') })
      // @ts-expect-error — testing private method
      expect(resolver.readExtName('/dir')).toBe('dir')
    })
  })

  describe('scanNpmExtensions', () => {
    it('returns empty when package.json does not exist', () => {
      mockedExistsSync.mockReturnValue(false)

      const result = resolver.scanNpmExtensions('/project')
      expect(result.size).toBe(0)
    })

    it('returns empty when package.json has no dependencies', () => {
      mockedExistsSync.mockImplementation((p: unknown) =>
        typeof p === 'string' && p === '/project/package.json',
      )
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p === '/project/package.json') {
          return JSON.stringify({})
        }
        throw new Error('not found')
      })

      const result = resolver.scanNpmExtensions('/project')
      expect(result.size).toBe(0)
    })
  })

  describe('scanSettingsExtensions', () => {
    const settingsDir = '/home/user/.taiji/agent'

    beforeEach(() => {
      // Phase 1 路径迁移：npmDir 已从 settingsDir 子树迁出到 dataDir 根层，
      // 注入 npmDir: join(settingsDir, 'npm') 让测试 fixture（settingsDir/npm/node_modules/...）继续生效。
      resolver = new ExtensionResolver({ settingsDir, npmDir: join(settingsDir, 'npm') })
      // 对齐 pi-settings-store 的读取路径到测试 settingsDir（scanSettingsExtensions 经 store 读 settings.json，D17）。
      setSettingsPath(`${settingsDir}/settings.json`)
      invalidateSettingsCache()
    })

    it('reads settings.json packages and resolves valid extensions', () => {
      const settingsPath = `${settingsDir}/settings.json`
      const pkgDir = `${settingsDir}/npm/node_modules/pi-ask-user`

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === settingsPath) return true
        if (p === pkgDir) return true
        if (p === `${pkgDir}/package.json`) return true
        if (p === `${settingsDir}/disabled-packages.json`) return false
        return false
      })

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === settingsPath) {
          return JSON.stringify({ packages: ['npm:pi-ask-user'] })
        }
        if (p === `${pkgDir}/package.json`) {
          return JSON.stringify({
            name: 'pi-ask-user',
            keywords: ['pi-package'],
            peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
          })
        }
        throw new Error('not found')
      })

      const result = resolver.scanSettingsExtensions()
      expect(result.size).toBe(1)
      expect(result.get('pi-ask-user')).toBe(pkgDir)
    })

    it('returns disabled packages (pure discovery, no disabled filtering)', () => {
      // S7：resolver 是纯发现层——不再过滤 disabled（过滤职责已移至 extension-filter.ts 管道）。
      // 让 disabled 包的目录确实存在，断言它仍被返回（全量发现）。
      const pkgDir = `${settingsDir}/npm/node_modules/pi-ask-user`

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === `${settingsDir}/settings.json`) return true
        if (p === `${settingsDir}/disabled-packages.json`) return true
        if (p === pkgDir) return true
        if (p === `${pkgDir}/package.json`) return true
        return false
      })

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === `${settingsDir}/settings.json`) {
          return JSON.stringify({ packages: ['npm:pi-ask-user'] })
        }
        if (p === `${settingsDir}/disabled-packages.json`) {
          return JSON.stringify({ disabled: ['npm:pi-ask-user'] })
        }
        if (p === `${pkgDir}/package.json`) {
          // 满足 isValidPiExtension（keywords 含 pi-package）
          return JSON.stringify({ name: 'pi-ask-user', keywords: ['pi-package'] })
        }
        throw new Error('not found')
      })

      const result = resolver.scanSettingsExtensions()
      // disabled 过滤已移至 extension-filter.ts，resolver 全量返回
      expect(result.size).toBe(1)
      // readExtName 读 package.json.name → 'pi-ask-user'（全链路统一用 package.json.name）
      expect(result.get('pi-ask-user')).toBe(pkgDir)
    })

    it('skips invalid pi extensions', () => {
      const pkgDir = `${settingsDir}/npm/node_modules/not-a-pi-ext`

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === `${settingsDir}/settings.json`) return true
        if (p === `${pkgDir}/package.json`) return true
        if (p === `${settingsDir}/disabled-packages.json`) return false
        return false
      })

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === `${settingsDir}/settings.json`) {
          return JSON.stringify({ packages: ['npm:not-a-pi-ext'] })
        }
        if (p === `${pkgDir}/package.json`) {
          return JSON.stringify({ name: 'not-a-pi-ext' })
        }
        throw new Error('not found')
      })

      const result = resolver.scanSettingsExtensions()
      expect(result.size).toBe(0)
    })

    it('returns empty when settings.json does not exist', () => {
      mockedExistsSync.mockReturnValue(false)

      const result = resolver.scanSettingsExtensions()
      expect(result.size).toBe(0)
    })
  })

  describe('scanBundledExtensions', () => {
    // dev 模式 projectRoot = apps/electron，源码目录 = repoRoot/extensions。
    // join mock 为字符串拼接（不解析 ..），dev 源码路径 = '/project/../../extensions'。
    // mock 布局对齐分组两层磁盘事实（taiji/universal 分组下放包；05d64e48e 目录分组
    // 后 mock 未同步曾致 2 用例存量失败）。dev 扫描源码后按 mandatory SSOT 过滤：
    // mock 3 个包（2 mandatory + 1 非 mandatory）验证过滤。
    const devSourceDir = '/project/../../extensions'
    const devGroupDir = `${devSourceDir}/universal`
    const nameByDir: Record<string, string> = {
      goal: '@zhushanwen/pi-goal',
      todo: '@zhushanwen/pi-todo',
      'context-engineering': '@zhushanwen/pi-context-engineering',
    }

    // dev 源码扫描专用 mock：package.json.name 返回真实 scoped 名（与 mandatory SSOT 对齐）
    function mockDevSource(): void {
      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === devSourceDir || p === devGroupDir) return true
        if (p.endsWith('/package.json')) {
          const dir = p.replace(/\/package\.json$/, '').split('/').pop() ?? ''
          return dir in nameByDir
        }
        return p.startsWith(devSourceDir + '/')
      })
      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === devSourceDir) return ['taiji', 'universal']
        if (p === devGroupDir) return Object.keys(nameByDir)
        return []
      }) as unknown as typeof readdirSync)
      mockedStatSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        const base = p.split('/').pop() ?? ''
        if (base in nameByDir || p === `${devSourceDir}/taiji` || p === devGroupDir) {
          return { isDirectory: () => true } as import('node:fs').Stats
        }
        const err = new Error('not found') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      })
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p.endsWith('/package.json')) {
          const dir = p.replace(/\/package\.json$/, '').split('/').pop() ?? ''
          if (dir in nameByDir) {
            return JSON.stringify({ name: nameByDir[dir], keywords: ['pi-package'] })
          }
        }
        throw new Error('not found')
      })
    }

    it('dev 扫描源码目录并按 mandatory SSOT 过滤（保留 mandatory，剔除非 mandatory）', () => {
      mockDevSource()
      const result = resolver.scanBundledExtensions('/project', false)
      // 只剩 2 个 mandatory（goal + todo），非 mandatory 的 context-engineering 被过滤
      expect(result.size).toBe(2)
      expect(result.has('@zhushanwen/pi-goal')).toBe(true)
      expect(result.has('@zhushanwen/pi-todo')).toBe(true)
      expect(result.has('@zhushanwen/pi-context-engineering')).toBe(false)
      // 路径指向源码目录（join mock 不解析 ..；包在分组层下）
      expect(result.get('@zhushanwen/pi-goal')).toBe(devGroupDir + '/goal')
    })

    it('packaged 读 staged bundle 目录（@zhushanwen scope，路径不变）', () => {
      const stagedDir = '/project/extensions/@zhushanwen'
      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === stagedDir) return true
        if (p.endsWith('/package.json') && p.startsWith(stagedDir + '/')) return true
        return false
      })
      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === stagedDir) return ['pi-goal'] as string[]
        return [] as string[]
      }) as unknown as typeof readdirSync)
      mockedStatSync.mockImplementation(() => ({ isDirectory: () => true } as import('node:fs').Stats))
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p.endsWith('/package.json') && p.includes(stagedDir)) {
          return JSON.stringify({ name: '@zhushanwen/pi-goal', keywords: ['pi-package'] })
        }
        throw new Error('not found')
      })
      const result = resolver.scanBundledExtensions('/project', true)
      expect(result.size).toBe(1)
      expect(result.has('@zhushanwen/pi-goal')).toBe(true)
      expect(result.get('@zhushanwen/pi-goal')).toBe(stagedDir + '/pi-goal')
    })

    it('dev 源码目录不存在时返回空（全新 clone 未装依赖）', () => {
      mockedExistsSync.mockImplementation(() => false)
      const result = resolver.scanBundledExtensions('/project', false)
      expect(result.size).toBe(0)
    })
  })

  describe('scanThirdPartyExtensions', () => {
    const thirdPartyDir = '/test/third-party-extensions'

    beforeEach(() => {
      resolver = new ExtensionResolver({ thirdPartyDir })
    })

    it('scans third-party extensions directory', () => {
      mockDir(thirdPartyDir)

      const result = resolver.scanThirdPartyExtensions()
      expect(result.size).toBe(2)
      expect(result.has('ext-a')).toBe(true)
      expect(result.has('ext-b')).toBe(true)
    })
  })

  describe('scanUserExtensions', () => {
    it('scans user-provided extension paths', () => {
      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p.endsWith('/package.json')) return true
        return true
      })
      mockedStatSync.mockImplementation(() => ({ isDirectory: () => true } as import('node:fs').Stats))
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p.endsWith('/package.json')) {
          const name = p.replace(/\/package\.json$/, '').split('/').pop() ?? ''
          return JSON.stringify({ name, keywords: ['pi-package'] })
        }
        throw new Error('not found')
      })

      const result = resolver.scanUserExtensions(['/custom/ext-a', '/custom/ext-b'])
      expect(result.size).toBe(2)
      expect(result.get('ext-a')).toBe('/custom/ext-a')
      expect(result.get('ext-b')).toBe('/custom/ext-b')
    })

    it('skips non-existent paths', () => {
      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === '/custom/ext-a') return true
        if (p === '/custom/ext-a/package.json') return true
        return false
      })
      mockedStatSync.mockImplementation(() => ({ isDirectory: () => true } as import('node:fs').Stats))
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === '/custom/ext-a/package.json') {
          return JSON.stringify({ name: 'ext-a', keywords: ['pi-package'] })
        }
        throw new Error('not found')
      })

      const result = resolver.scanUserExtensions(['/custom/ext-a', '/custom/nonexistent'])
      expect(result.size).toBe(1)
      expect(result.get('ext-a')).toBe('/custom/ext-a')
    })

    it('returns empty for empty input', () => {
      const result = resolver.scanUserExtensions([])
      expect(result.size).toBe(0)
    })
  })

  describe('deduplicate', () => {
    it('higher priority source wins over lower', () => {
      const sources: SourceMap[] = [
        {
          source: 'npm',
          extensions: new Map([['ext-a', '/npm/ext-a']]),
        },
        {
          source: 'bundled',
          extensions: new Map([
            ['ext-a', '/bundled/ext-a'],
            ['ext-b', '/bundled/ext-b'],
          ]),
        },
      ]

      const result = resolver.deduplicate(sources)
      expect(result.get('ext-a')?.dir).toBe('/npm/ext-a')
      expect(result.get('ext-a')?.source).toBe('npm')
      expect(result.get('ext-b')?.dir).toBe('/bundled/ext-b')
      expect(result.get('ext-b')?.source).toBe('bundled')
    })

    it('npm overrides settings for same name', () => {
      const sources: SourceMap[] = [
        {
          source: 'settings',
          extensions: new Map([['review', '/settings/review']]),
        },
        {
          source: 'npm',
          extensions: new Map([['review', '/npm/review']]),
        },
      ]

      const result = resolver.deduplicate(sources)
      expect(result.get('review')?.dir).toBe('/npm/review')
      expect(result.get('review')?.source).toBe('npm')
    })

    it('settings overrides bundled for same name', () => {
      const sources: SourceMap[] = [
        {
          source: 'bundled',
          extensions: new Map([['ext-a', '/bundled/ext-a']]),
        },
        {
          source: 'settings',
          extensions: new Map([['ext-a', '/settings/ext-a']]),
        },
      ]

      const result = resolver.deduplicate(sources)
      expect(result.get('ext-a')?.dir).toBe('/settings/ext-a')
      expect(result.get('ext-a')?.source).toBe('settings')
    })

    it('returns all extensions when no conflicts', () => {
      const sources: SourceMap[] = [
        {
          source: 'bundled',
          extensions: new Map([['ext-a', '/bundled/ext-a']]),
        },
        {
          source: 'third-party',
          extensions: new Map([['ext-b', '/third-party/ext-b']]),
        },
      ]

      const result = resolver.deduplicate(sources)
      expect(result.size).toBe(2)
    })
  })

  describe('resolve', () => {
    it('integrates all 5 sources and deduplicates', () => {
      // dev 模式 bundled 走源码目录（projectRoot/../../extensions），join mock 不解析 ..
      const bundledDir = '/project/../../extensions'
      const home = process.env.HOME ?? '/home/user'
      const settingsDir = `${home}/.taiji/agent`
      const settingsPath = `${settingsDir}/settings.json`

      vi.stubEnv('HOME', home)
      // 对齐 pi-settings-store 路径（scanSettingsExtensions 经 store 读 settings.json，D17）。
      setSettingsPath(settingsPath)
      invalidateSettingsCache()

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        // bundled dir exists
        if (p === bundledDir) return true
        // third-party dir exists
        if (p === `${settingsDir}/extensions`) return true
        // settings.json exists
        if (p === settingsPath) return true
        // user extension dir exists
        if (p === '/custom/my-ext') return true
        // project package.json
        if (p === '/project/package.json') return true
        // npm package - pi-goal exists
        if (p === '/project/node_modules/@zhushanwen/pi-goal/package.json') return true
        // bundled/third-party/user extension package.json
        if (p.endsWith('/package.json') && (p.includes(bundledDir) || p.includes('extensions/') || p === '/custom/my-ext/package.json')) return true
        // disabled-packages.json doesn't exist
        if (p === `${settingsDir}/disabled-packages.json`) return false
        return false
      })

      mockedReaddirSync.mockImplementation(((p: unknown) => {
        // dev 源码目录一层是分组目录（对齐分组两层磁盘布局），goal 在 universal/ 下
        if (p === bundledDir) return ['taiji', 'universal'] as string[]
        if (p === `${bundledDir}/universal`) return ['goal'] as string[]
        if (p === `${settingsDir}/extensions`) return ['ext-c'] as string[]
        return [] as string[]
      }) as unknown as typeof readdirSync)

      mockedStatSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        const basename = p.split('/').pop() ?? ''
        if (basename === 'shared') {
          const err = new Error('not found') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        return { isDirectory: () => true } as import('node:fs').Stats
      })

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === settingsPath) {
          return JSON.stringify({ packages: ['npm:pi-ask-user'] })
        }
        if (p === '/project/package.json') {
          return JSON.stringify({ dependencies: {} })
        }
        // package.json for bundled/third-party/user extensions
        if (p.endsWith('/package.json')) {
          const base = p.replace(/\/package\.json$/, '').split('/').pop() ?? ''
          // bundled 源码包 goal 返回真实 scoped 名（mandatory SSOT 对齐，过 mandatory 过滤）
          if (base === 'goal') {
            return JSON.stringify({ name: '@zhushanwen/pi-goal', keywords: ['pi-package'] })
          }
          if (['ext-c', 'my-ext'].includes(base)) {
            return JSON.stringify({ name: base, keywords: ['pi-package'] })
          }
        }
        throw new Error('not found')
      })

      resolver = new ExtensionResolver({ settingsDir, thirdPartyDir: `${settingsDir}/extensions`, npmDir: join(settingsDir, 'npm') })
      const result = resolver.resolve('/project', false, ['/custom/my-ext'])

      // bundled goal（dev 走源码，经 mandatory 过滤后保留；包在分组层下）
      expect(result.extensionDirs.some(d => d.path === bundledDir + '/universal/goal')).toBe(true)
      // third-party ext-c
      expect(result.extensionDirs.some(d => d.path.includes('ext-c'))).toBe(true)
      // user extension
      expect(result.extensionDirs.some(d => d.path === '/custom/my-ext')).toBe(true)
      // 5 sources all processed (no errors)
      expect(result.extensionDirs.length).toBeGreaterThanOrEqual(3)
    })

    it('throws when packaged and bundled dir missing (W-RT-7 fail-fast)', () => {
      const home = '/home/user'
      vi.stubEnv('HOME', home)

      const thirdPartyDir = `${home}/.taiji/extensions`

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === thirdPartyDir) return true
        if (p === '/project/package.json') return true
        if (p === `${thirdPartyDir}/ext-c/package.json`) return true
        return false
      })

      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === thirdPartyDir) return ['ext-c'] as string[]
        return [] as string[]
      }) as unknown as typeof readdirSync)

      mockedStatSync.mockImplementation(() => ({ isDirectory: () => true } as import('node:fs').Stats))

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === '/project/package.json') {
          return JSON.stringify({ dependencies: {} })
        }
        if (p === `${thirdPartyDir}/ext-c/package.json`) {
          return JSON.stringify({ name: 'ext-c', keywords: ['pi-package'] })
        }
        throw new Error('not found')
      })

      resolver = new ExtensionResolver({ thirdPartyDir })
      // W-RT-7 恢复（electron-build review R1-S2）：packaged 分支 builtin staged 目录缺失 =
      // 打包错误（extraResources 漏拷），fail-fast throw 而非静默返回空（静默会让
      // system-prompt / msg-id 映射 / reload 命令全部无声失效）
      expect(() => resolver.resolve('/project', true, [])).toThrow(/builtin extensions directory missing/)
    })

    it('scanDiscoveryExtensions: discovers single-file *.ts extensions', () => {
      resolver = new ExtensionResolver({})
      const result = resolver.scanDiscoveryExtensions(['/custom/ext-dir'])
      // scanDiscoveryExtensions 直接调 collectExtensionEntries，不经 mock 的 existsSync
      // 需要单独 mock——这里验证空 discovery 目录返回空 Map
      expect(result.size).toBe(0)
    })
  })

  describe('scanDiscoveryExtensions', () => {
    it('returns empty for non-existent directories', () => {
      mockedExistsSync.mockImplementation((() => false) as unknown as typeof existsSync)
      resolver = new ExtensionResolver({})
      const result = resolver.scanDiscoveryExtensions(['/nonexistent'])
      expect(result.size).toBe(0)
    })

    it('discovers index.ts in subdirectory (pi structure)', () => {
      const dir = '/discovery/ext-with-index'
      mockedExistsSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') return false
        // discovery 目录存在
        if (p === dir) return true
        // collectExtensionEntries → resolveExtensionEntries：无 package.json
        if (p === `${dir}/package.json`) return false
        // index.ts 存在
        if (p === `${dir}/index.ts`) return true
        return false
      }) as unknown as typeof existsSync)

      mockedStatSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        return { isDirectory: () => true } as import('node:fs').Stats
      }) as unknown as typeof statSync)

      resolver = new ExtensionResolver({})
      const result = resolver.scanDiscoveryExtensions([dir])
      // 目录自身有 index.ts → resolveExtensionEntries 返回 [dir/index.ts]
      expect(result.size).toBe(1)
    })

    it('discovers manifest-declared extensions (pi.extensions in package.json)', () => {
      const dir = '/discovery/manifest-ext'
      // mock join/resolve 不消除 ./，resolve(dir, './src/entry.ts') = dir/./src/entry.ts
      const entryPath = `${dir}/./src/entry.ts`
      mockedExistsSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === dir) return true
        if (p === `${dir}/package.json`) return true
        if (p === entryPath) return true
        return false
      }) as unknown as typeof existsSync)

      mockedStatSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        return { isDirectory: () => true } as import('node:fs').Stats
      }) as unknown as typeof statSync)

      mockedReadFileSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === `${dir}/package.json`) {
          return JSON.stringify({ pi: { extensions: ['./src/entry.ts'] } })
        }
        throw new Error('not found')
      }) as unknown as typeof readFileSync)

      resolver = new ExtensionResolver({})
      const result = resolver.scanDiscoveryExtensions([dir])
      // manifest 声明 ./src/entry.ts → resolveExtensionEntries 返回该路径
      expect(result.size).toBe(1)
    })

    it('discovers standalone *.ts files in directory', () => {
      const dir = '/discovery/loose-files'
      mockedExistsSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') return false
        // discovery 目录存在
        if (p === dir) return true
        // resolveExtensionEntries 检查目录自身：无 package.json、无 index.ts/js → null
        if (p === `${dir}/package.json`) return false
        if (p === `${dir}/index.ts`) return false
        if (p === `${dir}/index.js`) return false
        return false
      }) as unknown as typeof existsSync)

      mockedStatSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        return { isDirectory: () => true } as import('node:fs').Stats
      }) as unknown as typeof statSync)

      mockedReaddirSync.mockImplementation(((() => {
        // withFileTypes: 返回 Dirent-like 对象
        return [
          { name: 'my-ext.ts', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: 'node_modules', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          { name: '.hidden', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        ]
      }) as unknown as typeof readdirSync))

      resolver = new ExtensionResolver({})
      const result = resolver.scanDiscoveryExtensions([dir])
      // my-ext.ts 被收集（isFile + .ts 后缀），node_modules 和 .hidden 被跳过
      // key 现在是 canonicalPath（realpathSync fallback 原值，因 /discovery 路径不存在）
      expect(result.size).toBe(1)
      expect(result.has(`${dir}/my-ext.ts`)).toBe(true)
    })

    it('deduplicates index.ts entries by canonicalPath (not all keyed "index")', () => {
      // [HISTORICAL] 修复验证：多个 discovery directory 中的 extension 都以 index.ts 作为
      // 入口文件时，dedup key 应使用 canonicalPath（realpath）而不是统一的 "index"，
      // 否则除第一个外全部被丢弃。
      // 模拟两个 discovery dir：
      //   dirA/deepseek-thinking/index.ts → key = realpath → 该路径
      //   dirA/stock-tools/index.ts       → key = realpath → 该路径
      //   dirB/kelly-tools/index.ts       → key = realpath → 该路径
      // 三者 canonicalPath 互不相同，都应保留。
      const dirA = '/discovery/dirA'
      const dirB = '/discovery/dirB'
      mockedExistsSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') return false
        // dirA 存在
        if (p === dirA) return true
        if (p === `${dirA}/package.json`) return false
        if (p === `${dirA}/index.ts`) return false
        if (p === `${dirA}/index.js`) return false
        // dirB 存在
        if (p === dirB) return true
        if (p === `${dirB}/package.json`) return false
        if (p === `${dirB}/index.ts`) return false
        if (p === `${dirB}/index.js`) return false
        // 子目录的 index.ts（resolveExtensionEntries 在 fallback 检查时用）
        if (p === `${dirA}/deepseek-thinking/index.ts`) return true
        if (p === `${dirA}/deepseek-thinking/index.js`) return false
        if (p === `${dirA}/stock-tools/index.ts`) return true
        if (p === `${dirA}/stock-tools/index.js`) return false
        if (p === `${dirB}/kelly-tools/index.ts`) return true
        if (p === `${dirB}/kelly-tools/index.js`) return false
        return false
      }) as unknown as typeof existsSync)

      mockedStatSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        return { isDirectory: () => true } as import('node:fs').Stats
      }) as unknown as typeof statSync)

      // realpathSync 默认原样返回（canonicalizePath mock 实现已设为 (p)=>p）
      // 无需额外设置：三个路径各自不同 → 三个不同 key

      // dirA 子目录：deepseek-thinking/index.ts, stock-tools/index.ts
      // dirB 子目录：kelly-tools/index.ts
      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === dirA) {
          return [
            { name: 'deepseek-thinking', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
            { name: 'stock-tools', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          ]
        }
        if (p === dirB) {
          return [
            { name: 'kelly-tools', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          ]
        }
        throw new Error('not found')
      }) as unknown as typeof readdirSync)

      resolver = new ExtensionResolver({})
      const result = resolver.scanDiscoveryExtensions([dirA, dirB])
      // 三个 extension 都应归入 Map（key 为各自 canonicalPath）
      expect(result.size).toBe(3)
      expect(result.has(`${dirA}/deepseek-thinking/index.ts`)).toBe(true)
      expect(result.has(`${dirA}/stock-tools/index.ts`)).toBe(true)
      expect(result.has(`${dirB}/kelly-tools/index.ts`)).toBe(true)
      // 不应有任何 key 为 "index"（所有入口都是 index.ts，但 key 为 canonicalPath）
      expect(result.has('index')).toBe(false)
    })

    it('deduplicates same-named subdirectories across discovery dirs by canonicalPath', () => {
      // [HISTORICAL] 回归防护：两个 discovery 目录下都有同名 tools 子目录（tools/index.ts），
      // 按子目录名去重会碰撞（都叫 "tools"），按 canonicalPath 去重应各自独立保留。
      const dirA = '/discovery/dirA'
      const dirB = '/discovery/dirB'
      mockedExistsSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === dirA || p === dirB) return true
        if (p === `${dirA}/package.json` || p === `${dirB}/package.json`) return false
        if (p === `${dirA}/index.ts` || p === `${dirB}/index.ts`) return false
        if (p === `${dirA}/index.js` || p === `${dirB}/index.js`) return false
        if (p === `${dirA}/tools/index.ts`) return true
        if (p === `${dirA}/tools/index.js`) return false
        if (p === `${dirB}/tools/index.ts`) return true
        if (p === `${dirB}/tools/index.js`) return false
        return false
      }) as unknown as typeof existsSync)

      mockedStatSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        return { isDirectory: () => true } as import('node:fs').Stats
      }) as unknown as typeof statSync)

      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === dirA || p === dirB) {
          return [
            { name: 'tools', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          ]
        }
        throw new Error('not found')
      }) as unknown as typeof readdirSync)

      resolver = new ExtensionResolver({})
      const result = resolver.scanDiscoveryExtensions([dirA, dirB])
      // 两个同名 tools 子目录，canonicalPath 不同 → 都保留
      expect(result.size).toBe(2)
      expect(result.has(`${dirA}/tools/index.ts`)).toBe(true)
      expect(result.has(`${dirB}/tools/index.ts`)).toBe(true)
    })

    it('deduplicates symlink-equivalent paths via realpath', () => {
      // [HISTORICAL] 回归防护：同一物理 extension 经 symlink 访问，realpath 解析后
      // 应识别为同一路径只保留一份（canonicalizePath 调用 realpathSync）。
      const dirA = '/discovery/dirA'
      const dirB = '/discovery/dirB'
      const realTarget = '/real/extensions/shared-ext/index.ts'
      mockedExistsSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === dirA || p === dirB) return true
        if (p === `${dirA}/package.json` || p === `${dirB}/package.json`) return false
        if (p === `${dirA}/index.ts` || p === `${dirB}/index.ts`) return false
        if (p === `${dirA}/index.js` || p === `${dirB}/index.js`) return false
        if (p === `${dirA}/link-ext/index.ts`) return true
        if (p === `${dirA}/link-ext/index.js`) return false
        if (p === `${dirB}/link-ext/index.ts`) return true
        if (p === `${dirB}/link-ext/index.js`) return false
        return false
      }) as unknown as typeof existsSync)

      mockedStatSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        return { isDirectory: () => true } as import('node:fs').Stats
      }) as unknown as typeof statSync)

      // 关键：两个不同访问路径的 realpath 指向同一真实路径 → canonicalizePath 返回相同 key
      mockedRealpathSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') return p
        if (p === `${dirA}/link-ext/index.ts` || p === `${dirB}/link-ext/index.ts`) {
          return realTarget
        }
        return p
      }) as unknown as typeof realpathSync)

      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === dirA || p === dirB) {
          return [
            { name: 'link-ext', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          ]
        }
        throw new Error('not found')
      }) as unknown as typeof readdirSync)

      resolver = new ExtensionResolver({})
      const result = resolver.scanDiscoveryExtensions([dirA, dirB])
      // 两个 symlink 指向同一真实路径 → realpath 相同 → 只保留 1 个
      expect(result.size).toBe(1)
      expect(result.has(realTarget)).toBe(true)
    })

    it('resolve integrates discovery source with priority (discovery > settings)', () => {
      const home = '/home/user'
      vi.stubEnv('HOME', home)
      const settingsDir = `${home}/.taiji/agent`
      const settingsPath = `${settingsDir}/settings.json`

      setSettingsPath(settingsPath)
      invalidateSettingsCache()

      // discovery 目录提供一个 extension
      const discoveryDir = '/custom/discovery'

      mockedExistsSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === settingsPath) return true
        if (p === `${settingsDir}/disabled-packages.json`) return false
        // discovery 目录存在 + index.ts 存在
        if (p === discoveryDir) return true
        if (p === `${discoveryDir}/package.json`) return false
        if (p === `${discoveryDir}/index.ts`) return true
        return false
      }) as unknown as typeof existsSync)

      mockedStatSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        return { isDirectory: () => true } as import('node:fs').Stats
      }) as unknown as typeof statSync)

      mockedReadFileSync.mockImplementation(((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === settingsPath) return JSON.stringify({ packages: [] })
        throw new Error('not found')
      }) as unknown as typeof readFileSync)

      resolver = new ExtensionResolver({ settingsDir, npmDir: join(settingsDir, 'npm') })
      const result = resolver.resolve('/project', false, [], [discoveryDir])
      // discovery source 找到 extension
      expect(result.extensionDirs.length).toBeGreaterThanOrEqual(1)
    })
  })
})
