/**
 * MF-1 fixture：在隔离子进程中调用真实 initSandbox，验证 process.kill / process.ppid 防护。
 *
 * 为什么是独立 fixture 而非 in-process 单测：initSandbox 会修改全局 process.kill /
 * process.ppid / process.env / Module._resolveFilename。在 vitest worker 内直接调用会
 * 污染同 worker 的所有后续测试（vi.resetModules 不隔离全局 process 变更）。此处经
 * `child_process.fork({ execArgv: ['--import','tsx'] })` 在独立 CJS 进程中执行，进程退出
 * 即丢弃全部污染，无需 restore（Object.defineProperty(process,'ppid') 在部分 Node 版本
 * 不可逆，故采用「进程丢弃」而非「restore」策略）。
 *
 * 为什么是 .cjs：initSandbox 内部用 require('node:module')（CJS 构造，生产环境经 tsup
 * 打包为 CJS Worker/子进程入口）。.ts fixture 经 tsx 走 ESM，require 在 ESM 作用域不可用。
 * .cjs fixture 经 tsx 的 CJS hook 加载 .ts 源码，require 可用且与生产行为一致。
 *
 * 协议：向 stdout 输出一行 JSON（GuardResult），exit 0。
 */
const { initSandbox } = require('../../src/services/plugin-service/plugin-bootstrap.ts')

const result = {
  killBlocked: false,
  killErrorCode: undefined,
  ppidMasked: false,
  ppidValue: undefined,
}

// 调用真实 initSandbox（全局污染随本进程退出而丢弃）
initSandbox('/fake/plugin-dir')

// 断言 1: process.kill 被封堵 → 抛 PERMISSION_DENIED
// MF-2 防护的 DoS 向量：sandbox 插件 process.kill(process.ppid,'SIGKILL') 崩溃宿主 runtime。
// override 无条件抛错，参数不触发真实 kill，故用任意参数安全验证。
try {
  process.kill(0, 'SIGKILL')
  result.killBlocked = false // 未抛 = 防护失效
} catch (e) {
  result.killBlocked = true
  result.killErrorCode = e && e.code
}

// 断言 2: process.ppid 被屏蔽 → undefined（防 sandbox 插件定位父进程 PID）
result.ppidMasked = process.ppid === undefined
result.ppidValue = process.ppid === undefined ? null : process.ppid

process.stdout.write(JSON.stringify(result))
