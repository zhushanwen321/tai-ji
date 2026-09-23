/**
 * fs-guard 实现（纯逻辑）——由 test/fs-guard.ts 的 vi.mock 工厂动态 import；
 * test/global-setup.ts 复用 isInjectedEnvAllowed 做注入 fail-fast 判定（两防线共用单一实现，
 * 防判定形态漂移）。
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

/** 真实用户数据目录（prod 形态钉死值 = 打包 main resolvePackagedDataDir 的 fallback，homedir 动态推导）。
 *  导出供 global-setup 第一道 fail-fast 复用（单一来源，防第二份字面量漂移）。 */
export const REAL_DATA_DIR = resolve(join(homedir(), '.taiji'))

/**
 * 路径的判定形式全集：resolve 形式（逻辑规范化，不解析 symlink）+ realpath 形式
 * （symlink 真身，目标存在时）。双形式必要性（macOS 实测）：os.tmpdir() 返回
 * /var/folders/...，而测试路径经 realpathSync 后是 /private/var/folders/...——
 * 单形式前缀匹配会把合法 tmp fixture 误拦。realpath 形式同时是 symlink 别名的
 * 权威判定面（/tmp/link → ~/.taiji 的真身必须被拒）。
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

/** 注入值合法落点白名单：tmpdir() 与 ~/.taiji-dev（各取 resolve + realpath 双形式）。 */
function allowedRootVariants(): string[] {
  const roots = [resolve(tmpdir()), resolve(join(homedir(), '.taiji-dev'))]
  return [...new Set(roots.flatMap((r) => pathVariants(r)))]
}

/**
 * 注入的 TAIJI_AGENT_DATA_DIR 是否落在合法落点之下。global-setup 的 fail-fast 与本文件的
 * 白名单过滤共用此单一判定——两防线判定形态不一致正是本缝隙根因（taiji-full-rename R3：
 * 白名单语义 = 注入值 ≠ 真实目录，排除式）。
 */
export function isInjectedEnvAllowed(p: string): boolean {
  return pathVariants(p).some((v) => matchesPrefix(v, allowedRootVariants()))
}

/** 非法注入告警一次性 flag：whitelistPrefixes 每次 guard 调用都重算，不设 flag 会刷屏。 */
let invalidInjectionWarned = false

/**
 * 注入 env 的合法性过滤：旧实现把 TAIJI_AGENT_DATA_DIR 无条件 push 进白名单，注入值显式
 * 指到真实用户目录（含改名前的旧数据目录，物理存在且含历史数据）时破坏性 fs 操作被放行，
 * globalSetup 的前缀判定又只覆盖缺省目录——两层防线同时失守。现仅当注入值落在
 * tmpdir()/~/.taiji-dev 之下才进白名单；非法值剔除并一次性 console.error 说明
 * （guard 层防线语义由白名单达成，拒跑职责在 global-setup）。
 */
function injectedEnvVariants(): string[] {
  const injected = process.env.TAIJI_AGENT_DATA_DIR
  if (!injected) return []
  const resolved = resolve(injected)
  if (!isInjectedEnvAllowed(resolved)) {
    if (!invalidInjectionWarned) {
      invalidInjectionWarned = true
      console.error(
        `[fs-guard] TAIJI_AGENT_DATA_DIR 注入值不在合法落点（tmpdir() 或 ~/.taiji-dev）之下，已从白名单剔除：${resolved}\n` +
          `  恢复动作：unset TAIJI_AGENT_DATA_DIR，或改指 ~/.taiji-dev。`,
      )
    }
    return []
  }
  return pathVariants(resolved)
}

