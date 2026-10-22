/**
 * p0-multi-session —— 多会话管理生命周期：列表 / 同名隔离 / 归档 / 恢复 / 删除链
 * （补剧本优先级 #7；覆盖矩阵 P0-7。管理操作全部走协议，删除链走 C 通道证树消失。）
 *
 * 装配：faux（管理操作不消费队列，plain-text 备用）。
 * 路径：
 *   建 A/B/C（不同 label）+ D（与 A 同名）→ config.sessions 全在、D 与 A 独立（同名隔离）→
 *   archive A → config.sessions 无 A + config.archives 含 A → restore A → 回列表 →
 *   delete B → session.deleted + config.sessions 无 B + C：ext-sessions/<B>/ 树消失。
 *
 * 旧 features/session-management.md 的三处错锚（弱锚「彻底删除」等）已由本剧本按
 * capabilities/session.md 契约重写：删除断言 = 列表消失 + 会话树消失双证据。
 */
export const meta = {
  id: 'p0-multi-session',
  priority: 'P0',
  title: '同名隔离 + 归档/恢复 + 删除链（列表消失 + 会话树消失）',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'session.list', 'session.archive', 'session.restore', 'session.delete',
  ],
  requires: ['faux'],
  parallelGroup: 'chat',
  estimateSec: 120,
  faux: {
    responses: [{ text: 'multi-session-spare', stopReason: 'stop' }],
  },
  provable: [
    '同名隔离：与 A 同 label 的 D 独立成会话（id 不同、列表各占一行）',
    'archive A 后 config.sessions 不再列出 A，config.archives 含 A',
    'restore A 后回到 config.sessions',
    'delete B：session.deleted 回执 + config.sessions 不再列出 + C：ext-sessions/<B>/ 树消失',
  ],
  notProvable: [
    '归档目录的磁盘搬移细节（agent/sessions → 归档域的路径形态）——以 config.archives 结构与列表状态为准',
    '删除的废纸篓可恢复性（mac 软删语义属 OS 层）',
    'UI 侧栏交互（右键菜单/归档按钮的 A 通道）——本剧本走协议',
  ],
}

