/**
 * 打包模式数据目录「受控采信」解析（纯函数，与 dev-data-dir.ts 镜像对称）。
 *
 * 判定序（main.ts 打包分支唯一解析入口）：
 *   1. 外部值存在且 path.resolve 归一后位于 ~/.taiji 目录树内（含树根本身）→
 *      采信归一后的绝对路径（prod 自身目录树的合法子路径）。
 *   2. 其余一律钉死回 ~/.taiji：未设值 / 树外泄漏形态（宿主 shell 残留的
 *      ~/.taiji-dev/... 等 dev 值 / 任意路径）。
 *
 * 缺省反转（getDataDir 缺省已改 ~/.taiji-dev）后，本函数是 prod 数据目录的
 * 唯一权威钉死点：打包 main 在启动早期赋值 process.env.TAIJI_AGENT_DATA_DIR，
 * 之后 main→runtime spawn 显式透传；runtime 入口另有交叉断言
 * （TAIJI_AGENT_PACKAGED=1 必带 TAIJI_AGENT_DATA_DIR，缺一 fail-fast）兜住
 * spawn 漏传——两层合起来保证「prod 数据只能被显式声明触达，漏传变响亮报错
 * 而非静默写错目录」。
 *
 * 与 dev 侧差异：无 TAIJI_E2E 豁免——e2e（launch-app*）全部以非打包形态运行
 * （electron 二进制 loadFile 构建产物，app.isPackaged=false，走 dev 分支的
 * 豁免）；打包分支没有已发生的受控注入场景，不加推测性豁免。
 *
 * 包含判定用 path.resolve + sep 边界（resolve 消解 ../ 与重复分隔符后再判，
 * 纯词法、不做 fs realpath——env 泄漏威胁模型是路径值本身，symlink 越界不在面内，
 * 与 dev-data-dir.ts 同一威胁模型）。
 *
 * 大小写盲区（设计内残差）：包含判定不 casefold。大小写不敏感卷（macOS/Windows
 * 默认）上 `~/.TAIJI` 类手滑变体与本函数钉回的 `~/.taiji` 是同一物理目录——钉回
 * 规范根即安全方向，采信变体不产生任何不同结果；Linux 大小写敏感卷上该变体是
 * 树外另一目录，钉回 prod 根正确。若此处 casefold，Linux 上会把真树外目录当
 * prod 树采信，弱化钉死保证，故不做。对照：shared 侧准入守卫
 * （assertNotLeakedProdDataDir）漏判方向是「非 prod 进程写 prod」数据损失，
 * 故该处判定双侧 casefold——两处不对称是有意的（漏判代价不对称）。
 *
 * 依赖方向：无下游（纯函数，node:path）；行为矩阵守护 = main/test/packaged-data-dir.test.ts，
 * main.ts 接线守护 = main/test/main-dev-datadir-pin.test.ts（packaged describe）。
 */
import path from 'node:path'

/**
 * 解析打包模式的 taiji 数据目录（main.ts 打包分支调用）。
 *
 * @param env 进程 env（测试注入；读 TAIJI_AGENT_DATA_DIR）
 * @param homedirPath 用户 home（测试注入；调用方传 os.homedir()）
 * @returns 最终数据目录绝对路径（调用方写回 process.env.TAIJI_AGENT_DATA_DIR）
 */
export function resolvePackagedDataDir(env: NodeJS.ProcessEnv, homedirPath: string): string {
  const external = env.TAIJI_AGENT_DATA_DIR
  const fallback = path.join(homedirPath, '.taiji')
  if (external) {
    const resolved = path.resolve(external)
    if (resolved === fallback || resolved.startsWith(fallback + path.sep)) return resolved
  }
  return fallback
}
