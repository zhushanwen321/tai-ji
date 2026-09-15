/**
 * PluginInstaller 域 port —— 单包解压安装 + manifest 校验。
 *
 * 与 IInstaller（extension 的 npm+git 安装，递归装依赖到 node_modules）对称但独立：
 * plugin 安装模型是「单包解压 + manifest 校验 + 无依赖」，不走递归 node_modules 布局。
 *
 * 🔒 三层架构：services 定义 port，infra/installers/plugin-installer-adapter.ts
 * 实现（NpmPluginInstaller，复用 npm-installer.ts 的纯 Node 下载能力）。
 * PluginService 经此 port 执行安装/卸载，不直接 spawn child_process。
 */

/** plugin 安装结果。成功时返回 pluginId（= package.json name）与安装路径。 */
export interface InstallResult {
  success: boolean
  pluginId?: string
  path?: string
  error?: string
}

/**
 * 插件安装器 port —— install 单个 npm 包并校验 taijiPlugin manifest；uninstall 删目录。
 * 归属 services 层契约，实现由 infra 侧 adapter 提供。
 */
export interface IPluginInstaller {
  /**
   * 安装 npm 包为 taiji plugin。
   *
   * 流程（由 infra 实现负责）：
   *  1. 从 npm registry 下载 tarball 并解压到 pluginsDir/<name>（strip=1，包内容落根）
   *  2. 读 package.json，校验 taijiPlugin.manifestVersion === 1
   *  3. 校验失败 → 删除目标目录 + 返回 { success: false }
   *  4. 成功 → 返回 { success: true, pluginId, path }
   *
   * 失败（网络/解析/校验）返回 { success: false, error }，不抛异常。
   */
  install(packageSpecifier: string): Promise<InstallResult>
  /** 删除 plugin 目录（pluginId 仅用于语义，实际按 pluginPath 删）。 */
  uninstall(pluginId: string, pluginPath: string): Promise<void>
}
