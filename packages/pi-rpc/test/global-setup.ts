/**
 * Vitest globalSetup — 测试运行最早期执行（早于任何测试文件的 import）。
 *
 * [HISTORICAL] 2026-07-26 事故结构性兜底：
 * runtime 的多个 store 模块在 import 时 eager 初始化（模块级 `let xxxStore = createXxxStore(getXxxPath())`），
 * getXxxPath() 读 process.env.XYZ_AGENT_DATA_DIR。如果测试文件在 beforeEach 漏调 setXxxPath，
 * store 会绑定到用户真实数据目录 ~/.xyz-agent，写入污染用户数据。
 *
 * 本 globalSetup 强制把 XYZ_AGENT_DATA_DIR 指向测试专用 tmp 目录，
 * 让所有 eager 初始化天然走 tmp，结构性杜绝污染。
 *
 * [HISTORICAL] 2026-09-02 会话丢失事故：注入值指向真实 ~/.xyz-agent 时「尊重已有」
 * 使重定向失效（见 setup 内 fail-fast）；第二层防线 = fs-guard setupFiles 拦截全部
 * 破坏性 fs 操作的白名单外目标（test/fs-guard.ts）。
 *
 * 注意：globalSetup 在隔离进程跑，return 的 teardown 在所有测试结束后调用。
 * process.env 的设置通过 `process.env.X = ...` 直接赋值，对 worker 进程可见
 * （vitest fork worker 继承父进程 env）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

let testDataDir: string | null = null

/** 真实用户数据目录（与 apps/electron/main 打包态缺省一致，homedir 动态推导，无写死路径）。 */
const REAL_DATA_DIR = resolve(join(homedir(), '.xyz-agent'))

export function setup(): void {
  // [HISTORICAL] 2026-09-02 会话丢失事故第一层防线：env 注入的 XYZ_AGENT_DATA_DIR 指向
  // 真实用户数据目录时直接拒跑——旧版「尊重已有 env」使 tmp 重定向失效，测试的
  // rmSync(getSessionsDir()) 删光 ~/.xyz-agent 数据目录全部活跃会话，三个在跑
  // pi 进程随后 ENOENT 崩溃。fail-fast 必须先于「尊重已有」判定。
  const injected = process.env.XYZ_AGENT_DATA_DIR
  if (injected) {
    const resolved = resolve(injected)
    const targetsRealDataDir = resolved === REAL_DATA_DIR || resolved.startsWith(REAL_DATA_DIR + sep)
    if (targetsRealDataDir) {
      console.error(
        `[global-setup] XYZ_AGENT_DATA_DIR 指向真实用户数据目录，拒绝运行测试：${resolved}\n` +
          `  恢复动作：unset XYZ_AGENT_DATA_DIR（回到 tmp 重定向），或改指 dev 数据目录 ` +
          `~/.xyz-agent-dev（2026-09-02 会话丢失事故防线，见 test/fs-guard.ts 第二层）`,
      )
      process.exit(1)
    }
    // 已设且安全（CI 自定义 tmp / dev 实例注入的 ~/.xyz-agent-dev），尊重不覆盖
    return
  }
  testDataDir = mkdtempSync(join(tmpdir(), 'xyz-agent-test-data-'))
  process.env.XYZ_AGENT_DATA_DIR = testDataDir
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
