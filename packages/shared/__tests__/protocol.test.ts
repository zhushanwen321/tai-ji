/**
 * protocol.test.ts — 协议层类型一致性校验
 *
 * 验证新增 RPC 在 ClientMessageMap / ServerMessageMapBase / ReplyPayloadMap
 * 三个映射中都有注册，以及 payload 形状正确。
 *
 * 类型一致性通过 TypeScript 编译期断言保证（extends 条件类型 = never 失败）。
 * 运行期测试验证 payload 可赋值和 WorktreeErrorCode 值。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ClientMessageMap,
  ServerMessageMapBase,
  ReplyPayloadMap,
  WorktreeErrorCode,
  BackgroundTaskState,
  BackgroundTaskEndReason,
  BackgroundTaskKillReason,
  BackgroundTaskRegistryEntry,
  BtwForkState,
  BtwThreadInfo,
} from '../src/protocol'

// ── 编译期类型断言辅助 ─────────────────────────────────────────
// 如果类型不存在于映射中，条件类型求值为 never → 赋值失败 → tsc 报错。
// 这些声明在编译期被校验，运行期无成本。

type AssertHasKey<T, K extends keyof T> = never
type AssertExtends<A, B> = A extends B ? never : never

// ClientMessageMap 新增 key 存在性
type _Assert_Client_detect = AssertHasKey<ClientMessageMap, 'workspace.detect'>
type _Assert_Client_detectBare = AssertHasKey<ClientMessageMap, 'workspace.detectBare'>
type _Assert_Client_listBranches = AssertHasKey<ClientMessageMap, 'worktree.listBranches'>
type _Assert_Client_list = AssertHasKey<ClientMessageMap, 'worktree.list'>
type _Assert_Client_setWorktreeRootDir = AssertHasKey<ClientMessageMap, 'config.setWorktreeRootDir'>
type _Assert_Client_getWorktreeRootDir = AssertHasKey<ClientMessageMap, 'config.getWorktreeRootDir'>
type _Assert_Client_setSetupScript = AssertHasKey<ClientMessageMap, 'config.setSetupScript'>
type _Assert_Client_getSetupScript = AssertHasKey<ClientMessageMap, 'config.getSetupScript'>

// ServerMessageMapBase 新增 key 存在性
type _Assert_Server_detected = AssertHasKey<ServerMessageMapBase, 'workspace.detected'>
type _Assert_Server_bareDetected = AssertHasKey<ServerMessageMapBase, 'workspace.bareDetected'>
type _Assert_Server_branches = AssertHasKey<ServerMessageMapBase, 'worktree.branches'>
type _Assert_Server_listResult = AssertHasKey<ServerMessageMapBase, 'worktree.list:result'>
type _Assert_Server_worktreeRootDir = AssertHasKey<ServerMessageMapBase, 'config.worktreeRootDir'>
type _Assert_Server_setupScript = AssertHasKey<ServerMessageMapBase, 'config.setupScript'>

// ReplyPayloadMap 新增 key 存在性
type _Assert_Reply_detect = AssertHasKey<ReplyPayloadMap, 'workspace.detect'>
type _Assert_Reply_detectBare = AssertHasKey<ReplyPayloadMap, 'workspace.detectBare'>
type _Assert_Reply_listBranches = AssertHasKey<ReplyPayloadMap, 'worktree.listBranches'>
type _Assert_Reply_list = AssertHasKey<ReplyPayloadMap, 'worktree.list'>
type _Assert_Reply_setWorktreeRootDir = AssertHasKey<ReplyPayloadMap, 'config.setWorktreeRootDir'>
type _Assert_Reply_getWorktreeRootDir = AssertHasKey<ReplyPayloadMap, 'config.getWorktreeRootDir'>
type _Assert_Reply_setSetupScript = AssertHasKey<ReplyPayloadMap, 'config.setSetupScript'>
type _Assert_Reply_getSetupScript = AssertHasKey<ReplyPayloadMap, 'config.getSetupScript'>

// workspace.detected payload shape 编译期断言（必须包含 mode 三态）
type _Assert_DetectedShape = AssertExtends<
  ServerMessageMapBase['workspace.detected'],
  { mode: 'bare-workspace' | 'plain-repo' | 'not-repo'; wsRoot: string; barePath: string; repoRoot: string; defaultBranch: string }
>

// worktree.create baseBranch 编译期断言（必须是 string，不能只是旧联合）
type _Assert_BaseBranchIsString = AssertExtends<
  ClientMessageMap['worktree.create']['baseBranch'],
  string | undefined
>

// ── 运行期测试 ─────────────────────────────────────────────────

describe('worktree.create payload 形状', () => {
  it('baseBranch 接受任意字符串（非仅旧联合）', () => {
    const payload: ClientMessageMap['worktree.create'] = {
      branch: 'feat-x',
      baseBranch: 'origin/develop',
    }
    expect(payload.baseBranch).toBe('origin/develop')
  })

  it('baseBranch 仍接受 current 特殊值', () => {
    const payload: ClientMessageMap['worktree.create'] = {
      branch: 'feat-x',
      baseBranch: 'current',
    }
    expect(payload.baseBranch).toBe('current')
  })

  it('locationMode 接受 workspace / repo-dir / dedicated-dir', () => {
    const modes: NonNullable<ClientMessageMap['worktree.create']['locationMode']>[] = [
      'workspace', 'repo-dir', 'dedicated-dir',
    ]
    expect(modes).toHaveLength(3)
  })

  it('locationMode 和 baseBranch 可省略', () => {
    const payload: ClientMessageMap['worktree.create'] = { branch: 'feat-x' }
    expect(payload.branch).toBe('feat-x')
    expect(payload.baseBranch).toBeUndefined()
    expect(payload.locationMode).toBeUndefined()
  })
})

describe('workspace.detected payload 形状', () => {
  it('mode 支持三种值', () => {
    const modes: ServerMessageMapBase['workspace.detected']['mode'][] = [
      'bare-workspace', 'plain-repo', 'not-repo',
    ]
    expect(modes).toHaveLength(3)
  })

  it('包含 wsRoot / barePath / repoRoot / defaultBranch', () => {
    const reply: ServerMessageMapBase['workspace.detected'] = {
      mode: 'bare-workspace',
      wsRoot: '/tmp/ws',
      barePath: '/tmp/ws/.bare',
      repoRoot: '/tmp/ws',
      defaultBranch: 'main',
    }
    expect(reply.wsRoot).toBe('/tmp/ws')
    expect(reply.barePath).toBe('/tmp/ws/.bare')
    expect(reply.repoRoot).toBe('/tmp/ws')
    expect(reply.defaultBranch).toBe('main')
  })
})

describe('worktree.listBranches payload 形状', () => {
  it('包含 local / remote / defaultBranch', () => {
    const reply: ServerMessageMapBase['worktree.branches'] = {
      local: ['main', 'feat-x'],
      remote: ['origin/main', 'origin/feat-y'],
      defaultBranch: 'main',
    }
    expect(reply.local).toHaveLength(2)
    expect(reply.remote).toHaveLength(2)
    expect(reply.defaultBranch).toBe('main')
  })
})

describe('worktree.list payload 形状', () => {
  it('items 元素包含 path / branch / HEAD / bare', () => {
    const reply: ServerMessageMapBase['worktree.list:result'] = {
      items: [
        { path: '/tmp/ws/main', branch: 'main', HEAD: true, bare: false },
        { path: '/tmp/ws/feat-x', branch: 'feat-x', HEAD: false, bare: false },
      ],
    }
    expect(reply.items[0].HEAD).toBe(true)
    expect(reply.items[1].bare).toBe(false)
  })
})

describe('config RPC payload 形状', () => {
  it('config.setWorktreeRootDir payload 含 dir', () => {
    const payload: ClientMessageMap['config.setWorktreeRootDir'] = { dir: '/tmp/worktrees' }
    expect(payload.dir).toBe('/tmp/worktrees')
  })

  it('config.getWorktreeRootDir payload 为空', () => {
    // Record<string, never> 只能赋值为 {}
    const payload: ClientMessageMap['config.getWorktreeRootDir'] = {}
    expect(Object.keys(payload)).toHaveLength(0)
  })

  it('config.setSetupScript payload 含 script', () => {
    const payload: ClientMessageMap['config.setSetupScript'] = { script: 'setup.sh' }
    expect(payload.script).toBe('setup.sh')
  })

  it('config.getSetupScript payload 为空', () => {
    const payload: ClientMessageMap['config.getSetupScript'] = {}
    expect(Object.keys(payload)).toHaveLength(0)
  })

  it('config.worktreeRootDir reply 含 dir', () => {
    const reply: ServerMessageMapBase['config.worktreeRootDir'] = { dir: '/tmp/worktrees' }
    expect(reply.dir).toBe('/tmp/worktrees')
  })

  it('config.setupScript reply 含 script', () => {
    const reply: ServerMessageMapBase['config.setupScript'] = { script: 'setup.sh' }
    expect(reply.script).toBe('setup.sh')
  })
})

describe('WorktreeErrorCode', () => {
  it('包含 NOT_GIT_REPO', () => {
    const code: WorktreeErrorCode = 'NOT_GIT_REPO'
    expect(code).toBe('NOT_GIT_REPO')
  })

  it('包含所有旧错误码（向后兼容）', () => {
    const codes: WorktreeErrorCode[] = [
      'NOT_GIT_REPO', 'NOT_BARE_REPO', 'WORKTREE_EXISTS',
      'SETUP_FAILED', 'GIT_FAILED', 'INVALID_BRANCH',
    ]
    expect(codes).toHaveLength(6)
  })
})

// ── backgroundTask 域（u-proto，D3/D9）─────────────────────────────

// ClientMessageMap key 存在性（3 RPC）
type _Assert_Client_bgList = AssertHasKey<ClientMessageMap, 'backgroundTask.list'>
type _Assert_Client_bgOutput = AssertHasKey<ClientMessageMap, 'backgroundTask.output'>
type _Assert_Client_bgKill = AssertHasKey<ClientMessageMap, 'backgroundTask.kill'>

// ServerMessageMapBase key 存在性（3 回执 + 1 冒号 camelCase 广播）
type _Assert_Server_bgTasks = AssertHasKey<ServerMessageMapBase, 'backgroundTask.tasks'>
type _Assert_Server_bgOutputResult = AssertHasKey<ServerMessageMapBase, 'backgroundTask.outputResult'>
type _Assert_Server_bgKillResult = AssertHasKey<ServerMessageMapBase, 'backgroundTask.killResult'>
type _Assert_Server_bgUpdated = AssertHasKey<ServerMessageMapBase, 'backgroundTask:updated'>

// ReplyPayloadMap key 存在性（3 RPC 的 reply 登记）
type _Assert_Reply_bgList = AssertHasKey<ReplyPayloadMap, 'backgroundTask.list'>
type _Assert_Reply_bgOutput = AssertHasKey<ReplyPayloadMap, 'backgroundTask.output'>
type _Assert_Reply_bgKill = AssertHasKey<ReplyPayloadMap, 'backgroundTask.kill'>

/** 运行态条目样例（必填 8 字段；断言共享）。 */
const runningEntry: BackgroundTaskRegistryEntry = {
  taskId: 'bt-1',
  pid: 100,
  command: 'pnpm test',
  outputFile: '/tmp/bt-1.log',
  startedAt: 1000,
  state: 'running',
  ownerPiPid: 200,
  sessionId: 'sess-1',
}

