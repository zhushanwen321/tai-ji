/**
 * runtime 组合根 argv 解析（remote-access D9）：自 index.ts 提取的独立纯函数模块。
 * 提取原因：index.ts import 即执行 main() 不可直测（组合根先例——agent-settled-fanout
 * 同款），argv 解析的 `=` 值形态语义（路径含 `=` 不得截断）需要单测锚定。
 *
 * 每个 flag 支持双形态：`--flag value`（空格分隔）与 `--flag=value`。`=` 形态取值
 * **按首个 = 切分**（slice 掉 `--flag=` 前缀，取余下全部）：路径可含 `=` 字符
 * （如 `--mobile-dist=/tmp/a=b/dist`），旧的 split('=')[1] 写法会在路径内 `=` 处截断
 * （code-harden P2 修复）。
 *
 * 非法 `--port` 值 throw（消息与原实现一致）：组合根包装 console.error +
 * process.exit(1)，保持启动期 fail-fast 语义（组合根退出决策不进本模块，可测性）。
 */
import { BASE_PORT, MAX_PORT } from '@taiji/shared'

/** `--flag=value` 形态取值：按首个 = 切分，取 = 后全部（路径含 = 不截断）。 */
function valueAfterEquals(arg: string, flag: string): string {
  return arg.slice(flag.length + 1)
}

/** 解析并校验 `--flag value` / `--flag=value` 双形态的整数值（非法 throw）。 */
function parseIntArg(value: string, flag: string): number {
  const parsed = parseInt(value, 10)
  if (isNaN(parsed)) {
    throw new Error(`[runtime] invalid --${flag} value: ${value}`)
  }
  return parsed
}

/**
 * 解析 runtime 启动 argv（调用方已剥 `process.argv.slice(2)` 的 node/script 前缀）。
 * 未出现的 flag 取缺省：port = BASE_PORT + TAIJI_AGENT_PORT_OFFSET env 偏移。
 * 返回类型由实现推导（单消费方组合根，无独立接口——Rule of Three）。
 */
export function parseRuntimeArgs(argv: string[]) {
  const portOffset = Math.max(0, Math.min(parseInt(process.env.TAIJI_AGENT_PORT_OFFSET ?? '0', 10) || 0, MAX_PORT - BASE_PORT))
  // --remote-access flag 存在即开（remote-access D9，argv 判据 ambient 免疫）；
  // --mobile-dist=<path> 静态托管消费归 U1.1（remote-access D3）。
  let port = BASE_PORT + portOffset
  let projectRoot: string | undefined
  let builtinPluginsDir: string | undefined
  let remoteAccess = false
  let mobileDist: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' && i + 1 < argv.length) {
      port = parseIntArg(argv[i + 1], 'port')
    } else if (arg.startsWith('--port=')) {
      port = parseIntArg(valueAfterEquals(arg, '--port'), 'port')
    } else if (arg === '--project-root' && i + 1 < argv.length) {
      projectRoot = argv[i + 1]
    } else if (arg.startsWith('--project-root=')) {
      projectRoot = valueAfterEquals(arg, '--project-root')
    } else if (arg === '--builtin-plugins-dir' && i + 1 < argv.length) {
      builtinPluginsDir = argv[i + 1]
    } else if (arg.startsWith('--builtin-plugins-dir=')) {
      builtinPluginsDir = valueAfterEquals(arg, '--builtin-plugins-dir')
    } else if (arg === '--remote-access') {
      // 布尔 flag（remote-access D9）：出现即开，supervisor 按配置 enabled 拼参（U1.2）。
      remoteAccess = true
    } else if (arg === '--mobile-dist' && i + 1 < argv.length) {
      mobileDist = argv[i + 1]
    } else if (arg.startsWith('--mobile-dist=')) {
      mobileDist = valueAfterEquals(arg, '--mobile-dist')
    }
  }
  return { port, projectRoot, builtinPluginsDir, remoteAccess, mobileDist
  }
}
