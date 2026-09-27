import { describe, it, expect } from 'vitest'
import { buildFamilyIndex, resolveFamily } from '../core/family.js'
import type { Entry } from '../core/parser.js'

// ---- fixture 常量（映射 design §3.3 D-7 Q1 真实场景）----
const ROOT = '019fe620' // 家族根（无 parentSession）
const FORK = '019fe632' // fork 子代（parentSession 指向 ROOT 的文件）
const SUB = '019fe635' // subagent（rootSessionId=FORK，挂在 fork 子代下，非家族根）
const SUB2 = '019fe636' // U4 第二个 subagent（多 subagent 场景）

// ---- fixture helpers ----

/** 构造 session header entry（type=session，含 id/cwd，可选 parentSession） */
function header(id: string, opts?: { parentSession?: string; cwd?: string }): Entry {
  const e: Entry = { type: 'session', id, parentId: null, cwd: opts?.cwd ?? '/proj' }
  if (opts?.parentSession) e.parentSession = opts.parentSession
  return e
}

/** 模拟真实文件路径：含 sessionId 的 jsonl 路径（resolveParentSessionId 靠 includes 反查） */
function sessionFile(id: string): string {
  return `/sessions/2026-08-09T10-45-20Z_${id}.jsonl`
}

/** 构造 subagent-identity custom entry（data.rootSessionId/slug） */
function subagentIdentity(id: string, rootSessionId: string, slug: string): Entry {
  return {
    type: 'custom',
    id,
    parentId: null,
    customType: 'subagent-identity',
    data: { rootSessionId, slug },
  }
}

/** U4 富字段（可选，模拟 manifest 主/P-fallback identity 回退组装的 data） */
interface SubagentRichFields {
  task?: string
  agent?: string
  model?: string
  status?: string
  sessionFile?: string
}

/** 构造带 U4 富字段的 subagent-identity custom entry（manifest 主/P-fallback 两种 data 形态） */
function subagentIdentityRich(
  id: string,
  rootSessionId: string,
  slug: string,
  rich?: SubagentRichFields,
): Entry {
  const data: Record<string, unknown> = { rootSessionId, slug }
  if (rich?.task !== undefined) data.task = rich.task
  if (rich?.agent !== undefined) data.agent = rich.agent
  if (rich?.model !== undefined) data.model = rich.model
  if (rich?.status !== undefined) data.status = rich.status
  if (rich?.sessionFile !== undefined) data.sessionFile = rich.sessionFile
  return { type: 'custom', id, parentId: null, customType: 'subagent-identity', data }
}

/** 构造 fileStats Map（M1 key=sessionId） */
function makeStats(
  keys: string[],
  opts: { mtime?: number; size?: number } = {},
): Map<string, { mtime: number; size: number }> {
  const { mtime = 1000, size = 5000 } = opts
  const m = new Map<string, { mtime: number; size: number }>()
  for (const k of keys) m.set(k, { mtime, size })
  return m
}

/** Q1 核心 fixture：ROOT ← fork ← FORK；subagent SUB 挂在 fork 子代 FORK 下 */
function q1Fixture(aliveKeys: string[] = [ROOT, FORK, SUB]) {
  return {
    headers: [header(ROOT), header(FORK, { parentSession: sessionFile(ROOT) })],
    identities: [subagentIdentity(SUB, FORK, 'deep-survey')],
    fileStats: makeStats(aliveKeys),
  }
}

describe('buildFamilyIndex', () => {
  it('byId / childrenOf / subagentsByRoot 结构正确', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    expect(index.byId.has(ROOT)).toBe(true)
    expect(index.byId.has(FORK)).toBe(true)
    expect(index.byId.get(ROOT)?.cwd).toBe('/proj')

    // childrenOf key 是父 sessionId（经 parentSession 文件路径反查）
    expect(index.childrenOf.get(ROOT)).toHaveLength(1)
    expect(index.childrenOf.get(ROOT)?.[0].sessionId).toBe(FORK)

    // subagentsByRoot key 是 rootSessionId
    expect(index.subagentsByRoot.get(FORK)).toHaveLength(1)
    expect(index.subagentsByRoot.get(FORK)?.[0].sessionId).toBe(SUB)
    expect(index.subagentsByRoot.get(FORK)?.[0].slug).toBe('deep-survey')
  })

  it('parentSession 是文件路径：经 sessionId 子串反查建 childrenOf', () => {
    const headers = [
      header('aaa'),
      header('bbb', { parentSession: '/some/dir/2026-01-01T00-00-00Z_aaa.jsonl' }),
    ]
    const index = buildFamilyIndex(headers, [], new Map())

    expect(index.childrenOf.get('aaa')?.[0].sessionId).toBe('bbb')
  })

  it('parentSession 反查不到父 → 该 entry 不进 childrenOf（不报错）', () => {
    const headers = [header('bbb', { parentSession: '/missing.jsonl' })]
    const index = buildFamilyIndex(headers, [], new Map())

    expect(index.childrenOf.size).toBe(0)
  })

  it('identity 缺 rootSessionId/slug → 跳过（坏数据容错）', () => {
    const bad: Entry = {
      type: 'custom',
      id: 'x',
      parentId: null,
      customType: 'subagent-identity',
      data: { slug: 'no-root' },
    }
    const index = buildFamilyIndex([], [bad], new Map())

    expect(index.subagentsByRoot.size).toBe(0)
  })

  it('fileStats 原样存入 index（供 cleanedUp 判断用）', () => {
    const fileStats = makeStats(['s1'])
    const index = buildFamilyIndex([], [], fileStats)

    expect(index.fileStats).toBe(fileStats)
  })
})

