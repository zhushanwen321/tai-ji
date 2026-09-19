// src/infra/pi/argv-redact.ts
//
// argv 日志脱敏共享纯函数（唯一实现；两处 argv 回显调用点 import）：
//   ① rpc-client.ts spawn 日志（`[rpc] spawning pi:` 行）；
//   ② reap-orphan-pi.ts 的 argv 摘要 → crash journal 的 `detailDigest`。
//
// 设计来源：`.tmp/tech-design/mode-system-composer-density.md` §7.2「argv 日志脱敏」、
// §7.6 写入面（runtime 日志的两条 argv 回显）与探针 P15。只堵一条等于没堵——本函数是
// 两处唯一的遮蔽实现，禁止调用点各自复制逻辑。
//
// 规则（设计 §7.2 逐条）：
// - **只遮蔽「值型 flag」的值**（`--system-prompt <value>` → `--system-prompt <N chars>`），
//   其余 token 原样保留——诊断信息（`--mode rpc` / `--no-extensions` / `--extension <path>`，
//   以及 reap 侧 `detailDigest` 里 `ppid=1` / `spawn marker list` 等由调用点拼装的串）不得
//   被打掉，否则排障与既有断言（reap-orphan-pi.journal.test.ts）会同时失效；
// - **按词法/索引遮蔽，不做全局字符串替换**：值里恰好出现某个 flag 字面量、甚至值本身
//   就是 flag 名时，不得被当成 flag——数组形态按索引取值，字符串形态按 token 顺序扫描；
// - 兼容 `--flag value`（空格分隔）与 `--flag=value`（等号；防御性覆盖）两种形态；
// - 换行归一（argv 值里的 `\n` 直出会把一行日志变多行）+ 长度封顶（防单行撑爆日志）。
//
// 遮蔽 flag 选择：设计要求的两个提示词通道 `--system-prompt` / `--append-system-prompt`——
// 它们的值是用户可写的系统提示词正文（上限 16000 字符），是本次新增的泄露面。其余值型 flag
// （`--extension` / `--skill` / `--model` / `--tools` …）的值是路径/模型名/工具名等诊断信息，
// 按「只蔽值、其余保留」的规格**不**纳入——纳入会让排障所需的 argv 头部不可读。

/** 遮蔽后的默认长度封顶（字符）：脱敏后行通常已很短，此值只兜底极端 argv。 */
export const ARGV_REDACT_MAX = 2000

/** 需遮蔽「值」的值型 flag（设计 §7.2 指定两个提示词通道）。 */
const REDACTED_VALUE_FLAGS: readonly string[] = ['--system-prompt', '--append-system-prompt']

/**
 * 字符串形态扫描时的 flag 边界集（pi 两模板已知 flag 的并集）。
 *
 * 为什么不用「任何 `--` 开头 token」：提示词正文（markdown 列表、命令行示例）本身常含
 * `-` / `--` 开头的文本，用宽判据会把值中途截断导致正文泄漏；已知 flag 集合里的 token 才是
 * 真正的 argv 边界。集合漂移的失败方向是「把后续诊断 token 一并吞进值」（过度遮蔽，不是泄漏），
 * 可接受——pi 新增 argv flag 时按需在此补登记（主 agent 模板见 packages/pi-rpc/src/spawn-args.ts）。
 */
const ARGV_FLAG_BOUNDARY: ReadonlySet<string> = new Set([
  '--mode',
  '--no-extensions',
  '--approve',
  '--model',
  '--system-prompt',
  '--append-system-prompt',
  '--skill',
  '--extension',
  '--tools',
  '--exclude-tools',
  '--no-tools',
  '--no-skills',
  '--no-context-files',
  '--thinking',
  '--session-dir',
  '--session',
  '--fork',
])

/** 遮蔽占位：`<N chars>`（N = 被遮蔽值的字符数）。 */
function placeholder(value: string): string {
  return `<${value.length} chars>`
}

/** 长度封顶（超出截断并加省略号），复用既有 argv 摘要的「尾部 …」形态。 */
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

/**
 * token 是否命中需遮蔽的值型 flag。
 * 返回 `inlineValue` 非 null = 等号形态 `--flag=value`（值已随 token 给出）；
 * 返回 `inlineValue === null` = 空格形态（值在下一个 token）。
 */
function matchRedactedFlag(token: string): { flag: string; inlineValue: string | null } | null {
  for (const flag of REDACTED_VALUE_FLAGS) {
    if (token === flag) return { flag, inlineValue: null }
    if (token.startsWith(`${flag}=`)) return { flag, inlineValue: token.slice(flag.length + 1) }
  }
  return null
}

/** 字符串形态的边界判定：token 是已知 flag，或其等号形态。 */
function isFlagBoundary(token: string): boolean {
  if (ARGV_FLAG_BOUNDARY.has(token)) return true
  for (const flag of ARGV_FLAG_BOUNDARY) {
    if (token.startsWith(`${flag}=`)) return true
  }
  return false
}

/**
 * argv 数组 → 已脱敏、已归一、已封顶的单行日志串（rpc-client spawn 日志消费）。
 *
 * 按索引遮蔽（不做全局替换）：第 i 个 token 命中值型 flag 时，仅替换第 i+1 个 token 的值。
 */
export function redactArgv(args: readonly string[], maxLength: number = ARGV_REDACT_MAX): string {
  const masked: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    const matched = matchRedactedFlag(token)
    if (!matched) {
      masked.push(token)
      continue
    }
    if (matched.inlineValue !== null) {
      // 等号形态：值内联在 token 里，直接替换为占位。
      masked.push(matched.flag, placeholder(matched.inlineValue))
      continue
    }
    if (i + 1 < args.length) {
      // 空格形态：遮蔽紧随其后的单个 argv 值。
      masked.push(matched.flag, placeholder(args[i + 1]))
      i += 1
      continue
    }
    masked.push(matched.flag)
  }
  return truncate(masked.join(' '), maxLength)
}

/**
 * 命令行原文（ps `command` 列）→ 已脱敏、已归一、已封顶的单行日志串
 * （reap-orphan-pi 的 argv 摘要消费）。
 *
 * 与数组形态的差异：ps 输出的 argv 值不保留元素边界（含空格的值被拆成多个 token），
 * 故按「已知 flag 边界」吸收后续非边界 token 作为同一个值——否则提示词正文会从第二个
 * token 起继续泄漏。值字符数按吸收 token 以单空格重连计（ps 本身即以单空格连接 argv）。
 *
 * 先脱敏再封顶：若先截断，值会在遮蔽前被切断，截断窗口内仍是正文（设计 §7.2 指出
 * `reap-orphan-pi` 的 200 字符窗口正是这样泄露提示词开头的）。
 */
export function redactArgvLine(command: string, maxLength: number = ARGV_REDACT_MAX): string {
  // 换行归一：ps 原样输出 argv 值里的 \n，直出会把一行日志变多行。
  const tokens = command.replace(/[\r\n]+/g, ' ').split(/\s+/).filter((token) => token.length > 0)
  const masked: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const matched = matchRedactedFlag(tokens[i])
    if (!matched) {
      masked.push(tokens[i])
      continue
    }
    const valueParts: string[] = []
    if (matched.inlineValue !== null) valueParts.push(matched.inlineValue)
    let j = i + 1
    while (j < tokens.length && !isFlagBoundary(tokens[j])) {
      valueParts.push(tokens[j])
      j += 1
    }
    masked.push(matched.flag, placeholder(valueParts.join(' ')))
    i = j - 1
  }
  return truncate(masked.join(' '), maxLength)
}
