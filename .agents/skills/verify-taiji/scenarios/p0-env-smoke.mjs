/**
 * p0-env-smoke —— 环境原语自证（runner 自证剧本，B0）。
 *
 * 覆盖：launch / waitReady（三条判据）/ doctor / 协议 auth + 只读 RPC 往返 /
 * runtime 日志扩展装载 N / 数据目录隔离。不建 session（无业务语义依赖）。
 *
 * 契约缺口记录：任务书原写「协议 config.get 往返」，但 `config.get` 不是已登记协议
 * 消息（ClientMessageType 无此条目，runtime 会回 unknown_type error envelope）。
 * 本剧本改用 `ping`（内联 pong）+ `config.sessions`（真实只读聚合 RPC）证明往返；
 * 缺口已写入 Gotchas 与交付报告。
 */
import os from 'node:os'
import path from 'node:path'

export const meta = {
  id: 'p0-env-smoke',
  priority: 'P0',
  title: '环境原语冒烟：启动/就绪/doctor/协议往返/扩展装载/隔离',
  covers: ['env.launch', 'env.ready', 'env.doctor', 'env.isolation'],
  requires: ['none'],
  estimateSec: 90,
  provable: [
    '独立实例名派生独立端口段，与 worktree 默认实例（1665/9304）不冲突',
    'waitReady 三条判据（runtime.port / CDP 页面 URL 归属 / 扩展装载 N≥8）全过',
    'doctor 五项全 GREEN',
    'WS auth 握手成功且 ping→pong 往返成功（B 通道）',
    'runtime 日志出现 resolved N extensions（N≥8）',
    'dataDir 落在 ~/.taiji-dev 树内、非 prod ~/.taiji',
  ],
  notProvable: [
    'UI 渲染（本剧本不建会话、不连 CDP 页面做 DOM 断言）',
    '扩展实际能力（只证明装载数量，不证明每个扩展的 tool/command 可用）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = [
    'config.get 不是已登记协议消息（ClientMessageType 无此条目）；本剧本用 ping + config.sessions 替代往返证明',
  ]

  // ── B 通道：ping 往返（连接存活 + RPC 通路） ─────────────────
  const pong = await protocol.call('ping', {})
  ev.assert('B: ping → pong 往返', pong.__type === 'pong', {
    channel: 'B',
    expected: 'reply type = pong',
    actual: pong.__type,
  })

  // ── B 通道：config.sessions 只读聚合 RPC ─────────────────────
  const sessions = await protocol.call('config.sessions', {})
  const groups = sessions.groups ?? []
  ev.assert('B: config.sessions 返回 groups 数组', Array.isArray(groups), {
    channel: 'B',
    expected: 'groups 为数组',
    actual: `type=${typeof groups} len=${Array.isArray(groups) ? groups.length : 'n/a'} archiveCount=${sessions.archiveCount ?? 0}`,
  })
  log(`config.sessions groups=${groups.length} sessions=${groups.reduce((n, g) => n + (g.sessions?.length ?? 0), 0)}`)

  // ── C 通道：扩展装载（runtime 日志信号；waitReady 已保证就绪） ──
  const { resolvedExtensionCount, readRuntimeLogs } = await import('../scripts/lib/instance.mjs')
  const ext = resolvedExtensionCount(dataDir)
  ev.assert('C: runtime 日志 resolved N extensions 且 N≥8', ext.seen && ext.count >= 8, {
    channel: 'C',
    expected: 'N≥8',
    actual: ext.seen ? `resolved ${ext.count} extensions from ${ext.sources} sources` : '无 resolved 信号',
  })
  const logText = readRuntimeLogs(dataDir)
  const extLines = logText
    .split('\n')
    .filter((l) => /resolved \d+ extensions|extension/i.test(l))
    .slice(-40)
  ev.attach('runtime-extension-lines', extLines.join('\n') || '(no matched lines)')
  ev.step({
    step: 'extensions.resolved',
    channel: 'C',
    exitCode: 0,
    stats: { count: ext.count, sources: ext.sources, matchedLines: extLines.length },
  })

  // ── C 通道：数据目录隔离 ─────────────────────────────────────
  const devRoot = path.join(os.homedir(), '.taiji-dev')
  const prodRoot = path.join(os.homedir(), '.taiji')
  ev.assert('C: dataDir 在 ~/.taiji-dev 树内', dataDir.startsWith(`${devRoot}${path.sep}`), {
    channel: 'C',
    expected: `前缀 ${devRoot}/`,
    actual: dataDir,
  })
  ev.assert('C: dataDir 不指向 prod ~/.taiji', !dataDir.startsWith(`${prodRoot}${path.sep}`) && dataDir !== prodRoot, {
    channel: 'C',
    expected: `非 ${prodRoot}`,
    actual: dataDir,
  })
  ev.assert('C: 端口段独立于 worktree 默认派生（实例名隔离）', ctx.instance.info().instanceName !== path.basename(repo), {
    channel: 'C',
    expected: '实例名带 verify- 前缀（独立端口段）',
    actual: ctx.instance.info().instanceName,
  })

  ev.attach(
    'instance-info',
    JSON.stringify({ ...ctx.instance.info(), ready: ctx.instance.ready }, null, 2),
  )

  if (uncovered.length === 0) {
    log('env-smoke: 全部断言通过')
  }
  return { uncovered, gotchas }
}
