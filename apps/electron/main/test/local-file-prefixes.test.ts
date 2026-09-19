/**
 * computeLocalFilePrefixes 纯函数单测（integrity-hardening §3.2 D2a / D8c）。
 *
 * [HISTORICAL] 护栏从注释移到测试：原 protocol.handle 内联白名单含 process.cwd()，
 * macOS 打包版从 Finder/Dock 启动时 cwd 是 /，前缀匹配 startsWith('/') 对任意绝对
 * 路径恒真——白名单塌缩为全盘，「绝不放行 ~ 本身（含 ~/.ssh）」的注释不变量被
 * 运行时环境击穿。本测试用真实语义值锁定修复后的不变量：
 *  - 打包态白名单不含文件系统根 /、不含 homedir 本身、不含 cwd
 *  - dev 态含 cwd（图片预览主场景）
 *  - 组合 isPathInAllowedPrefixes 断言真实攻击路径不放行（~/.ssh、/etc/passwd）
 *
 * 运行：cd apps/electron/main && npx vitest run test/local-file-prefixes.test.ts
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { homedir } from 'node:os'
import { computeLocalFilePrefixes } from '../utils/local-file-prefixes'
import { isPathInAllowedPrefixes } from '../gateway/input-validators'

// 固定语义值（不依赖跑测试的机器，断言跨机器可复现）
const HOME = '/Users/tester'
const PROJECT_CWD = '/Users/tester/Code/my-project'
const APP_PATH = '/Applications/TaiJi.app/Contents/Resources/app.asar'
const DATA_DIR = '/Users/tester/.taiji'
const TMP = '/var/folders/zz/Tqrs123/C'

/** 打包态白名单（cwd 默认 /：macOS Finder/Dock 启动打包版的真实 cwd） */
function packagedPrefixes(cwd = '/'): string[] {
  return computeLocalFilePrefixes({
    isPackaged: true,
    cwd,
    appPath: APP_PATH,
    dataDir: DATA_DIR,
    tmpdir: TMP,
    home: HOME,
  })
}

/** dev 态白名单（cwd = pnpm dev 的项目根） */
function devPrefixes(): string[] {
  return computeLocalFilePrefixes({
    isPackaged: false,
    cwd: PROJECT_CWD,
    appPath: '/Users/tester/Code/taiji',
    dataDir: '/Users/tester/.taiji-dev',
    tmpdir: TMP,
    home: HOME,
  })
}

describe('computeLocalFilePrefixes: 打包态（D2a 守卫）', () => {
  it('白名单不含文件系统根 /（Finder 启动 cwd=/ 时 startsWith("/") 恒真的塌缩已剔除）', () => {
    const prefixes = packagedPrefixes('/')
    // 带 trailing sep 后根目录本身就是 path.sep（'/'），逐项断言不存在
    expect(prefixes).not.toContain(path.sep)
    expect(prefixes.some(p => p === path.sep)).toBe(false)
  })

  it('白名单不含 homedir 本身（~/.ssh、~/.aws 等敏感目录不可读）', () => {
    const prefixes = packagedPrefixes('/')
    expect(prefixes).not.toContain(HOME + path.sep)
  })

  it('白名单不含 cwd——即使打包态 cwd 非根（从终端启动打包版时 cwd 是任意目录，语义已失效）', () => {
    const prefixes = packagedPrefixes(PROJECT_CWD)
    expect(prefixes).not.toContain(PROJECT_CWD + path.sep)
  })

  it('真实攻击路径不放行：~/.ssh/id_rsa、/etc/passwd、~/Library/Keychains', () => {
    const prefixes = packagedPrefixes('/')
    expect(isPathInAllowedPrefixes(`${HOME}/.ssh/id_rsa`, prefixes)).toBe(false)
    expect(isPathInAllowedPrefixes('/etc/passwd', prefixes)).toBe(false)
    expect(isPathInAllowedPrefixes(`${HOME}/Library/Keychains/login.keychain-db`, prefixes)).toBe(false)
  })

  it('对照组——合法用户内容仍放行：~/Documents、~/Desktop、~/Downloads、attachments、appPath、tmpdir', () => {
    const prefixes = packagedPrefixes('/')
    expect(isPathInAllowedPrefixes(`${HOME}/Documents/photo.png`, prefixes)).toBe(true)
    expect(isPathInAllowedPrefixes(`${HOME}/Desktop/screenshot.png`, prefixes)).toBe(true)
    expect(isPathInAllowedPrefixes(`${HOME}/Downloads/doc.pdf`, prefixes)).toBe(true)
    expect(isPathInAllowedPrefixes(`${DATA_DIR}/attachments/sess-1/img.png`, prefixes)).toBe(true)
    expect(isPathInAllowedPrefixes(`${APP_PATH}/renderer/dist/index.html`, prefixes)).toBe(true)
    expect(isPathInAllowedPrefixes(`${TMP}/export.md`, prefixes)).toBe(true)
  })

  it('前缀误判防护：~ 本身不放行（HOME 精确匹配被拒），兄弟目录不误伤', () => {
    const prefixes = packagedPrefixes('/')
    // HOME 自身（不是其子目录）不匹配任何前缀——isPathInAllowedPrefixes 的精确匹配
    // 分支只在「resolved 是允许目录本身」时放行，HOME 不在白名单内
    expect(isPathInAllowedPrefixes(HOME, prefixes)).toBe(false)
    // /Users/tester-mail 不应因 /Users/tester 前缀被误放行（trailing sep 守护）
    expect(isPathInAllowedPrefixes(`${HOME}-mail/secret`, prefixes)).toBe(false)
  })
})

