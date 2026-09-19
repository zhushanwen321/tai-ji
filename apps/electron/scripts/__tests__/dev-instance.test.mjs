/**
 * dev-instance-lib.mjs 单测（review MF-8：C-build-08 唯一入口装配器零测试盲区）。
 *
 * deriveParams（fnv1a hash → 端口段）与 buildDevEnv 是纯函数、最易测，其 bug 形态
 * 正是 C-build-08 登记的事故类（端口/数据目录静默错配，验收证据绑错 worktree）。
 * 覆盖面：
 *   - 同 worktree 名端口稳定（重启不变，CDP 连接/日志可复现）
 *   - 不同名三端口段互不重叠（runtime offset 步进 10 段内不重叠）
 *   - buildDevEnv：泄漏变量剥除（workspace AGENTS.md MANDATORY 清单）+
 *     端口/数据目录统一注入（TAIJI_AGENT_DATA_DIR 覆盖而非透传）
 *   - 模板过滤谓词：运行时状态子目录排除（isRuntimeStateEntry / copyTreeFiltered 实复制）
 *   - ensureInstanceDir：--fresh 重建语义 + 越界拒绝 + 模板缺失报错（io 注入 tmpdir）
 *
 * CLI 行为回归 = node apps/electron/scripts/dev-instance.mjs --print（MF-8 要求：
 * 纯函数抽取后入口行为不变）。
 */
import { afterEach, describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEAK_ENV_KEYS,
  TEMPLATE_DIR_EXCLUDES,
  buildDevEnv,
  copyTreeFiltered,
  deriveParams,
  ensureInstanceDir,
  fnv1a,
  isRuntimeStateEntry,
  isWithinDevDataParent,
  resolveCustomDataDir,
} from '../dev-instance-lib.mjs'

const fixtures = []

