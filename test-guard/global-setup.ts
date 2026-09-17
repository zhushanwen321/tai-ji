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
 * [2026-09-17 自动脱钩] fail-fast 改为**自动脱钩 + 单行通告**：宿主 shell（dev 实例 / Electron
 * 主进程）会把 `TAIJI_AGENT_DATA_DIR=~/.taiji` 导出到子进程环境，导致任何测试与 pre-commit
 * 钩子内的守卫单测都必须 `env -u TAIJI_AGENT_DATA_DIR` 才能跑（人人需感知的环境摩擦）。
 * 安全性不依赖「拒跑」：脱钩后一律落 tmp 重定向，fs-guard 第二层照旧拦全部白名单外破坏
 * 性操作（拦截能力未变），故改为「不阻塞 + 保留可诊断性」。原两道 fail-fast 的判定条件
 * （真实数据目录 / 非白名单目录）保留为脱钩触发条件，日志文案含原因与去向。
 *
 * 注意：globalSetup 在隔离进程跑，return 的 teardown 在所有测试结束后调用。
 * process.env 的设置通过 `process.env.X = ...` 直接赋值，对 worker 进程可见
 * （vitest fork worker 继承父进程 env）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { isInjectedEnvAllowed, REAL_DATA_DIR } from './fs-guard-impl.js'

let testDataDir: string | null = null

export function setup(): void {
  // [HISTORICAL] 2026-09-02 会话丢失事故第一层防线：env 注入的 TAIJI_AGENT_DATA_DIR 指向
  // 真实用户数据目录时直接拒跑——旧版「尊重已有 env」使 tmp 重定向失效，测试的
  // rmSync(getSessionsDir()) 删光数据目录下全部活跃会话，三个在跑
  // pi 进程随后 ENOENT 崩溃。fail-fast 必须先于「尊重已有」判定。
  const injected = process.env.TAIJI_AGENT_DATA_DIR
  if (injected) {
    const resolved = resolve(injected)
    const targetsRealDataDir = resolved === REAL_DATA_DIR || resolved.startsWith(REAL_DATA_DIR + sep)
    // [2026-09-17] 两道判定（真实数据目录 / 非白名单目录）从 fail-fast 改为自动脱钩：
    // 判定条件与理由不变（2026-09-02 会话丢失事故 + 2026-09-15 白名单形态），只是处置从
    // 「exit 1 阻塞」换成「脱钩后落 tmp + 通告」——测试永远拿不到真实目录（安全等价），
    // 但宿主 env 泄漏不再要求使用者记得 `env -u`。
    if (targetsRealDataDir || !isInjectedEnvAllowed(resolved)) {
      delete process.env.TAIJI_AGENT_DATA_DIR
      console.warn(
        `[global-setup] 检测到宿主注入的 TAIJI_AGENT_DATA_DIR=${resolved}` +
          `（${targetsRealDataDir ? '真实用户数据目录' : '非白名单目录'}）——已自动脱钩，` +
          `本次测试改用 tmp 重定向（2026-09-02 会话丢失事故第一层防线；如需指定数据目录，` +
          `请注入 tmpdir() 或 ~/.taiji-dev 之下的路径）`,
      )
    } else {
      // 已设且安全（CI 自定义 tmp / dev 实例注入的 ~/.taiji-dev），尊重不覆盖
      return
    }
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
