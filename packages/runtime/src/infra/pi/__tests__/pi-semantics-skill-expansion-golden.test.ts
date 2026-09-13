/**
 * PS-24 探针：pi /skill: 展开格式 vs xyz-agent skill-injector 展开输出 golden diff
 * （composer-multi-skill-injection D5 守卫 / 验收场景 8）。
 *
 * 登记条目（docs/pi-semantics.json PS-24）：pi 0.84.4 的 /skill:name 展开为
 * `<skill name="<skillName>" location="<SKILL.md abs path>">\nReferences are relative to
 * <skillDir>.\n\n<body>\n</skill>`（body = stripFrontmatter 剥 frontmatter 后 trim；args
 * 有则 block + "\n\n" + args）——runtime 注入器（SkillInjector）块内单个 `<skill>` block
 * 的展开输出必须与 pi 逐字一致。pi 升级若改格式（tag 结构 / References 行 / trim 语义 /
 * stripFrontmatter 行为），本探针变红拦截。
 *
 * R4 D11 核对：注入形态改为「正文保留 `<xyz-skill/>` 标记 + 末尾 `<xyz-skill-data>`
 * 包裹块」后，golden 锚定对象不变（单个 `<skill>` block 内容）；整条消息形态断言随
 * D11 更新为「标记保留 + 空行 + 末尾包裹块」（本文件终断言）。
 *
 * 流程（真实 pi RPC 进程 + 真实模型 turn）：
 * 1. mkdtemp 自建 session-dir，并在其 .pi/skills/ 下自建最小测试 skill（项目级扫描源，
 *    fixture 的 --approve 信任 cwd=sessionDir 后 pi 加载；全程不触碰 ~/.xyz-agent / ~/.pi，
 *    凭证由 pi-fixture 拷入隔离 agent dir——只读源文件，不写不删真实目录）；
 * 2. 发 prompt `/skill:u6-golden-probe`，等 agent_end 后读 session JSONL 落盘文本
 *    （PS-14：assistant entry 落账才 flush，故文件出现即含本轮 user entry 展开文本），
 *    提取 user message 文本为 golden；
 * 3. 同输入跑 xyz 侧 SkillInjector：mock client 的 getCommands 原样返回真实 pi 的
 *    get_commands 响应（权威映射同源，不改写任何字段），getSessionStats 给巨大窗口绕过
 *    D6 降级；对照输入 = 生产标记形态 `<xyz-skill name="..."/>`（设计 D3/场景 2，name 为
 *    skill 名、无 `skill:` 前缀）；
 * 4. 终断言（R4 D11）：整条消息形态 = 标记保留 + 空行 + 末尾包裹块；块内单 `<skill>`
 *    block 内容与 pi golden 逐字相等。映射失效（skill_missing）与格式/形态漂移分别给出
 *    定向失败信息。
 *
 * 常量同源（任务约束「CJK 正则与展开格式的常量引用尽量同源」的实现方式）：探针形态 =
 * vitest（探针族现有模式，登记 schema 强制 guard.test 指向 .test.ts），直接 import 生产
 * TS 模块（SkillInjector / buildSkillMarker），无需 tsx/esbuild 加载或源码正则提取的妥协。
 *
 * 与探针族既有静态断言（pi-semantics-rpc-surface 等）的分工：静态族守 pi 源码形态、
 * 凭证无关；本探针是第一个动态成员（真实展开产物对照），按 REAL_PI_TESTS 池约定门控
 * （REAL_PI_READY：pi binary + LLM 凭证双就绪，CI skip）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-skill-expansion-golden.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnPiFixture, REAL_PI_READY, REAL_PI_SKIP_REASON, type PiFixture } from '../../../__tests__/equivalence/pi-fixture.js'
import { SkillInjector } from '../../../services/session/skill-injector.js'
import type { IPiEngine } from '../../../services/ports/pi-engine.js'
import { buildSkillMarker, SKILL_DATA_BLOCK_TAG } from '@xyz-agent/shared'

const SKILL_NAME = 'u6-golden-probe'
/** 测试 skill 正文（含 CJK 与 ascii 混排 + 行尾空白行——顺带覆盖 stripFrontmatter 镜像的 trim 语义）。 */
const SKILL_BODY_LINES = [
  'U6 探针正文第一行（含 CJK 与 ascii mixed 123）',
  '第二行：`code` 与 "quotes" 与 <angle> 原样保留',
]

