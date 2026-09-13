/**
 * fs-guard 实现（纯逻辑）——由 test/fs-guard.ts 的 vi.mock 工厂动态 import。
 *
 * 为什么独立成文件且零 `import 'node:fs'`：vi.mock 工厂被 vitest 提升到 setupFiles 模块
 * 顶部执行，引用模块级声明会 TDZ；本文件经工厂动态 import 加载，若顶部再 ESM import
 * node:fs 会触发刚注册的 mock 工厂 → 循环依赖。realpathSync 改经 createRequire 取
 * CJS 原始模块（vi.mock 只拦 ESM import 链），guard 自身不经过自己安装的 wrapper。
 *
 * 语义见 test/fs-guard.ts 文件头（[HISTORICAL] 2026-09-02 会话丢失事故）。
 */
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const realFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')

/** 真实用户数据目录（与 apps/electron/main 的打包态缺省一致，homedir 动态推导）。 */
const REAL_DATA_DIR = resolve(join(homedir(), '.xyz-agent'))

/**
 * 路径的判定形式全集：resolve 形式（逻辑规范化，不解析 symlink）+ realpath 形式
 * （symlink 真身，目标存在时）。双形式必要性（macOS 实测）：os.tmpdir() 返回
 * /var/folders/...，而测试路径经 realpathSync 后是 /private/var/folders/...——
 * 单形式前缀匹配会把合法 tmp fixture 误拦。realpath 形式同时是 symlink 别名的
 * 权威判定面（/tmp/link → ~/.xyz-agent 的真身必须被拒）。
 */
function pathVariants(p: string): string[] {
  const variants = [resolve(p)]
  try {
    variants.push(realFs.realpathSync(p))
  } catch {
    // 目标不存在（mkdir/writeFile 新建场景）的有意降级：resolve 形式参与匹配。创建类的
    // symlink 别名绕过由 AGENTS「禁止绕过 guard」条款约束（删除类目标必然存在，realpath
    // 权威判定覆盖）。void 0 标记非空块（no-empty）。
    void 0
  }
  return [...new Set(variants)]
}

function matchesPrefix(p: string, whitelist: string[]): boolean {
  return whitelist.some((w) => p === w || p.startsWith(w + sep))
}

function whitelistPrefixes(): string[] {
  const raw = [resolve(tmpdir()), resolve(join(homedir(), '.xyz-agent-dev'))]
  if (process.env.XYZ_AGENT_DATA_DIR) raw.push(resolve(process.env.XYZ_AGENT_DATA_DIR))
  const prefixes: string[] = []
  for (const p of raw) {
    prefixes.push(...pathVariants(p))
  }
  return [...new Set(prefixes)]
}

/** 真实数据目录判定形式全集（resolve + realpath，拒绝对 symlink 别名不透明）。 */
function realDataDirVariants(): string[] {
  return pathVariants(REAL_DATA_DIR)
}

/** 路径是否落在真实数据目录内（无条件拒绝区；任一形式命中即拒）。导出供 fs-guard.test.ts 单测。 */
export function isRealDataDir(p: string): boolean {
  const realForms = realDataDirVariants()
  return pathVariants(p).some((v) => matchesPrefix(v, realForms))
}

/** 路径是否允许作为破坏性 fs 操作目标（任一形式落在白名单即放行）。导出供 fs-guard.test.ts 单测。 */
export function isDestructiveAllowed(p: string): boolean {
  if (isRealDataDir(p)) return false
  return pathVariants(p).some((v) => matchesPrefix(v, whitelistPrefixes()))
}

/** 提取参数中的路径形态（string / file URL）；Buffer / fd / options 对象返回 null 跳过。 */
function pathOf(arg: unknown): string | null {
  if (typeof arg === 'string') return resolve(arg)
  if (arg instanceof URL) {
    try {
      return resolve(fileURLToPath(arg))
    } catch {
      return null
    }
  }
  return null
}

function guardPaths(fnName: string, paths: unknown[]): void {
  for (const arg of paths) {
    const p = pathOf(arg)
    if (p === null || isDestructiveAllowed(p)) continue
    throw new Error(
      `[vitest-fs-guard] BLOCKED ${fnName} → ${p}\n` +
        `  破坏性 fs 操作只允许落在白名单目录：${whitelistPrefixes().join(' | ')}\n` +
        `  真实数据目录 ${REAL_DATA_DIR} 无条件禁止（2026-09-02 会话丢失事故防线）。\n` +
        `  修复方向：测试夹具用 mkdtempSync(join(tmpdir(), ...)) 自建自删；确需持久数据目录时` +
        ` 设 XYZ_AGENT_DATA_DIR 指向 dev 目录（~/.xyz-agent-dev），禁止指向 ~/.xyz-agent。`,
    )
  }
}

export const FS_SYNC_FNS = [
  'rmSync', 'unlinkSync', 'rmdirSync', 'renameSync', 'cpSync', 'copyFileSync',
  'mkdirSync', 'writeFileSync', 'appendFileSync', 'truncateSync',
] as const

