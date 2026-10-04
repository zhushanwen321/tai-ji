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
 *
 * 兜底（code-harden P2）：未知 `--` flag（如拼错 `--remote-acces`）与已知带值 flag
 * 的缺值形态（如孤立出现在 argv 末尾的 `--port`）此前静默忽略——runtime 以关态/默认
 * 值启动无任何提示。两者均 console.warn 提示，**不 throw 不 reject**（对第三方传参
 * 保持「未知 flag 忽略」的兼容语义，仅补可观测）。
 */
import { BASE_PORT, MAX_PORT } from '@taiji/shared'

/**
 * 带值 flag 描述：各 flag 的双形态解析语义同构（空格形态取 i+1、`=` 形态按首个 =
 * 切分），差异仅在取值入口——port 走整数校验，其余原样字符串。表驱动展开使
 * 解析分支数不随 flag 数量增长（逐 flag if-else 展开曾致圈复杂度 19 > 15 门禁红）。
 */
interface ValueFlagSpec {
  flag: string
  apply: (raw: string) => void
}

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
  const valueFlags: ValueFlagSpec[] = [
    { flag: '--port', apply: (raw) => { port = parseIntArg(raw, 'port') } },
    { flag: '--project-root', apply: (raw) => { projectRoot = raw } },
    { flag: '--builtin-plugins-dir', apply: (raw) => { builtinPluginsDir = raw } },
    { flag: '--mobile-dist', apply: (raw) => { mobileDist = raw } },
  ]
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const spec = valueFlags.find((f) => arg === f.flag || arg.startsWith(`${f.flag}=`))
    if (spec) {
      if (arg !== spec.flag) {
        // `=` 形态：按首个 = 切分，取 = 后全部（路径含 = 不截断，code-harden P2）。
        spec.apply(valueAfterEquals(arg, spec.flag))
      } else if (i + 1 < argv.length) {
        // 空格形态：取后续值。
        spec.apply(argv[i + 1])
      } else {
        // 兜底（code-harden P2）：孤立出现在 argv 末尾缺值 → warn 提示（不 throw）。
        console.warn(`[runtime] ${spec.flag} 缺值（孤立出现在 argv 末尾），已忽略并使用默认值`)
      }
    } else if (arg === '--remote-access') {
      // 布尔 flag（remote-access D9）：出现即开，supervisor 按配置 enabled 拼参（U1.2）。
      remoteAccess = true
    } else if (arg.startsWith('--')) {
      // 兜底分支（code-harden P2）：未知 flag（如拼错 --remote-acces）→ warn 提示。
      // 解析结果不受影响——值不赋、不覆盖、不中断循环，仅补可观测。
      console.warn(`[runtime] unknown flag: ${arg} — 已忽略（不生效）；若为 remote-access 相关请核对拼写`)
    }
  }
  return { port, projectRoot, builtinPluginsDir, remoteAccess, mobileDist
  }
}
