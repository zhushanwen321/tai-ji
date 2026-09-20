/**
 * ExtensionResolver — 六源纯发现 + 去重
 *
 * 扫描六个来源的 extension，按优先级去重后返回 DiscoveredExtension[]（路径 + 来源元数据）：
 *   npm > user > discovery > settings > third-party > bundled
 *
 * [纯发现层] 只负责扫描磁盘、校验 isValidPiExtension、按优先级去重。
 * 不做任何策略过滤（disabled / mandatory / preset）——过滤职责归 extension-filter.ts 管道。
 *
 * npm 扫描：读取 package.json 的 dependencies，对每个包用 require.resolve 定位目录，
 * 再用 isValidPiExtension() 验证是否为有效 pi extension。
 * 不硬编码 scope 或前缀 —— dependencies 本身就是白名单。
 *
 * settings 扫描：读取 <dataDir>/agent/settings.json 的 packages[]，
 * 定位 ~/.taiji/npm/node_modules/ 下的扩展目录。全量返回，不过滤 disabled。
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { getNpmDir, getExtensionsDir } from '../pi/pi-paths.js'
import { canonicalizePath } from '../../utils/path-utils.js'
import { errorWithCode, BUILTIN_EXTENSIONS_MISSING } from '../../utils/errors.js'
import { readSettings } from '../pi/pi-settings-store.js'
import { mandatoryExtensions } from '@taiji/shared'
import { warnOnce } from '../../utils/warn-once.js'
import type { IExtensionResolver, ExtensionPaths, DiscoveredExtension, ExtensionSource } from '../../services/ports/installer.js'

const log = {
  info: (...args: unknown[]) => console.log('[extension-resolver]', ...args),
  warn: (...args: unknown[]) => console.warn('[extension-resolver]', ...args),
   
  debug: (..._args: unknown[]) => {},
}

/** 优先级：数值越小优先级越高（npm 最高） */
const PRIORITY_ORDER = ['npm', 'user', 'discovery', 'settings', 'third-party', 'bundled'] as const
type SourceName = (typeof PRIORITY_ORDER)[number]

/** 扫描结果：extension name → 目录绝对路径 */
type ExtensionMap = Map<string, string>

// ExtensionPaths 定义在 services/ports/installer.ts（依赖倒置：infra 实现接口，类型归属 service 契约）。
// 本文件只 import 使用，不再 re-export（无消费者经此文件取该类型）。

export interface SourceMap {
  source: SourceName
  extensions: ExtensionMap
}

export interface ResolverOptions {
  /** 打包模式下的 npm 扫描搜索路径（默认用 process.cwd()） */
  npmResolvePaths?: string[]
  /** 用户 settings 目录，默认 <dataDir>/agent */
  settingsDir?: string
  /** 第三方 extensions 目录，默认 ~/.taiji/extensions */
  thirdPartyDir?: string
  /** npm 安装目录，默认 ~/.taiji/npm（settings 源定位 node_modules 用） */
  npmDir?: string
}

export class ExtensionResolver implements IExtensionResolver {
  constructor(private readonly options: ResolverOptions = {}) {}

  /**
   * 解析所有 extension 路径，按优先级去重。
   * deduplicate() 按 PRIORITY_ORDER 升序遍历（高优先级先写入），first-write-wins。
   *
   * @param discoveryExtDirs 用户在 discovery.json 勾选的额外扫描目录（P1 pi 原生 + P2 taiji），
   *   复刻 pi 的 collectAutoExtensionEntries 三种结构识别（单文件/index.ts/manifest）
   */
  resolve(projectRoot: string, packaged: boolean, userExtPaths: string[], discoveryExtDirs: string[] = []): ExtensionPaths {
    const sources: SourceMap[] = []

    sources.push({ source: 'bundled', extensions: this.scanBundledExtensions(projectRoot, packaged) })
    sources.push({ source: 'third-party', extensions: this.scanThirdPartyExtensions() })
    sources.push({ source: 'settings', extensions: this.scanSettingsExtensions() })
    if (userExtPaths.length > 0) {
      sources.push({ source: 'user', extensions: this.scanUserExtensions(userExtPaths) })
    }
    if (discoveryExtDirs.length > 0) {
      sources.push({ source: 'discovery', extensions: this.scanDiscoveryExtensions(discoveryExtDirs) })
    }
    sources.push({ source: 'npm', extensions: this.scanNpmExtensions(projectRoot) })

    const deduped = this.deduplicate(sources)
    log.info(`[extension-resolver] resolved ${deduped.size} extensions from ${sources.length} sources`)
    const extensionDirs: DiscoveredExtension[] = [...deduped.entries()].map(([_, { dir, source }]) => ({ path: dir, source }))
    return { extensionDirs }
  }