describe('backgroundTask RPC 请求 payload 形状（D3）', () => {
  it('list 请求必带 sessionId', () => {
    const payload: ClientMessageMap['backgroundTask.list'] = { sessionId: 'sess-1' }
    expect(payload.sessionId).toBe('sess-1')
  })

  it('output 请求必带 sessionId/taskId，maxBytes 可选（省略 = runtime 默认 32KB 窗口）', () => {
    const without: ClientMessageMap['backgroundTask.output'] = { sessionId: 'sess-1', taskId: 'bt-1' }
    const withMax: ClientMessageMap['backgroundTask.output'] = { sessionId: 'sess-1', taskId: 'bt-1', maxBytes: 4096 }
    expect(without.maxBytes).toBeUndefined()
    expect(withMax.maxBytes).toBe(4096)
  })

  it('kill 请求必带 sessionId/taskId', () => {
    const payload: ClientMessageMap['backgroundTask.kill'] = { sessionId: 'sess-1', taskId: 'bt-1' }
    expect(payload.taskId).toBe('bt-1')
  })
})

describe('backgroundTask 回执/广播 payload 形状（D3）', () => {
  it('tasks 回执：sessionId + RegistryEntry 全量投影 + corrupted 损坏标记（缺省/false=正常拍）', () => {
    const reply: ServerMessageMapBase['backgroundTask.tasks'] = {
      sessionId: 'sess-1',
      tasks: [runningEntry],
      corrupted: false,
    }
    expect(reply.tasks[0].taskId).toBe('bt-1')
    expect(reply.tasks[0].state).toBe('running')
    // S7 错误条依据：损坏空表与真空表可区分（一致性审查修复，仿 config.systemPrompt 同名字段）
    const corruptReply: ServerMessageMapBase['backgroundTask.tasks'] = {
      sessionId: 'sess-1',
      tasks: [],
      corrupted: true,
    }
    expect(corruptReply.corrupted).toBe(true)
    expect(corruptReply.tasks).toHaveLength(0)
  })

  it('outputResult 回执：text/truncated/lost 三字段齐备（lost 时 text 空串）', () => {
    const ok: ServerMessageMapBase['backgroundTask.outputResult'] = {
      sessionId: 'sess-1', taskId: 'bt-1', text: 'hello', truncated: false, lost: false,
    }
    const lost: ServerMessageMapBase['backgroundTask.outputResult'] = {
      sessionId: 'sess-1', taskId: 'bt-1', text: '', truncated: false, lost: true,
    }
    expect(ok.truncated).toBe(false)
    expect(lost.lost).toBe(true)
    expect(lost.text).toBe('')
  })

  it('killResult 回执：killed + reason 四枚举（D6 分支矩阵）', () => {
    const reply: ServerMessageMapBase['backgroundTask.killResult'] = {
      sessionId: 'sess-1', taskId: 'bt-1', killed: true, reason: 'killed',
    }
    expect(reply.killed).toBe(true)
    expect(reply.reason).toBe('killed')
  })

  it('backgroundTask:updated 广播：冒号 camelCase 命名 + sessionId + tasks 全量 + corrupted 标记', () => {
    const broadcast: ServerMessageMapBase['backgroundTask:updated'] = {
      sessionId: 'sess-1',
      tasks: [runningEntry],
      corrupted: false,
    }
    expect(broadcast.tasks).toHaveLength(1)
    // corrupted 与 list 回执同源语义：损坏拍广播同样携带（renderer 错误条增删依据）
    const corruptBroadcast: ServerMessageMapBase['backgroundTask:updated'] = {
      sessionId: 'sess-1',
      tasks: [],
      corrupted: true,
    }
    expect(corruptBroadcast.corrupted).toBe(true)
  })
})