/** 尽力删除（macOS 下 pi 进程残余写入可致 ENOTEMPTY 竞态，失败不掩蔽主流程；tmp 由 OS 周期清理）。
 *  maxRetries 吸收竞态重试（flake gate 要求，教训 d9ad39cb8）；外层 catch 仍是最终兜底。 */
function rmBestEffort(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {
    // 尽力而为：遗留 tmp 目录不影响断言与后续用例
  }
}

/** pi message content 的宽形态 → 纯文本（string 或 [{type:'text',text}] 数组，实装两形态都处理）。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        const text = (c as { text?: unknown } | null)?.text
        return typeof text === 'string' ? text : ''
      })
      .join('')
  }
  return String(content)
}

/** 从 session JSONL 落盘文本提取首个 user message 的文本（= pi 对 /skill: 的展开产物）。 */
function extractFirstUserTextFromJsonl(sessionDir: string): string {
  const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
  expect(
    files.length,
    `session-dir 下应恰好落盘一个 session JSONL（实际 ${files.length} 个）——无文件 = 本轮未 flush（复核 PS-14 flush 门控与模型轮次是否完成）`,
  ).toBe(1)
  const raw = readFileSync(join(sessionDir, files[0]!), 'utf-8')
  const userTexts: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } }
    if (entry.type === 'message' && entry.message?.role === 'user') {
      userTexts.push(contentToText(entry.message.content))
    }
  }
  expect(
    userTexts.length,
    'JSONL 应含本轮 user message entry——0 条 = prompt 未入账（复核 pi prompt preflight 与模型轮次）',
  ).toBeGreaterThan(0)
  return userTexts[0]!
}