  /**
   * 扫描 npm extension：用户手动 npm 安装的扩展（从 package.json dependencies
   * 白名单 resolve）。
   *
   * builtin @zhushanwen/pi-* 不经此方法：现行 staged 打包内置——esbuild bundle 到
   * apps/electron/resources/extensions/@zhushanwen/，electron-builder extraResources
   * 拷贝为 Resources/extensions/，由 scanBundledExtensions 扫描，清单 SSOT =
   * packages/shared/src/mandatory-extensions.json。用户经 Settings 安装的扩展走
   * settings 源（scanSettingsExtensions），同样不经此方法。
   *
   * [HISTORICAL] builtin 机制演化：builtin 依赖（随产物 node_modules 打包）→ Settings
   * 推荐安装不打包进产物（2026-07-04，electron-builder.yml 曾移除 @zhushanwen
   * extraResources 拷贝）→ mandatory npm 安装 → staged 打包内置（2026-08-12，现行）。
   * 演化第一阶段的 packaged 分支（扫描 Resources/node_modules/@zhushanwen/ 兜底路径）
   * 已删除——现行打包不产出该目录（electron-builder.yml files 白名单不含 @zhushanwen，
   * extraResources 只拷 resources/extensions），分支恒返回空 Map，无行为。
   * projectRoot = apps/electron（runtime cwd），读 apps/electron/package.json。
   */
  scanNpmExtensions(projectRoot: string): ExtensionMap {
    const result: ExtensionMap = new Map()

    // 从 package.json dependencies 白名单 resolve
    const pkgJsonPath = join(projectRoot, 'package.json')
    if (!existsSync(pkgJsonPath)) return result

    let dependencies: Record<string, string>
    try {
      const raw = readFileSync(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
      dependencies = pkg.dependencies ?? {}
    } catch (e: unknown) {
      // RT-8#13：package.json 畸形 → 整个 npm 扩展源解析为空（「零扩展」）。此前 warn 有但
      // 无路径与恢复动作，运维看到也不知该修哪个文件——补全路径 + 指引，并按路径去重
      //（扩展装载链会反复调用本方法）。
      warnOnce(
        `ext-npm-pkg-json:${pkgJsonPath}`,
        `[extension-resolver] 读取/解析 ${pkgJsonPath} 失败，npm 源扩展全部不可用（列表为空）: ${pkgJsonPath}。` +
          '恢复动作：修复该 package.json 的 JSON 语法后重载扩展',
        e,
      )
      return result
    }

    const resolvePaths = this.options.npmResolvePaths ?? [projectRoot]

    for (const pkgName of Object.keys(dependencies)) {
      let pkgDir: string
      try {
        const resolved = require.resolve(`${pkgName}/package.json`, { paths: resolvePaths })
        pkgDir = dirname(resolved)
      } catch {
        continue
      }

      if (!this.isValidPiExtension(pkgDir)) continue

      result.set(this.readExtName(pkgDir), pkgDir)
    }

    return result
  }

  /**
   * 扫描 user-installed extensions。
   * 全量返回 packages[] 定位到的扩展目录。
   * [纯发现层] 不在此过滤 disabled——disabled 过滤由 extension-filter.ts 统一负责。
   * 定位 npm/目录下的扩展。
   */
  scanSettingsExtensions(): ExtensionMap {
    const result: ExtensionMap = new Map()
    // 读取 packages[]（经 pi-settings-store 单一所有者；测试经 setSettingsPath 对齐 settingsDir）
    const settings = readSettings()
    const packages: string[] = settings.packages ?? []

    for (const source of packages) {
      if (!source.startsWith('npm:')) continue
      const NPM_PREFIX_LEN = 4
      const pkgName = source.slice(NPM_PREFIX_LEN)
      // [纯发现层] 不在此过滤 disabled——过滤职责归 extension-filter.ts 管道。
      // resolver 只负责扫描磁盘、返回全量发现结果，策略过滤由上层消费者统一处理。

      const pkgDir = join(this.options.npmDir ?? getNpmDir(), 'node_modules', pkgName)

      if (!existsSync(pkgDir)) {
        log.debug(`[extension-resolver] settings package not installed: ${pkgName}`)
        continue
      }

      if (!this.isValidPiExtension(pkgDir)) continue

      result.set(this.readExtName(pkgDir), pkgDir)
    }

    return result
  }

  /**
   * 扫描 bundled extensions（builtin pi-* 包）
   *
   * dev/build 加载路径分流：
   *   - packaged（build）：读 electron-builder extraResources 拷贝的 staged bundle
   *     （Resources/extensions/@zhushanwen/<pkg>/，esbuild 全量 bundle 的自包含 index.js）。
   *   - dev：读源码目录 extensions/<pkg>/（repo root，pi 原生加载 .ts），
   *     改源码后新建 session 即生效，无需跑 prepare-builtin-extensions.sh。
   *
   * dev 源码扫描只保留 mandatory 包（对齐 build staged 集合）：源码目录 extensions/ 下
   * 的 @zhushanwen/pi-* 包多于 mandatory 集合（非 mandatory 扩展 + shared 库），build
   * 只 bundle mandatory 子集（prepare 脚本按 mandatory-extensions.json SSOT bundle，
   * 包数以 SSOT 为准、不在此写死）。若 dev 全量加载源码，会多出非 mandatory 包，与
   * build 产物集不一致。故按 mandatory SSOT 过滤，保证 dev/build 加载同一集合，仅路径
   * 分流（源码 .ts vs bundle .js）。这属「builtin 源集合界定」（静态定义），非
   * disabled/enabled/tier 运行时策略过滤（后者归 extension-filter）。
   *
   * [HISTORICAL] dev 模式历经三阶段：(1) 读 repoRoot 资源树 bundled extensions
   *（resources/pi 下 agent 资源层的 extensions/，仅含 bridge，isValidPiExtension 返回 false，恒返回空）；(2) 改读 staged bundle
   *（apps/electron/resources/extensions/@zhushanwen/），但 dev/build 同源导致改源码需跑
   * prepare-builtin-extensions.sh 全量 bundle ~40s + 重启 dev；(3) 现行 dev 读源码，
   * 彻底消除 dev 的 bundle 成本。
   */
  scanBundledExtensions(projectRoot: string, packaged: boolean): ExtensionMap {
    const result: ExtensionMap = new Map()

    if (packaged) {
      // build：读 staged bundle（projectRoot = process.resourcesPath）
      const builtinDir = join(projectRoot, 'extensions', '@zhushanwen')
      // [W-RT-7 恢复] packaged 模式 builtin 目录缺失 = 打包错误（electron-builder extraResources
      // 漏拷 staged extensions），fail-fast 抛错让用户/CI 立即感知，而非静默降级（builtin 缺失
      // 会导致 system-prompt 注入 / msg-id 映射 / reload 命令全部静默失效，pi 行为严重退化）。
      // dev 模式返回空仍合法（packaged 分支不触发）。恢复点：文件型 builtin 迁移 npm 包
      // （34234fb66）时旧 getBuiltinExtensionPaths 的同款 fail-fast 丢失。
      if (!existsSync(builtinDir)) {
        // 携带结构化 code（BUILTIN_EXTENSIONS_MISSING）：session-service.getExtensionPaths
        // facade 据此 rethrow 贯通 fail-fast（electron-build R3-S1），消息匹配不可靠。
        throw errorWithCode(
          `[extension] builtin extensions directory missing in packaged build: ${builtinDir} ` +
            `(expected staged Resources/extensions/@zhushanwen from electron-builder extraResources; ` +
            `verify with scripts/postbuild-validate.sh)`,
          BUILTIN_EXTENSIONS_MISSING,
        )
      }
      this.scanDirectory(builtinDir, result, 'bundled')
      return result
    }

    // dev：读源码目录（projectRoot = apps/electron，repoRoot = projectRoot/../..）。
    // join(projectRoot, '..', '..', 'extensions') 运行时解析为 <repoRoot>/extensions；
    // 包按职责分组在一层分组目录下（taiji/universal 等，约定见
    // docs/extensions/extension-conventions.md），scanDirectory 只扫一层，故对一层
    // 每个分组目录各扫一次（跳过 shared/ 共享库与文件）——不硬编码分组名，新增分组零维护。
    const sourceExtDir = join(projectRoot, '..', '..', 'extensions')
    if (!existsSync(sourceExtDir)) return result
    for (const entry of readdirSync(sourceExtDir)) {
      if (entry === 'shared') continue
      const groupDir = join(sourceExtDir, entry)
      try {
        if (!statSync(groupDir).isDirectory()) continue
      } catch {
        continue
      }
      this.scanDirectory(groupDir, result, 'bundled')
    }
    // 只保留 mandatory 包，对齐 build staged 集合（见方法注释 + 设计文档 §2.3）
    const mandatoryNames = new Set(mandatoryExtensions.map(e => e.name))
    for (const name of [...result.keys()]) {
      if (!mandatoryNames.has(name)) result.delete(name)
    }
    return result
  }

  /**
   * 扫描第三方 extensions：~/.taiji/extensions/（local/git 安装目录）
   */
  scanThirdPartyExtensions(): ExtensionMap {
    const result: ExtensionMap = new Map()
    const thirdPartyDir = this.options.thirdPartyDir ?? getExtensionsDir()
    if (!existsSync(thirdPartyDir)) return result

    this.scanDirectory(thirdPartyDir, result, 'third-party')
    return result
  }

  /**
   * 扫描用户指定的 extension 路径列表
   */
  scanUserExtensions(userExtPaths: string[]): ExtensionMap {
    const result: ExtensionMap = new Map()

    for (const extPath of userExtPaths) {
      if (!existsSync(extPath)) continue
      try {
        if (!statSync(extPath).isDirectory()) continue
      } catch {
        continue
      }
      if (!this.isValidPiExtension(extPath)) continue
      result.set(this.readExtName(extPath), extPath)
    }

    return result
  }

  /**
   * 扫描用户在 discovery.json 勾选的额外目录（P1 pi 原生 + P2 taiji + 自定义）。
   *
   * 复刻 pi 的 collectAutoExtensionEntries（pi-mono package-manager.ts:575）：
   * 支持三种 extension 结构——单文件 *.ts/*.js、子目录 index.ts/index.js、
   * package.json 的 pi.extensions manifest 字段。只识别路径返回，不加载模块（加载仍由 pi 完成）。
   *
   * 与 scanThirdPartyExtensions 的区别：后者只识别「子目录 + isValidPiExtension」结构，
   * discovery 扫描复刻 pi 原生完整识别（含单文件和 manifest 入口），保证勾选 pi 原生目录
   * （如 ~/.pi/agent/extensions）时行为与 pi 自身扫描一致。
   */
  scanDiscoveryExtensions(dirs: string[]): ExtensionMap {
    const result: ExtensionMap = new Map()
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const entries = this.collectExtensionEntries(dir)
      for (const entryPath of entries) {
        // dedup key 用 canonicalPath（对齐 Pi 原生 collectAutoExtensionEntries 按路径去重语义）。
        // [HISTORICAL] 此前用 normalizeExtName(name) 做同源内部 key，导致所有 index.ts 入口
        // 共享 key 'index'，跨目录的 stock-tools/kelly-tools/llm-router-session 等被静默丢弃。
        // canonicalPath 天然唯一，从结构上消除任意同名入口碰撞。
        const isFile = entryPath.endsWith('.ts') || entryPath.endsWith('.js')
        const key = canonicalizePath(entryPath)
        if (!result.has(key)) {
          result.set(key, isFile ? entryPath : dirname(entryPath))
        }
      }
    }
    return result
  }

