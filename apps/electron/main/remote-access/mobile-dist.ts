/**
 * mobile dist 绝对路径解析（remote-access D3）。
 *
 * 路径知识单侧持有：main 按运行环境解析绝对路径后经 argv `--mobile-dist=<path>`
 * 拼给 runtime，runtime 只消费不探测环境形态（D3 被否⑥：双侧持有路径知识是
 * pass-through 变体）。
 *
 * - dev（app 未打包）：`<仓库根>/packages/mobile-renderer/dist`（vite outDir 唯一输出；
 *   appPath = apps/electron，仓库根相对其 `../..`，与 process-control dev 分支的
 *   repoRoot 推导同构）；
 * - prod（打包态）：`<resources>/mobile-dist`（electron-builder extraResources 复制目标，
 *   与 builder.yml 的 `to: mobile-dist` 条目一致——打包后位于 process.resourcesPath 直下）。
 *
 * resolveMobileDistPath 为纯函数（运行环境经参数注入），独立可测；
 * resolveMobileDistEnv 是运行环境三元组的唯一工厂（electron app 单点读取）。
 */
import { join } from 'node:path'
import { app } from 'electron'

/** 运行环境判别输入（resolveMobileDistEnv 产出 / 测试注入）。 */
export interface MobileDistEnv {
  /** 打包态（app.isPackaged） */
  isPackaged: boolean
  /** Electron resources 目录（打包态 = process.resourcesPath） */
  resourcesPath: string
  /** 应用目录（app.getAppPath()；dev 形态 = apps/electron） */
  appPath: string
}

/**
 * electron app 注入面（resolveMobileDistEnv 的读取源；缺省绑 electron app，
 * 测试可注入桩——对齐 remote-access store dataDir 注入先例，保住可测性）。
 * resourcesPath 不在注入面：它是 process 属性而非 app 属性，恒直读
 * process.resourcesPath（与两消费点原取法逐字段一致）。
 */
export interface MobileDistAppSource {
  /** 打包态（app.isPackaged） */
  readonly isPackaged: boolean
  /** 应用目录（app.getAppPath()；dev 形态 = apps/electron） */
  getAppPath(): string
}

/**
 * 运行环境三元组工厂：{isPackaged, resourcesPath, appPath} 从 electron app 统一推导。
 *
 * 消费点 = spawnRuntimeProcess（argv 拼参）与 bridge isMobileDistReady（面板点测）
 * ——三元组取法曾两处各自内联（漂移 = spawn 与面板点测对同一 dist 判定不一致），
 * 工厂收口为单点；三元组语义与 repoRoot 无关（两消费点的 repoRoot 概念域不同，
 * 不在此合并）。
 */
export function resolveMobileDistEnv(appSource: MobileDistAppSource = app): MobileDistEnv {
  return {
    isPackaged: appSource.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: appSource.getAppPath(),
  }
}

/**
 * 解析移动壳 dist 绝对路径。
 *
 * @param env 运行环境（isPackaged / resourcesPath / appPath）
 */
export function resolveMobileDistPath(env: MobileDistEnv): string {
  if (env.isPackaged) {
    // 'mobile-dist' 字面量必须与 electron-builder.yml extraResources 的 `to: mobile-dist`
    // 一致（builder.yml 是该目标名的登记处——YAML 无法 import，两侧一致性靠本注释指认；
    // 漂移 = 打包产物找不到、E5 禁用静态托管面）。
    return join(env.resourcesPath, 'mobile-dist')
  }
  const repoRoot = join(env.appPath, '..', '..')
  return join(repoRoot, 'packages', 'mobile-renderer', 'dist')
}