describe('resolveFamily - 隔代关联（design §3.3 D-7 Q1 核心断言）', () => {
  it('从家族根 resolve 能关联到挂在 fork 子代下的隔代 subagent', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    const family = resolveFamily(ROOT, index)

    // Q1 核心：subagent SUB 的 rootSessionId 是 fork 子代 FORK，不是 root ROOT。
    // 只查 root 的 subagentsByRoot 会漏；必须对 fork 链每个节点（含 forks）查。
    expect(family.subagents.some((s) => s.sessionId === SUB)).toBe(true)
    expect(family.subagents.find((s) => s.sessionId === SUB)?.slug).toBe('deep-survey')
  })

  it('从 fork 子代 resolve 也能关联到直接挂在其下的 subagent', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    const family = resolveFamily(FORK, index)
    expect(family.subagents.some((s) => s.sessionId === SUB)).toBe(true)
  })
})

describe('resolveFamily - fork 链', () => {
  it('fork 子代的 parents 含 root；root 的 forks 含 fork 子代', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    expect(resolveFamily(FORK, index).parents.some((p) => p.sessionId === ROOT)).toBe(true)
    expect(resolveFamily(ROOT, index).forks.some((f) => f.sessionId === FORK)).toBe(true)
  })

  it('root 无 parentSession → parents 空、forks 取 childrenOf', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    const family = resolveFamily(ROOT, index)
    expect(family.parents).toEqual([])
    expect(family.forks.map((f) => f.sessionId)).toEqual([FORK])
  })

  it('线性多级 fork 链：C←B←A，resolveFamily(C).parents=[B,A]', () => {
    const headers = [
      header('A'),
      header('B', { parentSession: sessionFile('A') }),
      header('C', { parentSession: sessionFile('B') }),
    ]
    const index = buildFamilyIndex(headers, [], new Map())

    const family = resolveFamily('C', index)
    expect(family.parents.map((p) => p.sessionId)).toEqual(['B', 'A'])
    // forks 只含直接子代（孙代 C 是 B 的子代，不是 A 的直接子代）
    expect(resolveFamily('A', index).forks.map((f) => f.sessionId)).toEqual(['B'])
    expect(resolveFamily('B', index).forks.map((f) => f.sessionId)).toEqual(['C'])
  })

  it('workflows 恒为空数组（M1，接口字段保留供 M2）', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    expect(resolveFamily(ROOT, index).workflows).toEqual([])
  })
})

describe('resolveFamily - cleanedUp（subagent 文件被 GC）', () => {
  it('identity 在但 fileStats 不含其 sessionId → cleanedUp=true', () => {
    const { headers, identities, fileStats } = q1Fixture([ROOT, FORK]) // SUB 不在 fileStats（已 GC）
    const index = buildFamilyIndex(headers, identities, fileStats)

    const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
    expect(sub?.cleanedUp).toBe(true)
  })

  it('identity 在且 fileStats 含其 sessionId → cleanedUp=false', () => {
    const { headers, identities, fileStats } = q1Fixture() // 默认 [ROOT,FORK,SUB]，SUB 存活
    const index = buildFamilyIndex(headers, identities, fileStats)

    const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
    expect(sub?.cleanedUp).toBe(false)
  })
})

describe('resolveFamily - 错误', () => {
  it('sessionId 不在 index → 抛 Error', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    expect(() => resolveFamily('unknown-session', index)).toThrow(/not found in family index/)
  })
})

// ============================================================
// U4: SubagentRef 富字段（manifest 主 / P-fallback identity 回退）
// 验证 buildFamilyIndex 从 identity entry.data 读 task/agent/model/status/sessionFile
// 填 SubagentRef，异名映射（data.agent → agentName），守卫放宽（只校验 rootSessionId+slug）。
// ============================================================

