/**
 * shared/ignore-parser.ts — .gitignore 规则编译 + 路径匹配纯函数（⑤code-arch §3，#1 D-013）
 *
 * 纯函数范式（D-013：仿 git-status-parser 豁免，不包 port）。放 shared 非 infra——纯函数无 IO/无外部依赖。
 * FileService 经 IFileExecutor.readFile 读 .gitignore 内容（IO 走 port），再调本纯函数匹配（计算走 shared）。
 *
 * 双模式（D-020）：matchPath 纯函数本身不变。FileService 编排层分双模式——
 *   默认隐藏（matchPath=true 的节点移除）/ 显示模式（保留 + 标 ignored=true）。
 *
 * 接线层级：[叶子] 纯函数。
 * 不变式：无 node:fs import（AC-1.3 grep 验证）；无外部依赖；不 import any（用具体类型）。
 */

/**
 * ignore 规则匹配器（编译后的中间表示）。
 * 不暴露内部结构，外部只通过 matchPath 使用。
 */
export interface IgnoreMatcher {
  /** 内部规则集（实现细节，外部不访问） */
  readonly rules: IgnoreRule[]
}

/** 单条 ignore 规则（.gitignore 语法子集） */
export interface IgnoreRule {
  /** 原始 pattern */
  readonly pattern: string
  /** 是否取反（! 前缀） */
  readonly negated: boolean
  /** 是否仅匹配目录（/ 后缀） */
  readonly dirOnly: boolean
  /** 是否锚定到根（含 / 或 * 通配） */
  readonly anchored: boolean
  /** 编译后的正则 */
  readonly regex: RegExp
}

/**
 * 编译 .gitignore 内容为匹配器（纯函数，不读文件）。
 *
 * 支持的 .gitignore 语法子集（D-013）：
 * - 空行/注释（#）→ 跳过
 * - ! 取反
 * - / 末尾 → 仅目录
 * - / 开头或含 / → 锚定到根
 * - * 单层通配、** 多层通配
 * - 普通名字 → 匹配任意层级
 *
 * @param content .gitignore 文件内容
 * @returns 匹配器（content 为空 → 空 matcher，matchPath 永远返回 false）
 */
export function compileIgnoreRules(content: string): IgnoreMatcher {
  const rules: IgnoreRule[] = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => compileRule(line))
  return { rules }
}

/**
 * 编译单条规则为 IgnoreRule。
 * 规范化：去掉两端空白；处理 ! 取反前缀；处理末尾 / 目录标志；处理锚定。
 */
function compileRule(rawLine: string): IgnoreRule {
  let line = rawLine
  // 1. 取反标志（! 前缀）
  const negated = line.startsWith('!')
  if (negated) {
    line = line.slice(1)
  }
  // 2. 目录后缀（末尾 /）→ 仅匹配目录
  const dirOnly = line.endsWith('/')
  if (dirOnly) {
    line = line.slice(0, -1)
  }
  // 3. 锚定判定：
  //    - 开头 / → 锚定根，去掉前导 /
  //    - 内部含 /（非末尾）→ 锚定根（相对根路径）
  let anchored = false
  if (line.startsWith('/')) {
    anchored = true
    line = line.slice(1)
  } else if (line.includes('/')) {
    anchored = true
  }
  // 4. 编译为正则
  const regex = globToRegex(line, anchored)
  return { pattern: rawLine, negated, dirOnly, anchored, regex }
}

/** 正则元字符集合（表驱动）：命中则转义输出，未命中原样拼接——与原逐 case 转义逐字节等价。 */
const REGEX_META_CHARS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

/**
 * 将 gitignore glob pattern 转为 RegExp。
 *
 * @param pattern 已去除取反前缀/目录后缀/锚定前导斜杠的 pattern
 * @param anchored 是否锚定到根（true → 从根开始匹配；false → 匹配任意路径段开始）
 *
 * 转义规则（伪代码，注意勿在块注释中出现斜杠星号闭合序列）：
 * - 双星号加斜杠 → (.*  斜杠)?（零或多层目录前缀）
 * - 斜杠加双星号 → ( 斜杠 .*)?$（末尾多层）
 * - 双星号 → .*（跨目录）
 * - 单星号 → [^ 斜杠]*（单层，不跨分隔符）
 * - 问号 → [^ 斜杠]（单字符）
 * - 其余正则元字符转义（REGEX_META_CHARS 表驱动）
 */
function globToRegex(pattern: string, anchored: boolean): RegExp {
  // glob 多字符 token 的字符长度（用于游标偏移与推进）
  const DOUBLE_STAR_LEN = 2 // '**' 双星通配占 2 字符
  const DOUBLE_STAR_SLASH_LEN = 3 // '**/' 双星加斜杠占 3 字符
  // 逐字符构建正则源（避免 replace 链顺序问题：** 必须在 * 之前处理）
  let regexSrc = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    // ** 匹配（跨目录）
    if (ch === '*' && pattern[i + 1] === '*') {
      // **/ → 匹配零或多个目录前缀（含末尾 /）
      if (pattern[i + DOUBLE_STAR_LEN] === '/') {
        regexSrc += '(?:.*/)?'
        i += DOUBLE_STAR_SLASH_LEN
        continue
      }
      // /** 末尾 → 整段剩余
      regexSrc += '.*'
      i += DOUBLE_STAR_LEN
      continue
    }
    switch (ch) {
      case '*':
        regexSrc += '[^/]*'
        break
      case '?':
        regexSrc += '[^/]'
        break
      default:
        // 正则元字符转义（'*'/'?' 已在上方分支与 '**' 拦截中处理，不会落入此处）
        regexSrc += REGEX_META_CHARS.has(ch) ? '\\' + ch : ch
    }
    i += 1
  }
  // 锚定：anchored → 从根（^pattern），非锚定 → 匹配任意路径段开始（^|.*/）
  // 用 (?:^|/) 作为前缀，使非锚定规则能匹配 'node_modules/pkg' 中的 'node_modules' 段。
  const prefix = anchored ? '^' : '(?:^|/)'
  const suffix = '$'
  return new RegExp(prefix + regexSrc + suffix)
}

