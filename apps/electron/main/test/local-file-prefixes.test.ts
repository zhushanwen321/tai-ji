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
import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { homedir } from 'node:os'
import {
  collectSessionTmpEncodeCwdDirs,
  computeLocalFilePrefixes,
  computeLocalFileReadPrefixes,
  isPathUnderSessionTmp,
  probeLocalFileServable,
  readLocalFileContent,
  MAX_LOCAL_FILE_READ_BYTES,
} from '../utils/local-file-prefixes'
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

describe('readLocalFileContent: 源码态白名单读取通道（chat-html-support §8.2 S3）', () => {
  // 产物目录是主场景：<dataDir>/artifacts/<sessionId>/ 在 session cwd 外、在白名单内
  const PREFIXES = packagedPrefixes()
  const ARTIFACT = path.join(DATA_DIR, 'artifacts', 's1', 'report.html')

  it('白名单内文件 → ok + 内容 + truncated=false', () => {
    const reads: string[] = []
    const result = readLocalFileContent(ARTIFACT, PREFIXES, {
      statSync: () => ({ isDirectory: () => false, size: 11 }),
      readFileSync: (p) => {
        reads.push(p)
        return new TextEncoder().encode('<h1>hi</h1>')
      },
    })
    expect(result).toEqual({ ok: true, content: '<h1>hi</h1>', truncated: false })
    expect(reads).toEqual([ARTIFACT])
  })

  it('越界路径短路不触 fs（statSync / readFileSync 均不调用，无存在性探测通道）', () => {
    const stat = vi.fn()
    const read = vi.fn()
    const result = readLocalFileContent('/etc/passwd', PREFIXES, {
      statSync: stat,
      readFileSync: read,
    })
    expect(result).toEqual({ ok: false, reason: 'out_of_whitelist' })
    expect(stat).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('不存在 → not_found（不读内容）', () => {
    const read = vi.fn()
    const result = readLocalFileContent(ARTIFACT, PREFIXES, {
      statSync: () => undefined,
      readFileSync: read,
    })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
    expect(read).not.toHaveBeenCalled()
  })

  it('目录 → is_dir（不读内容）', () => {
    const read = vi.fn()
    const result = readLocalFileContent(path.join(DATA_DIR, 'artifacts'), PREFIXES, {
      statSync: () => ({ isDirectory: () => true, size: 0 }),
      readFileSync: read,
    })
    expect(result).toEqual({ ok: false, reason: 'is_dir' })
    expect(read).not.toHaveBeenCalled()
  })

  it('超上限截断（truncated=true，与 runtime file.read 同语义）', () => {
    const big = new Uint8Array(MAX_LOCAL_FILE_READ_BYTES + 8).fill(65)
    const result = readLocalFileContent(ARTIFACT, PREFIXES, {
      statSync: () => ({ isDirectory: () => false, size: big.byteLength }),
      readFileSync: () => big,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(true)
      expect(result.content.length).toBe(MAX_LOCAL_FILE_READ_BYTES)
    }
  })

  it('读取抛错（EACCES 等）→ read_failed（IPC 边界不抛错）', () => {
    const result = readLocalFileContent(ARTIFACT, PREFIXES, {
      statSync: () => ({ isDirectory: () => false, size: 1 }),
      readFileSync: () => {
        throw new Error('EACCES')
      },
    })
    expect(result).toEqual({ ok: false, reason: 'read_failed' })
  })

  it('读取真异常经 onError 旁路（不静默吞掉，与探针异常同一通道）', () => {
    const onError = vi.fn()
    const err = new Error('EACCES: permission denied')
    const result = readLocalFileContent(ARTIFACT, PREFIXES, {
      statSync: () => ({ isDirectory: () => false, size: 1 }),
      readFileSync: () => {
        throw err
      },
      onError,
    })
    expect(result).toEqual({ ok: false, reason: 'read_failed' })
    expect(onError).toHaveBeenCalledWith(err, ARTIFACT)
  })

  it('探测真异常经 onError 旁路 → not_found（不静默吞掉）', () => {
    const onError = vi.fn()
    const err = new Error('EACCES')
    const result = readLocalFileContent(ARTIFACT, PREFIXES, {
      statSync: () => {
        throw err
      },
      onError,
    })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
    expect(onError).toHaveBeenCalledWith(err, ARTIFACT)
  })
})

describe('computeLocalFileReadPrefixes: 读/预检 IPC 通道准入收窄（存储树产物子树，按现存会话枚举）', () => {
  // 通道消费域 = session 存储树内产物子树 <dataDir>/ext-sessions/<sid>/artifacts/
  // （HtmlPreviewInline 源码态/size 预检、useDetailPane 抽屉产物读取）；全量白名单含
  // <dataDir> 整前缀，读通道若复用 = 渲染进程可直读数据目录内任意文件文本（含 pi agent
  // 目录凭据）。本组用例锁定收窄面本身 + 布局反转候选①的枚举行为（先例 = ADR-0118 3d）。
  const STORE_DIR = path.join(DATA_DIR, 'ext-sessions')

  /** fs 桩：存储树一级目录名集 */
  function fsWith(entries: string[]) {
    return { readdirSync: () => entries }
  }

  it('前缀 = <dataDir>/ext-sessions/<sid>/artifacts/ 且带 trailing path.sep（每现存会话一项）', () => {
    const prefixes = computeLocalFileReadPrefixes(DATA_DIR, fsWith(['sess-1', 'sess-2']))
    expect(prefixes).toEqual([
      path.join(STORE_DIR, 'sess-1', 'artifacts') + path.sep,
      path.join(STORE_DIR, 'sess-2', 'artifacts') + path.sep,
    ])
  })

  it('非 sessionId 形态的一级目录跳过（D7 树内遍历规约）：含冒号 / 空格 / encodeCwd 形态 / 点文件不产前缀', () => {
    const prefixes = computeLocalFileReadPrefixes(DATA_DIR, fsWith(['sess-1', 'btw:abc', 'not a sid', '--Users-x--', '.DS_Store']))
    expect(prefixes).toEqual([path.join(STORE_DIR, 'sess-1', 'artifacts') + path.sep])
  })

  it('枚举失败准入从紧：ENOENT 静默空集（存储树未建 = 无产物，常态）；EACCES 空集 + onError 旁路', () => {
    const enoent = Object.assign(new Error('x'), { code: 'ENOENT' })
    const onErr = vi.fn()
    expect(computeLocalFileReadPrefixes(DATA_DIR, { readdirSync: () => { throw enoent } }, onErr)).toEqual([])
    expect(onErr).not.toHaveBeenCalled()

    const eaccs = Object.assign(new Error('x'), { code: 'EACCES' })
    expect(computeLocalFileReadPrefixes(DATA_DIR, { readdirSync: () => { throw eaccs } }, onErr)).toEqual([])
    expect(onErr).toHaveBeenCalledWith(eaccs, STORE_DIR)
  })

  it('产物路径命中；同一会话分区内非产物子树不命中（attachments / image-cache / plugin-data.json）', () => {
    const readPrefixes = computeLocalFileReadPrefixes(DATA_DIR, fsWith(['s1']))
    expect(isPathInAllowedPrefixes(path.join(STORE_DIR, 's1', 'artifacts', 'report.html'), readPrefixes)).toBe(true)
    expect(isPathInAllowedPrefixes(path.join(STORE_DIR, 's1', 'artifacts'), readPrefixes)).toBe(true)
    expect(isPathInAllowedPrefixes(path.join(STORE_DIR, 's1', 'attachments', 'img.png'), readPrefixes)).toBe(false)
    expect(isPathInAllowedPrefixes(path.join(STORE_DIR, 's1', 'image-cache', 'x.png'), readPrefixes)).toBe(false)
    expect(isPathInAllowedPrefixes(path.join(STORE_DIR, 's1', 'plugin-data.json'), readPrefixes)).toBe(false)
    // 未枚举到的会话分区不命中（按现存会话收窄语义）
    expect(isPathInAllowedPrefixes(path.join(STORE_DIR, 's2', 'artifacts', 'report.html'), readPrefixes)).toBe(false)
  })

  it('旧布局产物根与数据目录其余位置全部不命中（换根后旧前缀不放行）', () => {
    const readPrefixes = computeLocalFileReadPrefixes(DATA_DIR, fsWith(['s1']))
    expect(isPathInAllowedPrefixes(`${DATA_DIR}/artifacts/s1/report.html`, readPrefixes)).toBe(false)
    expect(isPathInAllowedPrefixes(`${DATA_DIR}/attachments/sess-1/img.png`, readPrefixes)).toBe(false)
    expect(isPathInAllowedPrefixes(`${DATA_DIR}/cache/images/x.png`, readPrefixes)).toBe(false)
    expect(isPathInAllowedPrefixes(`${DATA_DIR}/agent/auth.json`, readPrefixes)).toBe(false)
    // 兄弟目录不误伤（trailing sep 守护）
    expect(isPathInAllowedPrefixes(path.join(STORE_DIR, 's1', 'artifacts-extra', 'x.html'), readPrefixes)).toBe(false)
  })

  it('攻击面锁定：全量白名单内的 <dataDir>/agent/auth.json 经读通道前缀 out_of_whitelist 不触 fs', () => {
    // 对照组证明攻击面真实存在：同一路径在全量白名单内可读
    expect(isPathInAllowedPrefixes(`${DATA_DIR}/agent/auth.json`, packagedPrefixes())).toBe(true)
    const stat = vi.fn()
    const read = vi.fn()
    const result = readLocalFileContent(`${DATA_DIR}/agent/auth.json`, computeLocalFileReadPrefixes(DATA_DIR, fsWith(['s1'])), {
      statSync: stat,
      readFileSync: read,
    })
    expect(result).toEqual({ ok: false, reason: 'out_of_whitelist' })
    expect(stat).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('产物文件经读通道前缀正常读取（消费面不回归）', () => {
    const result = readLocalFileContent(path.join(STORE_DIR, 's1', 'artifacts', 'report.html'), computeLocalFileReadPrefixes(DATA_DIR, fsWith(['s1'])), {
      statSync: () => ({ isDirectory: () => false, size: 11 }),
      readFileSync: () => new TextEncoder().encode('<h1>hi</h1>'),
    })
    expect(result).toEqual({ ok: true, content: '<h1>hi</h1>', truncated: false })
  })
})

describe('会话项目 .tmp/ 子树准入（ADR-0118 决策②代价修订 3d）', () => {
  // 语义场景：应用有过 cwd = PROJECT_CWD 的会话（sessions 目录里有对应 encodeCwd 子目录）
  const SESSION_DIRS = new Set(['--Users-tester-Code-my-project--'])

  describe('isPathUnderSessionTmp: encodeCwd 正向对拍', () => {
    it('会话项目 .tmp 子树内命中（文件 / 嵌套 / 目录自身形态）', () => {
      expect(isPathUnderSessionTmp(`${PROJECT_CWD}/.tmp/demo.html`, SESSION_DIRS)).toBe(true)
      expect(isPathUnderSessionTmp(`${PROJECT_CWD}/.tmp/a/b.html`, SESSION_DIRS)).toBe(true)
      expect(isPathUnderSessionTmp(`${PROJECT_CWD}/.tmp`, SESSION_DIRS)).toBe(true)
    })

    it('项目根其它路径 / 相似名项目 / 目录集为空 → 不命中', () => {
      expect(isPathUnderSessionTmp(`${PROJECT_CWD}/README.md`, SESSION_DIRS)).toBe(false)
      // 目录名精确比对（encodeCwd 全串相等），非前缀匹配——相似名项目不误伤
      expect(isPathUnderSessionTmp('/Users/tester/Code/my-project2/.tmp/x.html', new Set(['--Users-tester-Code-my-project--']))).toBe(false)
      expect(isPathUnderSessionTmp(`${PROJECT_CWD}/.tmp/x.html`, new Set())).toBe(false)
    })

    it('`.`/`..` 已在 resolve 层折叠：折叠后脱离 .tmp 前缀的最终形态不命中', () => {
      // 谓词入口职责 = 接收规范化后形态；这里直接给折叠产物（等价 probeLocalFileServable 内部行为）
      expect(isPathUnderSessionTmp('/Users/tester/secrets.txt', SESSION_DIRS)).toBe(false)
      // .tmp 内再套 .tmp 的边界逐段对拍（内层候选 cwd 不在目录集则不命中）
      expect(isPathUnderSessionTmp(`${PROJECT_CWD}/.tmp/.tmp/x.html`, SESSION_DIRS)).toBe(true)
    })

    it('归并歧义上界：字面 `-` 项目与 `/` 归并项目同目录名时双候选都命中（有界过近似，仍限于真实会话目录集）', () => {
      const dirs = new Set(['--Users-tester-Code-my-proj--'])
      expect(isPathUnderSessionTmp('/Users/tester/Code/my/proj/.tmp/x.html', dirs)).toBe(true)
      expect(isPathUnderSessionTmp('/Users/tester/Code/my-proj/.tmp/x.html', dirs)).toBe(true)
    })
  })

  describe('collectSessionTmpEncodeCwdDirs', () => {
    it('只认 `--...--` 形态子项，其余文件/目录忽略', () => {
      const dirs = collectSessionTmpEncodeCwdDirs('/sessions', {
        readdirSync: () => ['--Users-tester-Code-my-project--', '--Users-tester-Code-other--', 'loose-file.jsonl', '.DS_Store'],
      })
      expect([...dirs].sort()).toEqual(['--Users-tester-Code-my-project--', '--Users-tester-Code-other--'])
    })

    it('ENOENT 静默空集（无会话目录 = 无会话项目）；其它异常空集 + onError 旁路', () => {
      const enoent = Object.assign(new Error('x'), { code: 'ENOENT' })
      const onErr = vi.fn()
      expect(collectSessionTmpEncodeCwdDirs('/sessions', { readdirSync: () => { throw enoent } }, onErr)).toEqual(new Set())
      expect(onErr).not.toHaveBeenCalled()

      const eaccs = Object.assign(new Error('x'), { code: 'EACCES' })
      expect(collectSessionTmpEncodeCwdDirs('/sessions', { readdirSync: () => { throw eaccs } }, onErr)).toEqual(new Set())
      expect(onErr).toHaveBeenCalledWith(eaccs, '/sessions')
    })
  })

  describe('probeLocalFileServable / readLocalFileContent 接入', () => {
    it('会话项目 .tmp 文件 servable=true（预检 + 读通道正向不回归）', () => {
      const stat = vi.fn(() => ({ isDirectory: () => false, size: 5 }))
      const probe = probeLocalFileServable(`${PROJECT_CWD}/.tmp/demo.html`, packagedPrefixes(), { statSync: stat }, SESSION_DIRS)
      expect(probe.servable).toBe(true)
      expect(probe.resolvedPath).toBe(`${PROJECT_CWD}/.tmp/demo.html`)

      const read = vi.fn(() => new TextEncoder().encode('<p>demo</p>'))
      const result = readLocalFileContent(
        `${PROJECT_CWD}/.tmp/demo.html`,
        computeLocalFileReadPrefixes(DATA_DIR, { readdirSync: () => ['s1'] }),
        { statSync: stat, readFileSync: read },
        SESSION_DIRS,
      )
      expect(result).toEqual({ ok: true, content: '<p>demo</p>', truncated: false })
    })

    it('目录集外路径依旧 out_of_whitelist 且不触 fs（越界不触 fs 性质保持）', () => {
      const stat = vi.fn()
      for (const p of ['/etc/passwd', `${HOME}/.ssh/id_rsa`, '/Users/other-proj/.tmp/x.html']) {
        const probe = probeLocalFileServable(p, packagedPrefixes(), { statSync: stat }, SESSION_DIRS)
        expect(probe).toEqual({ servable: false, reason: 'out_of_whitelist', resolvedPath: '' })
      }
      expect(stat).not.toHaveBeenCalled()
    })

    it('数据目录凭据不经会话 .tmp 通道放行（3d 不扩大 3c 收窄面的结论）', () => {
      const stat = vi.fn()
      const read = vi.fn()
      // encodeCwd(DATA_DIR) 不在目录集 → auth.json 仍被拒；即使目录集含它，读通道也只该
      // 覆盖 .tmp 段——双重断言锁定「凭据面不回归」
      const result = readLocalFileContent(
        `${DATA_DIR}/agent/auth.json`,
        computeLocalFileReadPrefixes(DATA_DIR, { readdirSync: () => ['s1'] }),
        { statSync: stat, readFileSync: read },
        new Set([...SESSION_DIRS, '--Users-tester-.taiji--']),
      )
      expect(result).toEqual({ ok: false, reason: 'out_of_whitelist' })
      expect(stat).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
    })

    it('sessionTmpDirs 缺省时行为与旧签名完全一致（可选参数向后兼容）', () => {
      const stat = vi.fn(() => ({ isDirectory: () => false, size: 1 }))
      expect(probeLocalFileServable(`${DATA_DIR}/artifacts/s1/a.html`, packagedPrefixes(), { statSync: stat }).servable).toBe(true)
      expect(probeLocalFileServable('/etc/passwd', packagedPrefixes(), { statSync: stat }).servable).toBe(false)
    })
  })
})
