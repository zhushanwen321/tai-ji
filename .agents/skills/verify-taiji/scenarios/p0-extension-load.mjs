/**
 * p0-extension-load —— 扩展装载框架的行为证据（覆盖矩阵 P0-11；补剧本优先级 #9 之一）。
 *
 * 装配：faux（默认 mandatory 装载 + faux-provider-ext 经 TAIJI_EXTENSION_PATHS 临时挂载）。
 * doctor 五项的第三判据（扩展装载 N≥8）只证明「resolver 去重目录数」，不证明「扩展真的可用」。
 * 本剧本补行为证据：
 *   B：extension.list → 数量 ≥ mandatory SSOT 基线 + infrastructure 组条目 enabled + faux 扩展在列；
 *   B：session.getCommands → 含 source='extension' 的注册命令（命令注册 = 扩展行为的直接证据）；
 *   C：runtime 日志无「Failed to load extension」级错误。
 */
export const meta = {
  id: 'p0-extension-load',
  priority: 'P0',
  title: '扩展装载行为证据：清单数量/infrastructure enabled/命令注册/日志无装载失败',
  covers: ['env.launch', 'env.ready', 'env.doctor', 'extension.load'],
  requires: ['faux'],
  estimateSec: 120,
  faux: {
    responses: [{ text: 'extension-load-spare', stopReason: 'stop' }],
  },
  provable: [
    'extension.list 数量 ≥ 15（mandatory SSOT 21 包 + faux 临时挂载；保守下限防包数漂移误红）',
    'extension.list 含 faux-provider-ext（TAIJI_EXTENSION_PATHS 临时挂载进入 user 源）',
    'session.getCommands 含 source=extension 的注册命令（行为证据：扩展不只是被列出，而是真的注册了能力）',
    'C：runtime 日志无 Failed to load extension / extension error 级错误行',
  ],
  notProvable: [
    '每个扩展的深层功能（各自域的 scenario 覆盖，如 interaction/plugin/settings 各 capability）',
    '插件（plugin.*）与扩展（extension）的边界——插件系统归 verify-plugin-contract.sh 机器轨（矩阵 P0-14 reuse-e2e）',
    'sandbox 插件的独立进程隔离（无 sandbox 夹具，矩阵已登记子能力级 unreachable）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, instance } = ctx
  const uncovered = []
  const gotchas = [
    'doctor 第三判据的 N = resolver 去重目录数，不是装载成功数——行为证据必须另取（命令注册 / 日志反证）',
    'infrastructure 组不可禁、feature 组可禁、都不可卸（mandatory-extensions.json SSOT；检查抛 builtin_cannot_*）',
    'extension.list 的 enabled 字段反映禁用态；infrastructure 条目 enabled 恒 true',
  ]
  const fs = await import('node:fs')
  const path = await import('node:path')

  // doctor 兜底（runner 已跑，这里取结论归档）
  const doctor = await instance.doctor()
  ev.step({ step: 'env.doctor', channel: 'C', exitCode: doctor.exitCode, stats: { verdict: doctor.raw?.verdict } })

  // ── B：extension.list 清单 ─────────────────────────────────
  const list = await protocol.call('extension.list', {})
  const extensions = list.extensions ?? []
  const names = extensions.map((x) => x.name ?? x.pkg ?? '')
  ev.step({ step: 'extension.list', channel: 'B', exitCode: 0, stats: { count: extensions.length } })
  ev.attach('extension-list', JSON.stringify(extensions, null, 2).slice(0, 30_000))

  ev.assert('B: 扩展数量 ≥ 15（mandatory 基线 + faux）', extensions.length >= 15, {
    channel: 'B',
    expected: '≥15',
    actual: `count=${extensions.length}`,
  })
  const fauxIn = names.some((n) => /faux/.test(n))
  ev.assert('B: faux-provider-ext 在清单（临时挂载进入）', fauxIn, {
    channel: 'B',
    expected: 'name 含 faux',
    actual: `names=${names.join(',').slice(0, 300)}`,
  })
  const infraDisabled = extensions.filter((x) => x.group === 'infrastructure' && x.enabled === false)
  ev.assert('B: infrastructure 组无 disabled 条目', infraDisabled.length === 0, {
    channel: 'B',
    expected: 'infrastructure 全部 enabled',
    actual: infraDisabled.length === 0 ? '无' : infraDisabled.map((x) => x.name).join(','),
  })

  // ── B：命令注册（行为证据） ────────────────────────────────
  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'p0-extension-load' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  await protocol.subscribe(sid)
  const cmds = await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 60_000 })
  const extCmds = (cmds.commands ?? []).filter((c) => c.source === 'extension')
  ev.step({ step: 'session.getCommands', channel: 'B', exitCode: 0, stats: { total: (cmds.commands ?? []).length, ext: extCmds.length } })
  ev.assert('B: 存在 source=extension 的注册命令（行为证据）', extCmds.length > 0, {
    channel: 'B',
    expected: '≥1 条扩展注册命令',
    actual: `ext=${extCmds.length} 样例=${extCmds.slice(0, 3).map((c) => c.name).join(',')}`,
  })
  ev.attach('ext-commands', JSON.stringify(extCmds, null, 2).slice(0, 20_000))

  // ── C：日志反证 ────────────────────────────────────────────
  const logsDir = path.join(dataDir, 'logs')
  let badLines = []
  if (fs.existsSync(logsDir)) {
    for (const f of fs.readdirSync(logsDir)) {
      if (!f.startsWith('runtime-')) continue
      const text = fs.readFileSync(path.join(logsDir, f), 'utf8')
      badLines = badLines.concat(
        text
          .split('\n')
          .filter((l) => /Failed to load extension|extension load (failed|error)/i.test(l))
          .slice(0, 10),
      )
    }
  }
  ev.assert('C: runtime 日志无扩展装载失败错误行', badLines.length === 0, {
    channel: 'C',
    expected: '0 行',
    actual: `${badLines.length} 行${badLines.length ? '：' + badLines[0].slice(0, 200) : ''}`,
  })

  log(`done sid=${sid} ext=${extensions.length} extCmds=${extCmds.length}`)
  return { uncovered, gotchas }
}
