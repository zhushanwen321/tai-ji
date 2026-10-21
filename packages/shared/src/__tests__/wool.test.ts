/**
 * wool 域类型与运行时守卫单测（wool-provider 设计 D2/D6/D7）。
 *
 * 覆盖：清单 schema 守卫（合法/缺字段/坏版本）、账号状态守卫（与 wool-shared
 * account-status 字段对齐义务的宿主侧锚点）、detect 回包守卫、家族词表守卫、
 * 动作词表完备性（dispatch 穷举前提）。
 *
 * 测试框架：vitest。运行：cd packages/shared && npx vitest run src/__tests__/wool.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  isWoolAccountStatusView,
  isWoolAssetManifest,
  isWoolDetectData,
  isWoolFamilyId,
  WOOL_ACTION_TYPES,
  WOOL_FAMILY_IDS,
  type WoolAssetManifest,
} from '../wool.js'

const VALID_MANIFEST: WoolAssetManifest = {
  schemaVersion: 1,
  generatedAt: 1_700_000_000_000,
  families: {
    qoder: {
      pkg: '@zhushanwen/pi-wool-qoder',
      version: '0.1.0',
      displayName: 'Qoder',
      vendor: '阿里',
      credentialsSource: 'ide-extract',
      riskNotice: '非官方接口：使用你自己的账号额度',
    },
  },
}

describe('isWoolAssetManifest（清单 schema 守卫）', () => {
  it('合法清单通过（含可选 integrity）', () => {
    expect(isWoolAssetManifest(VALID_MANIFEST)).toBe(true)
    expect(isWoolAssetManifest({ ...VALID_MANIFEST, families: { qoder: { ...VALID_MANIFEST.families.qoder!, integrity: 'sha512:abc' } } })).toBe(true)
  })

  it('schemaVersion 非 1 / generatedAt 非数字 / families 非对象 → 拒', () => {
    expect(isWoolAssetManifest({ ...VALID_MANIFEST, schemaVersion: 2 })).toBe(false)
    expect(isWoolAssetManifest({ ...VALID_MANIFEST, generatedAt: 'x' })).toBe(false)
    expect(isWoolAssetManifest({ ...VALID_MANIFEST, families: [] })).toBe(false)
    expect(isWoolAssetManifest(null)).toBe(false)
    expect(isWoolAssetManifest('json')).toBe(false)
  })

  it('家族条目缺必填字段（pkg/version/displayName/vendor/credentialsSource/riskNotice）→ 拒（bad_shape 阻断不直装的前提）', () => {
    const base = VALID_MANIFEST.families.qoder!
    expect(isWoolAssetManifest({ ...VALID_MANIFEST, families: { qoder: { ...base, pkg: '' } } })).toBe(false)
    expect(isWoolAssetManifest({ ...VALID_MANIFEST, families: { qoder: { ...base, version: '' } } })).toBe(false)
    expect(isWoolAssetManifest({ ...VALID_MANIFEST, families: { qoder: { ...base, displayName: 1 } } as never })).toBe(false)
    expect(isWoolAssetManifest({ ...VALID_MANIFEST, families: { qoder: { ...base, credentialsSource: 'magic' } } })).toBe(false)
    expect(isWoolAssetManifest({ ...VALID_MANIFEST, families: { qoder: { ...base, riskNotice: undefined } } })).toBe(false)
  })
})

describe('isWoolAccountStatusView（账号状态守卫——wool-shared 字段对齐锚点）', () => {
  it('最小合法（loggedIn + fetchedAt）与全字段形态通过', () => {
    expect(isWoolAccountStatusView({ loggedIn: true, fetchedAt: 1 })).toBe(true)
    expect(isWoolAccountStatusView({
      loggedIn: false,
      nickname: 'demo',
      quota: { used: 10, total: 100, remaining: 90, unit: 'credits' },
      checkin: { doneToday: true, streak: 3, lastCheckedAt: 2 },
      tokenExpiresAt: 3,
      fetchedAt: 4,
    })).toBe(true)
  })

  it('loggedIn/fetchedAt 缺失或错型 → 拒（读侧不信任扩展回包）', () => {
    expect(isWoolAccountStatusView({ loggedIn: 'yes', fetchedAt: 1 })).toBe(false)
    expect(isWoolAccountStatusView({ loggedIn: true })).toBe(false)
    expect(isWoolAccountStatusView(null)).toBe(false)
  })

  it('quota/checkin 子对象坏形态 → 拒', () => {
    expect(isWoolAccountStatusView({ loggedIn: true, fetchedAt: 1, quota: { used: 'x', unit: 'c' } })).toBe(false)
    expect(isWoolAccountStatusView({ loggedIn: true, fetchedAt: 1, quota: { used: 1 } })).toBe(false)
    expect(isWoolAccountStatusView({ loggedIn: true, fetchedAt: 1, checkin: { doneToday: 'y' } })).toBe(false)
  })
})

describe('isWoolDetectData / isWoolFamilyId', () => {
  it('detect 回包：detected 布尔必填，detail 可选字符串', () => {
    expect(isWoolDetectData({ detected: true })).toBe(true)
    expect(isWoolDetectData({ detected: false, detail: 'no file' })).toBe(true)
    expect(isWoolDetectData({ detail: 'no detected field' })).toBe(false)
    expect(isWoolDetectData({ detected: 1 })).toBe(false)
  })

  it('家族词表三值；词表外拒', () => {
    for (const id of WOOL_FAMILY_IDS) expect(isWoolFamilyId(id)).toBe(true)
    expect(isWoolFamilyId('codebuddy')).toBe(false)
    expect(isWoolFamilyId(42)).toBe(false)
  })
})

describe('动作词表（wool-manager dispatch 穷举前提）', () => {
  it('七动作 + extract（透传通道）词表封闭', () => {
    expect(WOOL_ACTION_TYPES).toEqual(['install', 'detect', 'status', 'checkin', 'refresh', 'setAutoCheckin', 'authorize', 'extract'])
  })
})
