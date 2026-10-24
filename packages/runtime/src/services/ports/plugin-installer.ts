/**
 * PluginInstaller 域 port —— 两段式安装（prepare 暂存 → commit 换入）+ 卸载删目录。
 *
 * 与 IInstaller（extension 的 npm+git 安装，递归装依赖到 node_modules）对称但独立：
 * plugin 安装模型是「单包解压 + manifest 校验 + 无依赖」，不走递归 node_modules 布局。
 *
 * 两段式（provider-plugin-access U4）：prepareInstall 把下载/校验/解压停在暂存目录，
 * 返回确认卡知情面（capabilities/readPaths 等 manifest 声明全量）；调用方（PluginService
 * 编排）在确认停点后调 commitInstall——暂存到正式目录为单步 rename 原子换入，提交失败
 * 旧版本幸存。进程死在中途只残暂存，正式目录由 sweepStaging 启动清扫（恢复类）收敛。
 *
 * 🔒 三层架构：services 定义 port，infra/installers/plugin-installer-adapter.ts
 * 实现（NpmPluginInstaller，复用 npm-installer.ts 的纯 Node 下载能力）。
 * PluginService 经此 port 执行安装/卸载，不直接 spawn child_process。
 */

/** plugin 安装结果。成功时返回 pluginId（= 安全化目录名，同 registry pluginId）与安装路径。 */
export interface InstallResult {
  success: boolean
  pluginId?: string
  path?: string
  error?: string
}

/**
 * prepare 阶段产物：暂存解压物 + 确认卡知情面（S27）。
 * manifest 声明的 capabilities/readPaths/permissions 全量透传（未声明为空数组）——
 * 确认卡展示的声明即暂存解压物内 manifest（同源，展示物 = 提交阶段校验物）。
 */
export interface PreparedPluginInstall {
  /** 安全化目录名（@scope/pkg → scope__pkg），= 安装后 registry pluginId */
  dirName: string
  /** 真实 npm 包名（namespace 推导的唯一事实源，不落盘） */
  packageName: string
  version: string
  /** 暂存绝对路径（<pluginsDir>/.staging/<dirName>） */
  stagingPath: string
  capabilities: string[]
  readPaths: string[]
  permissions: string[]
  /** 绑定校验通过的命名空间（manifest 未声明 namespace 时为 undefined，非 provider 插件常态） */
  namespace?: string
}

/** prepareInstall 结果：成功携 prepared，失败带 error（不抛异常）。 */
export interface PluginPrepareResult {
  success: boolean
  prepared?: PreparedPluginInstall
  error?: string
}

/**
 * 插件安装器 port —— 两段式安装 + 卸载删目录。
 * 归属 services 层契约，实现由 infra 侧 adapter 提供。
 */
export interface IPluginInstaller {
  /**
   * 第一段：下载 tarball 解压至暂存目录并校验。
   *
   * 流程（由 infra 实现负责）：
   *  1. 解析包名 → 安全化目录名（@scope/pkg → scope__pkg）
   *  2. 清空同插件旧暂存（重复发起安装幂等）后下载解压（strip=1，包内容落暂存根）
   *  3. 读 package.json，校验 taijiPlugin.manifestVersion === 1
   *  4. manifest 声明 namespace 时做包名绑定校验（不一致 → NAMESPACE_MISMATCH）
   *  5. 任一失败 → 清理暂存 + 返回 { success: false, error }，不抛异常
   */
  prepareInstall(packageSpecifier: string): Promise<PluginPrepareResult>
  /**
   * 第二段：暂存换入正式目录。更新场景旧版本目录先移入暂存区 replacing 位，rename
   * 失败自动移回（旧版本幸存，不存在原地覆盖后两头空）。commit 自身失败返回
   * { success: false }；commit 之后的失败（如激活失败）由调用方调 rollbackInstall。
   */
  commitInstall(prepared: PreparedPluginInstall): Promise<InstallResult>
  /**
   * 提交后失败的回滚（激活失败等）：删除刚换入的新版本目录；更新场景暂存区
   * replacing 位还留着旧版本时移回正式位（旧版本幸存）。
   */
  rollbackInstall(prepared: PreparedPluginInstall): Promise<void>
  /**
   * 提交后激活成功的收尾：清理 commit 遗留的旧版本 replacing 位（无则 no-op）。
   * best-effort——清理失败不阻断安装成功（残留由 sweepStaging 启动清扫收敛）。
   */
  discardReplaced(prepared: PreparedPluginInstall): Promise<void>
  /**
   * 启动清扫（恢复类，无定时器）：删除残留暂存目录；replacing 位中断残留按恢复
   * 语义处理——正式目录不存在时移回（恢复上次提交窗口中断的旧版本），存在时删除。
   */
  sweepStaging(): Promise<void>
  /** 删除 plugin 目录（pluginId 仅用于语义，实际按 pluginPath 删）。 */
  uninstall(pluginId: string, pluginPath: string): Promise<void>
}
