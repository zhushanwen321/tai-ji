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
    modelId: '',
    tokenCount: 0,
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

  it('TC-4: applySnapshot 单 session 快照 undefined 跳过、未知 id 静默', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'old', modelId: 'm1', thinkingLevel: 'medium' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    store.applySnapshot('s1', { label: '新名' })
    expect(store.list.value[0].label).toBe('新名')

    // 快照未涉及的字段（undefined）保留现值：只给 modelId，thinkingLevel 不变
    store.applySnapshot('s1', { modelId: 'm2' })
    expect(store.list.value[0].modelId).toBe('m2')
    expect(store.list.value[0].thinkingLevel).toBe('medium')

    store.applySnapshot('s1', { thinkingLevel: 'low' })
    expect(store.list.value[0].modelId).toBe('m2')
    expect(store.list.value[0].thinkingLevel).toBe('low')

    // 未知 id 静默无副作用
    store.applySnapshot('nope', { modelId: 'm3', label: 'x' })
    expect(store.list.value[0].modelId).toBe('m2')
    expect(store.list.value[0].label).toBe('新名')
  })

  it('TC-4a: D1b 合并规则——owner 快照整字段覆盖（多字段一次到位）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'old', modelId: 'm1', thinkingLevel: 'low', tokenCount: 10 })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // state_changed 广播形态：modelId + thinkingLevel 同帧整字段覆盖
    store.applySnapshot('s1', { modelId: 'm2', thinkingLevel: 'high' })
    const after = store.list.value[0]
    expect(after.modelId).toBe('m2')
    expect(after.thinkingLevel).toBe('high')
    // 未涉及字段保留
    expect(after.label).toBe('old')
    expect(after.tokenCount).toBe(10)

    // status 也走同一合并路径（session.exited 类状态迁移）
    store.applySnapshot('s1', { status: 'dead' })
    expect(store.list.value[0].status).toBe('dead')
  })

  it('TC-4b: D1b 合并规则——显式空值覆盖（owner 声明空即空，不保留旧真值）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', modelId: 'm1', thinkingLevel: 'high', tokenCount: 100 })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // owner 快照显式给空串/0 → 覆盖（与旧 patch 语义的差异点即在此：
    // 磁盘扫描占位值的空守卫归 W15，见下方 TC-W15 组）
    store.applySnapshot('s1', { modelId: '', thinkingLevel: '', tokenCount: 0 })
    const after = store.list.value[0]
    expect(after.modelId).toBe('')
    expect(after.thinkingLevel).toBe('')
    expect(after.tokenCount).toBe(0)
  })

  // ── W15 磁盘占位值守卫（D1b 按来源分流，双向断言）──────────────────
  // 快照来源：source:'scan' = 磁盘扫描占位（守卫生效）；缺省 = owner 权威（D1b 照常）。

  it('TC-W15-1: 扫描来源快照的占位 modelId 空串不覆盖已知真值', () => {
    const store = createSessionStore()
    // 实例/广播已入真值（重开 session 后 state_changed 收敛的形态）
    const s1 = makeSession({ id: 's1', modelId: 'provider/m-true', tokenCount: 42 })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // 扫描来源快照带占位 modelId:''（source:'scan' 显式标记占位语义）→ 真值保留
    store.applySnapshot('s1', { modelId: '', source: 'scan' })
    expect(store.list.value[0].modelId).toBe('provider/m-true')
  })

  it('TC-W15-2: 扫描来源快照的占位 tokenCount 0 不覆盖已知真值', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', modelId: 'm1', tokenCount: 512 })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    store.applySnapshot('s1', { tokenCount: 0, source: 'scan' })
    expect(store.list.value[0].tokenCount).toBe(512)

    // 双字段同帧（scannedToSummary 产出形态）：占位 ''/0 都被守卫，真值均保留
    store.applySnapshot('s1', { modelId: '', tokenCount: 0, source: 'scan' })
    expect(store.list.value[0].modelId).toBe('m1')
    expect(store.list.value[0].tokenCount).toBe(512)
  })

  it('TC-W15-3: owner 快照的权威空值必须覆盖旧名/旧值（防守卫扩大化）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: '旧名', modelId: 'm1', tokenCount: 100 })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // owner 权威空值（缺省来源，无 source:'scan'）：sessionName 空 = 未命名 = 权威空
    // （label 空值语义沿用登记表 #1——pi sessionName 空 = 未命名合法态，wire 到快照层
    // 为 label:''；label 实例已撤销，PR #185 MF1，语义不变）必须覆盖旧名——守卫只对
    // 扫描来源生效，不得把 owner 空值语义一并拦掉（D1b 两条规则不混用）。
    store.applySnapshot('s1', { label: '' })
    expect(store.list.value[0].label).toBe('')

    // owner 的 modelId:''/tokenCount:0 同理正常覆盖（与 TC-4b 同语义，此处锚定守卫未扩大化）
    store.applySnapshot('s1', { modelId: '', tokenCount: 0 })
    expect(store.list.value[0].modelId).toBe('')
    expect(store.list.value[0].tokenCount).toBe(0)
  })

  it('TC-W15-4: owner 快照的 modelId 真值正常覆盖（不因守卫误伤真值路径）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', modelId: 'provider/m-old', thinkingLevel: 'low' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // state_changed 广播形态（owner）：真值照常整字段覆盖
    store.applySnapshot('s1', { modelId: 'provider/m-new', thinkingLevel: 'high' })
    const after = store.list.value[0]
    expect(after.modelId).toBe('provider/m-new')
    expect(after.thinkingLevel).toBe('high')
  })

  it('TC-W15-5: 守卫边界——扫描快照的非占位字段照常合并；target 同为占位时覆盖等值无害', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', modelId: '', tokenCount: 0, status: 'idle' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // 守卫只拦占位空值：扫描快照的非守卫字段（label/status/thinkingLevel）与占位真值
    // （如未来扫描能读出的非空 modelId）照常 D1b 覆盖
    store.applySnapshot('s1', { label: '扫描名', status: 'done', thinkingLevel: 'high', modelId: 'scanned-true', source: 'scan' })
    const after = store.list.value[0]
    expect(after.label).toBe('扫描名')
    expect(after.status).toBe('done')
    expect(after.thinkingLevel).toBe('high')
    expect(after.modelId).toBe('scanned-true')

    // 覆盖后的非空 modelId 再次遭遇扫描占位快照 → 守卫生效保留真值（与 TC-W15-1 同语义）
    store.applySnapshot('s1', { modelId: '', source: 'scan' })
    expect(store.list.value[0].modelId).toBe('scanned-true')

    // target 的 modelId/tokenCount 本身是占位（''/0）时，扫描占位快照覆盖与否等值——
    // 行为单一（走覆盖分支），用干净占位条目断言值不变即可
    const s2 = makeSession({ id: 's2', modelId: '', tokenCount: 0 })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s2] }] })
    store.applySnapshot('s2', { modelId: '', tokenCount: 0, source: 'scan' })
    expect(store.list.value.find((s) => s.id === 's2')?.modelId).toBe('')
    expect(store.list.value.find((s) => s.id === 's2')?.tokenCount).toBe(0)
  })

  it('TC-4d: 单 session 快照 undefined → 整条静默跳过（mergeViewSnapshot 空快照守卫，托管字段全保留）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'old', modelId: 'm1', status: 'active', tokenCount: 9 })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // 调用方传 undefined 快照（如广播 payload 字段缺失的防御路径）：不抛、不产生任何
    // 字段变化——五个托管字段（label/status/modelId/thinkingLevel/tokenCount）原样保留
    // 防御路径：广播 payload 缺失时快照可为 undefined——经视图注入保持断言语义
    ;(store.applySnapshot as (id: string, snapshot?: SessionViewSnapshot) => void)('s1', undefined)
    const after = store.list.value[0]
    expect(after.label).toBe('old')
    expect(after.status).toBe('active')
    expect(after.modelId).toBe('m1')
    expect(after.tokenCount).toBe(9)
  })

  it('TC-4c: 乐观更新形态——本地入参只带乐观字段，权威广播回流幂等收敛', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: '旧名', modelId: 'm1' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // rename 乐观更新：applySnapshot 本地入参只带 label，UI 即时显示
    store.applySnapshot('s1', { label: '乐观名' })
    expect(store.list.value[0].label).toBe('乐观名')

    // config.sessions 权威整表回流：同一入口覆盖为 runtime 真值（重复写入幂等）
    const authoritative = makeSession({ id: 's1', label: '权威名', modelId: 'm1' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [authoritative] }] })
    expect(store.list.value[0].label).toBe('权威名')

    // switchModel 乐观更新：单字段快照立即生效，不依赖 state_changed 广播
    store.applySnapshot('s1', { modelId: 'provider/m9' })
    expect(store.list.value[0].modelId).toBe('provider/m9')
    // state_changed 广播随后到达，同值收敛（幂等）
    store.applySnapshot('s1', { modelId: 'provider/m9', thinkingLevel: 'max' })
    expect(store.list.value[0].modelId).toBe('provider/m9')
    expect(store.list.value[0].thinkingLevel).toBe('max')
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
        sessions: [makeSession({ id: 's1', label: '原名', modelId: 'provider/m1', status: 'active' })],
      }],
    })

    store.markDead('s1')
    const dead = store.list.value.find((s) => s.id === 's1')
    expect(dead?.status).toBe('dead')
    // 局部快照只带 status：label/modelId 等托管字段原样保留（不被 undefined 覆盖）
    expect(dead?.label).toBe('原名')
    expect(dead?.modelId).toBe('provider/m1')

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
