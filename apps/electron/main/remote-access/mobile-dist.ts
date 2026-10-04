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
 * 纯函数（运行环境经参数注入），独立可测。
 */
import { join } from 'node:path'

/** 运行环境判别输入（process-control / 测试注入）。 */
export interface MobileDistEnv {
  /** 打包态（app.isPackaged） */
  isPackaged: boolean
  /** Electron resources 目录（打包态 = process.resourcesPath） */
  resourcesPath: string
  /** 应用目录（app.getAppPath()；dev 形态 = apps/electron） */
  appPath: string
}

/** dev 态移动壳 dist 在仓库内的相对段（packages/<pkg>/dist）。 */
const MOBILE_RENDERER_DIST_SEGMENTS = ['packages', 'mobile-renderer', 'dist'] as const

/**
 * prod 态 extraResources 复制目标（相对 resources）。
 * 字面量必须与 electron-builder.yml extraResources 的 `to: mobile-dist` 一致
 * （builder.yml 是该目标名的登记处，两侧漂移 = 打包产物找不到、E5 禁用静态托管面）。
 */
const MOBILE_DIST_RESOURCE_SEGMENTS = ['mobile-dist'] as const

/**
 * 解析移动壳 dist 绝对路径。
 *
 * @param env 运行环境（isPackaged / resourcesPath / appPath）
 */
export function resolveMobileDistPath(env: MobileDistEnv): string {
  if (env.isPackaged) {
    return join(env.resourcesPath, ...MOBILE_DIST_RESOURCE_SEGMENTS)
  }
  const repoRoot = join(env.appPath, '..', '..')
  return join(repoRoot, ...MOBILE_RENDERER_DIST_SEGMENTS)
}