  /**
   * 复刻 pi 的 collectAutoExtensionEntries：扫描一个目录，识别 extension 入口路径列表。
   *
   * 逻辑（与 pi 一致）：
   * 1. 先检查目录自身是否是 extension（resolveExtensionEntries）
   * 2. 否则遍历子项：单文件 *.ts/*.js 直接收集，子目录递归 resolveExtensionEntries
   * 3. 跳过 .开头 和 node_modules（pi 用 ignore 库做 gitignore 过滤，taiji discovery
   *    目录是用户明确勾选的，不需要 gitignore 过滤）
   */
  private collectExtensionEntries(dir: string): string[] {
    // 先检查目录自身是否有 explicit extension entries
    const rootEntries = this.resolveExtensionEntries(dir)
    if (rootEntries) return rootEntries

    const entries: string[] = []
    try {
      const dirEntries = readdirSync(dir, { withFileTypes: true })
      for (const entry of dirEntries) {
        if (entry.name.startsWith('.')) continue
        if (entry.name === 'node_modules') continue

        const fullPath = join(dir, entry.name)
        let isDir = entry.isDirectory()
        let isFile = entry.isFile()

        // 符号链接解析真实类型（与 pi 一致）
        if (entry.isSymbolicLink()) {
          try {
            const stats = statSync(fullPath)
            isDir = stats.isDirectory()
            isFile = stats.isFile()
          } catch {
            continue
          }
        }

        if (isFile && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          entries.push(fullPath)
        } else if (isDir) {
          const resolved = this.resolveExtensionEntries(fullPath)
          if (resolved) {
            entries.push(...resolved)
          }
        }
      }
    } catch (e) {
      // 目录读取失败：warn 记录后跳过（对齐 pi 的静默跳过语义，但满足 taste/no-silent-catch 至少记录）
      log.warn('[extension-resolver] collectExtensionEntries readdir failed:', e)
    }
    return entries
  }

