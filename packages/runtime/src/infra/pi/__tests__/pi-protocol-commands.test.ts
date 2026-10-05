/**
 * 命令识别解析单测（pi1-disposition-chat-flow D2①，§4.1 验收条款 1）：
 * extractExtensionCommandNames 的 source 过滤（extension 命中、skill/prompt 不命中）+
 * matchCommandName 的 `:N` 消歧两类形态（裸 name / 带 `:N` 后缀 name）与失败降级形态。
 * 识别口径两侧同构的锚 = pi 实装 `_tryExecuteExtensionCommand`（slice(1, spaceIndex)
 * 剥斜杠 + invocationName 逐字匹配），本文件锁定该口径的 taiji 侧实现。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-protocol-commands.test.ts
 */
import { describe, expect, it } from 'vitest'
import { extractExtensionCommandNames, matchCommandName } from '../pi-protocol.js'

/** get_commands 响应形态（P5 已核实：extension/prompt/skill 三类条目）。 */
function responseOf(commands: unknown[]): { data: { commands: unknown[] } } {
  return { data: { commands } }
}

describe('extractExtensionCommandNames：source 过滤（D2①）', () => {
  it('extension 条目命中；skill / prompt 条目不进识别集（不属接管——skill/模板展开走正常回合）', () => {
    const names = extractExtensionCommandNames(
      responseOf([
        { name: 'plan', description: 'plan', source: 'extension', sourceInfo: { path: '/x' } },
        { name: 'skill:review', description: 'skill', source: 'skill' },
        { name: 'greet', description: 'template', source: 'prompt' },
        { name: 'todos', source: 'extension' },
      ]),
    )
    expect(names.has('plan')).toBe(true)
    expect(names.has('todos')).toBe(true)
    expect(names.has('skill:review')).toBe(false)
    expect(names.has('greet')).toBe(false)
    expect(names.size).toBe(2)
  })

  it('响应畸形（data.commands 非数组 / 缺 data）：空集——调用方按清单缺失兜底（分支 c）', () => {
    expect(extractExtensionCommandNames({ data: {} }).size).toBe(0)
    expect(extractExtensionCommandNames({ data: { commands: 'nope' } }).size).toBe(0)
    expect(extractExtensionCommandNames({}).size).toBe(0)
  })

  it('name 非字符串 / 空串条目跳过（防御畸形响应）', () => {
    const names = extractExtensionCommandNames(
      responseOf([
        { name: 42, source: 'extension' },
        { name: '', source: 'extension' },
        { source: 'extension' },
        { name: 'ok', source: 'extension' },
      ]),
    )
    expect([...names]).toEqual(['ok'])
  })
})

describe('matchCommandName：逐字精确匹配 + `:N` 消歧两类形态（D2①）', () => {
  // 入参 = extractExtensionCommandNames 的产物（source 过滤后）：extension 命令集
  const names = new Set(['plan', 'todos', 'cmd:1', 'cmd:2'])

  it('裸 name 命中：`/plan`、带参数 `/plan write xxx`（首空格前段）', () => {
    expect(matchCommandName('/plan', names)).toBe('plan')
    expect(matchCommandName('/plan write xxx', names)).toBe('plan')
    expect(matchCommandName('/todos', names)).toBe('todos')
  })

  it('`:N` 消歧后缀形态命中：同名扩展命令的 invocationName（`cmd:2`）逐字匹配', () => {
    expect(matchCommandName('/cmd:2', names)).toBe('cmd:2')
    expect(matchCommandName('/cmd:2 args', names)).toBe('cmd:2')
  })

  it('`:N` 消歧反向形态（两侧行为一致）：裸 name 未注册（pi 侧同样 miss）不命中', () => {
    // 清单只有 cmd:1/cmd:2（同名消歧产物）——用户输入裸 /cmd 时 pi 侧 getCommand('cmd')
    // 同样 miss，两侧行为一致：不命中 → 按普通消息带标记出站（D2① 尾附形态声明）
    expect(matchCommandName('/cmd', names)).toBeUndefined()
    expect(matchCommandName('/cmd:3', names)).toBeUndefined()
  })

  it('不命中形态：非 `/` 前缀、skill 条目经 source 过滤不在集内、大小写敏感', () => {
    expect(matchCommandName('plan', names)).toBeUndefined()
    expect(matchCommandName('/Plan', names)).toBeUndefined()
    expect(matchCommandName('/skill:review', names)).toBeUndefined() // source 过滤后不在集内
    expect(matchCommandName('/planx', names)).toBeUndefined() // 前缀不等于精确
  })

  it('剥斜杠口径与 pi 侧同构：首空格前段剥 `/` 后与 name 相等（含空前格边界）', () => {
    // pi 侧 spaceIndex === -1 时 slice(1)，有参数时 slice(1, spaceIndex)——同款
    expect(matchCommandName('/plan ', names)).toBe('plan')
    expect(matchCommandName('/', names)).toBeUndefined()
  })
})