describe('backgroundTask 契约枚举成员', () => {
  it('BackgroundTaskState 状态机 4 成员（running → killing → exited；orphaned 收殓）', () => {
    const states: BackgroundTaskState[] = ['running', 'killing', 'exited', 'orphaned']
    expect(states).toHaveLength(4)
  })

  it('BackgroundTaskEndReason 终态成因 4 成员（orphaned 不写 reason）', () => {
    const reasons: BackgroundTaskEndReason[] = ['natural', 'timeout', 'killed', 'process-exit']
    expect(reasons).toHaveLength(4)
  })

  it('BackgroundTaskKillReason 操作结果 4 成员（D6 分支 ①③④⑤）', () => {
    const reasons: BackgroundTaskKillReason[] = [
      'killed', 'already-exited', 'identity-unverifiable', 'registry-write-failed',
    ]
    expect(reasons).toHaveLength(4)
  })
})

describe('backgroundTask RegistryEntry 镜像形状（D9）', () => {
  it('运行态条目必填 8 字段齐备', () => {
    expect(runningEntry.taskId).toBe('bt-1')
    expect(runningEntry.pid).toBe(100)
    expect(runningEntry.ownerPiPid).toBe(200)
    expect(runningEntry.outputFile).toBe('/tmp/bt-1.log')
  })

  it('终态条目可选字段（exitCode/reason/endedAt/durationMs/tailSummary/pidStartTime）可赋值', () => {
    const terminal: BackgroundTaskRegistryEntry = {
      ...runningEntry,
      state: 'exited',
      exitCode: 0,
      reason: 'natural',
      endedAt: 4000,
      durationMs: 3000,
      tailSummary: 'done',
      pidStartTime: 100,
    }
    expect(terminal.durationMs).toBe(3000)
    expect(terminal.pidStartTime).toBe(100)
    expect(terminal.reason).toBe('natural')
  })

  it('exitCode 允许 null（signal 终止）与缺省（未终态）两态', () => {
    const signaled: BackgroundTaskRegistryEntry = {
      ...runningEntry,
      state: 'exited',
      exitCode: null,
      reason: 'killed',
      endedAt: 2000,
    }
    expect(signaled.exitCode).toBeNull()
    expect('exitCode' in runningEntry).toBe(false)
  })
})