describe('computeLocalFilePrefixes: dev 态', () => {
  it('白名单含 cwd（dev 态保留 cwd 成员，D2a 语义）', () => {
    const prefixes = devPrefixes()
    expect(prefixes).toContain(PROJECT_CWD + path.sep)
  })

  it('dev 态同样不含文件系统根 / 与 homedir 本身（W3 原不变量在 dev 态继续成立）', () => {
    const prefixes = devPrefixes()
    expect(prefixes).not.toContain(path.sep)
    expect(prefixes).not.toContain(HOME + path.sep)
  })

  it('dev 态 cwd 下文件放行（组合 isPathInAllowedPrefixes）', () => {
    const prefixes = devPrefixes()
    expect(isPathInAllowedPrefixes(`${PROJECT_CWD}/assets/chart.png`, prefixes)).toBe(true)
    expect(isPathInAllowedPrefixes(`${HOME}/.ssh/id_rsa`, prefixes)).toBe(false)
  })
})

describe('computeLocalFilePrefixes: projectRoot（dev 装配器注入成员）', () => {
  // dev-instance.mjs 装配的真实形态：electron cwd/appPath 都指向 worktree 根下的
  // apps/electron 子目录，projectRoot 才是 worktree 根——对话流 <img src="docs/...">
  // 相对路径解析出的项目根文件只有它能放行
  const WORKTREE_ROOT = '/Users/tester/Code/taiji-worktree'

  /** dev 装配形态白名单（cwd/appPath = apps/electron 子目录 + projectRoot = worktree 根） */
  function devAssembledPrefixes(): string[] {
    return computeLocalFilePrefixes({
      isPackaged: false,
      cwd: `${WORKTREE_ROOT}/apps/electron`,
      appPath: `${WORKTREE_ROOT}/apps/electron`,
      projectRoot: WORKTREE_ROOT,
      dataDir: '/Users/tester/.taiji-dev',
      tmpdir: TMP,
      home: HOME,
    })
  }

  it('dev 装配态传入 projectRoot 时拼入白名单且带 trailing sep，项目根下用户文件放行', () => {
    const prefixes = devAssembledPrefixes()
    expect(prefixes).toContain(WORKTREE_ROOT + path.sep)
    expect(isPathInAllowedPrefixes(`${WORKTREE_ROOT}/docs/assets/logo.png`, prefixes)).toBe(true)
    // cwd/appPath 命中不了的项目根文件由 projectRoot 成员放行（本次修复场景）
    expect(prefixes.every(p => p.endsWith(path.sep))).toBe(true)
  })

  it('projectRoot 缺省时不混入对应项（既有行为不回归）', () => {
    const prefixes = devPrefixes()
    expect(prefixes.some(p => p.startsWith(WORKTREE_ROOT))).toBe(false)
  })

  it('本函数对 projectRoot 无条件拼入（含打包态入参）——dev-only 过滤职责在 main.ts 调用侧', () => {
    // computeLocalFilePrefixes 是纯构造函数，不按 isPackaged 过滤 projectRoot；
    // 「打包态不出现该成员」由 main.ts protocol.handle 调用侧条件展开裁决
    // （isDev && process.env.TAIJI_DEV_PROJECT_ROOT 才传入，打包态缺省），此处锁定
    // 纯函数语义；调用侧防线已按读代码核实（main.ts local-file handler 入参展开）。
    const prefixes = computeLocalFilePrefixes({
      isPackaged: true,
      cwd: '/',
      projectRoot: WORKTREE_ROOT,
      home: HOME,
    })
    expect(prefixes).toContain(WORKTREE_ROOT + path.sep)
  })
})

describe('computeLocalFilePrefixes: 输出契约与缺省行为', () => {
  it('每项前缀都带 trailing path.sep（防 /Users/foo 匹配 /Users/foobar）', () => {
    const prefixes = [...packagedPrefixes(), ...devPrefixes()]
    expect(prefixes.length).toBeGreaterThan(0)
    expect(prefixes.every(p => p.endsWith(path.sep))).toBe(true)
  })

  it('home 缺省回退 os.homedir()（与 expandLocalFilePath 同范式，main.ts 调用不传 home）', () => {
    const prefixes = computeLocalFilePrefixes({ isPackaged: true, cwd: '/' })
    expect(prefixes).toContain(path.join(homedir(), 'Documents') + path.sep)
  })

  it('可选路径参数缺省时跳过对应项（appPath/dataDir/tmpdir 不混入）', () => {
    const prefixes = computeLocalFilePrefixes({ isPackaged: true, cwd: '/', home: HOME })
    expect(prefixes.some(p => p.startsWith(APP_PATH))).toBe(false)
    expect(prefixes.some(p => p.startsWith(DATA_DIR))).toBe(false)
    expect(prefixes.some(p => p.startsWith(TMP))).toBe(false)
    // 只剩用户内容子目录 3 项
    expect(prefixes).toHaveLength(3)
  })
})