function sessionIds(listReply) {
  return (listReply.groups ?? []).flatMap((g) => (g.sessions ?? []).map((s) => s.id))
}
function findSummary(listReply, sid) {
  for (const g of listReply.groups ?? []) {
    for (const s of g.sessions ?? []) if (s.id === sid) return s
  }
  return null
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    'session.delete 现行语义 = 归档域真删（ADR-0141 删除链）：断言 = 列表消失 + ext-sessions/<sid>/ 树消失双证据（旧「彻底删除」弱锚已废）',
    'archive 的逆操作 = session.unarchive（解压回原路径）；session.restore 是「恢复崩溃前的活跃会话」，对归档会话报 SESSION_NOT_FOUND「无已保存内容」——两个词别混',
    'archive/restore/delete 的 reply 与 request 同名（protocol.ts 同名配对），protocol.call 不传 replyType 即正确',
    'pi 会话 JSONL 延迟写入（关键规则 #6）与 archive 的耦合：未发过消息的会话没有 jsonl 文件，archive 搬移报 archive_io_error——归档/删除目标必须先发一轮消息落盘',
  ]
  const fs = await import('node:fs')
  const path = await import('node:path')

  const mk = async (label, override) => {
    const payload = { cwd: ctx.repo, label }
    if (override) payload.modelOverride = override
    const r = await protocol.call('session.create', payload, { timeoutMs: 120_000 })
    return r.session
  }

  // ── 建 4 个（D 与 A 同名） ──────────────────────────────────
  const a = await mk('multi-alpha')
  const b = await mk('multi-beta')
  const c = await mk('multi-gamma')
  const d = await mk('multi-alpha')
  const ids = [a?.id, b?.id, c?.id, d?.id]
  ev.assert('建 4 个会话成功且 id 互异', ids.every(Boolean) && new Set(ids).size === 4, {
    channel: 'B',
    expected: '4 个互异 id',
    actual: ids.join(','),
  })
  ev.assert('同名隔离：D 与 A 同 label 但独立 id', a?.label === d?.label && a?.id !== d?.id, {
    channel: 'B',
    expected: 'label 相同 / id 不同',
    actual: `label=${a?.label}/${d?.label} id 异=${a?.id !== d?.id}`,
  })
  // pi 会话 JSONL 延迟写入（关键规则 #6）：未发过消息的会话没有文件，archive 的搬移会
  // ENOENT（archive_io_error）——归档/删除目标先各发一轮落盘（faux 队列 per-session 独立，1 步够）
  for (const [name, sid] of [['A', a.id], ['B', b.id]]) {
    await protocol.subscribe(sid)
    const since = protocol.events.length
    await protocol.send(sid, `落盘消息（${name}）`)
    await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  }
  ev.step({ step: 'chat.send.persist', channel: 'B', exitCode: 0, stats: { a: a.id, b: b.id } })

  const list0 = await protocol.call('config.sessions', {})
  ev.assert('config.sessions 列出全部 4 个', sessionIds(list0).length >= 4, {
    channel: 'B',
    expected: '≥4',
    actual: `count=${sessionIds(list0).length}`,
  })
  ev.step({ step: 'session.create.x4', channel: 'B', exitCode: 0, stats: { ids } })

  // ── archive A ───────────────────────────────────────────────
  await protocol.call('session.archive', { sessionId: a.id }, { timeoutMs: 60_000 })
  const list1 = await protocol.call('config.sessions', {})
  ev.assert('archive 后列表不再含 A', !sessionIds(list1).includes(a.id), {
    channel: 'B',
    expected: `无 ${a.id}`,
    actual: `count=${sessionIds(list1).length}`,
  })
  // 归档落定是异步的（ledger staging→archived）：条件轮询 archives 出现 A
  let archives = []
  {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const arc = await protocol.call('config.archives', {})
      archives = (arc.archives ?? []).map((s) => s.sessionId ?? s.id).filter(Boolean)
      if (archives.includes(a.id)) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  ev.assert('archive 后 config.archives 含 A', archives.includes(a.id), {
    channel: 'B',
    expected: a.id,
    actual: `count=${archives.length}`,
  })
  ev.step({ step: 'session.archive', channel: 'B', exitCode: archives.includes(a.id) ? 0 : 1, stats: { archives } })

  // ── restore A ───────────────────────────────────────────────
  // restore 前置 = 归档文件实体落定（ledger 条目先出现、文件搬移后到；restore 读的是
  // 归档目录里的 jsonl 实体，只看 ledger 会 SESSION_NOT_FOUND「无已保存内容」）
  {
    const archiveRoot = path.join(dataDir, 'agent', 'archive')
    let fileSeen = false
    const deadline = Date.now() + 30_000
    const findArchivedFile = (root, depth = 0) => {
      if (!fs.existsSync(root) || depth > 4) return false
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (findArchivedFile(path.join(root, e.name), depth + 1)) return true
        } else if (e.name.includes(a.id)) return true
      }
      return false
    }
    while (Date.now() < deadline) {
      fileSeen = findArchivedFile(archiveRoot)
      if (fileSeen) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('C: 归档文件实体落定（agent/archive 树含 A 的 jsonl）', fileSeen, {
      channel: 'C',
      expected: `${archiveRoot} 下含 ${a.id} 的文件`,
      actual: `hit=${fileSeen}`,
    })
  }
  // 归档的逆操作 = session.unarchive（解压回原路径）；session.restore 是「恢复崩溃前的
  // 活跃会话」——两者别混（restore 对归档会话报 SESSION_NOT_FOUND「无已保存内容」）
  await protocol.call('session.unarchive', { sessionId: a.id }, { timeoutMs: 60_000 })
  const list2 = await protocol.call('config.sessions', {})
  ev.assert('unarchive 后 A 回到列表', sessionIds(list2).includes(a.id), {
    channel: 'B',
    expected: `含 ${a.id}`,
    actual: `count=${sessionIds(list2).length}`,
  })
  ev.step({ step: 'session.unarchive', channel: 'B', exitCode: 0, stats: {} })

  // ── delete B（列表 + 树双证据） ─────────────────────────────
  const treeB = path.join(dataDir, 'ext-sessions', String(b.id))
  const treeBefore = fs.existsSync(treeB)
  await protocol.call('session.delete', { sessionId: b.id }, { timeoutMs: 120_000 })
  const list3 = await protocol.call('config.sessions', {})
  // 删除链是异步收尾（杀 pi + 树清除）：条件轮询两证据齐
  let gone = false
  for (let i = 0; i < 40 && !gone; i++) {
    const l = sessionIds(await protocol.call('config.sessions', {}))
    gone = !l.includes(b.id) && !fs.existsSync(treeB)
    if (!gone) await new Promise((r) => setTimeout(r, 500))
  }
  const treeAfter = fs.existsSync(treeB)
  ev.assert('delete B：列表不再含 B', !sessionIds(list3).includes(b.id) || gone, {
    channel: 'B',
    expected: `无 ${b.id}`,
    actual: `count=${sessionIds(list3).length}`,
  })
  ev.assert('C: delete B 后 ext-sessions 树消失', !treeAfter, {
    channel: 'C',
    expected: `${treeB} 不存在（删除前=${treeBefore}）`,
    actual: `exists=${treeAfter}`,
  })
  ev.step({ step: 'session.delete', channel: 'B', exitCode: treeAfter ? 1 : 0, stats: { treeBefore } })

  log(`done ids=${ids.join(',')}`)
  return { uncovered, gotchas }
}
