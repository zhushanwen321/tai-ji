/**
 * a7-disk-invariant —— 验收场景 7（设计 §8）：邻居不变量：磁盘表面不变（字节 diff）。
 *
 * 回溯目标 1-4。通过标准：无编辑操作时启动流程不改写 projects.json。种子为正常
 * 形态（默认项目在场、activeProjectId 有效），实际验证「无需归一化也不写盘」；
 * 失配形态的归一化读时修复分支（仅改回执视图不写盘，§6.6①）由 runtime 单测
 * project-store.test 承载——见 notProvable 登记。与场景 1 同流程合并执行
 * （验收计划表 A7 行 optimization），本剧本为其独立可执行形态（2 次冷启动）。
 *
 * 判据：projects.json sha256 + size + mtimeMs 在启动前后完全一致；且 project.load
 * 回执的归一化视图（projects 数组）与非空磁盘文件并存——「读了、归一化了、没写盘」。
 */
import fs from 'node:fs'
import path from 'node:path'

import { PROD_DATA_DIR, readJsonFile, seedRealisticDataDir, sha256File, waitForSidebarGroups } from './lib-conn-datasync.mjs'

export const meta = {
  id: 'a7-disk-invariant',
  priority: 'P0',
  title: '场景 7：磁盘表面不变（projects.json 字节 diff，2 次冷启动）',
  covers: ['env.launch', 'env.ready', 'evidence.tree'],
  requires: ['none'],
  estimateSec: 240,
  provable: [
    '2 次冷启动后 projects.json sha256/size/mtime 均不变（启动流程零改写；种子为正常形态，实际验证「无需归一化也不写盘」）',
    '磁盘文件非空且 project.load 回执视图与磁盘内容一致（读路径在场）',
  ],
  notProvable: [
    '失配存量文件的归一化读时修复分支（默认项目缺失/activeProjectId 失配 → 仅修回执视图不写盘，§6.6①）——种子为正常形态不触发该分支，由 runtime 单测 project-store.test 承载',
    '编辑命令后的写盘形态（属场景 6 / P-4 写侧范围，不在本邻居不变量内）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = []

  await instance.stop()
  const seed = seedRealisticDataDir(dataDir, { prodRoot: PROD_DATA_DIR, maxSessions: 2 })
  const projectsFile = path.join(dataDir, 'projects.json')
  const stat = () => {
    const s = fs.statSync(projectsFile)
    return { sha256: sha256File(projectsFile), size: s.size, mtimeMs: s.mtimeMs }
  }
  const before = stat()
  ev.step({ step: 'a7.before', channel: 'C', exitCode: 0, stats: { ...before, boundSessions: seed.sessions.length } })

  for (const round of [1, 2]) {
    if (round === 2) await instance.stop()
    await instance.launch()
    const ready = await instance.waitReady({ timeoutMs: 180_000 })
    const page = await instance.page()
    await waitForSidebarGroups(page, { minGroups: 1, timeoutMs: 60_000 })
    ev.step({ step: `a7.boot.${round}`, channel: 'C', exitCode: 0, stats: { runtimePort: ready.runtimePort } })

    // 每次启动后立即核对字节（不等整轮结束——早发现早归因）
    const mid = stat()
    ev.assert(`A7: 第 ${round} 次冷启动后 projects.json 字节不变`, mid.sha256 === before.sha256 && mid.size === before.size && mid.mtimeMs === before.mtimeMs, {
      channel: 'C',
      expected: before,
      actual: mid,
    })
  }

  // 读路径在场证明：磁盘内容可解析且与 load 回执一致（正常形态无需归一化、也不写盘）
  const onDisk = readJsonFile(projectsFile)
  ev.assert('A7: 磁盘 projects.json 仍可解析且含命名项目', Array.isArray(onDisk.projects) && onDisk.projects.some((p) => p.name), {
    channel: 'C',
    expected: 'projects 数组含命名项',
    actual: `len=${onDisk.projects?.length ?? 'n/a'} revision=${onDisk.revision ?? '(缺，存量形态)'}`,
  })

  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: instance.info().runtimePort })
  try {
    const reply = await proto.call('project.load', {}, { replyType: 'project.loaded', timeoutMs: 30_000 })
    const diskIds = onDisk.projects.map((p) => p.id).sort()
    const replyIds = (reply.projects ?? []).map((p) => p.id).sort()
    ev.assert('A7: load 回执视图与磁盘内容一致（正常形态无需归一化、不写盘）', JSON.stringify(diskIds) === JSON.stringify(replyIds), {
      channel: 'B',
      expected: diskIds.join(','),
      actual: replyIds.join(','),
    })
  } finally {
    await proto.close().catch(() => {})
  }

  if (uncovered.length === 0) log('a7: 全部断言通过')
  return { uncovered, gotchas }
}
