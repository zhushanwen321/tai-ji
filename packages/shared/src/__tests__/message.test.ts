/**
 * parseSubagentDirective 单测（composer 四符号 @ 定向对话，PR #191）。
 *
 * 覆盖：SUBAGENT_DIRECTIVE_CUSTOM_TYPE / PI_RESPAWN_NOTICE_CUSTOM_TYPE 两个
 * SSOT 值锁定 + 防御性解析器全分支——
 * 合法输入全字段 / details 缺 subagentId、slug、direction 非 'user' / details 为
 * null、undefined、数组、原始类型 / content 非 string 时 text 归空串。
 * 消费点（runtime live 广播、reload display 覆写、renderer 定向气泡）共用此
 * 单点解析，live ≡ reload 字段一致性构造性成立（关键规则 9）。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/message.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  MSG_ID_TAG_RE,
  PI_RESPAWN_NOTICE_CUSTOM_TYPE,
  SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
  decodeNewlineEscapes,
  parseRespawnNoticeVariant,
  parseSubagentDirective,
} from '../message'

describe('SUBAGENT_DIRECTIVE_CUSTOM_TYPE SSOT', () => {
  it('常量值锁定为 subagent-directive（与 extension 端写入字符串一致，防改名漂移）', () => {
    expect(SUBAGENT_DIRECTIVE_CUSTOM_TYPE).toBe('subagent-directive')
  })
})

describe('PI_RESPAWN_NOTICE_CUSTOM_TYPE SSOT', () => {
  it('常量值锁定为 pi-respawn-notice（core 写入方与 ui 渲染分支共用，防字面量漂移）', () => {
    expect(PI_RESPAWN_NOTICE_CUSTOM_TYPE).toBe('pi-respawn-notice')
  })
})

describe('parseRespawnNoticeVariant 防御性解析', () => {
  it('合法 details：variant 字段命中两形态之一原样返回', () => {
    expect(parseRespawnNoticeVariant({ variant: 'restored' })).toBe('restored')
    expect(parseRespawnNoticeVariant({ variant: 'restoreFailed' })).toBe('restoreFailed')
  })

  it('details 非对象形态（null / undefined / 数组 / 原始类型）→ null（消费侧降级不崩溃）', () => {
    expect(parseRespawnNoticeVariant(null)).toBeNull()
    expect(parseRespawnNoticeVariant(undefined)).toBeNull()
    expect(parseRespawnNoticeVariant([{ variant: 'restored' }])).toBeNull()
    expect(parseRespawnNoticeVariant('restored')).toBeNull()
    expect(parseRespawnNoticeVariant(42)).toBeNull()
  })

  it('variant 非法值 / 缺失 → null', () => {
    expect(parseRespawnNoticeVariant({})).toBeNull()
    expect(parseRespawnNoticeVariant({ variant: 'unknown' })).toBeNull()
    expect(parseRespawnNoticeVariant({ variant: null })).toBeNull()
  })
})

describe('parseSubagentDirective 合法输入', () => {
  it('全字段解析：content + details → SubagentDirectiveData', () => {
    expect(
      parseSubagentDirective('看下构建结果', { subagentId: 'bg-build-1', slug: 'build-api', direction: 'user' }),
    ).toEqual({
      subagentId: 'bg-build-1',
      slug: 'build-api',
      direction: 'user',
      text: '看下构建结果',
    })
  })

  it('query 段含空格的定向文本原样保留（content 是全文原文，不做 trim）', () => {
    const parsed = parseSubagentDirective('请 继续 重试 ', { subagentId: 'a', slug: 'b', direction: 'user' })
    expect(parsed?.text).toBe('请 继续 重试 ')
  })

  it('details 携带多余字段时忽略（只取契约内四字段）', () => {
    const parsed = parseSubagentDirective('hi', {
      subagentId: 'a',
      slug: 'b',
      direction: 'user',
      extra: 'noise',
    })
    expect(parsed).toEqual({ subagentId: 'a', slug: 'b', direction: 'user', text: 'hi' })
  })
})

describe('parseSubagentDirective details 异常 → null（消费侧降级不崩溃）', () => {
  it('details 为 null → null', () => {
    expect(parseSubagentDirective('hi', null)).toBeNull()
  })

  it('details 为 undefined → null', () => {
    expect(parseSubagentDirective('hi', undefined)).toBeNull()
  })

  it('details 为数组 → null（数组是 object，须显式排除）', () => {
    expect(parseSubagentDirective('hi', [{ subagentId: 'a', slug: 'b', direction: 'user' }])).toBeNull()
  })

  it('details 为原始类型（string/number）→ null', () => {
    expect(parseSubagentDirective('hi', 'subagent-directive')).toBeNull()
    expect(parseSubagentDirective('hi', 42)).toBeNull()
  })

  it('details 缺 subagentId → null', () => {
    expect(parseSubagentDirective('hi', { slug: 'b', direction: 'user' })).toBeNull()
  })

  it('details.subagentId 非 string → null', () => {
    expect(parseSubagentDirective('hi', { subagentId: 123, slug: 'b', direction: 'user' })).toBeNull()
  })

  it('details 缺 slug → null', () => {
    expect(parseSubagentDirective('hi', { subagentId: 'a', direction: 'user' })).toBeNull()
  })

  it('details.slug 非 string → null', () => {
    expect(parseSubagentDirective('hi', { subagentId: 'a', slug: null, direction: 'user' })).toBeNull()
  })

  it('details.direction 非 user（如 agent / 缺失）→ null', () => {
    expect(parseSubagentDirective('hi', { subagentId: 'a', slug: 'b', direction: 'agent' })).toBeNull()
    expect(parseSubagentDirective('hi', { subagentId: 'a', slug: 'b' })).toBeNull()
  })
})

describe('parseSubagentDirective content 非 string → text 归空串', () => {
  it('content 为 undefined / number / 数组：details 有效则仍返回（气泡携带去向信息，text 空串）', () => {
    const expected = { subagentId: 'a', slug: 'b', direction: 'user' as const, text: '' }
    expect(parseSubagentDirective(undefined, { subagentId: 'a', slug: 'b', direction: 'user' })).toEqual(expected)
    expect(parseSubagentDirective(100, { subagentId: 'a', slug: 'b', direction: 'user' })).toEqual(expected)
    expect(
      parseSubagentDirective([{ type: 'text', text: 'hi' }], { subagentId: 'a', slug: 'b', direction: 'user' }),
    ).toEqual(expected)
  })

  it('content 异常 + details 异常 → 以 details 判定为准返回 null', () => {
    expect(parseSubagentDirective(undefined, null)).toBeNull()
    expect(parseSubagentDirective(100, { subagentId: 'a', slug: 'b', direction: 'agent' })).toBeNull()
  })
})

describe('MSG_ID_TAG_RE 双形态匹配（投递身份标记 SSOT）', () => {
  const bare = '0a1b2c3d-11e2-42f3-8a44-556677889900'

  it('裸 uuid 形态：命中且捕获组 1 缺省、组 2 = 裸 uuid', () => {
    const m = MSG_ID_TAG_RE.exec(`prefix <!--taiji:msg:${bare}--> suffix`)
    expect(m).not.toBeNull()
    expect(m![1]).toBeUndefined()
    expect(m![2]).toBe(bare)
  })

  it('u- 前缀形态：捕获组 1 = u-、组 2 = 裸 uuid（同 clientUuid 双形态收口）', () => {
    const m = MSG_ID_TAG_RE.exec(`<!--taiji:msg:u-${bare}-->`)
    expect(m![1]).toBe('u-')
    expect(m![2]).toBe(bare)
  })

  it('大写十六进制命中（i 旗标等价覆盖，消费方 toLowerCase 归一）', () => {
    expect(MSG_ID_TAG_RE.test(`<!--taiji:msg:${bare.toUpperCase()}-->`)).toBe(true)
  })

  it('非标记文本 / 非 uuid 形状 → 不命中', () => {
    expect(MSG_ID_TAG_RE.test('plain text without marker')).toBe(false)
    expect(MSG_ID_TAG_RE.test('<!--taiji:msg:not-a-uuid-->')).toBe(false)
    expect(MSG_ID_TAG_RE.test('<!--taiji:msg:0a1b2c3d-11e2-42f3-8a44-55667788990-->')).toBe(false)
  })

  it('/i 无 lastIndex 状态：模块级单例连续 exec 同输入结果恒定', () => {
    const text = `<!--taiji:msg:${bare}-->`
    expect(MSG_ID_TAG_RE.exec(text)?.[2]).toBe(bare)
    expect(MSG_ID_TAG_RE.exec(text)?.[2]).toBe(bare)
  })
})

describe('decodeNewlineEscapes（与 runtime encodeDirectiveText 互逆）', () => {
  // 与 runtime session-records.ts encodeDirectiveText 逐字同型的镜像（shared 不依赖 runtime），
  // 互逆性以此为往返基准。
  const encodeDirectiveText = (text: string): string =>
    text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')

  it('字面 \\n → 真实换行；字面 \\\\ → 单反斜杠', () => {
    expect(decodeNewlineEscapes('a\\nb')).toBe('a\nb')
    expect(decodeNewlineEscapes('a\\\\b')).toBe('a\\b')
  })

  it('单次遍历优先匹配两反斜杠：字面「反斜杠+n」不被误解码为换行（路径 C:\\new 场景）', () => {
    expect(decodeNewlineEscapes('C:\\\\new')).toBe('C:\\new')
    expect(decodeNewlineEscapes('a\\nb')).not.toBe('a\\nb')
  })

  it('互逆性：decode(encode(s)) === s 对转义敏感样本恒成立', () => {
    const samples = [
      'plain',
      'multi\nline\ntext',
      'windows path C:\\new\\thing',
      'trailing backslash \\',
      'backslash-n literal \\n inside',
      '\\\\n doubled backslash then n',
      '换行\n与反斜杠\\混合',
      '',
    ]
    for (const s of samples) {
      expect(decodeNewlineEscapes(encodeDirectiveText(s))).toBe(s)
    }
  })
})
