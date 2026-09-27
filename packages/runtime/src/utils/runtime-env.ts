/**
 * 运行环境判定工具（D18）。
 *
 * - `isPackaged()`：统一 `process.env.TAIJI_AGENT_PACKAGED === '1'` 判定（散落 5 处）。
 *
 * 注：`isPackaged()` 读 env，进程生命周期内不变；若调用方需在测试中覆盖，应从构造
 * 参数注入 packaged（如 ExtensionService 已做 `options.packaged ?? isPackaged()`）。
 */

/** 是否运行在打包后的 Electron 应用中（ Resources 目录布局）。 */
export function isPackaged(): boolean {
  return process.env.TAIJI_AGENT_PACKAGED === '1'
}