export const FS_ASYNC_FNS = [
  'rm', 'unlink', 'rmdir', 'rename', 'cp', 'copyFile',
  'mkdir', 'writeFile', 'appendFile', 'truncate',
] as const

/**
 * 写句柄入口函数名（fd/流写路径防线）：破坏名单只拦「直接路径」操作，fd/流形态可绕过
 * ——openSync(path,'w')+writeSync(fd)、callback 版 open(path,'w')、createWriteStream(path)。
 * 写 fd 只能经这些入口产生（Node 无「无 path 造写 fd」的暴露 API），入口校验写 flags
 * 即闭合 writeSync / ftruncate(Sync) 等全部 fd 消费点：fd 是 number，参数层无 path 可
 * 校验，逐点拦只会得到恒放行的假防线；且 O_RDONLY fd 上 ftruncate/write 系统调用必败
 * EINVAL/EBADF（实测），只读句柄无绕过价值。fs/promises 无 ftruncate 导出（实测），
 * FileHandle 写句柄唯一产生点 = promises.open。
 */
export const FS_OPEN_FNS = ['openSync', 'open', 'createWriteStream'] as const

/** promises 侧写句柄入口（open 返回 FileHandle，实例方法不经模块层，入口校验即闭合）。 */
export const FS_PROMISES_OPEN_FNS = ['open'] as const

/**
 * 各 API 的校验参数位：
 * - rename（src 被移走 = 破坏性）：src + dest 双端校验
 * - cp / copyFile（src 只读不破坏）：只校验 dest——src 从包内 fixtures 复制到 tmp 是
 *   标准测试形态（读源无损害，拦 src 会误伤全部 fixture 复制用例）
 * - 其余：只校验首参（次参可能是 string 文件内容，如 writeFileSync(path, data)）
 */
const RENAME_FNS = new Set(['renameSync', 'rename'])
const DEST_ONLY_FNS = new Set(['cpSync', 'cp', 'copyFileSync', 'copyFile'])
/** slice 参数位（具名常量，no-magic-numbers；0/1 在规则默认豁免内）。 */
const TWO_ARGS = 2

/** 对 actual 模块做浅拷贝并替换破坏性函数为 wrapper（读函数原样透传）。 */
export function wrapModule(actual: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const wrapped = { ...actual }
  for (const name of names) {
    const orig = actual[name]
    if (typeof orig !== 'function') continue
    const argSlice = RENAME_FNS.has(name) ? [0, TWO_ARGS] : DEST_ONLY_FNS.has(name) ? [1, TWO_ARGS] : [0, 1]
    wrapped[name] = function (this: unknown, ...args: unknown[]) {
      guardPaths(name, args.slice(argSlice[0], argSlice[1]))
      return (orig as (...a: unknown[]) => unknown).apply(this, args)
    }
  }
  return wrapped
}

/** O_ACCMODE 掩码（O_RDONLY=0 / O_WRONLY=1 / O_RDWR=2）——数字 flags 的写位判定。 */
const O_ACCMODE_MASK = 0o3

/**
 * open 系第二参的写位判定：string flags（'r'/'rs'/'sr' 只读；含 a/w/x/+ 任一为写）、
 * number flags（O_ACCMODE 位非零为写）、object options（取 .flags 同判定）。缺省按
 * 调用方默认——open 系 'r'（只读零开销放行）、createWriteStream 'w'（默认即写，必拦）。
 */
function isWriteOpenArg(arg: unknown, defaultFlags: string): boolean {
  let flags: string | number = defaultFlags
  if (typeof arg === 'string' || typeof arg === 'number') {
    flags = arg
  } else if (arg && typeof arg === 'object') {
    const f = (arg as { flags?: unknown }).flags
    if (typeof f === 'string' || typeof f === 'number') flags = f
  }
  return typeof flags === 'number' ? (flags & O_ACCMODE_MASK) !== 0 : /[awx+]/.test(flags)
}

/**
 * 写句柄入口 wrapper（在 wrapModule 结果上叠加）：写 flags 时校验 path 后透传，读
 * flags 放行。createWriteStream 的打开发生在构造时（fs 层同步 open），先校验再返回
 * 原流即闭合。首参为 fd / FileHandle（number / 对象）时 pathOf 返回 null 跳过——该
 * 句柄必来自已校验的入口。orig 取自 actual 而非已 wrap 的 target（避免叠加误拦）。
 */
export function wrapOpenFns(
  target: Record<string, unknown>,
  actual: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  const wrapped = { ...target }
  for (const name of names) {
    const orig = actual[name]
    if (typeof orig !== 'function') continue
    const defaultFlags = name === 'createWriteStream' ? 'w' : 'r'
    wrapped[name] = function (this: unknown, ...args: unknown[]) {
      if (isWriteOpenArg(args[1], defaultFlags)) guardPaths(name, [args[0]])
      return (orig as (...a: unknown[]) => unknown).apply(this, args)
    }
  }
  return wrapped
}
