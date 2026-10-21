/**
 * archiveAssetDomainDir 的 sessionId 内联断言单测（dmg-r2-1 兜底防线）：该函数返回值
 * 流向 rmSync(recursive, force) 破坏性原语，非法 id 在 join 前 fail-fast。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/archive/archive-paths.test.ts
 */
import { describe, expect, it } from 'vitest'
import { archiveAssetDomainDir } from './archive-paths.js'

describe('archiveAssetDomainDir sessionId 内联断言（dmg-r2-1）', () => {
  it('合法 pi 会话 id 返回 assets/<sessionId>/<domain> 分区路径', () => {
    expect(archiveAssetDomainDir('/archive/bucket', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'attachments')).toBe(
      '/archive/bucket/assets/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/attachments',
    )
  })

  it.each(['../evil', '..', 'sub/sess', 'sub\\sess', 'btw:sess01', 'sess 01', ''])(
    '穿越/非法形态 sessionId throw（path traversal blocked）：%s',
    (sessionId) => {
      expect(() => archiveAssetDomainDir('/archive/bucket', sessionId, 'artifacts')).toThrow('path traversal blocked')
    },
  )
})
