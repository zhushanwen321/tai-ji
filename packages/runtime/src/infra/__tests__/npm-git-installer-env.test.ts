/**
 * NpmGitInstaller.installGit 出站 env 契约锁定（C-proc-09 收编回归，原守卫豁免条目）。
 *
 * 收编后锁定的不变式：
 * 1. deny 清单两键（TAIJI_AGENT_PACKAGED / TAIJI_RUNTIME_TOKEN）无论从哪条通路进父 env，
 *    都不出现在 git clone 的子进程 env（credential helper / npm script 后代进程泄道收口）；
 * 2. 白名单基座键（PATH/HOME）不因契约接线丢失（Node spawn env 整体替换语义）；
 * 3. 代理键被显式 forward——入站白名单 ENV_WHITELIST_PREFIXES 不含任何 PROXY 键，
 *    漏 forward 则用户代理环境下 GitHub clone（extension 安装主场景）直接失效；
 *    未设置的代理键不出现（extras 只含有值键）；
 * 4. clone 的 argv 形态不受契约改造牵连。
 *
 * 策略：mock node:child_process 捕获 execFileSync 参数；父进程 env 污染经 vi.stubEnv
 * 注入（R3：禁止直接读写真实 process.env）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/__tests__/npm-git-installer-env.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NpmGitInstaller } from '../installers/npm-git-installer.js'

let capturedEnv: Record<string, string> | undefined
let capturedArgs: readonly unknown[] | undefined

vi.mock('node:child_process', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 形位对齐真实签名便于阅读
  execFileSync: (_cmd: string, args: readonly unknown[], opts?: { env?: Record<string, string> }) => {
    capturedArgs = args
    capturedEnv = opts?.env
    return Buffer.alloc(0)
  },
}))

describe('NpmGitInstaller.installGit — 出站 env 契约（C-proc-09 收编）', () => {
  beforeEach(() => {
    capturedEnv = undefined
    capturedArgs = undefined
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('deny 清单两键不出现在 git 子进程 env', async () => {
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '1')
    vi.stubEnv('TAIJI_RUNTIME_TOKEN', 'deadbeef')
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest')
    expect(capturedEnv).toBeDefined()
    expect(capturedEnv?.TAIJI_AGENT_PACKAGED).toBeUndefined()
    expect(capturedEnv?.TAIJI_RUNTIME_TOKEN).toBeUndefined()
  })

  it('PATH/HOME 白名单基座保留', async () => {
    vi.stubEnv('PATH', '/usr/local/bin:/usr/bin')
    vi.stubEnv('HOME', '/Users/tester')
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest')
    expect(capturedEnv?.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(capturedEnv?.HOME).toBe('/Users/tester')
  })

  it('代理键显式 forward，未设置的代理键不出现', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890')
    vi.stubEnv('no_proxy', 'localhost,127.0.0.1')
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest')
    expect(capturedEnv?.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(capturedEnv?.no_proxy).toBe('localhost,127.0.0.1')
    expect(capturedEnv?.ALL_PROXY).toBeUndefined()
    expect(capturedEnv?.HTTP_PROXY).toBeUndefined()
    expect(capturedEnv?.NO_PROXY).toBeUndefined()
  })

  it('父 env 未设代理键时 extras 为空对象语义（仅基座 + 无残留）', async () => {
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest')
    for (const key of [
      'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
      'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    ]) {
      expect(capturedEnv?.[key]).toBeUndefined()
    }
  })

  it('clone argv 形态锚定（--depth 1 与 url/destDir 不受改造牵连）', async () => {
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest-x')
    expect(capturedArgs).toEqual([
      'clone', '--depth', '1', 'https://github.com/a/b.git', '/tmp/dest-x',
    ])
  })
})
