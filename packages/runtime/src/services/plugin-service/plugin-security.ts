/**
 * Plugin 安全开关（external 安装硬锁）—— §6.6 排期硬锁。
 *
 * [HISTORICAL] 此开关对应 sandbox 真隔离修复进度：
 *
 * 背景：plugin-bootstrap.ts:79 用 `await import()`（ESM 动态导入）加载插件模块，
 * 而 initSandbox 只 patch 了 Module._resolveFilename（CJS require 钩子），ESM 导入
 * 完全绕过该拦截 —— sandbox 名存实亡，external plugin 可 import node:fs 直接
 * 越权访问 fs/child_process/http。在该缺陷修复落地前，external 插件的安装与激活
 * 都是任意代码执行。
 *
 * 联动契约：EXTERNAL_PLUGIN_ENABLED 默认 false（fail-closed）。sandbox 真隔离
 * 修复（消除 plugin-bootstrap.ts:79 的 ESM 绕过）落地时，由修复方在此文件将
 * 常量翻转为 true 并更新本注释。
 *
 * [翻转记录] sandbox 真隔离闭环已全部落地，本常量翻转为 true：
 *   1. sandbox 插件 fork 独立子进程（plugin-host-process.ts，process.execPath +
 *      ELECTRON_RUN_AS_NODE），进程级隔离
 *   2. ESM loader（plugin-esm-loader.cjs）经 execArgv --import 注入子进程，resolve hook
 *      封堵 node:* 内置模块黑名单 + 越界路径 import（重构 3）
 *   3. TAIJI_PLUGIN_SANDBOX_DIR env 注入 fork 子进程（loader initialize() 读此 env 做边界
 *      判定，缺失 fail-closed throw）—— 之前宿主注入的是入口文件路径（<dir>/index.js），
 *      loader 的 filePath.startsWith(sandboxDir + path.sep) 判定要求模块路径以
 *      …/index.js/ 开头，恒 false，边界判定形同虚设（修正后注入 dirname(pluginPath)
 *      目录形态，判界才生效）
 *   4. postbuild-validate.sh 校验 plugin-esm-loader.cjs 产物存在（macOS + Windows）
 * 任一环节回退时须同步把本常量改回 false（external 插件在 sandbox 未就绪时的危险面
 * 不应暴露给任何调用方）。
 */

/** external 插件安装开关。sandbox 真隔离闭环已完成（见上），开启 external 安装。 */
export const EXTERNAL_PLUGIN_ENABLED = true

/** 锁错误码前缀（InstallResult.error 字符串前缀，业务错误码；与 RPC 线协议数值码分层不混用）。 */
export const EXTERNAL_PLUGIN_DISABLED = 'EXTERNAL_PLUGIN_DISABLED'

/** installPlugin 短路返回的完整错误文案。 */
export const EXTERNAL_PLUGIN_DISABLED_MESSAGE =
  'EXTERNAL_PLUGIN_DISABLED: sandbox isolation not yet implemented, external plugin install is locked'