describe.skipIf(!REAL_PI_READY)(
  `PS-24 探针：/skill: 展开格式 golden diff（真实 pi RPC${REAL_PI_SKIP_REASON ? `｜skip：${REAL_PI_SKIP_REASON}` : ''}）`,
  () => {
    let fixture: PiFixture | null = null
    // sessionDir 刻意不走 fixture 的默认 mkdtemp：探针要在 spawn 之前预置 .pi/skills/<name>/SKILL.md
    //（pi 项目级 skill 扫描源，spawn 后不可补挂），dispose 时由 fixture 连同自定义目录一并删除。
    let sessionDir: string | null = null

    beforeAll(async () => {
      sessionDir = mkdtempSync(join(tmpdir(), 'pi-ps22-sess-'))
      const skillDir = join(sessionDir, '.pi', 'skills', SKILL_NAME)
      mkdirSync(skillDir, { recursive: true })
      // frontmatter 只写 description：pi loadSkillFromFile 的 name 回退父目录名（skills.js :244-245）
      writeSkillFile(skillDir, SKILL_BODY_LINES)
      // 冷启动余量 15s：同 thinking-level-effective-e2e 的隔离 agent dir 首启预算
      fixture = await spawnPiFixture({ sessionDir, coldStartTimeoutMs: 15_000 })
    }, 30_000)

    afterAll(async () => {
      if (fixture) await fixture.dispose()
      else if (sessionDir) rmBestEffort(sessionDir)
    })

    it(
      'xyz 注入器展开输出 ≡ pi JSONL 落盘展开文本（逐字 golden diff）',
      { timeout: 240_000 },
      async () => {
        // ── 1. 测试 skill 挂载确认（get_commands 权威映射含本 skill）──
        const cmdsResp = await fixture!.sendCommand('get_commands')
        const commands = ((cmdsResp.data as { commands?: Array<Record<string, unknown>> } | undefined)?.commands ?? []) as Array<{
          name: string
          source: string
          sourceInfo?: { path?: string; baseDir?: string }
        }>
        const skillCmd = commands.find((c) => c.source === 'skill' && c.name === `skill:${SKILL_NAME}`)
        expect(
          skillCmd,
          `get_commands 未返回 skill:${SKILL_NAME}——测试 skill 未被 pi 加载（复核 .pi/skills 挂载与 --approve 信任），后续 diff 无意义`,
        ).toBeDefined()

        // ── 2. 真实 pi turn：/skill:<name> 展开后落盘，读 JSONL 得 golden ──
        await fixture!.runTurn({ message: `/skill:${SKILL_NAME}` }, 180_000)
        const piGolden = extractFirstUserTextFromJsonl(sessionDir!)
        // pi 侧必须是展开形态（防「skill 未挂上 → 原样透传」的假 green：透传文本是命令原文而非 block）
        expect(
          piGolden.startsWith(`<skill name="${SKILL_NAME}"`),
          `pi 侧 user entry 不是展开形态（原样透传？）：${piGolden.slice(0, 120)}`,
        ).toBe(true)

        // ── 3. xyz 侧：同输入跑生产注入器（get_commands 原样透传 = 映射同源；大窗口绕过 D6 降级）──
        const injector = new SkillInjector()
        const client = {
          getCommands: async () => commands,
          getSessionStats: async () => ({ contextUsage: { tokens: 0, contextWindow: 100_000_000, percent: 0 } }),
        } as unknown as IPiEngine
        const marker = buildSkillMarker(SKILL_NAME)
        const result = await injector.inject(client, marker)

        // ── 4. 映射失效定向断言（与格式漂移区分，失败信息指向修复面）──
        const missing = result.notices.find((n) => n.reason === 'skill_missing')
        expect(
          missing,
          `注入器报 skill_missing：生产标记形态（name="${SKILL_NAME}"，无前缀）在 get_commands 映射中未命中。` +
            `pi 实装的 skill 项 name 恒带 "skill:" 前缀（agent-session.js getCommands：name: \`skill:\${skill.name}\`）——` +
            `注入器若以 cmd.name 原样作 map key（或以 cmd.name 插值 block 的 name 属性），与生产标记形态错位。` +
            `修复面：skill-injector 映射/插值用剥离前缀后的 skill 名（PI 锚点 PS-24）`,
        ).toBeUndefined()

        // ── 5. 终断言：整条消息形态（R4 D11「标记保留 + 末尾包裹块」）+ golden diff
        //    （单 block 内容锚不变：块内唯一 `<skill>` 展开必须与 pi 落盘逐字一致；
        //    不等时 vitest 输出首处差异 diff）──
        expect(
          result.text,
          '形态/格式漂移：期望「正文标记保留 + 空行 + 末尾 <xyz-skill-data> 包裹块，块内单 <skill> 与 pi 落盘逐字一致」'
            + '（D11 末尾块组装或 D5 逐字对齐被破坏——复核 skill-injector 末尾块组装、stripFrontmatter 镜像、block 模板、baseDir 取值）',
        ).toBe(`${marker}\n\n${[`<${SKILL_DATA_BLOCK_TAG}>`, piGolden, `</${SKILL_DATA_BLOCK_TAG}>`].join('\n')}`)
      },
    )
  },
)

/** 写最小 SKILL.md（frontmatter description 必填——pi validateDescription 空描述直接过滤该 skill）。 */
function writeSkillFile(skillDir: string, bodyLines: string[]): void {
  const content = [
    '---',
    'description: u6 golden probe skill for expansion format diff',
    '---',
    ...bodyLines,
    '', // 尾部空行：stripFrontmatter 后 trim 语义的顺带覆盖
    '',
  ].join('\n')
  writeFileSync(join(skillDir, 'SKILL.md'), content)
}