function whitelistPrefixes(): string[] {
  return [...new Set([...allowedRootVariants(), ...injectedEnvVariants()])]
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
        ` 设 TAIJI_AGENT_DATA_DIR 指向 dev 目录（~/.taiji-dev），禁止指向 ~/.taiji。`,
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

/**
 * node:fs 模块面的 promises 访问器装配：{...actual} 浅拷贝会把 promises getter 求值出的
 * 原始模块当普通属性透传——经 fs.promises 到达的破坏性 API 整面绕过拦截（与直引
 * node:fs/promises 的防线形成双轨）。此处对真实 promises 模块单层 wrap 后覆盖赋值，
 * 语义 = 经访问器访问与直引同防线。
 * 数据源取 target.promises（展开时 getter 已求值为真实模块）而非工厂内 import
 * ('node:fs/promises')：后者会命中 vitest runner 的 mock 注册，引入两工厂执行时序耦合
 * （promises 工厂被局部覆盖/未注册时静默分叉）。产出的 wrap 与 node:fs/promises 工厂
 * 是平行且等价的单层实例（同一 FS_ASYNC_FNS 名单 + 同一 impl 的 guardPaths，模块缓存
 * 共享），非二次包装，防线行为一致。
 */
export function attachPromisesModule(target: Record<string, unknown>): Record<string, unknown> {
  const actualPromises = target.promises
  if (!actualPromises || typeof actualPromises !== 'object') return target
  const source = actualPromises as Record<string, unknown>
  target.promises = wrapOpenFns(wrapModule(source, FS_ASYNC_FNS), source, FS_PROMISES_OPEN_FNS)
  return target
}

/**
 * worker 进程内跨测试文件的 TAIJI_AGENT_DATA_DIR 钉扎槽（挂 globalThis：模块注册表每
 * 个测试文件重建，模块级变量跨文件不存续；globalThis 在 worker 进程内存续——isolate=false
 * 等 worker 复用形态下正是靠它把首见值带到后续文件）。
 */
const DATA_DIR_ENV_PIN = Symbol.for('taiji.test-guard.dataDirEnvPin')

const DATA_DIR_ENV_KEY = 'TAIJI_AGENT_DATA_DIR'

/**
 * [2026-09-22 import-service 污染事故] env 钉扎漂移恢复（worker 复用形态防线）。
 *
 * globalSetup 只在 vitest 进程启动时执行一次，把 TAIJI_AGENT_DATA_DIR 钉到 tmp；worker
 * 进程 fork 时继承该值。但 isolate=false 等 worker 进程复用形态下，前序测试文件对
 * process.env 的变更（如 afterEach `delete process.env.TAIJI_AGENT_DATA_DIR`）会跨文件
 * 泄漏（探针实证：同 worker 后续文件读到 undefined）——后续文件的 getSessionsDir() 按
 * 缺省解析到真实 ~/.taiji，叠加文件级 vi.mock('node:fs/promises') 解除 fs-guard 时即
 * 静默污染真实数据目录。本函数由 fs-guard setupFile 在每个测试文件执行前调用：
 * 首次执行记录当前值（= globalSetup 钉扎值或合法注入值），后续执行发现漂移即恢复并
 * 告警（错误信息含背景与恢复动作）。默认 isolate（每文件新 fork）下槽随进程重建，
 * 首见即钉扎值，恒 no-op——零开销。
 *
 * 返回是否发生了恢复（供元测试断言）。
 */
export function repinDataDirEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const registry = globalThis as Record<symbol, { value: string | undefined } | undefined>
  const current = env[DATA_DIR_ENV_KEY]
  const slot = registry[DATA_DIR_ENV_PIN]
  if (!slot) {
    registry[DATA_DIR_ENV_PIN] = { value: current }
    return false
  }
  if (current === slot.value) return false
  env[DATA_DIR_ENV_KEY] = slot.value
  console.warn(
    `[fs-guard] TAIJI_AGENT_DATA_DIR 在同 worker 前序测试文件中被改动（${current === undefined ? '被删除' : `被改为 ${current}`}），` +
      `已恢复为本 worker 首个测试文件执行时的钉扎值 ${slot.value ?? '(未设置)'}。\n` +
      '  背景：isolate=false 等 worker 进程复用形态下 process.env 变更跨测试文件泄漏，' +
      '前序文件删除该 env 会让后续文件的 getSessionsDir() 缺省解析到真实 ~/.taiji（数据污染风险）。\n' +
      '  修复动作：测试内需改动 TAIJI_AGENT_DATA_DIR 时，在 afterAll/afterEach 恢复进入时原值，不要以 delete 收尾。',
  )
  return true
}

/** 测试专用：清空 env 钉扎槽（fs-guard.test.ts 元测试用例间隔离；生产代码禁调）。 */
export function _resetDataDirEnvPinForTest(): void {
  const registry = globalThis as Record<symbol, { value: string | undefined } | undefined>
  delete registry[DATA_DIR_ENV_PIN]
}
