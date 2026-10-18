/**
 * paths.ts 单测：pi 会话树段常量 + session 存储树（`<dataDir>/ext-sessions/`）函数族
 * + 旧推导函数新布局断言 + sessionId 路径穿越防线
 * + 非反转域（getPiAgentDir / getTtsCacheDir / getDataDir prod 准入守卫）。
 *
 * session-store-layout-inversion（D1）：全部 session 维度衍生数据落存储树
 * `<root>/<sessionId>/<domain>/`，带 sessionId 的推导函数统一过 assertPiSessionId
 * （与 runtime isPiSessionId 同域正则，非法 id throw 防路径穿越）。
 *
 * 被测函数是纯路径字符串推导，全程不触任何真实数据目录（~/.taiji）、不做任何 fs
 * 读断言；缺省形态用 vi.stubEnv 桩注入 TAIJI_AGENT_DATA_DIR。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/paths.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  encodeCwd,
  getDataDir,
  getPiAgentDir,
  getPiSessionsDir,
  getTtsCacheDir,
  PI_SESSION_TREE_SEGMENTS,
  SESSION_STORE_DIR_SEGMENT,
  getSessionStoreDir,
  getAttachmentsDir,
  isPiSessionId,
  getImageCacheDir,
  getSessionArtifactsDir,
  getSessionPluginDataPath,
  getSessionCanvasesDir,
  getSessionBackgroundTasksDir,
  getSessionViewPath,
  getSessionBtwDir,
  getSessionLogsDir,
  getSessionSubagentsDir,
  getSessionSubagentSessionsDir,
  getSessionSubagentRecordsDir,
  getSessionSubagentModelSwitchDir,
  getSessionWorkflowDir,
  getSessionWorkflowRunsDir,
} from '../paths'

const DATA = '/tmp/taiji-shared-test-data'
const SID = '019f9bd8-ee50-779d-a912-4a661683cf69'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('PI_SESSION_TREE_SEGMENTS', () => {
  it('树段全集：pi 宿主三段（sessions / subagents / btw，布局权威 = runtime pi-paths.ts 三函数）+ 末位存储树根段 ext-sessions', () => {
    expect([...PI_SESSION_TREE_SEGMENTS]).toEqual(['sessions', 'subagents', 'btw', 'ext-sessions'])
  })

  it('末位段与 SESSION_STORE_DIR_SEGMENT / getSessionStoreDir 同源（存储树根段一致）', () => {
    expect(PI_SESSION_TREE_SEGMENTS[PI_SESSION_TREE_SEGMENTS.length - 1]).toBe(SESSION_STORE_DIR_SEGMENT)
    expect(getSessionStoreDir(DATA)).toBe(join(DATA, SESSION_STORE_DIR_SEGMENT))
  })

  it('首段与 getPiSessionsDir 树根一致（常量与既有同构推导函数不漂移）', () => {
    expect(getPiSessionsDir(DATA)).toBe(join(DATA, 'agent', PI_SESSION_TREE_SEGMENTS[0]))
  })
})

describe('getPiSessionsDir', () => {
  it('注入 dataDir：join(dataDir, agent, sessions)（SSOT 同构推导，禁各进程手拼层级）', () => {
    expect(getPiSessionsDir(DATA)).toBe(join(DATA, 'agent', 'sessions'))
  })

  it('缺省形态：读 TAIJI_AGENT_DATA_DIR env（vi.stubEnv 注入，无 env 注入先例故用 env 桩）', () => {
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', DATA)
    expect(getPiSessionsDir()).toBe(join(DATA, 'agent', 'sessions'))
  })

  it('缺省且 env 未设：homedir() 兜底 ~/.taiji-dev（缺省反转，fail-safe default；纯字符串推导，不触 fs）', () => {
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', undefined)
    expect(getPiSessionsDir()).toBe(join(homedir(), '.taiji-dev', 'agent', 'sessions'))
  })
})

describe('getSessionStoreDir（session 存储树根）', () => {
  it('注入 dataDir：join(dataDir, ext-sessions)', () => {
    expect(getSessionStoreDir(DATA)).toBe(join(DATA, 'ext-sessions'))
  })

  it('缺省形态：读 TAIJI_AGENT_DATA_DIR env（vi.stubEnv 桩，不触 fs）', () => {
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', DATA)
    expect(getSessionStoreDir()).toBe(join(DATA, 'ext-sessions'))
  })
})

// ── 旧推导函数改公式：返回 session 存储树新布局（调用方零改动即得新路径）────────

describe('旧推导函数返回存储树新布局', () => {
  it('getAttachmentsDir → <root>/<sid>/attachments（域 1；原 <dataDir>/attachments/<sid>）', () => {
    expect(getAttachmentsDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'attachments'))
    // taiji store 的 u-<uuid> 格式同样合法（isPiSessionId 同域宽集）
    expect(getAttachmentsDir('u-a1b2c3d4-e5f6-7890-abcd-ef1234567890', DATA)).toBe(
      join(DATA, 'ext-sessions', 'u-a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'attachments'),
    )
  })

  it('getSessionArtifactsDir → <root>/<sid>/artifacts（域 2；原 <dataDir>/artifacts/<sid>）', () => {
    expect(getSessionArtifactsDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'artifacts'))
  })

  it('getImageCacheDir → <root>/<sid>/image-cache（域 3；原 <dataDir>/cache/images/<sid>）', () => {
    expect(getImageCacheDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'image-cache'))
  })

  it('合法 sid 含 `.` / `_`（isPiSessionId 同域宽集；原窄集 /^[A-Za-z0-9_-]+$/ 会误拒，统一后放行）', () => {
    expect(getAttachmentsDir('sess.AB_01', DATA)).toBe(join(DATA, 'ext-sessions', 'sess.AB_01', 'attachments'))
    expect(getImageCacheDir('sess.AB_01', DATA)).toBe(join(DATA, 'ext-sessions', 'sess.AB_01', 'image-cache'))
    expect(getSessionArtifactsDir('sess.AB_01', DATA)).toBe(join(DATA, 'ext-sessions', 'sess.AB_01', 'artifacts'))
  })

  it('isPiSessionId：与 assertPiSessionId 同正则（合法 uuid / 含 . _ 宽集过；空串、含 : 、含分隔符、首尾非字母数字拒）', () => {
    expect(isPiSessionId(SID)).toBe(true)
    expect(isPiSessionId('sess.AB_01')).toBe(true)
    expect(isPiSessionId('')).toBe(false)
    expect(isPiSessionId('btw:abc')).toBe(false)
    expect(isPiSessionId('../evil')).toBe(false)
    expect(isPiSessionId('a/b')).toBe(false)
    expect(isPiSessionId('.lead-dot')).toBe(false)
    expect(isPiSessionId('trail-dot.')).toBe(false)
  })
})

// ── 新增域函数族（<root>/<sid>/<domain>/）────────────────────────────────────

describe('session 存储树各域推导函数', () => {
  it('域 4 插件 KV：getSessionPluginDataPath → <root>/<sid>/plugin-data.json', () => {
    expect(getSessionPluginDataPath(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'plugin-data.json'))
  })

  it('域 5 后台任务：getSessionBackgroundTasksDir → <root>/<sid>/background-tasks', () => {
    expect(getSessionBackgroundTasksDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'background-tasks'))
  })

  it('域 6 会话导出：getSessionViewPath → <root>/<sid>/session-view.md', () => {
    expect(getSessionViewPath(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'session-view.md'))
  })

  it('域 7 btw 线：getSessionBtwDir → <root>/<mainSid>/btw（mainSid 分区，无 encodeCwd 层）', () => {
    expect(getSessionBtwDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'btw'))
  })

  it('域 8 画布：getSessionCanvasesDir → <root>/<sid>/canvases（画布 id 1:N 子分区由消费方拼接）', () => {
    expect(getSessionCanvasesDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'canvases'))
  })

  it('域 9 subagent：getSessionSubagentsDir → <root>/<sid>/subagents + 三个子域（sessions/records/model-switch）', () => {
    expect(getSessionSubagentsDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'subagents'))
    expect(getSessionSubagentSessionsDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'subagents', 'sessions'))
    expect(getSessionSubagentRecordsDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'subagents', 'records'))
    expect(getSessionSubagentModelSwitchDir(SID, DATA)).toBe(
      join(DATA, 'ext-sessions', SID, 'subagents', 'model-switch'),
    )
  })

  it('域 10 workflow：getSessionWorkflowDir → <root>/<sid>/workflow + runs 子域', () => {
    expect(getSessionWorkflowDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'workflow'))
    expect(getSessionWorkflowRunsDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'workflow', 'runs'))
  })

  it('域 11 会话日志：getSessionLogsDir → <root>/<sid>/logs', () => {
    expect(getSessionLogsDir(SID, DATA)).toBe(join(DATA, 'ext-sessions', SID, 'logs'))
  })

  it('缺省形态：读 TAIJI_AGENT_DATA_DIR env（vi.stubEnv 桩，不触 fs）', () => {
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', DATA)
    expect(getAttachmentsDir(SID)).toBe(join(DATA, 'ext-sessions', SID, 'attachments'))
    expect(getSessionBtwDir(SID)).toBe(join(DATA, 'ext-sessions', SID, 'btw'))
    expect(getSessionLogsDir(SID)).toBe(join(DATA, 'ext-sessions', SID, 'logs'))
  })
})

// ── sessionId 路径穿越防线（全部树内推导函数统一 assertPiSessionId 同域校验）────

describe('sessionId 穿越拒绝（isPiSessionId 同域校验，非法 id throw）', () => {
  // 任务书指定形态：../、绝对路径、空串、含 / \ : 的 id；另含 `..` 与首尾非字母数字
  const BAD_IDS = ['../evil', '/tmp/evil', 'a/b', 'a\\b', 'a:b', '', '..', '.abc', 'abc.', 'a b', '-abc']

  const STORE_FNS = [
    getAttachmentsDir,
    getImageCacheDir,
    getSessionArtifactsDir,
    getSessionPluginDataPath,
    getSessionCanvasesDir,
    getSessionBackgroundTasksDir,
    getSessionViewPath,
    getSessionBtwDir,
    getSessionLogsDir,
    getSessionSubagentsDir,
    getSessionSubagentSessionsDir,
    getSessionSubagentRecordsDir,
    getSessionSubagentModelSwitchDir,
    getSessionWorkflowDir,
    getSessionWorkflowRunsDir,
  ]

  it('全部树内推导函数对非法 id 一律 throw（路径遍历防护守卫，含 btw 虚拟 id 冒号形态）', () => {
    for (const fn of STORE_FNS) {
      for (const bad of BAD_IDS) {
        expect(() => fn(bad, DATA), `${fn.name}("${bad}") 应 throw`).toThrow(
          /invalid sessionId \(path traversal blocked\)/,
        )
      }
    }
  })

  it('btw 虚拟 id（btw:<sid> 含冒号）被拒——vid 是路由 key，不直传目录层', () => {
    expect(() => getSessionBtwDir('btw:019f9bd8', DATA)).toThrow(/invalid sessionId/)
  })
})

describe('encodeCwd', () => {
  it('posix：去首斜杠 + `/` 归并为 `-`，双 `--` 包裹', () => {
    expect(encodeCwd('/Users/x/proj')).toBe('--Users-x-proj--')
    expect(encodeCwd('/Users/x/Code/my-proj')).toBe('--Users-x-Code-my-proj--')
  })

  it('win：盘符冒号与反斜杠各替换为一个 `-`（与 pi 原生编码产物一致）', () => {
    expect(encodeCwd('C:\\Users\\x\\proj')).toBe('--C--Users-x-proj--')
  })

  it('归并有损（字面 `-` 与分隔符产物不可区分）→ 只保证正向单射：同 cwd 恒同目录名', () => {
    // 正向确定性是 main 侧会话项目 .tmp 准入正向对拍的前提（反向解码有歧义，禁止依赖）
    const cwd = '/Users/x/Code/my-proj'
    expect(encodeCwd(cwd)).toBe(encodeCwd(cwd))
    expect(encodeCwd('/Users/x/Code/my/proj')).toBe(encodeCwd('/Users/x/Code/my-proj'))
  })
})

// ── 非反转域（自包根级 __tests__/paths.test.ts 迁入：该文件断言旧反转公式已退役，职责并入本文件）──

describe('getPiAgentDir（方案 B 布局对齐 pi）', () => {
  it('env 注入 TAIJI_AGENT_DATA_DIR → path.join(dataDir, "agent")（单层，无中间层）', () => {
    const env = { TAIJI_AGENT_DATA_DIR: '/custom/data' }
    // 回归守卫：旧两级布局会返回带一层中间目录的路径（<dataDir>/<层>/agent），
    // 与上面的期望值不同 → 退化必红，无需再写第二条反向断言。
    expect(getPiAgentDir(env)).toBe(join('/custom/data', 'agent'))
  })

  it('不传 env → path.join(getDataDir(), "agent")', () => {
    expect(getPiAgentDir()).toBe(join(getDataDir(), 'agent'))
  })

  it('env 无 TAIJI_AGENT_DATA_DIR → 缺省 ~/.taiji-dev/agent（fail-safe default，非 prod ~/.taiji、非系统 pi 的 ~/.pi/agent）', () => {
    // 纯路径推导，不触碰磁盘。缺省反转回归守卫：旧缺省 ~/.taiji 必红。
    expect(getPiAgentDir({})).toBe(join(homedir(), '.taiji-dev', 'agent'))
    expect(getPiAgentDir({})).not.toBe(join(homedir(), '.taiji', 'agent'))
    expect(getPiAgentDir({})).not.toBe(join(homedir(), '.pi', 'agent'))
  })
})

describe('getTtsCacheDir（TTS 朗读缓存，设计 §7.4）', () => {
  it('传 dataDir → path.join(dataDir, "tts-cache")', () => {
    expect(getTtsCacheDir('/custom/data')).toBe(join('/custom/data', 'tts-cache'))
  })

  it('不传 dataDir → path.join(getDataDir(), "tts-cache")（动态推导，禁硬编码绝对路径）', () => {
    expect(getTtsCacheDir()).toBe(join(getDataDir(), 'tts-cache'))
  })
})

describe('getDataDir prod 值准入守卫（C-proc-26 第二支柱）', () => {
  /** 守卫判定纯词法（resolve + 真实 homedir 树内判），构造值不触磁盘 */
  const PROD_ROOT = join(homedir(), '.taiji')
  const DEV_ROOT = join(homedir(), '.taiji-dev')

  it('prod 树值 + 无 PACKAGED → throw（泄漏形态：消息含恢复动作）', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: PROD_ROOT })).toThrow(/C-proc-26 prod-admission guard/)
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: join(PROD_ROOT, 'agent') })).toThrow(
      /unset TAIJI_AGENT_DATA_DIR/,
    )
  })

  it('prod 树值 + PACKAGED=1 → 放行返回原值（合法 prod 消费链）', () => {
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: PROD_ROOT, TAIJI_AGENT_PACKAGED: '1' })).toBe(PROD_ROOT)
  })

  it('dev 树值 / tmp 值 / 未设 / 空串 → 不触发守卫（缺省或原值）', () => {
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: DEV_ROOT })).toBe(DEV_ROOT)
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: '/tmp/anything' })).toBe('/tmp/anything')
    expect(getDataDir({})).toBe(DEV_ROOT)
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: '' })).toBe(DEV_ROOT)
  })

  it('词法入树形态 ~/.taiji-dev/../.taiji → resolve 消解后在 prod 树内，throw', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: `${DEV_ROOT}/../.taiji` })).toThrow(
      /prod-admission guard/,
    )
  })

  it('词法出树形态 ~/.taiji/../.taiji-dev → resolve 消解后在 dev 树，放行', () => {
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: `${PROD_ROOT}/../.taiji-dev` })).toBe(
      `${PROD_ROOT}/../.taiji-dev`,
    )
  })

  it('前缀混淆形态 ~/.taijiish → sep 边界判不在树内，放行', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: `${PROD_ROOT}ish` })).not.toThrow()
  })

  it('大小写变体 ~/.TAIJI（无 PACKAGED）→ casefold 判在 prod 树内，throw（大小写不敏感卷漏判 = 写真实 prod）', () => {
    const variant = join(homedir(), '.TAIJI')
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: variant })).toThrow(/prod-admission guard/)
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: join(variant, 'agent') })).toThrow(
      /prod-admission guard/,
    )
  })

  it('大小写变体 ~/.TAIJI + PACKAGED=1 → 放行返回原值（错误消息保留原大小写）', () => {
    const variant = join(homedir(), '.TAIJI')
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: variant, TAIJI_AGENT_PACKAGED: '1' })).toBe(variant)
  })

  it('大小写变体前缀混淆 ~/.TAIJIish → casefold 后 sep 边界仍生效，放行', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: `${join(homedir(), '.TAIJI')}ish` })).not.toThrow()
  })

  it('PACKAGED 非 "1" 值（0/true）不构成 prod 形态声明，prod 树值仍 throw', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: PROD_ROOT, TAIJI_AGENT_PACKAGED: '0' })).toThrow()
    expect(() =>
      getDataDir({ TAIJI_AGENT_DATA_DIR: PROD_ROOT, TAIJI_AGENT_PACKAGED: 'true' }),
    ).toThrow()
  })
})
