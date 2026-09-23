/**
 * MF-1: initSandbox 的 process 守卫测试（process.kill 封堵 + process.ppid 屏蔽）。
 *
 * R2 审查发现 MF-2（process.kill/process.ppid DoS 防护）发布时零测试覆盖。initSandbox
 * 修改全局 process 对象，无法在 vitest worker 内安全 in-process 调用（污染所有后续测试，
 * 且 Object.defineProperty(process,'ppid') 部分版本不可逆）。故用 child_process.fork 在
 * 隔离 CJS 进程中调用真实 initSandbox，进程退出即丢弃全部污染。
 *
 * 回归保护目标：未来 sandbox 重构若删除/弱化 override（如「清理死代码」），本测试拦截。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fork } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTsxPathsTsconfig, type TsxPathsTsconfig } from './helpers/tsx-fork-tsconfig.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(__dirname, 'fixtures/sandbox-process-guards.fixture.cjs')

interface GuardResult {
  killBlocked: boolean
  killErrorCode?: string
  ppidMasked: boolean
  ppidValue?: unknown
}

/** 临时 tsconfig（fork env TSX_TSCONFIG_PATH）：绕开 extension-protocol exports 缺 require 条件，见 helper 注释 */
let tsxTsconfig: TsxPathsTsconfig | null = null

/**
 * 在隔离 CJS 子进程中运行 fixture，返回 stdout 解析的 GuardResult。
 *
 * execArgv ['--import','tsx'] 让 tsx 注册 CJS hook，fixture 得以 require() 加载
 * plugin-bootstrap.ts 源码（与生产 tsup CJS 产物 require 语义一致）。
 */
function runFixture(): Promise<GuardResult> {
  return new Promise((resolveP, reject) => {
    const child = fork(FIXTURE, [], {
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, TSX_TSCONFIG_PATH: tsxTsconfig?.tsconfigPath },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`fixture exited ${code}. stderr=${stderr}`))
        return
      }
      try {
        resolveP(JSON.parse(stdout) as GuardResult)
      } catch (e) {
        reject(new Error(`fixture did not emit JSON: ${(e as Error).message}. stdout=${stdout} stderr=${stderr}`))
      }
    })
  })
}

describe('MF-1: initSandbox process 守卫（process.kill / process.ppid）', () => {
  // 临时 tsconfig 生命周期 = describe 级（mkdtemp 自建自删，测试红线）
  beforeAll(() => {
    tsxTsconfig = createTsxPathsTsconfig()
  })
  afterAll(() => {
    tsxTsconfig?.dispose()
    tsxTsconfig = null
  })
  // 超时豁免登记（口径对齐 plugin-host.test.ts fork 用例的显式超时登记）：真实 fork 子进程
  // + execArgv ['--import','tsx'] 注册链，CI 满并行下冷启可达数秒超 vitest 默认 5s testTimeout；
  // 本地实测 0.25s——15s 是 CI 负载余量非真实耗时。
  it('process.kill 被封堵 → 抛 PERMISSION_DENIED（阻断 DoS 向量）', async () => {
    const result = await runFixture()
    // MF-2 核心防护：sandbox 插件 process.kill(process.ppid,'SIGKILL') 必须被拦截
    expect(result.killBlocked).toBe(true)
    expect(result.killErrorCode).toBe('PERMISSION_DENIED')
  }, 15000)

  // 超时豁免登记同上（同一 fork + tsx 注册链，15s = CI 负载余量，本地实测 0.25s）
  it('process.ppid 被屏蔽 → undefined（阻断父进程 PID 定位）', async () => {
    const result = await runFixture()
    expect(result.ppidMasked).toBe(true)
    expect(result.ppidValue).toBeNull()
  }, 15000)
})