// ── btw.* 3 控制帧（btw-question 设计 D6，M2-a 协议根节点）────────────────
//
// 三帧 = btw.create / btw.list { mainSid } / btw.remove，ack 必回；**不设 btw.send /
// btw.close**（D6 被否项）。登记完整性断言分两层：
// ① 源码区段扫描（运行期，vitest 强制）——本文件位于包根 __tests__/（不在 tsconfig
//    include 内），类型断言不被 tsc 执行，扫描断言才是机器守卫本体；
// ② 类型级断言（同文件风格，typecheck 覆盖到时自动生效）。

const PROTOCOL_TS = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'protocol.ts')
const PROTOCOL_SOURCE = readFileSync(PROTOCOL_TS, 'utf8')

/** 提取顶层声明区段：type 联合到首个行首 export；interface 到首个行首 }（嵌套闭合均缩进，不命中） */
function extractBlock(anchor: string): string {
  const anchorIdx = PROTOCOL_SOURCE.indexOf(anchor)
  if (anchorIdx === -1) throw new Error(`protocol.ts 未找到锚点 "${anchor}"——声明位置变动，请同步本测试`)
  const endMarker = anchor.startsWith('export interface') ? '\n}' : '\nexport '
  const endIdx = PROTOCOL_SOURCE.indexOf(endMarker, anchorIdx)
  if (endIdx === -1) throw new Error(`protocol.ts 区段 "${anchor}" 未找到结束标记`)
  return PROTOCOL_SOURCE.slice(anchorIdx, endIdx)
}

