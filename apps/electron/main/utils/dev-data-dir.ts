/**
 * dev 模式数据目录「受控采信」解析（纯函数，R-13 修复）。
 *
 * 判定序（main.ts isDev 块唯一解析入口）：
 *   1. TAIJI_E2E === '1' 且外部值非空 → 采信外部值（e2e 受控装配豁免，原样保留——
 *      launch-app.ts / launch-app-real.ts 的 mkdtemp 隔离目录不在 ~/.taiji-dev 树内，
 *      属受控测试进程的注入意图，不是「宿主 shell 泄漏」场景）。
 *   2. 外部值存在且 path.resolve 归一后位于 ~/.taiji-dev 目录树内（含树根本身）→
 *      采信归一后的绝对路径（装配器 dev-instance.mjs 注入的
 *      ~/.taiji-dev/instances/<worktree> per-worktree 实例目录，多 worktree 并行
 *      dev 的数据隔离权威来源）。
 *   3. 其余一律钉死回 ~/.taiji-dev：未设值 / 泄漏形态（~/.taiji 等树外路径）/
 *      词法逃逸形态（~/.taiji-dev/../.taiji——resolve 消解 .. 后已不在树内）。
 *
 * [HISTORICAL] 2026-09-08 Gate B 泄漏事故：宿主 shell 的
 * TAIJI_AGENT_DATA_DIR=/Users/<user>/.taiji 泄漏进 dev Electron，旧实现
 * `env ?? ~/.taiji-dev` 只在 undefined 兜底、泄漏值被采信，dev app 整个跑在
 * 用户 prod 数据目录上。本函数保留该防线语义（树外一律拒绝），仅对树内
 * 实例目录放开采信（原无条件钉死使装配器实例层被静默覆盖，全部 dev 实例
 * 共享 ~/.taiji-dev → Electron 单实例锁互踢，R-13）。
 *
 * 包含判定用 path.resolve + sep 边界（resolve 消解 ../ 与重复分隔符后再判，
 * 纯词法、不做 fs realpath——env 泄漏威胁模型是路径值本身，symlink 越界不在面内）。
 *
 * 依赖方向：无下游（纯函数，node:path）；行为矩阵守护 = main/test/dev-data-dir.test.ts，
 * main.ts 接线守护 = main/test/main-dev-datadir-pin.test.ts。
 */
import path from 'node:path'

/**
 * 解析 dev 模式的 taiji 数据目录（main.ts isDev 块调用）。
 *
 * @param env 进程 env（测试注入；读 TAIJI_AGENT_DATA_DIR / TAIJI_E2E）
 * @param homedirPath 用户 home（测试注入；缺省调用方传 os.homedir()）
 * @returns 最终数据目录绝对路径（调用方写回 process.env.TAIJI_AGENT_DATA_DIR）
 */
export function resolveDevDataDir(env: NodeJS.ProcessEnv, homedirPath: string): string {
  const external = env.TAIJI_AGENT_DATA_DIR
  const fallback = path.join(homedirPath, '.taiji-dev')
  if (env.TAIJI_E2E === '1' && external) return external
  if (external) {
    const resolved = path.resolve(external)
    if (resolved === fallback || resolved.startsWith(fallback + path.sep)) return resolved
  }
  return fallback
}