  /**
   * 复刻 pi 的 resolveExtensionEntries（package-manager.ts:545）：
   * 解析一个目录的 extension 入口，三种结构按优先级：
   * 1. package.json 的 pi.extensions manifest 字段 → 声明的入口路径列表
   * 2. index.ts / index.js → 单入口
   * 3. 都没有 → 返回 null（不是 extension 目录）
   */
  private resolveExtensionEntries(dir: string): string[] | null {
    const packageJsonPath = join(dir, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const raw = readFileSync(packageJsonPath, 'utf-8')
        const pkg = JSON.parse(raw) as { pi?: { extensions?: string[] } }
        if (pkg.pi?.extensions?.length) {
          const resolved: string[] = []
          for (const extPath of pkg.pi.extensions) {
            const resolvedExtPath = resolve(dir, extPath)
            if (existsSync(resolvedExtPath)) {
              resolved.push(resolvedExtPath)
            }
          }
          if (resolved.length > 0) return resolved
        }
      } catch (e: unknown) {
        // package.json 解析失败：warn 记录后继续降级尝试 index.ts/index.js。RT-8#13：补路径
        // 与恢复动作，并按路径去重（discovery 扫描对同目录会反复进入本分支）。
        warnOnce(
          `ext-discovery-pkg-json:${packageJsonPath}`,
          `[extension-resolver] 读取/解析 ${packageJsonPath} 失败，pi.extensions manifest 入口不可用，` +
            '降级尝试 index.ts/index.js（两者也没有则该目录不算扩展）。' +
            `恢复动作：修复该 package.json 的 JSON 语法后重扫: ${packageJsonPath}`,
          e,
        )
      }
    }

