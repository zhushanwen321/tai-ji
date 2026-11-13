/**
 * memory-worktree-shared —— pi-memory V5（A5）：同一仓库的 linked worktree 会话共享项目记忆。
 *
 * 装配：mock-http（llm 通道）——注入块断言需要观察**请求载荷**（context 事件注入的
 * `<memory-context>` 块只在 LLM 请求 messages 里可见，mock server 全量记录请求体，
 * faux 通道无此观察面）。两会话用 model-keyed 独立模型（mem-main / mem-wt）隔离
 * 响应队列游标（mock-llm 游标 per-model 共享，见 lib/mock-llm.mjs 文件头）。
 *
 * 路径（对齐设计 §4 V5 步骤原文）：
 *   ① 主目录会话（cwd=fixture 主仓）经 memory_save 存项目记忆（V1 同款显式路径）→
 *      C：projects/<slug>/facts/<name>.md 落盘 + MEMORY.md 索引行；
 *   ② 同一仓库的 linked worktree 目录开会话（cwd=fixture worktree）提问 →
 *      B：请求载荷含 `<memory-context>` 索引块与该条目（mock requests 铁证）；
 *   ③ commondir 归一共享：主目录会话的续请求载荷同样含该条目 +
 *      C：projects/ 下始终只有一个 slug 目录（两 cwd 派生同一 slug）。
 *
 * 源码锚（feat-memory-system worktree，2026-11-13 实读）：
 *   - slug 归一：extensions/universal/memory/src/engine/paths.ts deriveProjectSlug——
 *     git 仓哈希键 = `git rev-parse --git-common-dir` 的 realpath（linked worktree 与
 *     主仓同值），slug = `<主仓目录名>-<sha256 前 8 位>`；
 *   - 注入块：src/inject/block.ts MEMORY_BLOCK_START='<memory-context>'，
 *     user 消息置于消息流头部（src/inject/context-hook.ts）；
 *   - turn_end 跳过门：src/extract/queue.ts shouldSkipExtraction——本轮 toolResults
 *     含 memory_save 即 already-saved 跳过（会话 A 不产生提炼调用）；
 *   - 提炼调用特征：src/extract/prompt.ts buildExtractionPrompt systemPrompt 首句
 *     「你是记忆提炼器」（会话 B 的 turn_end 提炼以此识别）。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 注入块边界标记（inject/block.ts MEMORY_BLOCK_START）。 */
const MEMORY_BLOCK_START = '<memory-context>'
/** 提炼调用 systemPrompt 首句特征（extract/prompt.ts）。 */
const EXTRACT_MARKER = '你是记忆提炼器'
/** 本剧本的项目记忆条目名（kebab-case，memory_save 参数契约）。 */
const ENTRY_NAME = 'use-pnpm-only'

/** 会话 A（主仓 cwd）的演员：R1 驱动 memory_save 工具调用，R2 文本收尾。 */
const MAIN_STEPS = [
  {
    toolCalls: [
      {
        name: 'memory_save',
        args: {
          name: ENTRY_NAME,
          description: '该项目统一使用 pnpm 包管理器，禁止 npm',
          type: 'project',
          content:
            'Why: 团队约定依赖安装统一走 pnpm workspace 协议，混用 npm 会破坏 lockfile 一致性。\n\nHow to apply: 安装依赖用 pnpm add，运行脚本用 pnpm run；禁止 npm install。',
        },
      },
    ],
    stopReason: 'toolUse',
  },
  { text: '已记住：这个项目统一用 pnpm。', stopReason: 'stop' },
]
/** 会话 B（worktree cwd）的演员：R1 文本回复；R2 = turn_end 提炼调用的 skip 出口。 */
const WT_STEPS = [
  { text: '根据项目记忆：这个项目统一使用 pnpm，禁止 npm。', stopReason: 'stop' },
  { text: '{"operations":[{"op":"skip","reason":"普通提问，无可记内容"}]}', stopReason: 'stop' },
]

