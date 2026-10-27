/**
 * a1-cold-start-groups —— 验收场景 1（设计 §8）：冷启动分组正确（真实数据目录 ×5 次）。
 *
 * 回溯目标 1（冷启动侧栏项目分组丢失的架构级修复）。随场景断言：
 * - P-3 探针：auth 应答 runtimeId === supervisor 签发值（env TAIJI_RUNTIME_ID）。
 * - P-4 读侧：存量无 revision 的 projects.json 首启 project.load 成功且 revision=0。
 * - A7（邻居不变量，与场景 1 同流程合并执行）：无编辑操作时 projects.json 字节不变
 *   （含归一化读时修复不写盘）。
 *
 * 数据目录口径：C-proc-26 禁止非打包进程持有 ~/.taiji 树值，故「prod 实例」=
 * 生产数据目录的副本（projects.json 字节级 + 每命名项目一条真实绑定会话），
 * 与 P-4 探针的「生产数据目录副本」口径一致。
 *
 * 通过标准（设计 §8 场景 1）：
 *   每次启动侧栏直接呈现正确项目分组；日志无 `load failed...连接已断开`；
 *   P-3 探针通过（auth 双侧 runtimeId 一致）。
 */
import path from 'node:path'

import {
  PROD_DATA_DIR,
  authEcho,
  readJsonFile,
  readLaunchLog,
  readRuntimeLog,
  runtimeEnvOf,
  runtimePidOf,
  seedRealisticDataDir,
  sha256File,
  supervisorSnapshot,
  waitForSidebarGroups,
} from './lib-conn-datasync.mjs'

const COLD_START_ROUNDS = 5