describe('U4: SubagentRef 富字段（buildFamilyIndex 透传）', () => {
  it('TC-u4-manifest-enrich: manifest 主路径，富字段全透传到 SubagentRef', () => {
    const identities = [
      subagentIdentityRich(SUB, ROOT, 'codex-research', {
        task: '调研 codex',
        agent: 'explorer',
        model: 'glm-5.2',
        status: 'completed',
        sessionFile: '/path/to/sub.jsonl',
      }),
    ]
    const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT, SUB]))

    const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
    expect(sub?.task).toBe('调研 codex')
    expect(sub?.slug).toBe('codex-research')
    // 异名映射核心断言：identity.data.agent → SubagentRef.agentName
    expect(sub?.agentName).toBe('explorer')
    expect(sub?.model).toBe('glm-5.2')
    expect(sub?.status).toBe('completed')
    expect(sub?.sessionFile).toBe('/path/to/sub.jsonl')
    expect(sub?.cleanedUp).toBe(false)
  })

  it('TC-u4-pfallback-identity: P-fallback（有 identity 无 model/status），task/agent/sessionFile 透传', () => {
    const identities = [
      subagentIdentityRich(SUB, ROOT, 'fix', {
        task: 'fix bug',
        agent: 'worker',
        sessionFile: '/alive/sub.jsonl',
        // 无 model/status（P-fallback identity 不含这两项，探针 15/15 确认）
      }),
    ]
    const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT, SUB]))

    const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
    expect(sub?.task).toBe('fix bug')
    expect(sub?.slug).toBe('fix')
    expect(sub?.agentName).toBe('worker')
    expect(sub?.sessionFile).toBe('/alive/sub.jsonl')
    // P-fallback 核心断言：model/status 必 undefined（identity 不可回退）
    expect(sub?.model).toBeUndefined()
    expect(sub?.status).toBeUndefined()
  })

  it('TC-u4-pfallback-no-identity: data 缺 rootSessionId → 守卫拒掉，不入 subagentsByRoot，不抛错', () => {
    // 模拟无 identity（运行中/异常，尾行是 message 非 identity）：data 只有 slug 无 rootSessionId
    const noRoot: Entry = {
      type: 'custom',
      id: 'no-root',
      parentId: null,
      customType: 'subagent-identity',
      data: { slug: 'dangling', task: 't' }, // 缺 rootSessionId
    }
    const index = buildFamilyIndex([header(ROOT)], [noRoot], makeStats([ROOT]))

    // 守卫拒掉 → 不入 subagentsByRoot
    expect(index.subagentsByRoot.size).toBe(0)
    // resolveFamily 不抛错，subagents 空
    const family = resolveFamily(ROOT, index)
    expect(family.subagents).toHaveLength(0)
  })

  it('TC-u4-orphan-manifest: fileStats 不含 id → cleanedUp=true，富字段仍透传（GC 路径保留）', () => {
    const identities = [
      subagentIdentityRich('sa-ghost', ROOT, 'ghost-slug', {
        task: 'ghost task',
        agent: 'worker',
        model: 'gpt-4',
        status: 'completed',
        sessionFile: '/gc/ghost.jsonl',
      }),
    ]
    // fileStats 不含 'sa-ghost'（模拟 .jsonl 被 GC，manifest 残留）→ cleanedUp=true
    const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT]))

    const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === 'sa-ghost')
    expect(sub?.cleanedUp).toBe(true)
    expect(sub?.task).toBe('ghost task')
    expect(sub?.agentName).toBe('worker')
    expect(sub?.model).toBe('gpt-4')
    expect(sub?.status).toBe('completed')
    expect(sub?.sessionFile).toBe('/gc/ghost.jsonl') // GC 路径保留（不置空）
  })

  it('TC-u4-recordmanifest-compat: 最小 identity（仅 rootSessionId+slug）→ 富字段全 undefined，不抛错', () => {
    // 模拟旧 manifest（无 task/slug/model/status/agentName）经 buildFamilyFromFs 转成的最小 identity
    const identities = [subagentIdentity(SUB, ROOT, 'legacy')]
    const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT, SUB]))

    const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
    expect(sub?.slug).toBe('legacy')
    expect(sub?.rootSessionId).toBe(ROOT)
    expect(sub?.task).toBeUndefined()
    expect(sub?.agentName).toBeUndefined()
    expect(sub?.model).toBeUndefined()
    expect(sub?.status).toBeUndefined()
    expect(sub?.sessionFile).toBeUndefined()
  })

  it('isSubagentIdentityData 守卫放宽：富字段部分缺失/全缺都通过（只校验 rootSessionId+slug）', () => {
    const identities = [
      subagentIdentityRich(SUB, ROOT, 's1', { task: 'only-task' }), // 部分富字段
      subagentIdentity(SUB2, ROOT, 's2'), // 完全无富字段（旧 manifest 形态）
    ]
    const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT, SUB, SUB2]))

    const family = resolveFamily(ROOT, index)
    expect(family.subagents).toHaveLength(2)
    const s1 = family.subagents.find((s) => s.sessionId === SUB)
    expect(s1?.task).toBe('only-task')
    expect(s1?.model).toBeUndefined()
    const s2 = family.subagents.find((s) => s.sessionId === SUB2)
    expect(s2?.task).toBeUndefined()
    expect(s2?.agentName).toBeUndefined()
  })
})