/**
 * 判断路径是否被 ignore 规则匹配（纯函数）。
 *
 * @param matcher 编译后的匹配器
 * @param path 待检测路径（相对路径，不含前导斜杠，如 'src/index.ts'）
 * @returns 最后一条匹配规则是正向（非取反）→ true（被忽略）
 *
 * 语义对齐 git：多条规则按顺序求值，最后匹配的规则决定结果（取反覆盖正向）。
 *
 * 匹配策略（gitignore 核心语义）：
 * - 对路径的所有祖先前缀（含自身）逐一测试规则。
 *   例：'a/b/c' → 测试 'a/b/c'、'a/b'、'a'。
 * - 某规则匹配某祖先前缀 X：
 *   - 非 dirOnly 规则：X == 路径（文件/目录自身命中）或 X 是路径的严格前缀（目录命中，其下所有内容被忽略）→ 匹配。
 *   - dirOnly 规则：仅当 X 是路径的严格前缀（X 是目录，路径在其下），或 X == 路径且路径以分隔符结尾（目录自身）。
 *   （gitignore: `foo` 匹配文件或目录；`foo/` 仅匹配目录及其内容。）
 */
export function matchPath(matcher: IgnoreMatcher, path: string): boolean {
  // 规范化路径：去前导斜杠、去末尾分隔符
  const normalized = normalizePath(path)
  // 短路径直通（D7-2）：无 '/' 的路径只有自身一个前缀（allPrefixes('x') ≡ ['x']），
  // 跳过 split/构建数组，直接以 [path] 测试——文件树顶层 entry 全是短路径，省 split 开销。
  // 空串守卫（W24 审查 A-2）：''/根路径（'/' 归一化后为 ''）必须保持旧 allPrefixes 语义
  // （返回 [] → 恒 false），不能落入直通分支——否则 `*` 规则下 [''] 前缀命中 regex 且
  // isSelf(''==='') 成立，被错误判为 ignored（探针证实旧版 false / 新版 true 的漂移）。
  const prefixes = normalized !== '' && !normalized.includes('/') ? [normalized] : allPrefixes(normalized)
  let ignored = false
  for (const rule of matcher.rules) {
    // 任一祖先前缀命中该规则 → 该规则对整条路径生效
    if (prefixes.some((prefix) => ruleMatchesPath(rule, prefix, normalized))) {
      ignored = !rule.negated
    }
  }
  return ignored
}

/**
 * 判断单条规则是否对「prefix 命中 → 整条 path 被忽略」成立。
 *
 * @param rule 规则
 * @param prefix 当前测试的祖先前缀（path 的前缀之一）
 * @param path 完整路径（规范化后）
 *
 * 规则：
 * - regex 必须匹配 prefix（锚定/非锚定由 regex 内的 prefix 处理）。
 * - 非 dirOnly：prefix == path（命中自身）或 prefix 是 path 的目录前缀（prefix + '/' 是 path 前缀）→ 命中。
 * - dirOnly：仅当 prefix 是 path 的目录前缀（prefix + '/' 是 path 前缀）→ 命中（目录内容）。
 *   prefix == path 时不命中（dirOnly 不匹配同名文件，build/ 不匹配名为 build 的文件）。
 */
function ruleMatchesPath(rule: IgnoreRule, prefix: string, path: string): boolean {
  if (!rule.regex.test(prefix)) return false
  // prefix 命中 regex 后，判断 prefix 是否覆盖 path：
  // - prefix == path：规则命中路径自身（文件/目录）
  // - prefix 是 path 的祖先目录：prefix 下所有内容被忽略
  const isSelf = prefix === path
  const isAncestorDir = path.startsWith(prefix + '/')
  if (rule.dirOnly) {
    // 目录规则：仅匹配目录（祖先目录覆盖），不匹配同名文件（isSelf 不算）
    return isAncestorDir
  }
  return isSelf || isAncestorDir
}

/**
 * 规范化路径：去前导/末尾斜杠与多余分隔符，统一为正斜杠。
 */
function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/')
  p = p.replace(/^\/+/, '').replace(/\/+$/, '')
  return p
}

/**
 * 生成路径的所有祖先前缀（含自身），从深到浅。
 * 例：'a/b/c' → ['a/b/c', 'a/b', 'a']；'x' → ['x']。
 */
function allPrefixes(path: string): string[] {
  const segments = path.split('/').filter((s) => s.length > 0)
  const result: string[] = []
  for (let end = segments.length; end >= 1; end -= 1) {
    result.push(segments.slice(0, end).join('/'))
  }
  return result
}
