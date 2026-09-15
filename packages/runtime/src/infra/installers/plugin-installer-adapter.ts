/**
 * NpmPluginInstaller — IPluginInstaller port 的 infra 实现。
 *
 * 替代旧 services 层 PluginInstaller（直接 spawn `npm pack` + `tar -xzf`）。
 * 改为复用 npm-installer.ts 的纯 Node 下载能力（registry HTTPS + tar 解压），
 * 消除 services 层 child_process seam 泄漏。
 *
 * 安装模型（区别于 extension 的 IInstaller）：
 *  - 单包解压（strip=1，包内容落 targetDir 根），不递归装依赖
 *  - 读 package.json 校验 taijiPlugin.manifestVersion === 1
 *  - 校验失败 → 删 targetDir + 返回 { success: false }
 */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadPackageTarball } from './npm-installer.js'
import type { IPluginInstaller, InstallResult } from '../../services/ports/plugin-installer.js'
import { toErrorMessage } from '../../utils/errors.js'

export class NpmPluginInstaller implements IPluginInstaller {
  private pluginsDir: string

  /** @param pluginsDir 插件安装根目录（组合根注入，通常 join(configDir, 'plugins')）。 */
  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir
  }

  async install(packageSpecifier: string): Promise<InstallResult> {
    // 先用 registry metadata 的 name 推导 targetDir（registry name 通常与 tarball 内
    // package.json 一致；解压后再读 package.json 确认 + 取真实 name 作 pluginId）。
    // 采用方案 (b)：简洁，且解压后 pkg.name 覆盖 pluginId 保证最终一致性。
    let targetDir: string | undefined
    try {
      // downloadPackageTarball 内部 parseSpec 拿 name；此处复刻一次仅为先建 targetDir。
      // 真实下载由 downloadPackageTarball 在内部完成（它也会 mkdir targetDir）。
      targetDir = await this.resolveTargetDir(packageSpecifier)

      await downloadPackageTarball(packageSpecifier, targetDir)

      // 校验 package.json 的 taijiPlugin manifest
      const pkgPath = join(targetDir, 'package.json')
      const pkgRaw = await readFile(pkgPath, 'utf-8')
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>

      const taijiPlugin = pkg.taijiPlugin as Record<string, unknown> | undefined
      if (!taijiPlugin || taijiPlugin.manifestVersion !== 1) {
        await rm(targetDir, { recursive: true, force: true })
        return { success: false, error: 'Not a valid taiji plugin (missing taijiPlugin manifest)' }
      }

      const pluginName = typeof pkg.name === 'string' ? pkg.name : String(pkg.name ?? 'unknown-plugin')
      return { success: true, pluginId: pluginName, path: targetDir }
    } catch (err) {
      // downloadPackageTarball 成功落盘后，readFile/JSON.parse 失败会落此处——
      // targetDir 已存在内容但 manifest 不可读，必须清理，否则 registry.scan 扫到僵尸目录。
      // downloadPackageTarball 自身失败时 targetDir 可能不存在，force: true 兜底。
      if (targetDir) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => {})
      }
      const message = toErrorMessage(err)
      return { success: false, error: message }
    }
  }

  /**
   * 推导 spec 对应的 targetDir（pluginsDir/<name>）。
   *
   * name 取自 package specifier 的 name 部分（不含 @version）。若 specifier 是
   * dist-tag（如 `pkg@latest`），name 部分仍是 `pkg`，与 registry name 一致。
   * 不依赖网络——只解析字符串。
   */
  private async resolveTargetDir(spec: string): Promise<string> {
    const name = parseName(spec)
    await mkdir(this.pluginsDir, { recursive: true })
    return join(this.pluginsDir, name)
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
