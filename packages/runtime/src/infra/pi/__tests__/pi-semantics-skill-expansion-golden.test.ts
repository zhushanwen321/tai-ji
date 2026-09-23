/**
 * PS-24 探针：pi /skill: 展开格式 vs taiji skill-injector 展开输出 golden diff
 * （composer-multi-skill-injection D5 守卫 / 验收场景 8）。
 *
 * 登记条目（docs/pi-semantics.json PS-24）：pi 0.84.4 的 /skill:name 展开为
 * `<skill name="<skillName>" location="<SKILL.md abs path>">\nReferences are relative to
 * <skillDir>.\n\n<body>\n</skill>`（body = stripFrontmatter 剥 frontmatter 后 trim；args
 * 有则 block + "\n\n" + args）——runtime 注入器（SkillInjector）块内单个 `<skill>` block
 * 的展开输出必须与 pi 逐字一致。pi 升级若改格式（tag 结构 / References 行 / trim 语义 /
 * stripFrontmatter 行为），本探针变红拦截。
 *
 * R4 D11 核对：注入形态改为「正文保留 `<taiji-skill/>` 标记 + 末尾 `<taiji-skill-data>`
 * 包裹块」后，golden 锚定对象不变（单个 `<skill>` block 内容）；整条消息形态断言随
 * D11 更新为「标记保留 + 空行 + 末尾包裹块」（本文件终断言）。
 *
 * 流程（真实 pi RPC 进程 + 真实模型 turn）：
 * 1. mkdtemp 自建 session-dir，并在其 .pi/skills/ 下自建最小测试 skill（项目级扫描源，
 *    fixture 的 --approve 信任 cwd=sessionDir 后 pi 加载；全程不触碰 ~/.taiji / ~/.pi，
 *    凭证由 pi-fixture 拷入隔离 agent dir——只读源文件，不写不删真实目录）；
 * 2. 发 prompt `/skill:u6-golden-probe`，等 agent_end 后读 session JSONL 落盘文本
 *    （PS-14：assistant entry 落账才 flush，故文件出现即含本轮 user entry 展开文本），
 *    提取 user message 文本为 golden；
 * 3. 同输入跑 taiji 侧 SkillInjector：映射源（D7 切源后为 SkillMappingSource 形态）携带
 *    真实 get_commands skill 项的 SKILL.md 路径（展开输入同源），getSessionStats 给巨大窗口
 *    绕过 D6 降级；对照输入 = 生产标记形态 `<taiji-skill name="..."/>`（设计 D3/场景 2，
 *    name 为 skill 名、无 `skill:` 前缀）；
 * 4. 终断言（R4 D11）：整条消息形态 = 标记保留 + 空行 + 末尾包裹块；块内单 `<skill>`
 *    block 内容与 pi golden 逐字相等。映射失效（skill_missing）与格式/形态漂移分别给出
 *    定向失败信息。
 *
 * 常量同源（任务约束「CJK 正则与展开格式的常量引用尽量同源」的实现方式）：探针形态 =
 * vitest（探针族现有模式，登记 schema 强制 guard.test 指向 .test.ts），直接 import 生产
 * TS 模块（SkillInjector / buildSkillMarker），无需 tsx/esbuild 加载或源码正则提取的妥协。
 *
 * 与探针族既有静态断言（pi-semantics-rpc-surface 等）的分工：静态族守 pi 源码形态、
 * 凭证无关；本探针是动态成员（真实展开产物对照）。faux LLM 轨（L2.5 翻轨）：turn 的
 * 唯一目的是触发 JSONL flush（PS-14 assistant 落账门），faux 一轮文本回复即可，断言
 * 对象（pi 落盘展开文本 golden vs taiji 注入器逐字 diff）与翻轨前一致；门控
 * FAUX_PI_READY（只判 binary，凭证无关、CI 可跑，已从 REAL_PI_TESTS 分池移出）。
 * [pi-bump 触发] /skill: 展开格式是 pi 源码行为，bump 时建议真实轨重放一次（登记由
 * 后续 e2e-map 承接）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-skill-expansion-golden.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnPiFixture, FAUX_PI_READY, FAUX_PI_SKIP_REASON, type PiFixture } from '../../../__tests__/equivalence/pi-fixture.js'
import { SkillInjector } from '../../../services/session/skill-injector.js'
import type { IPiEngine } from '../../../services/ports/pi-engine.js'
import { buildSkillMarker, SKILL_DATA_BLOCK_TAG } from '@taiji/shared'

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

describe.skipIf(!FAUX_PI_READY)(
  `PS-24 探针：/skill: 展开格式 golden diff（faux-pi RPC${FAUX_PI_SKIP_REASON ? `｜skip：${FAUX_PI_SKIP_REASON}` : ''}）`,
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
      // faux 轨：一轮文本回复只为触发 JSONL flush（PS-14 assistant 落账门）；
      // 冷启动余量 15s 由 faux 通道下限兜底（jiti 冷编译 extension）
      fixture = await spawnPiFixture({ sessionDir, coldStartTimeoutMs: 15_000, fauxResponses: [{ text: 'ok' }] })
    }, 30_000)

    afterAll(async () => {
      if (fixture) await fixture.dispose()
      else if (sessionDir) rmBestEffort(sessionDir)
    })

    it(
      'taiji 注入器展开输出 ≡ pi JSONL 落盘展开文本（逐字 golden diff）',
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

        // ── 3. taiji 侧：同输入跑生产注入器（映射源携带 pi 实际加载的 SKILL.md 路径 =
        //    展开输入同源；大窗口绕过 D6 降级）。D7 切源后注入器消费 SkillMappingSource
        //    （registry 扫描形态，name 裸名 + sourcePath）——探针以真实 get_commands 的
        //    skill 项 path 构造同形 stub（pi 侧 get_commands 仍是「这个路径被谁加载」的
        //    权威取径），golden 对照目标不变（同路径 → 同 block）。──
        const skillMdPath = skillCmd?.sourceInfo?.path
        expect(
          skillMdPath,
          'get_commands skill 项缺 sourceInfo.path——无法构造注入器映射源（复核 pi createSkillSourceInfo）',
        ).toBeTypeOf('string')
        const injector = new SkillInjector({
          getGlobalSkills: () => [{
            id: `probe-${SKILL_NAME}`,
            name: SKILL_NAME,
            description: 'u6 golden probe entry',
            enabled: true,
            source: 'pi',
            triggers: [],
            sourcePath: skillMdPath as string,
          }],
          getProjectSkills: async () => [],
        })
        const client = {
          getSessionStats: async () => ({ contextUsage: { tokens: 0, contextWindow: 100_000_000, percent: 0 } }),
        } as unknown as IPiEngine
        const marker = buildSkillMarker(SKILL_NAME)
        const result = await injector.inject(client, marker)

        // ── 4. 映射失效定向断言（与格式漂移区分，失败信息指向修复面）──
        const missing = result.notices.find((n) => n.reason === 'skill_missing')
        expect(
          missing,
          `注入器报 skill_missing：映射源未提供 name="${SKILL_NAME}"（裸名）条目。` +
            `修复面：skill-injector 的 registry 映射构建（buildSkillsByNameFromRegistry，key 用 SkillInfo.name 裸名）或本探针映射源构造`,
        ).toBeUndefined()

        // ── 5. 终断言：整条消息形态（R4 D11「标记保留 + 末尾包裹块」）+ golden diff
        //    （单 block 内容锚不变：块内唯一 `<skill>` 展开必须与 pi 落盘逐字一致；
        //    不等时 vitest 输出首处差异 diff）──
        expect(
          result.text,
          '形态/格式漂移：期望「正文标记保留 + 空行 + 末尾 <taiji-skill-data> 包裹块，块内单 <skill> 与 pi 落盘逐字一致」'
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