export const meta = {
  id: 'memory-worktree-shared',
  priority: 'P0',
  title: 'V5：linked worktree 会话共享项目记忆（commondir 归一两 cwd 同 slug）',
  covers: ['env.launch', 'env.ready', 'env.isolation', 'session.create', 'session.getCommands', 'chat.send', 'chat.wait'],
  requires: ['mock-http'],
  estimateSec: 180,
  llm: {
    mainModel: 'mem-main',
    models: ['mem-main', 'mem-wt'],
    responses: {
      'mockllm/mem-main': MAIN_STEPS,
      'mockllm/mem-wt': WT_STEPS,
    },
  },
  provable: [
    '主仓会话 memory_save 落盘：projects/<slug>/facts/use-pnpm-only.md + MEMORY.md 索引行',
    '主仓会话续请求载荷含 <memory-context> 索引块与该条目（V5 步骤①的注入侧）',
    'linked worktree 会话请求载荷含同一 <memory-context> 块与同一项目条目（V5 通过标准）',
    'C：projects/ 下始终只有一个 slug 目录（主仓与 worktree 两 cwd 归一到同一 slug）',
  ],
  notProvable: [
    'slug 哈希段的数值正确性（sha256 实现属单测域 memory-engine.spec.ts；本剧本以磁盘唯一目录 + 双会话同内容注入为行为证据）',
    'worktree 会话内模型回复执行 pnpm 的语义正确性（mock 演员无语义，V1 的模型行为面不在本剧本）',
  ],
}

