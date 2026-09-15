/**
 * 自动升级后端常量（路径 SSOT）。
 *
 * 对应 slice auto-update-and-install w3：所有升级相关文件统一落在
 * `<dataDir>/update/` 目录下，跨进程（main + detached updater 脚本 + self-healer）
 * 共享同一路径源。
 *
 * [HISTORICAL] 不变量：
 * - 所有路径基于 getDataDir()（读 TAIJI_AGENT_DATA_DIR，dev 模式 main.ts 兜底到 ~/.taiji-dev）
 * - update-result.json 是升级流程的跨进程状态 SSOT（status:
 *   replacing|done|failed|rolled-back|no-op，其中 no-op 由 self-healer 在
 *   "中断但无 .old 备份"时写入，表示未做回滚动作）
 * - updater.sh / updater-linux.sh 由 platform-updater 在每次升级时覆写（含 sha256/版本）
 *
 * [HISTORICAL] 延迟求值（module-eager-binding 修复）：全部路径以函数形态导出，
 * 调用时才经 getDataDir() 解析，禁止改回模块级常量。main.ts 的 dev 兜底
 * （TAIJI_AGENT_DATA_DIR ?? ~/.taiji-dev）在模块 import 链之后才执行——若在
 * import 期求值，无 env 启动的 dev 实例（如 keeper 自动重启不带 env）会把路径
 * 烤死到真实目录 ~/.taiji/update，升级产物/日志误写生产数据（曾致 190MB
 * 产物误落真实目录）。运行时首次实际调用（IPC / whenReady 链）必然晚于 main.ts
 * 的 isDev 块，函数形态保证 env 已就位。范式同 proxy-config.ts getProxyConfigPath。
 *
 * 依赖方向：constants → @taiji/shared/paths + node:path
 */
import path from 'node:path'
import { getDataDir } from '@taiji/shared/paths'

/** 升级工作根目录：`<dataDir>/update` */
export function getUpdateDir(): string {
  return path.join(getDataDir(), 'update')
}

/** 升级结果状态文件（跨进程 SSOT） */
export function getUpdateResultFile(): string {
  return path.join(getUpdateDir(), 'update-result.json')
}

/** 升级提醒持久化标志文件（检测到新版时写，启动时读以恢复「可升级」提醒）。 */
export function getPendingUpdateFile(): string {
  return path.join(getUpdateDir(), 'pending-update.json')
}

/** 预下载产物元信息文件（后台下载完成后写，点击更新时读以跳过重复下载）。 */
export function getPreloadedUpdateFile(): string {
  return path.join(getUpdateDir(), 'preloaded-update.json')
}

/** 升级设置文件（如预下载开关）。 */
export function getUpdateSettingsFile(): string {
  return path.join(getUpdateDir(), 'update-settings.json')
}

/** mac 升级 detached bash 脚本路径 */
export function getUpdaterScriptPath(): string {
  return path.join(getUpdateDir(), 'updater.sh')
}

/** linux AppImage 升级 detached bash 脚本路径 */
export function getLinuxUpdaterScriptPath(): string {
  return path.join(getUpdateDir(), 'updater-linux.sh')
}

/** mac 升级日志路径 */
export function getUpdaterLogPath(): string {
  return path.join(getUpdateDir(), 'updater.log')
}

/** linux 升级日志路径 */
export function getLinuxUpdaterLogPath(): string {
  return path.join(getUpdateDir(), 'updater-linux.log')
}

/** win wrapper cmd 脚本路径（批次 2；与 mac/linux 脚本同入清理矩阵） */
export function getWinUpdaterScriptPath(): string {
  return path.join(getUpdateDir(), 'updater.cmd')
}

/** win wrapper 日志路径（批次 2；与 mac/linux 日志同入 m14 归档/删除策略） */
export function getWinUpdaterLogPath(): string {
  return path.join(getUpdateDir(), 'updater-win.log')
}

/** 升级错误日志路径（JSONL 格式，D7） */
export function getUpdateErrorLog(): string {
  return path.join(getUpdateDir(), 'update-error.log')
}

/**
 * 升级脚本 PID 文件（批次 5 互斥 §3.7.1）。
 *
 * 读写两端共用此路径函数，避免路径双写漂移：
 * - 写侧：mac/linux 由 updater 脚本模板自写 `$$`（`$(dirname "{{RESULT_PATH}}")/updater.pid`，
 *   与升级工作目录同目录）；win 由 platform-updater 在 spawn 后写 `child.pid`（#13）
 * - 读侧：update-self-healer 的存活探测（含 PID 复用加固与死 PID 自愈清理）
 *
 * [HISTORICAL] 写侧分散在 shell 模板与 TS 两处，但路径必须唯一——此前 mac 模板按
 * `dirname(RESULT_PATH)` 推导、self-healer 按升级工作目录推导，两者恰好等价
 * （update-result.json 就在升级工作目录下），抽出函数把这个巧合固化。
 */
export function getUpdaterPidFile(): string {
  return path.join(getUpdateDir(), 'updater.pid')
}
