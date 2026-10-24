/**
 * NpmPluginInstaller — IPluginInstaller port 的 infra 实现（两段式安装）。
 *
 * 替代旧 services 层 PluginInstaller（直接 spawn `npm pack` + `tar -xzf`）。
 * 改为复用 npm-installer.ts 的纯 Node 下载能力（registry HTTPS + tar 解压），
 * 消除 services 层 child_process seam 泄漏。
 *
 * 安装模型（区别于 extension 的 IInstaller）：
 *  - 单包解压（strip=1，包内容落暂存根），不递归装依赖
 *  - 两段式（provider-plugin-access U4）：prepareInstall 下载/校验/解压停在暂存目录
 *    并返回确认卡知情面；commitInstall 暂存到正式目录单步 rename 原子换入
 *  - scoped 包目录名解耦：@scope/pkg → scope__pkg（registry.scan 只 readdir 一级目录，
 *    嵌套 @scope/ 目录永不被发现——S8 缺陷的根修）
 *  - 提交失败旧版本幸存：更新场景旧版本先移入暂存区 replacing 位，rename 失败自动
 *    移回；提交后失败（激活失败）由调用方调 rollbackInstall 删新版、恢复旧版
 *  - 进程死在中途只残暂存/替换位（正式目录的损坏窗口仅两条 rename 之间），启动清扫
 *    sweepStaging 按「正常暂存删、替换位恢复优先」收敛（恢复类，无定时器）
 */
import { mkdir, readFile, rename, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { downloadPackageTarball } from './npm-installer.js'
import { validateNamespaceBinding, NAMESPACE_MISMATCH } from '@taiji/shared/plugin-namespace'
import type {
  IPluginInstaller,
  InstallResult,
  PreparedPluginInstall,
  PluginPrepareResult,
} from '../../services/ports/plugin-installer.js'
import { toErrorMessage } from '../../utils/errors.js'

/** 插件安装根下的暂存区目录（registry.scan 跳过 dot 条目，不作为插件扫描）。 */
const STAGING_DIR = '.staging'
/** 更新提交时旧版本的暂存区移入位前缀（rollback/清扫按恢复语义消费）。 */
const REPLACING_PREFIX = '.replacing-'
/** scoped 包名中 `/` 的最早合法下标：`@` 占 index 0、scope 段至少 1 字符（`@s/pkg`）。 */
const SCOPED_NAME_MIN_SLASH_INDEX = 2

interface ExtractedPackageJson {
  name: string
  version?: string
  taijiPlugin?: {
    manifestVersion?: unknown
    namespace?: unknown
    capabilities?: unknown
    readPaths?: unknown
    permissions?: unknown
  }
}

export class NpmPluginInstaller implements IPluginInstaller {
  private pluginsDir: string

  /** @param pluginsDir 插件安装根目录（组合根注入，通常 join(configDir, 'plugins')）。 */
  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir
  }

  async prepareInstall(packageSpecifier: string): Promise<PluginPrepareResult> {
    let dirName: string
    try {
      dirName = safePluginDirName(parseName(packageSpecifier))
    } catch (err) {
      return { success: false, error: toErrorMessage(err) }
    }
    const stagingPath = join(this.pluginsDir, STAGING_DIR, dirName)
    try {
      // 同插件再次发起安装先清旧暂存（幂等），再下载解压
      await rm(stagingPath, { recursive: true, force: true })
      await downloadPackageTarball(packageSpecifier, stagingPath)

      const pkg = await readPackageJson(stagingPath)

      const taijiPlugin = pkg.taijiPlugin
      if (!taijiPlugin || taijiPlugin.manifestVersion !== 1) {
        await rm(stagingPath, { recursive: true, force: true })
        return { success: false, error: 'Not a valid taiji plugin (missing taijiPlugin manifest)' }
      }

      // 命名空间绑定校验（D4）：manifest 显式声明时才校验（未声明 = 非 provider 插件，
      // 跳过）。声明值 ≠ 包名推导值 → NAMESPACE_MISMATCH 拒装，暂存不残留（S22）。
      let namespace: string | undefined
      if (typeof taijiPlugin.namespace === 'string') {
        const binding = validateNamespaceBinding(pkg.name, taijiPlugin.namespace)
        if (!binding.ok) {
          await rm(stagingPath, { recursive: true, force: true })
          return {
            success: false,
            error:
              `${NAMESPACE_MISMATCH}: manifest declares namespace "${binding.declared}" but package ` +
              `"${pkg.name}" derives "${binding.derived}" — fix the plugin manifest or use the correct version`,
          }
        }
        namespace = binding.namespace
      }

      const prepared: PreparedPluginInstall = {
        dirName,
        packageName: pkg.name,
        version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
        stagingPath,
        capabilities: stringArrayOrEmpty(taijiPlugin.capabilities),
        readPaths: stringArrayOrEmpty(taijiPlugin.readPaths),
        permissions: stringArrayOrEmpty(taijiPlugin.permissions),
        namespace,
      }
      return { success: true, prepared }
    } catch (err) {
      // downloadPackageTarball 自身失败时暂存可能未建，force 兜底；校验读失败同理——
      // 失败路径一律无暂存残留。
      await rm(stagingPath, { recursive: true, force: true }).catch(() => {})
      return { success: false, error: toErrorMessage(err) }
    }
  }

  async commitInstall(prepared: PreparedPluginInstall): Promise<InstallResult> {
    const targetDir = join(this.pluginsDir, prepared.dirName)
    const replacingPath = join(this.pluginsDir, STAGING_DIR, REPLACING_PREFIX + prepared.dirName)
    try {
      await mkdir(join(this.pluginsDir, STAGING_DIR), { recursive: true })
      if (existsSync(targetDir)) {
        // 更新场景：旧版本移入 replacing 位，换入失败自动移回（旧版本幸存——不存在
        // 原地覆盖后两头空）。同名替换位残留先清（上次异常周期遗留，正式目录既已
        // 存在说明其已无恢复价值）。replacing 位在 commit 成功后**保留**——提交后的
        // 失败（激活失败）回滚仍需它恢复旧版本；激活终局成功后由 discardReplaced
        // 清理，进程中断残留由 sweepStaging 收敛（正式位存在 → 删）。
        await rm(replacingPath, { recursive: true, force: true })
        await rename(targetDir, replacingPath)
      }
      try {
        await rename(prepared.stagingPath, targetDir)
      } catch (err) {
        if (existsSync(replacingPath)) {
          await rename(replacingPath, targetDir).catch((restoreErr: unknown) => {
            console.error(`[plugin-installer] failed to restore old version after commit failure:`, restoreErr)
          })
        }
        throw err
      }
      return { success: true, pluginId: prepared.dirName, path: targetDir }
    } catch (err) {
      return { success: false, error: toErrorMessage(err) }
    }
  }

  /**
   * 提交后激活成功的收尾：清理 commit 遗留的旧版本 replacing 位（无则 no-op）。
   * 清理失败不抛（残留由启动清扫按「正式位存在 → 删」收敛）。
   */
  async discardReplaced(prepared: PreparedPluginInstall): Promise<void> {
    const replacingPath = join(this.pluginsDir, STAGING_DIR, REPLACING_PREFIX + prepared.dirName)
    if (existsSync(replacingPath)) {
      await rm(replacingPath, { recursive: true, force: true }).catch((err: unknown) => {
        console.warn(`[plugin-installer] failed to discard replaced version for ${prepared.dirName}:`, err)
      })
    }
  }

  async rollbackInstall(prepared: PreparedPluginInstall): Promise<void> {
    const targetDir = join(this.pluginsDir, prepared.dirName)
    const replacingPath = join(this.pluginsDir, STAGING_DIR, REPLACING_PREFIX + prepared.dirName)
    // 删刚提交的新版本；更新场景 replacing 位还留有旧版本 → 移回正式位（旧版本幸存）
    await rm(targetDir, { recursive: true, force: true })
    if (existsSync(replacingPath)) {
      await rename(replacingPath, targetDir)
    }
  }

  async sweepStaging(): Promise<void> {
    const stagingDir = join(this.pluginsDir, STAGING_DIR)
    let entries: string[]
    try {
      entries = await readdir(stagingDir)
    } catch {
      return // 暂存区不存在 → 无残留
    }
    for (const entry of entries) {
      const fullPath = join(stagingDir, entry)
      if (entry.startsWith(REPLACING_PREFIX)) {
        // 提交窗口中断残留：正式位没有该插件 → 移回（恢复旧版本）；有 → 新版已入位，替换位可弃
        const dirName = entry.slice(REPLACING_PREFIX.length)
        const targetDir = join(this.pluginsDir, dirName)
        if (existsSync(targetDir)) {
          await rm(fullPath, { recursive: true, force: true }).catch(() => {})
        } else {
          await rename(fullPath, targetDir).catch((err: unknown) => {
            console.error(`[plugin-installer] failed to restore replaced version for ${dirName}:`, err)
          })
        }
        continue
      }
      // 正常暂存形态（上次安装未确认/未提交）→ 删
      await rm(fullPath, { recursive: true, force: true }).catch(() => {})
    }
  }

  async uninstall(_pluginId: string, pluginPath: string): Promise<void> {
    await rm(pluginPath, { recursive: true, force: true })
  }
}

