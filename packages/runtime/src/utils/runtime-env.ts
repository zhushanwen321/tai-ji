/**
 * 运行环境判定工具（D18）。
 *
 * - `isPackaged()`：统一 `process.env.TAIJI_AGENT_PACKAGED === '1'` 判定（散落 5 处）。
 * - `spawnDataDirContractViolation()`：缺省反转配套的 spawn 契约校验（组合根入口调用）。
 *
 * 注：`isPackaged()` 读 env，进程生命周期内不变；若调用方需在测试中覆盖，应从构造
 * 参数注入 packaged（如 ExtensionService 已做 `options.packaged ?? isPackaged()`）。
 */

/** 是否运行在打包后的 Electron 应用中（ Resources 目录布局）。 */
export function isPackaged(): boolean {
  return process.env.TAIJI_AGENT_PACKAGED === '1'
}

/**
 * spawn 数据目录契约校验（缺省反转护栏，纯函数供组合根入口调用）。
 *
 * 契约：main 经 process-control spawn runtime 时，TAIJI_AGENT_PACKAGED 与
 * TAIJI_AGENT_DATA_DIR 必须成对注入。打包态却缺 DATA_DIR 必是 spawn 契约破损——
 * 缺省反转（getDataDir 缺省 = ~/.taiji-dev）后，该形态会把 prod 数据静默写进
 * dev 目录（数据错位而非报错），故组合根最早期 fail-fast。
 * 非打包态（裸跑/验证脚本）不适用：正该走缺省落 dev 树。
 *
 * @returns 违规时的报错行（调用方打印后退出）；合规返回 null
 */
export function spawnDataDirContractViolation(env: NodeJS.ProcessEnv): string[] | null {
  if (env.TAIJI_AGENT_PACKAGED !== '1' || env.TAIJI_AGENT_DATA_DIR) return null
  return [
    '[runtime] fatal: TAIJI_AGENT_PACKAGED=1 but TAIJI_AGENT_DATA_DIR missing — spawn contract broken.',
    '  cause   : main must pin the prod data dir (resolvePackagedDataDir) before spawning runtime;',
    '            without it this process would silently write prod data into the fail-safe',
    '            default (~/.taiji-dev) — data misplacement, not a valid run.',
    '  recovery: this is a spawn/packaging bug, not an env config issue — fix the env pair at',
    '            apps/electron/main/supervisor/process-control.ts (TAIJI_AGENT_PACKAGED and',
    '            TAIJI_AGENT_DATA_DIR are injected together).',
  ]
}
