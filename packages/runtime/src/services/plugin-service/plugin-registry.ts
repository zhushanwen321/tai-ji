import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { TaijiPackageJson, PluginDescriptor, PluginState, PluginContributes, PluginSource, TaijiManifest } from './plugin-types.js'
import { checkPluginCompatibility } from './plugin-version-checker.js'

/**
 * 插件注册中心：扫描本地插件目录，解析 package.json 中的 taijiPlugin manifest，
 * 产成 PluginDescriptor 缓存在内存。
 *
 * 扫描目录优先级：
 *   1. <configDir>/plugins/        （全局插件，configDir 由组合根注入）
 *   2. <projectRoot>/.taiji/plugins/  （项目级插件）
 *   3. built-in 目录（resolveBuiltinPluginsDir：--builtin-plugins-dir 显式注入优先，
 *      缺失时回退多形态候选探测，见其注释）
 */
export class PluginRegistry {
  private cache = new Map<string, PluginDescriptor>()
  private projectRoot: string
  private pluginsConfigDir: string
  private builtinPluginsDir: string | undefined

  /** @param projectRoot 项目根（项目级插件扫描用）
   *  @param pluginsConfigDir 全局配置根（~/.taiji/，全局插件扫描用），由组合根注入。
   *  @param builtinPluginsDir 显式 built-in 插件目录（S1-W4/D3：Electron 主进程经
   *    --builtin-plugins-dir 注入的绝对路径）。提供时 built-in 扫描只用该目录，
   *    不做 cwd 探测（防用户 repo 预置同名目录冒充 built-in 插件，供应链攻击面）；
   *    缺失时回退旧探测链（dev 直跑/测试无主进程场景兼容）并落 warning。 */
  constructor(projectRoot: string, pluginsConfigDir: string, builtinPluginsDir?: string) {
    this.projectRoot = projectRoot
    this.pluginsConfigDir = pluginsConfigDir
    this.builtinPluginsDir = builtinPluginsDir
  }