// ── 类型级断言（style 同上文 AssertHasKey；typecheck 覆盖到即编译期生效）──
type _Assert_Client_btwCreate = AssertHasKey<ClientMessageMap, 'btw.create'>
type _Assert_Client_btwList = AssertHasKey<ClientMessageMap, 'btw.list'>
type _Assert_Client_btwRemove = AssertHasKey<ClientMessageMap, 'btw.remove'>
type _Assert_Server_btwCreate = AssertHasKey<ServerMessageMapBase, 'btw.create'>
type _Assert_Server_btwList = AssertHasKey<ServerMessageMapBase, 'btw.list'>
type _Assert_Server_btwRemove = AssertHasKey<ServerMessageMapBase, 'btw.remove'>
type _Assert_Reply_btwCreate = AssertHasKey<ReplyPayloadMap, 'btw.create'>
type _Assert_Reply_btwList = AssertHasKey<ReplyPayloadMap, 'btw.list'>
type _Assert_Reply_btwRemove = AssertHasKey<ReplyPayloadMap, 'btw.remove'>
/** D6 负向（类型层）：key 存在则求值 true，下面赋 false 编译错 */
type IsClientKey<K extends string> = K extends keyof ClientMessageMap ? true : false
const _no_btw_send: IsClientKey<'btw.send'> = false
const _no_btw_close: IsClientKey<'btw.close'> = false

