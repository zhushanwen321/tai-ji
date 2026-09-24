/**
 * 撤回草稿还原纯函数测试（U5，设计 §3.3 D7 两层规则——revoke-restore.ts 为 SSOT）。
 *
 * 覆盖：
 * - stripDeliveryMarkers：单条剥标记（裸 uuid / u- 前缀双形态）+ 用户尾换行保留 + 无标记原样；
 * - restoreRevokedDraft 层 1 切条：段数、各段内容、第 2..N 段首连接产物剥除、
 *   corner「用户原文以分隔符开头——段首字面保留」、多条空行合并回单草稿；
 * - restoreRevokedDraft 层 2 兜底：混入无标记段 / 内嵌标记形态 / 单标记非末尾 / 无标记
 *   ——整条原样返回，不剥任何标记（宁合不裂，内容不丢优先）；
 * - 跨包可达性：index.ts allowlist 登记守卫。
 *
 * 输入形态锚定（内核实装核实）：单条 = `原文\n<!--taiji:msg:<uuid>-->`（withDeliveryMarker
 * 恒尾附）；降级整批 = 各条已带标记的文本以 `\n\n---\n\n` 连接（buildBatchPayload BATCH_SEP）。
 */
import { describe, it, expect } from 'vitest'
import { stripDeliveryMarkers, restoreRevokedDraft } from '../revoke-restore'
import {
  stripDeliveryMarkers as stripFromRoot,
  restoreRevokedDraft as restoreFromRoot,
} from '../index'

const UUID_A = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'
const UUID_B = '1b2c3d4e-5f60-7182-8394-b5c6d7e8f9a0'
const UUID_C = '2c3d4e5f-6071-8293-94a5-c6d7e8f9a0b1'
const TAG_A = `<!--taiji:msg:${UUID_A}-->`
const TAG_B = `<!--taiji:msg:${UUID_B}-->`
const TAG_C = `<!--taiji:msg:${UUID_C}-->`
const U_TAG = `<!--taiji:msg:u-${UUID_A}-->`
const JOINER = '\n\n---\n\n'

describe('stripDeliveryMarkers（单条形态主导路径）', () => {
  it('裸 uuid 形态：剥标记与紧邻前导换行，剥后即用户原文', () => {
    expect(stripDeliveryMarkers(`帮我写个排序\n${TAG_A}`)).toBe('帮我写个排序')
  })

  it('u- 前缀形态（回归期富消息双标记）：同样剥除', () => {
    expect(stripDeliveryMarkers(`带图片的消息\n${U_TAG}`)).toBe('带图片的消息')
  })

  it('用户原文以换行结尾：自身尾换行保留（只剥内核连接换行）', () => {
    // transcript = `原文\n` + `\n` + TAG —— 剥「标记+紧邻单个前导换行」后剩 `原文\n`
    expect(stripDeliveryMarkers(`原文\n\n${TAG_A}`)).toBe('原文\n')
  })

  it('多行原文：中段换行全保留', () => {
    const text = '第一行\n第二行\n\n第三行'
    expect(stripDeliveryMarkers(`${text}\n${TAG_A}`)).toBe(text)
  })

  it('无标记文本：原样返回', () => {
    expect(stripDeliveryMarkers('plain text')).toBe('plain text')
  })
})

describe('restoreRevokedDraft 层 1（纯用户合批切条，确定性）', () => {
  it('三段合批：切出三段原文，第 2..N 段首连接产物剥除，空行连接合并回单草稿', () => {
    const batch = `第一条\n${TAG_A}${JOINER}第二条\n${TAG_B}${JOINER}第三条\n${TAG_C}`
    expect(restoreRevokedDraft(batch)).toBe('第一条\n\n第二条\n\n第三条')
  })

  it('两段合批（最小降级形态）', () => {
    const batch = `甲\n${TAG_A}${JOINER}乙\n${TAG_B}`
    expect(restoreRevokedDraft(batch)).toBe('甲\n\n乙')
  })

  it('单条形态（整批函数的单条输入）：剥标记即原文（与 stripDeliveryMarkers 一致）', () => {
    expect(restoreRevokedDraft(`单条消息\n${TAG_A}`)).toBe('单条消息')
  })

  it('corner：第 2 段用户原文以分隔符开头——段首只剥内核连接产物，用户字面保留', () => {
    // 第二条原文本身以 `\n\n---\n\n` 开头：段内首个 joiner 是内核产物（剥），第二个是用户字面（留）
    const secondRaw = `${JOINER}用户以分隔符开头`
    const batch = `第一条\n${TAG_A}${JOINER}${secondRaw}\n${TAG_B}`
    expect(restoreRevokedDraft(batch)).toBe(`第一条\n\n${secondRaw}`)
  })

  it('corner：第 1 段用户原文以分隔符开头——段首无连接产物不剥，字面保留', () => {
    const firstRaw = `${JOINER}首条以分隔符开头`
    const batch = `${firstRaw}\n${TAG_A}${JOINER}第二条\n${TAG_B}`
    expect(restoreRevokedDraft(batch)).toBe(`${firstRaw}\n\n第二条`)
  })

  it('段原文含多行与尾换行：各段内容精确保留（含原文自身的尾换行）', () => {
    const firstRaw = '多行\n原文\n'
    const secondRaw = '第二段'
    const batch = `${firstRaw}\n${TAG_A}${JOINER}${secondRaw}\n${TAG_B}`
    expect(restoreRevokedDraft(batch)).toBe(`${firstRaw}\n\n${secondRaw}`)
  })

  it('u- 前缀标记形态的合批同样可切条（双形态同源正则）', () => {
    const batch = `一\n${U_TAG}${JOINER}二\n${TAG_B}`
    expect(restoreRevokedDraft(batch)).toBe('一\n\n二')
  })
})

describe('restoreRevokedDraft 层 2（一切校验不过——整条原样，不剥标记）', () => {
  it('混入无标记段（标记后 joiner 但无下一标记）：整条原样', () => {
    const content = `第一条\n${TAG_A}${JOINER}agent 通路段无标记`
    expect(restoreRevokedDraft(content)).toBe(content)
  })

  it('末段无标记（合批尾段标记缺失）：整条原样', () => {
    const content = `一\n${TAG_A}${JOINER}二\n${TAG_B}${JOINER}三（无标记尾段）`
    expect(restoreRevokedDraft(content)).toBe(content)
  })

  it('内嵌标记形态（用户字面嵌在段中间，布局失真）：整条原样不剥', () => {
    const content = `用户嵌了${TAG_A}字面在中间\n${TAG_B}`
    expect(restoreRevokedDraft(content)).toBe(content)
  })

  it('单标记但不在全文末尾（无真尾标记的异常形态）：整条原样', () => {
    const content = `前文${TAG_A}后文`
    expect(restoreRevokedDraft(content)).toBe(content)
  })

  it('无标记：原样返回', () => {
    expect(restoreRevokedDraft('无标记内容')).toBe('无标记内容')
  })

  it('标记后既非末尾也非 joiner（布局不一致）：整条原样', () => {
    const content = `一\n${TAG_A}紧跟文本\n${TAG_B}`
    expect(restoreRevokedDraft(content)).toBe(content)
  })
})

describe('revoke-restore 跨包可达性（index allowlist）', () => {
  it('根入口导出与模块直连是同一实现', () => {
    expect(stripFromRoot).toBe(stripDeliveryMarkers)
    expect(restoreFromRoot).toBe(restoreRevokedDraft)
  })
})
