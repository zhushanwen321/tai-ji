/**
 * vitest fs-guard — worker 级破坏性 fs 操作白名单切面（经 vitest setupFiles 挂载）。
 *
 * [HISTORICAL] 2026-09-02 会话丢失事故：测试进程在 env 带 XYZ_AGENT_DATA_DIR=真实
 * ~/.xyz-agent 时运行（globalSetup 旧版「尊重已有 env」使 tmp 重定向失效），
 * import-service.test.ts afterAll 的 rmSync(getSessionsDir(), { recursive: true })
 * 删掉用户全部活跃会话文件，三个在跑 pi 进程随后 appendFileSync 撞上消失的父目录
 * ENOENT 崩溃（flags 'a' 本可自建文件，ENOENT 根因是目录被 recursive 删除）。
 *
 * 实现路径（为什么是 vi.mock 而非改模块属性）：node:fs 是 CJS built-in，ESM named
 * import 的绑定是进程级快照——在 setupFiles 里替换模块对象属性赶不上 vitest 模块
 * 运行时早已固化的 named bindings（实测 wrapper 完全不生效）；而 vi.mock 走 vitest
 * 模块 runner 的解析层拦截，对测试文件及其依赖链的 import 必然生效（同机制已在
 * import-service.test.ts 的 copyFile 失败注入上验证）。setupFiles 中调用 vi.mock 对
 * 该 worker 的全部后续测试文件注册全局 mock。
 *
 * 工厂体保持自引用零依赖（vi.mock 工厂被提升到模块顶部执行，引用模块级声明会 TDZ）：
 * guard 逻辑在 ./fs-guard-impl.ts，工厂动态 import；impl 的 realpathSync 经
 * createRequire 取 CJS 原始模块（vi.mock 只拦 ESM import 链），guard 不经过自己的 wrapper。
 *
 * 防护语义：破坏性 fs 操作（写/删/移动）的目标路径必须落在白名单前缀内（resolve +
 * realpath 双形式匹配），否则抛错。白名单（无写死绝对路径）：
 *   1. os.tmpdir()             —— mkdtempSync fixture 根基（现有测试的标准形态）
 *   2. $XYZ_AGENT_DATA_DIR     —— globalSetup 注入的 tmp / CI 自定义 / dev 实例（pnpm dev
 *                                  的 Electron main 会注入 ~/.xyz-agent-dev）；指向真实
 *                                  ~/.xyz-agent 的情况由 globalSetup 入口 fail-fast 拒跑
 *   3. ~/.xyz-agent-dev        —— 缺省 dev 数据目录（homedir 动态推导）
 * 真实数据目录 ~/.xyz-agent 无条件拒绝（先于白名单判定——即使白名单逻辑未来被改坏，
 * 用户数据仍不可触碰）。
 *
 * 边界（有意为之）：
 * - 只拦写/删/移动，不拦读——vitest 模块加载与源码 import 本身就是海量读 IO，拦读会
 *   破坏测试运行时；读操作对用户数据不可造成不可逆损害。
 * - fd 消费点（writeSync / ftruncate(Sync) / fs.ftruncate）不逐点拦：fd 是 number，
 *   参数层无 path 可校验，逐点拦是恒放行的假防线。防线落在写句柄入口——openSync /
 *   callback open / createWriteStream / promises.open 的写 flags 校验 path（写 fd 只能
 *   经这些入口产生，O_RDONLY fd 上 ftruncate/write 系统调用必败 EINVAL/EBADF，实测；
 *   fs/promises 无 ftruncate 导出，实测）。论证链见 fs-guard-impl.ts FS_OPEN_FNS 注释。
 * - mock 只覆盖走 vitest 模块 runner 的 import（测试文件 + 其依赖链）；CJS require
 *   消费者与测试 spawn 出去的子进程（真实 pi 等）不在拦截范围——后者的写删目标由
 *   各自 fixture 的 tmp sessionDir 隔离。
 * - 测试文件内重新 vi.mock 同一 fs 模块会覆盖本全局 mock（如 import-service.test.ts
 *   对 node:fs/promises copyFile 的失败注入）——该文件内 fs/promises 的 guard 失效，
 *   属已知边界，禁止以此为姿势绕过 guard。
 */
import { vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const impl = await import('./fs-guard-impl.js')
  const wrapped = impl.wrapModule(actual as unknown as Record<string, unknown>, impl.FS_SYNC_FNS)
  return impl.wrapOpenFns(wrapped, actual as unknown as Record<string, unknown>, impl.FS_OPEN_FNS)
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const impl = await import('./fs-guard-impl.js')
  const wrapped = impl.wrapModule(actual as unknown as Record<string, unknown>, impl.FS_ASYNC_FNS)
  return impl.wrapOpenFns(wrapped, actual as unknown as Record<string, unknown>, impl.FS_PROMISES_OPEN_FNS)
})