/** 请求体 messages → 可检索文本（string 直取；内容块数组取 text 块拼接）。 */
function requestText(req) {
  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('')
    }
    return ''
  }
  return (req.messages ?? []).map((m) => textOf(m?.content)).join('\n')
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, instance } = ctx
  const uncovered = []
  const gotchas = [
    'mock-llm 游标 per-model 共享：主仓会话与 worktree 会话必须用不同模型（modelOverride mem-main / mem-wt），否则第二个会话首轮会吃到第一个会话的队列错位 step',
    '会话 A 的 turn_end 被 already-saved 跳过门拦（toolResults 含 memory_save），不产生提炼调用；会话 B 的 turn_end 正常入队提炼（用户正文 ≥3 词），其 complete 调用继承会话模型 mem-wt、消费队列第 2 步（skip 出口）',
    '请求载荷识别排除提炼调用：提炼请求 systemPrompt 含「你是记忆提炼器」，注入块断言只统计非提炼请求',
  ]

  const gitRun = (cwd, args) => execSync(['git', ...args].join(' '), { cwd, encoding: 'utf8' })

  // ── fixture：真实主仓 + linked worktree（memory-engine.spec.ts 同款手法） ──
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mem-wt-'))
  const repoDir = path.join(tmpRoot, 'repo-main')
  const wtDir = path.join(tmpRoot, 'linked-wt')
  fs.mkdirSync(repoDir)
  gitRun(repoDir, ['init'])
  gitRun(repoDir, ['-c', 'user.email=verify@taiji.dev', '-c', 'user.name=verify', 'commit', '--allow-empty', '-m', 'init'])
  gitRun(repoDir, ['worktree', 'add', '-b', 'wt-branch', JSON.stringify(wtDir)])
  ev.step({ step: 'fixture.worktree', command: 'git init + commit + worktree add', exitCode: 0, stats: { repoDir, wtDir } })

  try {
    // ── ① 主仓会话：memory_save 存项目记忆 ──────────────────────
    const createA = await protocol.call(
      'session.create',
      { cwd: repoDir, label: 'mem-wt-main', modelOverride: 'mockllm/mem-main' },
      { timeoutMs: 120_000 },
    )
    const sidA = createA.session?.id
    ev.assert('B: 主仓会话创建（cwd=fixture 主仓）', Boolean(sidA) && createA.session?.cwd === repoDir, {
      channel: 'B',
      expected: `cwd=${repoDir}`,
      actual: `sid=${sidA} cwd=${createA.session?.cwd}`,
    })

    // memory 扩展装载的行为证据：命令注册在场（govern/commands.ts registerCommand('memory')）
    const cmds = await protocol.call('session.getCommands', { sessionId: sidA }, { timeoutMs: 60_000 })
    const memCmd = (cmds.commands ?? []).find((c) => c?.name === 'memory')
    ev.assert('B: /memory 命令注册在场（pi-memory 扩展装载）', Boolean(memCmd), {
      channel: 'B',
      expected: 'commands 含 name=memory',
      actual: `total=${(cmds.commands ?? []).length} ext=${(cmds.commands ?? []).filter((c) => c?.source === 'extension').length}`,
    })
    ev.step({ step: 'session.getCommands', command: `session.getCommands ${sidA}`, exitCode: memCmd ? 0 : 1, stats: { hasMemory: Boolean(memCmd) } })

    await protocol.subscribe(sidA)
    const sinceA = protocol.events.length
    await protocol.send(sidA, '记住：这个项目统一用 pnpm 包管理器，不要用 npm 安装依赖')
    const endA = await protocol.waitTurnEnd(sidA, { since: sinceA, timeoutMs: 180_000 })
    ev.assert('B: 主仓会话 turn 以 message.complete 结束', endA.ok, {
      channel: 'B',
      expected: 'message.complete + stopReason≠error',
      actual: `${endA.type} stopReason=${endA.payload?.stopReason ?? 'n/a'}`,
    })
    ev.step({ step: 'memory-save.turn', channel: 'B', exitCode: endA.ok ? 0 : 1, stats: { sid: sidA, type: endA.type } })

    // ── C：磁盘落盘（facts 文件 + 项目级索引行） ─────────────────
    const projectsDir = path.join(dataDir, 'agent', 'memory', 'projects')
    let slug = ''
    let factFile = ''
    {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (fs.existsSync(projectsDir)) {
          const dirs = fs.readdirSync(projectsDir).filter((d) => fs.existsSync(path.join(projectsDir, d, 'facts', `${ENTRY_NAME}.md`)))
          if (dirs.length > 0) {
            slug = dirs[0]
            factFile = path.join(projectsDir, slug, 'facts', `${ENTRY_NAME}.md`)
            break
          }
        }
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    ev.assert(`C: 项目条目文件落盘 projects/<slug>/facts/${ENTRY_NAME}.md`, Boolean(slug), {
      channel: 'C',
      expected: `${projectsDir}/<slug>/facts/${ENTRY_NAME}.md 存在`,
      actual: slug ? `slug=${slug}` : `15s 未出现（projects 目录内容：${fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir).join(',') : '目录不存在'}）`,
    })
    const projectIndex = slug ? fs.readFileSync(path.join(projectsDir, slug, 'MEMORY.md'), 'utf8') : ''
    ev.assert('C: 项目级 MEMORY.md 含索引行', projectIndex.includes(`- [${ENTRY_NAME}](${ENTRY_NAME}.md)`), {
      channel: 'C',
      expected: `- [${ENTRY_NAME}](${ENTRY_NAME}.md) — …`,
      actual: projectIndex.split('\n').filter((l) => l.startsWith('- ')).join(' | ').slice(0, 300),
    })
    ev.attach('project-memory-md', projectIndex.slice(0, 2_000))
    ev.attach('fact-file', factFile ? fs.readFileSync(factFile, 'utf8').slice(0, 2_000) : '(missing)')

    // ── ② 主仓会话注入侧（V5 步骤①续）：续请求载荷含索引块 ──────
    const mainInjected = instance.mockLlm.requests.filter(
      (r) => r.model === 'mem-main' && r.status === 200 && !requestText(r).includes(EXTRACT_MARKER) && requestText(r).includes(MEMORY_BLOCK_START),
    )
    ev.assert('B: 主仓会话请求载荷含 <memory-context> 索引块', mainInjected.length >= 1, {
      channel: 'B',
      expected: `≥1 个 mem-main 请求含 ${MEMORY_BLOCK_START}`,
      actual: `hit=${mainInjected.length} totalMemMain=${instance.mockLlm.requests.filter((r) => r.model === 'mem-main').length}`,
    })
    ev.assert('B: 主仓会话注入块含项目条目 use-pnpm-only', mainInjected.some((r) => requestText(r).includes(ENTRY_NAME)), {
      channel: 'B',
      expected: `注入块含 ${ENTRY_NAME}`,
      actual: mainInjected.length ? '在场' : '无注入请求可检',
    })
    if (mainInjected[0]) ev.attach('main-injected-request-tail', requestText(mainInjected[0]).slice(0, 3_000))
    ev.step({ step: 'inject.main', channel: 'B', exitCode: mainInjected.length ? 0 : 1, stats: { hits: mainInjected.length } })

    // ── ③ worktree 会话：同一仓库的 linked worktree 目录提问 ────
    const createB = await protocol.call(
      'session.create',
      { cwd: wtDir, label: 'mem-wt-linked', modelOverride: 'mockllm/mem-wt' },
      { timeoutMs: 120_000 },
    )
    const sidB = createB.session?.id
    ev.assert('B: worktree 会话创建（cwd=fixture linked worktree）', Boolean(sidB) && createB.session?.cwd === wtDir, {
      channel: 'B',
      expected: `cwd=${wtDir}`,
      actual: `sid=${sidB} cwd=${createB.session?.cwd}`,
    })
    await protocol.subscribe(sidB)
    const sinceB = protocol.events.length
    await protocol.send(sidB, '这个项目有什么要注意的包管理约定吗')
    const endB = await protocol.waitTurnEnd(sidB, { since: sinceB, timeoutMs: 180_000 })
    ev.assert('B: worktree 会话 turn 以 message.complete 结束', endB.ok, {
      channel: 'B',
      expected: 'message.complete',
      actual: `${endB.type} stopReason=${endB.payload?.stopReason ?? 'n/a'}`,
    })
    ev.step({ step: 'worktree.turn', channel: 'B', exitCode: endB.ok ? 0 : 1, stats: { sid: sidB } })

    // V5 通过标准：worktree 会话看到同一项目的记忆（请求载荷含索引块 + 同一条目）
    const wtInjected = instance.mockLlm.requests.filter(
      (r) => r.model === 'mem-wt' && r.status === 200 && !requestText(r).includes(EXTRACT_MARKER) && requestText(r).includes(MEMORY_BLOCK_START),
    )
    ev.assert('B: worktree 会话请求载荷含 <memory-context> 索引块（V5 通过标准）', wtInjected.length >= 1, {
      channel: 'B',
      expected: `≥1 个 mem-wt 请求含 ${MEMORY_BLOCK_START}`,
      actual: `hit=${wtInjected.length} totalMemWt=${instance.mockLlm.requests.filter((r) => r.model === 'mem-wt').length}`,
    })
    ev.assert('B: worktree 会话注入块含主仓存的同一项目条目', wtInjected.some((r) => requestText(r).includes(ENTRY_NAME)), {
      channel: 'B',
      expected: `注入块含 ${ENTRY_NAME}（commondir 归一共享）`,
      actual: wtInjected.length ? '在场' : '无注入请求可检',
    })
    if (wtInjected[0]) ev.attach('wt-injected-request-tail', requestText(wtInjected[0]).slice(0, 3_000))
    ev.step({ step: 'inject.worktree', channel: 'B', exitCode: wtInjected.length ? 0 : 1, stats: { hits: wtInjected.length } })

    // ── C：commondir 归一——两 cwd 派生同一 slug（磁盘唯一目录） ──
    const slugsAfter = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : []
    ev.assert('C: projects/ 下只有一个 slug 目录（主仓与 worktree 同 slug）', slugsAfter.length === 1 && slugsAfter[0] === slug, {
      channel: 'C',
      expected: `唯一目录 ${slug}`,
      actual: `dirs=${slugsAfter.join(',')}`,
    })
    // 辅助证据：剧本侧独立复算 commondir 归一键（对齐 paths.ts probeGitCommonDir）
    let commonDirMatch = false
    try {
      const cdRepo = path.resolve(repoDir, gitRun(repoDir, ['rev-parse', '--git-common-dir']).trim())
      const cdWt = path.resolve(wtDir, gitRun(wtDir, ['rev-parse', '--git-common-dir']).trim())
      commonDirMatch = fs.realpathSync(cdRepo) === fs.realpathSync(cdWt)
    } catch {
      commonDirMatch = false
    }
    ev.assert('C: 两 cwd 的 git commondir 指向同一主仓（归一键同值）', commonDirMatch, {
      channel: 'C',
      expected: 'rev-parse --git-common-dir realpath 相同',
      actual: `match=${commonDirMatch}`,
    })

    // ── 软观测：会话 B turn_end 提炼调用的 skip 出口（非断言面） ──
    let extractSeen = false
    try {
      await protocol.waitFor(
        () => instance.mockLlm.requests.some((r) => r.model === 'mem-wt' && requestText(r).includes(EXTRACT_MARKER)),
        { timeoutMs: 20_000 },
      )
      extractSeen = true
    } catch {
      extractSeen = false
    }
    ev.step({ step: 'extract.soft-observe', channel: 'B', exitCode: 0, stats: { extractCallSeen: extractSeen } })
    log(`done slug=${slug} mainInjected=${mainInjected.length} wtInjected=${wtInjected.length} extractSeen=${extractSeen}`)
  } finally {
    // fixture 清理（临时目录整体删除；pi 会话进程不持有 fixture 内写句柄——turn 已收尾）
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* 清理失败不阻塞证据收尾 */
    }
    ev.step({ step: 'fixture.cleanup', command: `rm -rf ${tmpRoot}`, exitCode: fs.existsSync(tmpRoot) ? 1 : 0, stats: { cleaned: !fs.existsSync(tmpRoot) } })
  }

  return { uncovered, gotchas }
}
