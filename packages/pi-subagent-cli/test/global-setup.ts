/**
 * Vitest globalSetup — 测试运行最早期执行（早于任何测试文件的 import）。
 *
 * [HISTORICAL] 2026-07-26 事故结构性兜底：
 * runtime 的多个 store 模块在 import 时 eager 初始化（模块级 `let xxxStore = createXxxStore(getXxxPath())`），
 * getXxxPath() 读 process.env.TAIJI_AGENT_DATA_DIR。如果测试文件在 beforeEach 漏调 setXxxPath，
 * store 会绑定到用户真实数据目录 ~/.taiji，写入污染用户数据。
 *
 * 本 globalSetup 强制把 TAIJI_AGENT_DATA_DIR 指向测试专用 tmp 目录，
 * 让所有 eager 初始化天然走 tmp，结构性杜绝污染。
 *
 * [HISTORICAL] 2026-09-02 会话丢失事故：注入值指向真实 ~/.taiji 时「尊重已有」
 * 使重定向失效（见 setup 内 fail-fast）；第二层防线 = fs-guard setupFiles 拦截全部
 * 破坏性 fs 操作的白名单外目标（test/fs-guard.ts）。
 *
 * [2026-09-15 一致性审查 B 组] fail-fast 升级为白名单形态：注入值必须落在
 * tmpdir()/~/.taiji-dev 之下（isInjectedEnvAllowed，与 fs-guard 白名单共用判定）才
 * 「尊重不覆盖」，否则拒跑——不再只拒缺省真实目录一个点，指到其他家目录真实路径
 * （含改名前旧数据目录）的注入一律拒跑。
 *
 * 注意：globalSetup 在隔离进程跑，return 的 teardown 在所有测试结束后调用。
 * process.env 的设置通过 `process.env.X = ...` 直接赋值，对 worker 进程可见
 * （vitest fork worker 继承父进程 env）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { isInjectedEnvAllowed } from './fs-guard-impl.js'

let testDataDir: string | null = null

/** 真实用户数据目录（与 apps/electron/main 打包态缺省一致，homedir 动态推导，无写死路径）。 */
const REAL_DATA_DIR = resolve(join(homedir(), '.taiji'))

export function setup(): void {
  // [HISTORICAL] 2026-09-02 会话丢失事故第一层防线：env 注入的 TAIJI_AGENT_DATA_DIR 指向
  // 真实用户数据目录时直接拒跑——旧版「尊重已有 env」使 tmp 重定向失效，测试的
  // rmSync(getSessionsDir()) 删光数据目录下全部活跃会话，三个在跑
  // pi 进程随后 ENOENT 崩溃。fail-fast 必须先于「尊重已有」判定。
  const injected = process.env.TAIJI_AGENT_DATA_DIR
  if (injected) {
    const resolved = resolve(injected)
    const targetsRealDataDir = resolved === REAL_DATA_DIR || resolved.startsWith(REAL_DATA_DIR + sep)
    if (targetsRealDataDir) {
      console.error(
        `[global-setup] TAIJI_AGENT_DATA_DIR 指向真实用户数据目录，拒绝运行测试：${resolved}\n` +
          `  恢复动作：unset TAIJI_AGENT_DATA_DIR（回到 tmp 重定向），或改指 dev 数据目录 ` +
          `~/.taiji-dev（2026-09-02 会话丢失事故防线，见 test/fs-guard.ts 第二层）`,
      )
      process.exit(1)
    }
    // [2026-09-15 一致性审查 B 组] 白名单形态 fail-fast（第二道）：上一条前缀判定只覆盖
    // 缺省真实目录一个点——注入值显式指到其他家目录真实路径（含改名前的旧数据目录，
    // 物理存在且含用户数据）时旧判定不拦，guard 层旧版又无条件放行注入值，两层防线
    // 同时失守。改为排除式：注入值必须落在 tmpdir()/~/.taiji-dev 之下才「尊重不覆盖」，
    // 判定与 fs-guard 白名单过滤共用 isInjectedEnvAllowed（单一实现，防两防线漂移）。
    if (!isInjectedEnvAllowed(resolved)) {
      console.error(
        `[global-setup] TAIJI_AGENT_DATA_DIR 指向非白名单目录，拒绝运行测试：${resolved}\n` +
          `  合法落点仅限 tmpdir() 或 ~/.taiji-dev 之下。\n` +
          `  恢复动作：unset TAIJI_AGENT_DATA_DIR（回到 tmp 重定向），或改指 dev 数据目录 ~/.taiji-dev`,
      )
      process.exit(1)
    }
    // 已设且安全（CI 自定义 tmp / dev 实例注入的 ~/.taiji-dev），尊重不覆盖
    return
  }
  testDataDir = mkdtempSync(join(tmpdir(), 'taiji-test-data-'))
  process.env.TAIJI_AGENT_DATA_DIR = testDataDir
}

export function teardown(): void {
  if (testDataDir) {
    try {
      rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch (e) {
      // best-effort cleanup；globalSetup teardown 失败不应阻断 vitest 退出
      console.warn(`[global-setup] teardown rmSync failed for ${testDataDir}:`, e instanceof Error ? e.message : e)
    }
  }
}

export default function globalSetup(): (() => void) | void {
  setup()
  return teardown
}