  async scan(): Promise<PluginDescriptor[]> {
    const dirs: Array<{ path: string; source: PluginSource }> = [
      { path: join(this.pluginsConfigDir, 'plugins'), source: 'external' },
      { path: join(this.projectRoot, '.taiji', 'plugins'), source: 'external' },
      { path: await this.resolveBuiltinPluginsDir(), source: 'built-in' },
    ]
    const results: PluginDescriptor[] = []
    for (const { path: dir, source } of dirs) {
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        // 目录不存在 → 跳过（首次运行时 ~/.taiji/plugins/ 可能尚未创建）
        continue
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          const st = await stat(fullPath)
          if (!st.isDirectory()) continue
        } catch {
          console.warn(`[plugin-registry] cannot stat ${fullPath}, skipping`)
          continue
        }
        const descriptor = await this.parsePlugin(entry, fullPath, source)
        if (descriptor) results.push(descriptor)
      }
    }
    this.cacheDescriptors(results)
    return results
  }

  /**
   * 解析 built-in 插件目录（resources/plugins/）。
   *
   * S1-W4（D3）起优先级两级：
   *
   *   1. 显式注入（this.builtinPluginsDir，来自 --builtin-plugins-dir）——唯一权威来源。
   *      提供时直接使用，绝不再做 cwd 探测（探测链可被用户 repo 内预置的
   *      resources/plugins 目录劫持，冒充 built-in 插件获得 trusted 权限）。
   *      目录不存在时同样不回退到探测（scan() 的 readdir 失败分支按既有语义跳过），
   *      避免「显式路径缺失 → 捡到 cwd 里攻击者目录」的降级路径。
   *   2. 回退：cwd 多运行形态候选探测（dev 直跑 / vitest / e2e 脚本起 runtime
   *      无主进程传参的场景兼容）。使用回退时每次落 warning（fail-visible——
   *      生产主进程总是显式传参，看到此日志即说明 built-in 目录回到了
   *      可被 cwd 影响的探测路径）。
   *
   * 回退候选（projectRoot = runtime cwd，组合根 effectiveRoot）：
   *
   *   候选 1  <projectRoot>/resources/plugins
   *     - 打包形态：cwd=Resources/，electron-builder extraResources 拷贝目标即
   *       Resources/resources/plugins（electron-builder.yml `to: resources/plugins`）
   *     - cwd=仓库根：隔离 tsx 直跑（verify-plugin-e2e.sh）/ 本地 dist 运行
   *   候选 2  <projectRoot>/../../resources/plugins
   *     - pnpm dev：runtime cwd=apps/electron，仓库根在其上两层（与
   *       extension-resolver.scanBundledExtensions 的 ../.. 推导同构）
   *
   * [HISTORICAL] dev 缺口（F4 修复）：dev 下 cwd=apps/electron，旧实现只扫
   * <projectRoot>/resources/plugins（不存在）→ built-in statusline 在 dev 从不被
   * 发现。候选探测同时覆盖「cwd=仓库根」与「cwd=apps/electron」两种 dev 形态，
   * 不依赖 isPackaged env（两打包形态均由候选 1 命中）。
   *
   * 全部候选缺失（如全新 checkout 未跑 prepare-builtin-plugins.sh）时返回候选 1，
   * 让 scan() 的 readdir 失败分支按既有语义静默跳过。
   */
  private async resolveBuiltinPluginsDir(): Promise<string> {
    if (this.builtinPluginsDir) return this.builtinPluginsDir

    console.warn(
      '[plugin-registry] --builtin-plugins-dir not provided; falling back to cwd-based probing for built-in plugins dir (host process should always inject it explicitly)',
    )
    const candidates = [
      join(this.projectRoot, 'resources', 'plugins'),
      resolve(this.projectRoot, '..', '..', 'resources', 'plugins'),
    ]
    for (const dir of candidates) {
      try {
        if ((await stat(dir)).isDirectory()) return dir
      } catch {
        // 候选不存在 → 试下一个
        continue
      }
    }
    return candidates[0]
  }

  cacheDescriptors(descriptors: PluginDescriptor[]): void {
    for (const d of descriptors) this.cache.set(d.pluginId, d)
  }

  getDescriptor(pluginId: string): PluginDescriptor | undefined {
    return this.cache.get(pluginId)
  }

  getAllDescriptors(): PluginDescriptor[] {
    return [...this.cache.values()]
  }

  /** Remove a descriptor from the cache (used during uninstall) */
  removeDescriptor(pluginId: string): boolean {
    return this.cache.delete(pluginId)
  }

  async reload(): Promise<PluginDescriptor[]> {
    this.cache.clear()
    return this.scan()
  }

  private async parsePlugin(dirName: string, fullPath: string, source: PluginSource): Promise<PluginDescriptor | null> {
    const pkgPath = join(fullPath, 'package.json')
    const raw = await this.readPkgRaw(pkgPath)
    if (raw === null) return null

    const pkg = this.parseManifest(raw, pkgPath, dirName)
    if (pkg === null) return null

    const manifest = pkg.taijiPlugin
    const activationEvents = this.inferActivationEvents(manifest.activationEvents ?? [], manifest.contributes)

    // 注意：descriptor.engines 存原始 engineRange（非 string 时原样落盘 ?? '*' 兜底），
    // 而 compat 校验只接受 string 形态（非 string 回落 '*'）——两值语义不同，不可合并。
    const engineRange = pkg.engines?.['taiji'] ?? '*'
    const compat = checkPluginCompatibility(typeof engineRange === 'string' ? engineRange : '*')

    const entry = this.resolveEntry(fullPath, manifest.main, dirName)
    if (entry === null) return null

    const trustLevel = this.resolveTrustLevel(source, manifest, dirName)

    const descriptor = this.buildDescriptor({
      dirName,
      pkg,
      manifest,
      main: entry.main,
      activationEvents,
      trustLevel,
      engineRange,
      entryPath: entry.entryPath,
      source,
      compatCompatible: compat.compatible,
      compatibilityReason: compat.reason,
    })

    if (!compat.compatible) {
      console.warn(`[plugin-registry] ${dirName}: ${compat.reason}`)
    }

    return descriptor
  }

  /** 读取插件 package.json 原文；不可读（缺失/权限）→ null（静默跳过，既有语义） */
  private async readPkgRaw(pkgPath: string): Promise<string | null> {
    try {
      return await readFile(pkgPath, 'utf-8')
    } catch {
      return null
    }
  }

  /** JSON 解析 + manifest 有效性校验；任一失败落 warning 并返回 null（跳过该插件） */
  private parseManifest(raw: string, pkgPath: string, dirName: string): TaijiPackageJson | null {
    let pkg: TaijiPackageJson
    try {
      pkg = JSON.parse(raw)
    } catch {
      console.warn(`[plugin-registry] invalid JSON in ${pkgPath}, skipping`)
      return null
    }

    if (!pkg.taijiPlugin || pkg.taijiPlugin.manifestVersion !== 1) {
      console.warn(`[plugin-registry] ${dirName}: missing or invalid taijiPlugin manifest, skipping`)
      return null
    }

    return pkg
  }

  /**
   * 入口文件路径解析：manifest.main 缺省 index.js（向后兼容）。
   * pluginPath 必须指向具体入口文件而非插件目录——plugin-bootstrap 的 load 分支
   * 直接 `import(pluginPath)`，ESM 禁止目录导入（ERR_UNSUPPORTED_DIR_IMPORT），
   * 存目录会导致所有插件激活必炸（built-in statusline 曾因目录路径从未激活成功）。
   *
   * 入口守卫：main 必须解析到插件目录内（拒绝 ../ 逃逸与绝对路径），
   * 防止插件声明越权入口 import 插件目录外的任意文件。越权 → warning + null。
   */
  private resolveEntry(
    fullPath: string,
    manifestMain: string | undefined,
    dirName: string,
  ): { main: string; entryPath: string } | null {
    const main = manifestMain ?? 'index.js'
    const entryPath = resolve(fullPath, main)
    if (entryPath !== fullPath && !entryPath.startsWith(fullPath + sep)) {
      console.warn(`[plugin-registry] ${dirName}: main "${main}" escapes plugin directory, skipping`)
      return null
    }
    return { main, entryPath }
  }

  /**
   * S1-W4（D3）：信任级判定权归宿主，manifest 声明不参与判定——
   *   external（用户安装）一律 sandbox（进程沙箱隔离 + 权限审批照走）；
   *   built-in（随应用分发）一律 trusted。
   * external 声明非 sandbox 的 trustLevel 被忽略时落 warning（fail-visible，
   * 含插件 id 与被忽略的声明值）；声明值与强制值一致（sandbox/缺省）时无需提示。
   */
  private resolveTrustLevel(source: PluginSource, manifest: TaijiManifest, dirName: string): 'trusted' | 'sandbox' {
    if (source === 'built-in') {
      return 'trusted'
    }
    if (manifest.trustLevel && manifest.trustLevel !== 'sandbox') {
      console.warn(
        `[plugin-registry] ${dirName}: external plugin manifest declares trustLevel "${manifest.trustLevel}" — ignored and forced to 'sandbox' (trust level is host-decided by plugin source)`,
      )
    }
    return 'sandbox'
  }

  /** descriptor 装配（纯组装，无 I/O）：缺省字段兜底与兼容性状态在此落定 */
  private buildDescriptor(args: {
    dirName: string
    pkg: TaijiPackageJson
    manifest: TaijiManifest
    main: string
    activationEvents: string[]
    trustLevel: 'trusted' | 'sandbox'
    engineRange: string | undefined
    entryPath: string
    source: PluginSource
    compatCompatible: boolean
    compatibilityReason: string | undefined
  }): PluginDescriptor {
    const { dirName, pkg, manifest, main, activationEvents, trustLevel, engineRange, entryPath, source, compatCompatible, compatibilityReason } = args
    const descriptor: PluginDescriptor = {
      pluginId: dirName,
      version: pkg.version ?? '0.0.0',
      displayName: pkg.displayName ?? pkg.name ?? dirName,
      description: pkg.description ?? '',
      main,
      activationEvents,
      trustLevel,
      status: compatCompatible ? ('UNLOADED' as PluginState) : ('DEPS_MISSING' as PluginState),
      contributes: manifest.contributes ?? {} as PluginContributes,
      permissions: manifest.permissions ?? [],
      engines: { 'taiji': engineRange ?? '*' },
      pluginPath: entryPath,
      source,
      extensionDependencies: manifest.extensionDependencies ?? [],
      ...(compatCompatible ? {} : { compatibilityError: compatibilityReason }),
    }
    return descriptor
  }

  /**
   * 从 contributes.slashCommands 推断隐式 activationEvent，
   * 避免插件开发者手动声明每个命令对应的 onSlashCommand:xxx。
   */
  private inferActivationEvents(
    declared: string[],
    contributes?: PluginContributes,
  ): string[] {
    const events = [...declared]
    if (contributes?.slashCommands) {
      for (const cmd of contributes.slashCommands) {
        const event = `onSlashCommand:${cmd.name}`
        if (!events.includes(event)) events.push(event)
      }
    }
    if (contributes?.tools) {
      for (const tool of contributes.tools) {
        const event = `onToolCall:${tool.name}`
        if (!events.includes(event)) events.push(event)
      }
    }
    if (contributes?.hooks) {
      for (const hook of contributes.hooks) {
        if (!events.includes(hook)) events.push(hook)
      }
    }
    // Phase 1 不为 panels/statusBarItems 推断 activation events（无对应事件类型）
    // panels/statusBarItems 的激活由 Phase 3+ 的 UI 扩展机制处理
    return events
  }
}