function tmpdir2(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  fixtures.push(dir)
  return dir
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── 端口派生 ──────────────────────────────────────────────────────────

describe('deriveParams 端口派生', () => {
  it('fnv1a 稳定且 32bit 无符号', () => {
    expect(fnv1a('dev-0.9.19')).toBe(fnv1a('dev-0.9.19'))
    expect(fnv1a('')).toBe(0x811c9dc5) // FNV offset basis
    expect(Number.isInteger(fnv1a('main'))).toBe(true)
    expect(fnv1a('main')).toBeLessThan(2 ** 32)
  })

  it('同 worktree 名派生参数全等（重启不变）', () => {
    const a = deriveParams('dev-0.9.19')
    const b = deriveParams('dev-0.9.19')
    expect(a).toEqual(b)
  })

  it('不同 worktree 名端口落在合法范围且 runtime offset 在步进 10 网格上（20 实例抽样）', () => {
    const names = Array.from({ length: 20 }, (_, i) => `worktree-${i}`)
    const params = names.map((n) => deriveParams(n, '/tmp/instances'))
    for (const p of params) {
      expect(p.vitePort).toBeGreaterThanOrEqual(1420)
      expect(p.vitePort).toBeLessThan(1720)
      expect(p.cdpPort).toBeGreaterThanOrEqual(9222)
      expect(p.cdpPort).toBeLessThan(9522)
      // runtime offset 步进 10（段宽 10：3210+offset..+9 与相邻实例段不重叠）；
      // 桶数仅 40，同名碰撞是设计内已接受形态（响亮失败 + 换名逃生，I-6），不做唯一性断言
      expect(p.portOffset).toBeGreaterThanOrEqual(100)
      expect(p.portOffset).toBeLessThanOrEqual(490)
      expect((p.portOffset - 100) % 10).toBe(0)
    }
    // dataDir 按名隔离（instancesDir 注入生效）
    expect(params[0].dataDir).toBe('/tmp/instances/worktree-0')
    expect(new Set(params.map((p) => p.dataDir)).size).toBe(params.length)
  })
})

// ── env 装配 ──────────────────────────────────────────────────────────

describe('buildDevEnv 泄漏剥除与统一注入', () => {
  it('剥除 MANDATORY 泄漏清单（ELECTRON_RUN_AS_NODE + RELAY_STD* 三名）', () => {
    const base = {
      ELECTRON_RUN_AS_NODE: '1',
      TAIJI_SUBAGENT_RELAY_STDIN: '3',
      TAIJI_SUBAGENT_RELAY_STDOUT: '4',
      TAIJI_SUBAGENT_RELAY_STDERR: '5',
      PATH: '/usr/bin',
    }
    const env = buildDevEnv(deriveParams('t', '/tmp/i'), base)
    for (const k of LEAK_ENV_KEYS) expect(env[k]).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('TAIJI_AGENT_DATA_DIR 覆盖注入（外部残留值不透传）+ 四端口键一致', () => {
    const p = deriveParams('wt', '/tmp/i')
    const env = buildDevEnv(p, { TAIJI_AGENT_DATA_DIR: '/leaked/prod-data', TAIJI_VITE_PORT: '1999' })
    expect(env.TAIJI_AGENT_DATA_DIR).toBe('/tmp/i/wt')
    expect(env.TAIJI_VITE_PORT).toBe(String(p.vitePort))
    expect(env.TAIJI_CDP_PORT).toBe(String(p.cdpPort))
    expect(env.TAIJI_AGENT_PORT_OFFSET).toBe(String(p.portOffset))
    expect(env.TAIJI_VITE_DEV_URL).toBe(`http://localhost:${p.vitePort}`)
  })

  it('baseEnv 缺省 = process.env（CLI 直跑路径不炸）', () => {
    const env = buildDevEnv(deriveParams('t', '/tmp/i'))
    expect(typeof env.TAIJI_VITE_PORT).toBe('string')
  })
})

// ── 模板过滤 ──────────────────────────────────────────────────────────

describe('模板运行时状态过滤', () => {
  it('isRuntimeStateEntry：排除名单命中、根自身放行', () => {
    expect(isRuntimeStateEntry('')).toBe(false)
    expect(isRuntimeStateEntry('sessions')).toBe(true)
    expect(isRuntimeStateEntry(join('agent', 'subagents'))).toBe(true)
    expect(isRuntimeStateEntry(join('agent', 'skills'))).toBe(false)
  })

  it('TEMPLATE_DIR_EXCLUDES 覆盖会话/记录/调度/日志面', () => {
    for (const d of ['subagents', 'records', 'scheduler', 'workflow-state', 'logs', 'sessions']) {
      expect(TEMPLATE_DIR_EXCLUDES).toContain(d)
    }
  })

  it('copyTreeFiltered 实复制：运行时状态子目录不落目标', () => {
    const src = tmpdir2('di-src-')
    const dst = tmpdir2('di-dst-')
    mkdirSync(join(src, 'agent', 'sessions'), { recursive: true })
    mkdirSync(join(src, 'agent', 'skills'), { recursive: true })
    writeFileSync(join(src, 'agent', 'settings.json'), '{}')
    writeFileSync(join(src, 'agent', 'sessions', 's.jsonl'), 'session')
    writeFileSync(join(src, 'agent', 'skills', 'x.md'), 'skill')
    copyTreeFiltered(src, join(dst, 'copy'))
    expect(existsSync(join(dst, 'copy', 'agent', 'settings.json'))).toBe(true)
    expect(existsSync(join(dst, 'copy', 'agent', 'skills', 'x.md'))).toBe(true)
    expect(existsSync(join(dst, 'copy', 'agent', 'sessions'))).toBe(false)
  })
})

// ── --data-dir 实验数据目录 ───────────────────────────────────────────

describe('resolveCustomDataDir 值域校验', () => {
  function devRoot() {
    return tmpdir2('di-devroot-')
  }

  it('树内绝对路径归一化（.. 消解后仍在树内即放行）', () => {
    const root = devRoot()
    expect(resolveCustomDataDir(join(root, 'renderopt'), { devDataParent: root })).toBe(join(root, 'renderopt'))
    expect(resolveCustomDataDir(join(root, 'a', '..', 'b'), { devDataParent: root })).toBe(join(root, 'b'))
  })

  it('树外路径拒绝并给值域指引（防绕过 fs-guard 白名单 / 指向真实数据目录）', () => {
    const root = devRoot()
    for (const bad of [tmpdir2('di-outside-'), join(root, '../elsewhere')]) {
      expect(() => resolveCustomDataDir(bad, { devDataParent: root })).toThrow(/必须落在|值域/)
    }
  })

  it('保留目录拒绝（DEV_DATA_PARENT 本体按值域外拒绝、instances 按保留目录拒绝——--fresh 会整目录删除）', () => {
    const root = devRoot()
    expect(() => resolveCustomDataDir(root, { devDataParent: root })).toThrow(/必须落在/)
    expect(() => resolveCustomDataDir(join(root, 'instances'), { devDataParent: root })).toThrow(/保留目录/)
  })

  it('空参拒绝并指向显式路径用法', () => {
    expect(() => resolveCustomDataDir(undefined, { devDataParent: devRoot() })).toThrow(/--data-dir/)
  })

  it('isWithinDevDataParent：严格子路径成立，本体与树外不成立', () => {
    const root = devRoot()
    expect(isWithinDevDataParent(join(root, 'x'), root)).toBe(true)
    expect(isWithinDevDataParent(root, root)).toBe(false)
    expect(isWithinDevDataParent(join(root, '..', 'escape'), root)).toBe(false)
  })
})

describe('ensureInstanceDir --data-dir 分支', () => {
  function setup() {
    const root = tmpdir2('di-inst-')
    const instancesDir = join(root, 'instances')
    const templateDir = join(root, 'template')
    mkdirSync(instancesDir, { recursive: true })
    mkdirSync(templateDir, { recursive: true })
    writeFileSync(join(templateDir, 'config.json'), '{}')
    return { root, instancesDir, templateDir }
  }

  it('树内自定义目录允许就绪（--fresh 可清实验目录）', () => {
    const { root, instancesDir, templateDir } = setup()
    const custom = join(root, 'renderopt')
    const ok = ensureInstanceDir({ dataDir: custom, name: 'x' }, false, {
      instancesDir, templateDir, devDataParent: root, log: () => {},
    })
    expect(ok).toBe(true)
    expect(existsSync(join(custom, 'config.json'))).toBe(true)
  })

  it('树外目录仍拒绝（防误删语义对 --data-dir 分支不放松）', () => {
    const { root, instancesDir, templateDir } = setup()
    const fail = (msg) => { throw new Error(msg) }
    expect(() => ensureInstanceDir({ dataDir: tmpdir2('di-elsewhere-'), name: 'x' }, true, {
      instancesDir, templateDir, devDataParent: root, fail,
    })).toThrow(/越界/)
  })
})

// ── ensureInstanceDir：--fresh 重建语义 ───────────────────────────────

describe('ensureInstanceDir', () => {
  function setup() {
    const root = tmpdir2('di-inst-')
    const instancesDir = join(root, 'instances')
    const templateDir = join(root, 'template')
    mkdirSync(instancesDir, { recursive: true })
    mkdirSync(templateDir, { recursive: true })
    writeFileSync(join(templateDir, 'config.json'), '{}')
    return { root, instancesDir, templateDir }
  }

  it('缺失时从模板整树复制', () => {
    const { instancesDir, templateDir } = setup()
    const p = deriveParams('wt-a', instancesDir)
    const logs = []
    const ok = ensureInstanceDir(p, false, { instancesDir, templateDir, log: (m) => logs.push(m) })
    expect(ok).toBe(true)
    expect(existsSync(join(p.dataDir, 'config.json'))).toBe(true)
    expect(logs.some((m) => m.includes('已从模板创建'))).toBe(true)
  })

  it('--fresh 清空既有实例目录后重建（干净环境语义）', () => {
    const { instancesDir, templateDir } = setup()
    const p = deriveParams('wt-b', instancesDir)
    ensureInstanceDir(p, false, { instancesDir, templateDir, log: () => {} })
    writeFileSync(join(p.dataDir, 'dirty.json'), 'runtime-state')
    const logs = []
    ensureInstanceDir(p, true, { instancesDir, templateDir, log: (m) => logs.push(m) })
    expect(existsSync(join(p.dataDir, 'dirty.json'))).toBe(false) // 脏状态被清
    expect(existsSync(join(p.dataDir, 'config.json'))).toBe(true) // 模板重建
    expect(logs.some((m) => m.includes('--fresh 已清空'))).toBe(true)
  })

  it('目录已存在且非 fresh → 幂等跳过（不覆盖用户改动）', () => {
    const { instancesDir, templateDir } = setup()
    const p = deriveParams('wt-c', instancesDir)
    ensureInstanceDir(p, false, { instancesDir, templateDir, log: () => {} })
    writeFileSync(join(p.dataDir, 'config.json'), '{"user":true}')
    ensureInstanceDir(p, false, { instancesDir, templateDir, log: () => {} })
    expect(readFileSync(join(p.dataDir, 'config.json'), 'utf8')).toBe('{"user":true}')
  })

  it('越界目录拒绝（--fresh 只允许 instances/ 直属子目录）', () => {
    const { root, instancesDir, templateDir } = setup()
    const fail = (msg) => { throw new Error(msg) }
    expect(() => ensureInstanceDir({ dataDir: join(root, 'elsewhere'), name: 'x' }, true, { instancesDir, templateDir, fail }))
      .toThrow(/越界/)
  })

  it('模板缺失报错并给恢复指引', () => {
    const { instancesDir, templateDir } = setup()
    rmSync(templateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    const p = deriveParams('wt-d', instancesDir)
    const fail = (msg) => { throw new Error(msg) }
    expect(() => ensureInstanceDir(p, false, { instancesDir, templateDir, fail })).toThrow(/模板不存在/)
  })
})
