/**
 * sandbox 子进程 ESM loader 的 execArgv 解析（从 plugin-service.ts 迁出，
 * max-lines 拆分——逻辑不变）。
 */
import { resolveAndValidateFile } from './plugin-host.js'

/**
 * 从 execArgv 中提取 tsx 注入的 --import 值（dev 模式判定）。
 *
 * tsx 运行时（`npx tsx src/index.ts`）向 node 注入（实测 Node 24 + tsx）：
 *   ['--require', '<...>/node_modules/tsx/dist/preflight.cjs',
 *    '--import', 'file://<...>/node_modules/tsx/dist/loader.mjs']
 * 判定条件：--import 的值含 `node_modules/tsx/`（同时覆盖 file:// URL 与裸路径、
 * npm/pnpm 安装布局）。支持 `--import <value>` 与 `--import=<value>` 两种形态。
 */
export function findTsxImportArg(execArgv: readonly string[]): string | undefined {
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]
    if (arg === '--import' && i + 1 < execArgv.length) {
      const value = execArgv[i + 1]
      if (value.includes('node_modules/tsx/')) return value
    } else if (arg.startsWith('--import=')) {
      const value = arg.slice('--import='.length)
      if (value.includes('node_modules/tsx/')) return value
    }
  }
  return undefined
}

/**
 * 解析 sandbox 子进程 ESM loader 路径，构建 execArgv（--import 注入）。
 *
 * loader（plugin-esm-loader.cjs）经 execArgv 注入 fork 子进程，注册 ESM resolve
 * hook 封堵 node:* 内置模块 + 越界路径 import（重构 3：消除 ESM import 绕过）。
 * 与 plugin-bootstrap.cjs 同目录约定，路径经 resolveAndValidateFile 动态推导
 * （AGENTS.md #12：打包后 __dirname → app.asar.unpacked/dist/runtime/，
 * dev → src/services/plugin-service/）。
 *
 * F1（dev sandbox fork 修复）：主进程运行于 tsx 时（execArgv 含 tsx 的 --import），
 * 把该项追加到 fork execArgv 末尾。fork 默认不继承父进程 execArgv（C3），子进程
 * 入口 plugin-bootstrap-process.ts 内部 `import './plugin-bootstrap.js'`（TS ESM
 * 风格后缀）依赖 tsx loader 的 resolve hook 做 .js→.ts remap——esm-loader 只透传
 * 不 remap，Node 原生 resolver 找不到 .js 文件 → ERR_MODULE_NOT_FOUND，dev 模式
 * sandbox 插件激活必炸。顺序约束：esm-loader 必须在前（fork 边界 MF-1 断言
 * execArgv 含 --import，且 Node hooks 链后注册先调用——tsx remap 后的路径仍会流经
 * esm-loader 的沙箱边界检查，不破坏封堵语义）。
 *
 * MF-1（fail-closed 分层）：loader 缺失时本函数返回 undefined（不阻塞 runtime 启动），
 * 真正的 fail-closed 在 PluginHostProcess.createProcess 的 fork 边界——sandbox fork 前
 * 断言 execArgv 含 --import，缺失即 throw（拒绝创建无 ESM 防护的 sandbox 进程）。
 * 故 loader 缺失时 runtime 仍能启动（trusted 插件正常），仅 sandbox（external）插件激活
 * 会被拒。loader 存在性另由 postbuild-validate.sh + validate-runtime-bundle.sh CI 强制校验。
 */
export function resolveEsmLoaderExecArgv(): string[] | undefined {
  try {
    const loaderPath = resolveAndValidateFile('plugin-esm-loader.cjs')
    const execArgv = ['--import', loaderPath]
    const tsxImport = findTsxImportArg(process.execArgv)
    if (tsxImport) {
      execArgv.push('--import', tsxImport)
    }
    return execArgv
  } catch (e: unknown) {
    console.error(
      '[plugin-service] plugin-esm-loader.cjs not found; sandbox ESM guard inactive ' +
      '(sandbox plugin activation will be refused at fork boundary; fix loader packaging before shipping):',
      e,
    )
    return undefined
  }
}