    const indexTs = join(dir, 'index.ts')
    if (existsSync(indexTs)) return [indexTs]
    const indexJs = join(dir, 'index.js')
    if (existsSync(indexJs)) return [indexJs]

    return null
  }

  /**
   * 去重：按 PRIORITY_ORDER 升序遍历（高优先级在前），first-write-wins。
   * 返回值携带 source 元数据，供过滤管道使用。
   */
  deduplicate(sources: SourceMap[]): Map<string, { dir: string; source: ExtensionSource }> {
    const merged = new Map<string, { dir: string; source: ExtensionSource }>()

    const sorted = [...sources].sort((a, b) => {
      return PRIORITY_ORDER.indexOf(a.source) - PRIORITY_ORDER.indexOf(b.source)
    })

    for (const { source, extensions } of sorted) {
      for (const [name, dir] of extensions) {
        if (!merged.has(name)) {
          merged.set(name, { dir, source })
        }
      }
    }

    return merged
  }

  // ── Public helpers ──────────────────────────────────────────────

  /**
   * 验证包是否为有效的 pi extension。
   * 有效条件（满足任一）：
   * - keywords 包含 'pi-package'
   * - peerDependencies 包含含 'pi-coding-agent' 或 'pi-agent-core' 的包
   * - package.json 中有 'pi' manifest 字段
   */
  isValidPiExtension(pkgDir: string): boolean {
    const pkgJsonPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) return false

    try {
      const raw = readFileSync(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(raw) as {
        pi?: unknown
        keywords?: string[]
        peerDependencies?: Record<string, string>
      }

      if (pkg.pi) return true
      if (pkg.keywords?.includes('pi-package')) return true

      const peerDeps = Object.keys(pkg.peerDependencies ?? {})
      if (peerDeps.some(d => /pi-coding-agent|pi-agent-core/.test(d))) return true

      return false
    } catch (e: unknown) {
      // RT-8#13：package.json 畸形 → 判非扩展。静默 false = 该扩展从列表无声消失且
      // 无归因（半损坏清单被当「非 extension 目录」）。warn-once 按路径去重防重扫刷屏。
      warnOnce(
        `ext-pkg-json:${pkgJsonPath}`,
        `[extension-resolver] package.json 读取/解析失败，该目录被判定为非 pi 扩展（不会出现在列表）: ${pkgJsonPath}。` +
          '恢复动作：修复该 package.json 的 JSON 语法',
        e,
      )
      return false
    }
  }

  /**
   * 从扩展目录读 package.json.name 作为 deduplicate 的去重 key（扩展身份唯一源）。
   *
   * [HISTORICAL] 此前用 normalizeExtName（保留 scope、去 pi- 前缀）做去重 key，但 bundled 源
   * 遍历 @zhushanwen 目录子项拿到的是无 scope 目录名（pi-ask-user），而 settings/npm 源用
   * 完整 scoped 包名（@zhushanwen/pi-ask-user），两者经 normalizeExtName 产生不同 key
   *（ask-user vs @zhushanwen/ask-user），导致同一扩展跨源去重失败、列表出现重复条目。
   *
   * 根治：去重 key 统一为 package.json.name，与 disabled key（resolveExtension 的
   * `npm:${meta.name}`）、ExtensionInfo.name 全链路一致。name 缺失/非 string 时 fallback
   * basename(dir)，与 resolveExtension 的 typeof 守卫对齐。
   */
  private readExtName(dir: string): string {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf-8')
      const pkg = JSON.parse(raw) as { name?: unknown }
      return typeof pkg.name === 'string' ? pkg.name : basename(dir)
    } catch (e: unknown) {
      // RT-8#13：fallback basename(dir) 是「身份降级」（同包跨源去重可能失效产生重复条目），
      // 静默降级不可观测——warn-once 按路径。
      warnOnce(
        `ext-name:${dir}`,
        `[extension-resolver] 读取扩展 name 失败（package.json 缺失/畸形/无 name 字段），` +
          `去重 key 降级用目录名 ${basename(dir)}（可能导致该扩展跨源重复显示）: ${dir}`,
        e,
      )
      return basename(dir)
    }
  }

  /** 扫描目录下的子目录，跳过 shared/ */
  private scanDirectory(dir: string, result: ExtensionMap, label: string): void {
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry === 'shared') continue
        const entryPath = join(dir, entry)
        try {
          if (!statSync(entryPath).isDirectory()) continue
        } catch {
          continue
        }
        if (!this.isValidPiExtension(entryPath)) continue
        result.set(this.readExtName(entryPath), entryPath)
      }
      log.debug(`[extension-resolver] ${label}: found ${result.size} extensions in ${dir}`)
    } catch (e) {
      log.warn(`[extension-resolver] failed to scan ${label} dir ${dir}: ${e}`)
    }
  }
}
