/**
 * memory-diag-requests —— 诊断剧本：dump mock server 全量请求记录（时间/model/
 * status/stepIndex/特征标记），用于归因 turn_end 提炼调用次数与注入时序。不设业务断言。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXTRACT_MARKER = '你是记忆提炼器'
const MEMORY_BLOCK_START = '<memory-context>'

function requestText(req) {
  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('')
    return ''
  }
  return (req.messages ?? []).map((m) => textOf(m?.content)).join('\n')
}

export const meta = {
  id: 'memory-diag-requests',
  priority: 'P1',
  title: '诊断：mock 请求全量 dump（提炼次数/注入时序归因）',
  covers: [],
  requires: ['mock-http'],
  estimateSec: 120,
  llm: {
    mainModel: 'diag',
    models: ['diag'],
    responses: {
      'mockllm/diag': [
        {
          toolCalls: [
            { name: 'memory_save', args: { name: 'diag-entry', description: '诊断条目', type: 'user', content: '诊断用临时条目。' } },
          ],
          stopReason: 'toolUse',
        },
        { text: 'diag-saved', stopReason: 'stop' },
        { text: 'diag-plain-reply', stopReason: 'stop' },
        { text: '{"operations":[{"op":"skip","reason":"无"}]}', stopReason: 'stop' },
        { text: '{"operations":[{"op":"skip","reason":"无2"}]}', stopReason: 'stop' },
        { text: 'diag-t3-reply', stopReason: 'stop' },
        { text: '{"operations":[{"op":"skip","reason":"无3"}]}', stopReason: 'stop' },
        { text: 'diag-extra', stopReason: 'stop' },
      ],
    },
  },
  provable: ['mock 请求全量记录被 dump 到证据（归因用）'],
  notProvable: ['一切业务断言（本剧本是诊断探针）'],
}

export async function run(ctx) {
  const { protocol, ev, log, instance, dataDir: diagDataDir } = ctx
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mem-diag-'))
  try {
    const created = await protocol.call('session.create', { cwd: tmpDir, label: 'mem-diag', modelOverride: 'mockllm/diag' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    await protocol.subscribe(sid)

    // 双装载验证①：extension.list 中 memory 扩展出现次数
    const extList = await protocol.call('extension.list', {}, { timeoutMs: 30_000 })
    const extRows = extList.extensions ?? extList.list ?? []
    const byNameCount = {}
    for (const x of extRows) byNameCount[x?.name ?? '?'] = (byNameCount[x?.name ?? '?'] ?? 0) + 1
    const memRows = extRows.filter((x) => String(x?.name ?? '').includes('pi-memory'))
    ev.attach('extension-list-names', Object.keys(byNameCount).join('\n'))
    ev.step({ step: 'diag.extension-list', channel: 'B', exitCode: 0, stats: { total: extRows.length, memoryRows: memRows.length } })
    log(`extension.list: total=${extRows.length} memoryRows=${memRows.length} dupNames=${JSON.stringify(Object.entries(byNameCount).filter(([, n]) => n > 1))}`)
    log(`memory rows: ${JSON.stringify(memRows.map((x) => ({ name: x.name, path: x.path, source: x.source })))}`)

    const dump = (tag) => {
      const rows = instance.mockLlm.requests.map((r) => ({
        at: new Date(r.at).toISOString().slice(11, 23),
        model: r.model,
        status: r.status,
        stepIndex: r.stepIndex,
        extract: requestText(r).includes(EXTRACT_MARKER),
        memoryBlock: requestText(r).includes(MEMORY_BLOCK_START),
        msgCount: r.messageCount,
        head: requestText(r).slice(0, 120).replace(/\n/g, ' '),
      }))
      ev.attach(`requests-${tag}`, JSON.stringify(rows, null, 2))
      log(`${tag}: ${rows.length} 请求`)
      for (const row of rows) log(`  ${row.at} st=${row.status} step=${row.stepIndex} extract=${row.extract} block=${row.memoryBlock} :: ${row.head.slice(0, 80)}`)
      return rows
    }

    let since = protocol.events.length
    await protocol.send(sid, '请记住我是诊断用户，我喜欢简洁回复')
    const e1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    log(`T1 end=${e1.type} ok=${e1.ok}`)
    await new Promise((r) => setTimeout(r, 3_000))
    dump('after-T1')

    since = protocol.events.length
    await protocol.send(sid, '这是普通第二轮对话，日志用 JSON 格式比较好')
    const e2 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    log(`T2 end=${e2.type} ok=${e2.ok}`)
    await new Promise((r) => setTimeout(r, 3_000))
    dump('after-T2')

    // command
    since = protocol.events.length
    await protocol.send(sid, '/memory list')
    try {
      const evt = await protocol.waitFor((e) => e.type === 'extension:notify' && e.payload?.sessionId === sid, { since, timeoutMs: 20_000 })
      log(`notify: ${String(evt.payload?.message ?? '').slice(0, 100)}`)
      ev.attach('notify-list', String(evt.payload?.message ?? ''))
    } catch (err) {
      log(`notify 未到: ${err instanceof Error ? err.message : String(err)}`)
    }
    dump('after-list')

    // off 段：命令 → notify → T3 轮 → 请求时间线对照
    since = protocol.events.length
    const offSentAt = Date.now()
    await protocol.send(sid, '/memory off')
    try {
      const evt = await protocol.waitFor((e) => e.type === 'extension:notify' && e.payload?.sessionId === sid && String(e.payload?.message ?? '').includes('记忆系统'), { since, timeoutMs: 20_000 })
      log(`off notify at=+${Date.now() - offSentAt}ms: ${String(evt.payload?.message ?? '').slice(0, 120)}`)
      ev.attach('notify-off', String(evt.payload?.message ?? ''))
      // 双装载验证：统计窗口内全部 notify/widget 帧（handler 双执行则帧×2）
      await new Promise((r) => setTimeout(r, 2_000))
      const windowFrames = protocol.events.slice(since)
      const notifyCount = windowFrames.filter((e) => e.type === 'extension:notify').length
      const widgetCount = windowFrames.filter((e) => e.type === 'extension:widget').length
      log(`off 窗口帧计数: notify=${notifyCount} widget=${widgetCount}（双装载则 >1）`)
      ev.step({ step: 'diag.off-frames', channel: 'B', exitCode: 0, stats: { notifyCount, widgetCount } })
    } catch (err) {
      log(`off notify 未到: ${err instanceof Error ? err.message : String(err)}`)
    }
    const offNotifyAt = Date.now()
    const cfgPath = path.join(diagDataDir, 'agent', 'config', 'memory-ext-config.json')
    try {
      ev.attach('config-after-off', fs.readFileSync(cfgPath, 'utf8'))
    } catch (err) {
      ev.attach('config-after-off', `读失败: ${err instanceof Error ? err.message : String(err)}`)
    }

    since = protocol.events.length
    await protocol.send(sid, '关闭之后我们再聊一句话看看注入是否停止了')
    const e3 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    await new Promise((r) => setTimeout(r, 3_000))
    const rows3 = dump('after-off-T3')
    const t3req = rows3.filter((r) => !r.extract).slice(-1)[0]
    log(`offNotifyAt=${new Date(offNotifyAt).toISOString().slice(11, 23)} t3MainReqAt=${t3req?.at} t3Block=${t3req?.memoryBlock} t3End=${e3.type}`)
    // T3 后提炼调用数
    const extractAfterOff = rows3.filter((r) => r.extract).length
    const extractBeforeOff = dump('after-list').filter((r) => r.extract).length
    log(`extract calls: beforeOff=${extractBeforeOff} afterOff=${extractAfterOff}`)

    ev.step({ step: 'diag.done', channel: 'B', exitCode: 0, stats: { total: instance.mockLlm.requests.length, extractBeforeOff, extractAfterOff } })
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* noop */ }
  }
  return { uncovered: [], gotchas: [] }
}