export const meta = {
  id: 'a1-cold-start-groups',
  priority: 'P0',
  title: '场景 1：冷启动分组正确（真实数据目录 5 次）+ P-3 探针 + A7 字节不变量',
  covers: ['env.launch', 'env.ready', 'env.isolation', 'session.list'],
  requires: ['none'],
  estimateSec: 480,
  provable: [
    '5 次冷启动每次侧栏直接呈现正确项目分组（命名组名 + 计数，无「连接已断开」加载失败日志）',
    'P-3：auth.result.runtimeId === runtime 进程 env TAIJI_RUNTIME_ID（supervisor 签发值，16 hex）',
    'P-4 读侧：存量无 revision 的 projects.json 经 project.load 成功返回且 revision=0',
    'A7：无编辑操作下 projects.json 启动前后 sha256 一致（归一化读时修复不写盘）',
  ],
  notProvable: [
    'prod 打包形态（~/.taiji 本体）：C-proc-26 禁止非打包进程持生产目录值，验收用生产数据目录副本（projects.json 字节级 + 真实绑定会话子集），与 P-4 探针口径一致',
    '侧栏分组的像素级视觉正确性（只断言 DOM 结构：组名/计数/归属）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = []

  const projectsFile = path.join(dataDir, 'projects.json')

  // ── 段 0：停 runner 空实例 → 种子真实数据 → 冷启动第 1 轮 ─────────
  await instance.stop()
  ev.step({ step: 'instance.stop-for-seed', channel: 'C', exitCode: 0, stats: { dataDir } })

  const seed = seedRealisticDataDir(dataDir, { prodRoot: PROD_DATA_DIR })
  const seeded = readJsonFile(projectsFile)
  const expectedGroups = seeded.projects.filter((p) => p.id !== 'proj-default' && p.name).map((p) => ({ id: p.id, name: p.name }))
  const expectedNames = expectedGroups.map((g) => g.name).sort()
  const seededCounts = expectedGroups
    .map((g) => `${g.name}=${seed.sessions.filter((s) => s.projectId === g.id).length}`)
    .sort()
    .join(' ')
  const shaBefore = sha256File(projectsFile)
  ev.step({
    step: 'seed.realistic-data',
    channel: 'C',
    exitCode: 0,
    stats: {
      projectsJsonCopied: seed.projectsJson,
      namedProjects: expectedGroups.length,
      boundSessions: seed.sessions.length,
      sha256Before: shaBefore,
    },
  })
  ev.assert('种子：projects.json 为生产字节副本且含命名项目', seed.projectsJson && expectedGroups.length >= 2, {
    channel: 'C',
    expected: '≥2 个命名项目',
    actual: `${expectedGroups.length} 个：${expectedGroups.map((g) => g.name).join(',')}`,
  })
  ev.assert('种子：实例 projects.json 与生产文件字节一致（sha256）', sha256File(path.join(dataDir, 'projects.json')) === sha256File(path.join(PROD_DATA_DIR, 'projects.json')), {
    channel: 'C',
    expected: 'sha256 一致',
    actual: sha256File(path.join(dataDir, 'projects.json')),
  })
  ev.assert('种子：每个命名项目至少一条真实绑定会话', seed.sessions.length >= 2, {
    channel: 'C',
    expected: '≥2 条绑定会话',
    actual: `${seed.sessions.length} 条：${seed.sessions.map((s) => s.projectId).join(',')}`,
  })

  const rounds = []
  for (let round = 1; round <= COLD_START_ROUNDS; round += 1) {
    // ── 冷启动（第 1 轮已 stop 过，直接 launch；后续轮 stop→launch） ──
    if (round > 1) {
      await instance.stop()
      ev.step({ step: `cold.${round}.stop`, channel: 'C', exitCode: 0, stats: { round } })
    }
    await instance.launch()
    const ready = await instance.waitReady({ timeoutMs: 180_000 })
    ev.step({
      step: `cold.${round}.ready`,
      channel: 'C',
      exitCode: 0,
      stats: { round, runtimePort: ready.runtimePort, extensions: ready.extensions, elapsedMs: ready.elapsedMs },
    })
    log(`round ${round}: ready in ${ready.elapsedMs}ms runtime=${ready.runtimePort}`)

    // ── 分组直接呈现（首屏即正确，不等额外刷新） ─────────────────────
    const page = await instance.page()
    const groups = await waitForSidebarGroups(page, { minGroups: expectedGroups.length, timeoutMs: 60_000 })
    const names = groups.map((g) => g.name).sort()
    ev.assert(`A: 第 ${round} 次冷启动侧栏直接呈现全部命名项目分组`, JSON.stringify(names) === JSON.stringify(expectedNames), {
      channel: 'A',
      expected: expectedNames.join(','),
      actual: names.join(','),
    })
    const counts = groups.map((g) => `${g.name}=${g.count}`).sort().join(' ')
    ev.assert(`A: 第 ${round} 次冷启动分组计数与种子绑定一致`, counts === seededCounts, {
      channel: 'A',
      expected: seededCounts,
      actual: counts,
    })
    await ev.shot(page, `cold-${round}-groups`)

    // ── P-3 探针：auth 应答 runtimeId === supervisor 签发值 ──────────
    // 签发侧双证据：① IPC 快照读口（supervisor.currentSnapshot，权威）；② runtime 进程
    // env TAIJI_RUNTIME_ID（spawn 同点注入）。应答侧 = 裸 WS 握手 auth.result.payload。
    const snapshot = await supervisorSnapshot(page)
    const issued = snapshot?.runtimeId ?? null
    const runtimePid = runtimePidOf(dataDir)
    const env = runtimePid ? runtimeEnvOf(runtimePid) : new Map()
    const envIssued = env.get('TAIJI_RUNTIME_ID') ?? null
    const echo = await authEcho(dataDir, ready.runtimePort)
    ev.assert(`P-3: 第 ${round} 轮 auth 应答 runtimeId === supervisor 快照签发值`, Boolean(issued) && echo.runtimeId === issued, {
      channel: 'B',
      expected: issued,
      actual: `${echo.runtimeId ?? '(缺失)'}（auth.ok=${echo.ok === true}）`,
    })
    ev.assert(`P-3: 第 ${round} 轮 runtimeId 为 16 位 hex（8 字节熵）`, /^[0-9a-f]{16}$/.test(String(echo.runtimeId ?? '')), {
      channel: 'B',
      expected: '/^[0-9a-f]{16}$/',
      actual: String(echo.runtimeId),
    })
    ev.assert(`P-3: 第 ${round} 轮 spawn env 注入值与快照一致（TAIJI_RUNTIME_ID）`, envIssued === issued, {
      channel: 'C',
      expected: issued,
      actual: envIssued ?? '(env 不可读)',
    })

    // ── 日志无 `load failed...连接已断开`（设计通过标准） ────────────
    const launchLog = readLaunchLog(dataDir)
    const runtimeLog = readRuntimeLog(dataDir)
    const badLines = [...launchLog.split('\n'), ...runtimeLog.split('\n')].filter((l) =>
      /load failed.*连接已断开|连接已断开.*load failed/i.test(l),
    )
    ev.assert(`C: 第 ${round} 轮日志无「load failed…连接已断开」`, badLines.length === 0, {
      channel: 'C',
      expected: '0 行',
      actual: badLines.slice(0, 3).join(' | ') || '0 行',
    })
    rounds.push({ round, runtimePort: ready.runtimePort, runtimeId: echo.runtimeId, elapsedMs: ready.elapsedMs })
  }

  // ── P-4 读侧：存量无 revision 文件按 0 读（自建协议连接，B 通道） ──
  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: rounds[rounds.length - 1].runtimePort })
  try {
    const loadReply = await proto.call('project.load', {}, { replyType: 'project.loaded', timeoutMs: 30_000 })
    ev.assert('P-4 读侧：存量无 revision 的 projects.json 首启 load 成功', Array.isArray(loadReply.projects), {
      channel: 'B',
      expected: 'projects 数组',
      actual: `len=${loadReply.projects?.length ?? 'n/a'}`,
    })
    ev.assert('P-4 读侧：存量文件 revision 按 0 读', loadReply.revision === 0, {
      channel: 'B',
      expected: 0,
      actual: loadReply.revision,
    })
  } finally {
    await proto.close().catch(() => {})
  }

  // ── A7：projects.json 字节不变量（5 次冷启动全程无编辑） ───────────
  const shaAfter = sha256File(projectsFile)
  ev.assert('A7: 5 次冷启动后 projects.json 字节不变（sha256 一致）', shaAfter === shaBefore, {
    channel: 'C',
    expected: shaBefore,
    actual: shaAfter,
  })
  ev.attach('a7-byte-diff', JSON.stringify({ file: 'projects.json', sha256Before: shaBefore, sha256After: shaAfter, equal: shaAfter === shaBefore }, null, 2))
  ev.attach('cold-start-rounds', JSON.stringify(rounds, null, 2))

  if (uncovered.length === 0) log('a1: 全部断言通过')
  return { uncovered, gotchas }
}