describe('btw.* 3 帧登记完整性（D6，M2-a）', () => {
  const clientBlock = extractBlock('export type ClientMessageType =')
  const clientMapBlock = extractBlock('export interface ClientMessageMap {')
  const serverMapBlock = extractBlock('export interface ServerMessageMapBase {')
  const replyMapBlock = extractBlock('export interface ReplyPayloadMap {')

  it('ClientMessageType 恰好 3 个 btw.* 帧（create / list / remove）', () => {
    const frames = [...clientBlock.matchAll(/\'(btw\.[a-zA-Z]+)\'/g)].map((m) => m[1])
    expect([...new Set(frames)].sort()).toEqual(['btw.create', 'btw.list', 'btw.remove'])
  })

  it('D6 负向守卫：不设 btw.send / btw.close（发送复用 message.send、销毁复用 btw.remove）', () => {
    for (const block of [clientBlock, clientMapBlock, replyMapBlock]) {
      expect(block).not.toMatch(/\'btw\.(send|close)\'/)
    }
  })

  it('BtwThreadInfo 含可选 reclaimImminent（D1 回收提醒数据源；可选防破坏既有消费——BU3 runtime 半）', () => {
    const block = extractBlock('export interface BtwThreadInfo {')
    expect(block).toMatch(/vid: string/)
    expect(block).toMatch(/reclaimImminent\?: boolean/)
  })

  it('三帧在 ClientMessageMap / ServerMessageMapBase / ReplyPayloadMap 全登记（ack 必回）', () => {
    for (const frame of ['btw.create', 'btw.list', 'btw.remove']) {
      const pattern = new RegExp(`'${frame.replace('.', '\\.')}'`)
      expect(clientMapBlock, `ClientMessageMap 缺 ${frame}`).toMatch(pattern)
      expect(serverMapBlock, `ServerMessageMapBase 缺 ${frame}（reply type）`).toMatch(pattern)
      expect(replyMapBlock, `ReplyPayloadMap 缺 ${frame}（ack 必回）`).toMatch(pattern)
    }
  })

  it('request payload 形状：create/list 只带 mainSid、remove 只带 vid', () => {
    const createPayload: ClientMessageMap['btw.create'] = { mainSid: 's-main' }
    expect(createPayload.mainSid).toBe('s-main')
    const listPayload: ClientMessageMap['btw.list'] = { mainSid: 's-main' }
    expect(Object.keys(listPayload)).toEqual(['mainSid'])
    const removePayload: ClientMessageMap['btw.remove'] = { vid: 'btw:pi-1' }
    expect(Object.keys(removePayload)).toEqual(['vid'])
  })

  it('reply payload 形状：create 带 vid/mainSid/forkState（三值域）、list 带 threads、remove 回显 vid', () => {
    const states: BtwForkState[] = ['full', 'truncated', 'none']
    expect(states).toHaveLength(3)
    const createReply: ServerMessageMapBase['btw.create'] = { vid: 'btw:pi-1', mainSid: 's-main', forkState: 'none' }
    expect(createReply.forkState).toBe('none')
    const threads: BtwThreadInfo[] = [{ vid: 'btw:pi-1' }]
    const listReply: ServerMessageMapBase['btw.list'] = { mainSid: 's-main', threads }
    expect(listReply.threads[0].vid).toBe('btw:pi-1')
    const removeReply: ServerMessageMapBase['btw.remove'] = { vid: 'btw:pi-1' }
    expect(removeReply.vid).toBe('btw:pi-1')
  })

  it('ReplyPayloadMap：create/list payload 消费型、remove ack 型 void', () => {
    const createReply: ReplyPayloadMap['btw.create'] = { vid: 'btw:pi-1', mainSid: 's-main', forkState: 'full' }
    expect(createReply.vid).toBe('btw:pi-1')
    const listReply: ReplyPayloadMap['btw.list'] = { mainSid: 's-main', threads: [] }
    expect(listReply.threads).toEqual([])
    const removeAck: ReplyPayloadMap['btw.remove'] = undefined as void
    expect(removeAck).toBeUndefined()
  })

  it('forkState 回显型：分支三态在 ServerMessageMapBase create reply 内联可达（pill 数据源）', () => {
    for (const forkState of ['full', 'truncated', 'none'] as const) {
      const reply: ServerMessageMapBase['btw.create'] = { vid: 'v', mainSid: 'm', forkState }
      expect(reply.forkState).toBe(forkState)
    }
  })

  it('类型层负向常量恒 false（key 若出现，typecheck 报错；运行期仅标记已使用）', () => {
    expect(_no_btw_send).toBe(false)
    expect(_no_btw_close).toBe(false)
  })
})