/** 解析 npm specifier 的 name 部分（scoped 包支持，如 @scope/pkg@1.0.0 → @scope/pkg）。 */
function parseName(spec: string): string {
  if (spec.startsWith('@')) {
    const lastAt = spec.indexOf('@', 1)
    if (lastAt === -1) return spec
    return spec.slice(0, lastAt)
  }
  const atIdx = spec.indexOf('@')
  if (atIdx === -1) return spec
  return spec.slice(0, atIdx)
}

/**
 * 包名 → 安全化安装目录名（scoped 包目录解耦，S8）：@scope/pkg → scope__pkg。
 * 无 scope 包名原样。fail-closed：裸 scope（'@scope'，无 /）、空段、'..' 段、含路径
 * 分隔符的段一律抛错——目录名由包名派生，穿越段必须在落盘前拒绝。
 */
function safePluginDirName(pkgName: string): string {
  if (pkgName.startsWith('@')) {
    const slash = pkgName.indexOf('/')
    if (slash < SCOPED_NAME_MIN_SLASH_INDEX) throw new Error(`Invalid scoped package name: "${pkgName}"`)
    const scope = pkgName.slice(1, slash)
    const name = pkgName.slice(slash + 1)
    assertSafeSegment(scope)
    assertSafeSegment(name)
    return `${scope}__${name}`
  }
  assertSafeSegment(pkgName)
  return pkgName
}

function assertSafeSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
    throw new Error(`Unsafe plugin directory name derived from package name: "${segment}"`)
  }
}

async function readPackageJson(dir: string): Promise<ExtractedPackageJson> {
  const pkgPath = join(dir, 'package.json')
  const raw = await readFile(pkgPath, 'utf-8')
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Invalid package.json at ${pkgPath}`)
  }
  const pkg = parsed as ExtractedPackageJson
  if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
    throw new Error(`package.json at ${pkgPath} has no name`)
  }
  return pkg
}

function stringArrayOrEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}
