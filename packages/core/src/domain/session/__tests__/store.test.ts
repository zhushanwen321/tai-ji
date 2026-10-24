/**
 * createSessionStore 单测（IF1）。
 *
 * 覆盖 plan TC-1..TC-6：list 派生 / appendSession 归组 / removeFromList 回退与空组移除 /
 * applySnapshot 合并语义（D1b）/ markDead+revive / listLoadError+active 派生。
 * W13 三写入口（setGroups/updateLabel/updateSessionState）收敛为 applySnapshot 后，
 * 合并规则用例三组：整字段覆盖 / 显式空值覆盖 / 乐观更新形态。
 * node 环境实测 vue reactivity（ref/computed），零 mock。
 */
import { describe, expect, it } from 'vitest'
import type { SessionViewSnapshot,  SessionSummary, SessionGroup } from '@taiji/shared'
import { createSessionStore } from '../store'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    label: overrides.id,
    cwd: '/work/a',
    status: 'idle',
    lastActiveAt: 0,
    ...overrides,
  }
}

describe('createSessionStore', () => {
  it('TC-1: applySnapshot 整表形态 → list 派生（flatMap 展平、顺序保持、跟随更新）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a' })
    const s2 = makeSession({ id: 's2', cwd: '/a' })
    const s3 = makeSession({ id: 's3', cwd: '/b' })

    store.applySnapshot({
      groups: [
        { cwd: '/a', sessions: [s1, s2] },
        { cwd: '/b', sessions: [s3] },
      ],
    })
    expect(store.list.value.map((s) => s.id)).toEqual(['s1', 's2', 's3'])

    // 整表快照换新数组后 list 同步变化（响应性，非一次性快照）
    store.applySnapshot({ groups: [{ cwd: '/b', sessions: [s3] }] })
    expect(store.list.value.map((s) => s.id)).toEqual(['s3'])
  })

  it('TC-2: appendSession 按 cwd 归组（命中入尾 / 新建组在末尾）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a' })
    const s2 = makeSession({ id: 's2', cwd: '/a' })
    const s3 = makeSession({ id: 's3', cwd: '/c' })

    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })
    store.appendSession(s2)
    expect(store.groups.value).toEqual([{ cwd: '/a', sessions: [s1, s2] }])

    // 未命中 cwd → 新建组追加在末尾，原组顺序不变
    store.appendSession(s3)
    expect(store.groups.value.map((g) => g.cwd)).toEqual(['/a', '/c'])
    expect(store.groups.value[1].sessions.map((s) => s.id)).toEqual(['s3'])
  })

  it('TC-3: removeFromList 删 active 回退 list[0]、空组移除、删非 active 不影响 activeId', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a' })
    const s2 = makeSession({ id: 's2', cwd: '/a' })
    const s3 = makeSession({ id: 's3', cwd: '/b' })
    store.applySnapshot({
      groups: [
        { cwd: '/a', sessions: [s1, s2] },
        { cwd: '/b', sessions: [s3] },
      ],
    })
    store.activeId.value = 's2'

    // 删 active → 回退删除后 list[0]（s1）
    store.removeFromList('s2')
    expect(store.activeId.value).toBe('s1')
    expect(store.groups.value).toEqual([{ cwd: '/a', sessions: [s1] }, { cwd: '/b', sessions: [s3] }])

    // 删非 active → activeId 不变
    store.removeFromList('s3')
    expect(store.activeId.value).toBe('s1')

    // 删空组：删 s1 后 /a 组清空 → 组移除，仅剩 /b 空组？/b 已删 s3 为空——应被整体移除
    store.removeFromList('s1')
    expect(store.groups.value).toEqual([])
    expect(store.activeId.value).toBeNull()
  })

  it('TC-4: applySnapshot 单 session 描述字段——undefined 跳过、未知 id 静默', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'old', status: 'idle' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    store.applySnapshot('s1', { label: '新名' })
    expect(store.list.value[0].label).toBe('新名')

    // 快照未涉及的字段（undefined）保留现值：只给 status，label 不变
    store.applySnapshot('s1', { status: 'active' })
    expect(store.list.value[0].status).toBe('active')
    expect(store.list.value[0].label).toBe('新名')

    // 未知 id 静默无副作用
    store.applySnapshot('nope', { label: 'x', status: 'dead' })
    expect(store.list.value[0].label).toBe('新名')
    expect(store.list.value[0].status).toBe('active')
  })

  it('TC-4a: D1b 合并规则——描述字段整字段覆盖（多字段一次到位）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'old', status: 'idle' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    store.applySnapshot('s1', { label: '扫描名', status: 'done' })
    const after = store.list.value[0]
    expect(after.label).toBe('扫描名')
    expect(after.status).toBe('done')

    // status 也走同一合并路径（session.exited 类状态迁移）
    store.applySnapshot('s1', { status: 'dead' })
    expect(store.list.value[0].status).toBe('dead')
  })

  it('TC-4b: D1b 合并规则——显式空值覆盖（owner 声明空即空，不保留旧真值）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: '旧名' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // owner 权威空值（sessionName 空 = 未命名合法态，wire 到快照层为 label:''）覆盖
    store.applySnapshot('s1', { label: '' })
    expect(store.list.value[0].label).toBe('')
  })

  // ── [W1 会话架构四层分离] 状态字段不再由导航列表承载 ──────────────────
  // 设计 §3.3 删除清单：applySnapshot 不再写 modelId / thinkingLevel / tokenCount。
  // 状态权威 = domain/session/live-state（唯一写入口 applyLiveState）。
  // [W3] 三状态字段已从 SessionSummary 类型删除（状态归状态层，列表只承载导航）——
  // 原「列表条目带种子字段」的断言形态随之退役：不变量反向锁定为「状态帧里的同名
  // 字段落不进列表条目」（条目上无该属性）。以下用例维持该锁定。

  it('TC-W1-1: 单条快照带状态字段 → 列表条目不被写入（列表只托管描述字段）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    store.applySnapshot('s1', { modelId: 'state/model', thinkingLevel: 'high', tokenCount: 999 })
    const after = store.list.value[0]
    // W3：条目上不再存在三状态字段（类型级删除），状态帧写入目标 = 状态层而非列表
    expect(after).not.toHaveProperty('modelId')
    expect(after).not.toHaveProperty('thinkingLevel')
    expect(after).not.toHaveProperty('tokenCount')
    expect(after.label).toBe('s1')
  })

  it('TC-W1-2: 列表外 id 的单条快照不写入任何条目（状态层才是列表外 id 的落点）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // btw 线 session id（runtime hidden 注册，不进侧栏列表）——列表不新增条目、不抛错
    store.applySnapshot('pi-line-1', { modelId: 'line/model', label: 'x' })
    expect(store.list.value.map((s) => s.id)).toEqual(['s1'])
  })

  it('TC-W1-3: 整表刷新只替换列表条目（描述字段随载荷），不涉及状态容器', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'a', status: 'idle' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // 归档 / 项目过滤 / 刷新都只是整表替换：列表条目随载荷
    const next = makeSession({ id: 's1', label: 'a', status: 'done' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [next] }] })
    expect(store.list.value[0].status).toBe('done')

    // 状态层不受影响（此处只验证列表侧语义：列表 ≠ 状态容器，W1 后不变量见 live-state.test.ts）
    store.applySnapshot({ groups: [] })
    expect(store.list.value).toEqual([])
  })

  it('TC-4d: 单 session 快照 undefined → 整条静默跳过（描述字段全保留）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'old', status: 'active' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // 防御路径：广播 payload 缺失时快照可为 undefined
    ;(store.applySnapshot as (id: string, snapshot?: SessionViewSnapshot) => void)('s1', undefined)
    const after = store.list.value[0]
    expect(after.label).toBe('old')
    expect(after.status).toBe('active')
  })

  it('TC-4c: 乐观更新形态——本地入参只带乐观字段，权威广播回流幂等收敛', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: '旧名' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // rename 乐观更新：applySnapshot 本地入参只带 label，UI 即时显示
    store.applySnapshot('s1', { label: '乐观名' })
    expect(store.list.value[0].label).toBe('乐观名')

    // config.sessions 权威整表回流：同一入口覆盖为 runtime 真值（重复写入幂等）
    const authoritative = makeSession({ id: 's1', label: '权威名' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [authoritative] }] })
    expect(store.list.value[0].label).toBe('权威名')
  })

  it('TC-5: markDead / revive 状态切换（revive 仅 dead→idle）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', status: 'idle' })
    const s2 = makeSession({ id: 's2', status: 'active' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1, s2] }] })

    store.markDead('s1')
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')
    // 已是 dead 再 markDead 保持 dead
    store.markDead('s1')
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')

    store.revive('s1')
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('idle')

    // 非 dead（active）revive 无副作用
    store.revive('s2')
    expect(store.list.value.find((s) => s.id === 's2')?.status).toBe('active')

    // 未知 id 静默
    store.markDead('nope')
    store.revive('nope')
    expect(store.list.value.length).toBe(2)
  })

  it('TC-5b: markDead 后全量快照保留 dead 态（session.exited 后紧接 config.sessions 全量覆盖不冲掉 dead）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a', status: 'active' })
    const s2 = makeSession({ id: 's2', cwd: '/a', status: 'active' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1, s2] }] })

    store.markDead('s1')
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')

    // runtime 全量广播 config.sessions：s1 来自磁盘 outcome（stopped），s2 正常 idle。
    // dead 是运行时进程态（比磁盘 outcome 新），不得被覆盖
    store.applySnapshot({
      groups: [
        {
          cwd: '/a',
          sessions: [
            makeSession({ id: 's1', cwd: '/a', status: 'stopped' }),
            makeSession({ id: 's2', cwd: '/a', status: 'idle' }),
          ],
        },
      ],
    })
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')
    expect(store.list.value.find((s) => s.id === 's2')?.status).toBe('idle')

    // 新列表中不存在的 dead session 不保留（首 turn 无文件死亡的终结语义：随列表消失）
    store.markDead('s2')
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [makeSession({ id: 's1', cwd: '/a', status: 'done' })] }] })
    expect(store.list.value.map((s) => s.id)).toEqual(['s1'])
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')
  })

  it('TC-5c: revive 后全量快照不再保持 dead（restoreSession 成功后磁盘态正常生效）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a', status: 'active' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })
    store.markDead('s1')
    store.revive('s1')
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('idle')

    // revive 后全量刷新：新列表状态原样生效（不再被 dead 保留逻辑钉住）
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [makeSession({ id: 's1', cwd: '/a', status: 'idle' })] }] })
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('idle')
  })

  // [W13 单入口薄壳，goal-audit 问题 3] markDead/revive 内部改经 applySnapshot(id, { status })
  // 局部快照——行为等价性固化：局部写不吞同条目其它托管字段（D1b undefined=快照未涉及），
  // status 变化保持响应式（侧栏 dead 置灰 / revive 恢复由同一链路驱动）。
  it('TC-5d: markDead/revive 经 applySnapshot 薄壳——局部快照不吞其它托管字段', () => {
    const store = createSessionStore()
    store.applySnapshot({
      groups: [{
        cwd: '/a',
        sessions: [makeSession({ id: 's1', label: '原名', status: 'active' })],
      }],
    })

    store.markDead('s1')
    const dead = store.list.value.find((s) => s.id === 's1')
    expect(dead?.status).toBe('dead')
    // 局部快照只带 status：label 等托管字段原样保留（不被 undefined 覆盖）
    // （W3 起 modelId 等三状态字段不在 SessionSummary 上，「不吞字段」断言收敛到描述字段）
    expect(dead?.label).toBe('原名')

    store.revive('s1')
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('idle')
  })

  it('TC-6: listLoadError set/清空 + active 按 activeId 派生', () => {
    const store = createSessionStore()
    expect(store.listLoadError.value).toBeNull()

    store.setListLoadError('加载失败，点击重试')
    expect(store.listLoadError.value).toBe('加载失败，点击重试')

    store.setListLoadError(null)
    expect(store.listLoadError.value).toBeNull()

    // active 派生
    const s1 = makeSession({ id: 's1' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })
    expect(store.active.value).toBeNull() // activeId 未设

    store.activeId.value = 's1'
    expect(store.active.value?.id).toBe('s1')

    store.activeId.value = 'ghost'
    expect(store.active.value).toBeNull() // 未命中
  })
})
