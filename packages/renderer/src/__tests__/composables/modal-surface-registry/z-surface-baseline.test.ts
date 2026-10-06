/**
 * 聚合单测族 · z 基线全等断言（display-containers §6.7 完备性判据 / §8.2 验收条款 1）。
 *
 * 对账语义：全仓 z 值 ≥ 1000 的表面字面量扫描集（z-scan-helper 三类字面形态 + CSS 声明形）
 * 与登记表（modal-surface-registry/manifest.ts）的 zAnchors 多重集**全等**——
 * - 新增表面不登记 ⇒ 本文件红（防「view 盖模态 + Esc 双关」静默回归）；
 * - 表面删除/改 z 形态未同步登记表 ⇒ 同样红（登记表不许腐化）。
 *
 * 三视角归属：本文件是守卫类对账用例（构建者白盒——登记表 ↔ 源码字面量机器对账）；
 * 用户可见 DOM/行为断言由 registry-flags（挂载点开关 + 旗标查询）/ modal-surface-event-order
 * （真实事件序）/ local-esc-two-tier（两档契约）三个文件承载。
 *
 * 测试框架：vitest（fs 只读扫描，不触任何数据目录）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/modal-surface-registry
 */
import { describe, it, expect } from 'vitest'
import {
  MODAL_SURFACE_FAMILY_FLAGS,
  MODAL_SURFACE_MANIFEST,
  modalSurfaceEntry,
  modalSurfaceFlags,
} from '@/composables/features/app/modal-surface-registry'
import { findRepoRoot, scanZSurfaces, type ZOccurrence } from './z-scan-helper'

const repoRoot = findRepoRoot()
const occurrences: ZOccurrence[] = scanZSurfaces(repoRoot)

/** (file, form, literal) → 出现次数（扫描侧多重集） */
function scannedCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const o of occurrences) counts.set(`${o.file}|${o.form}|${o.literal}`, (counts.get(`${o.file}|${o.form}|${o.literal}`) ?? 0) + 1)
  return counts
}

/** (file, form, literal) → 出现次数（登记表侧多重集） */
function manifestCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of MODAL_SURFACE_MANIFEST) {
    for (const anchor of entry.zAnchors) {
      const key = `${anchor.file}|${anchor.form}|${anchor.literal}`
      counts.set(key, (counts.get(key) ?? 0) + anchor.count)
    }
  }
  return counts
}

describe('z 基线 ↔ 登记表全等对账（§6.7 完备性判据）', () => {
  it('扫描器非空转：已知表面（SettingsModal / SearchModal / CompanionBand / ToastContainer）均被扫到', () => {
    const keys = [...scannedCounts().keys()]
    expect(keys.some((k) => k.includes('SettingsModal.vue') && k.includes('var(--z-modal)'))).toBe(true)
    expect(keys.some((k) => k.includes('overlays/SearchModal.vue') && k.endsWith('|1000'))).toBe(true)
    expect(keys.some((k) => k.includes('CompanionBand.vue') && k.includes('var(--z-dialog)'))).toBe(true)
    expect(keys.some((k) => k.includes('ToastContainer.vue') && k.endsWith('|9999'))).toBe(true)
    // 三类字面形态 + CSS 声明形都在扫描面里（CSS 形现存 0 处，形本身仍须在场）
    for (const o of occurrences) expect(o.value).toBeGreaterThanOrEqual(1000)
  })

  it('全等断言：扫描多重集 ≡ 登记表 zAnchors 多重集（新增表面不登记即红）', () => {
    const scanned = scannedCounts()
    const manifest = manifestCounts()
    const unregistered = [...scanned.keys()].filter((k) => !manifest.has(k)).sort()
    const stale = [...manifest.keys()].filter((k) => !scanned.has(k)).sort()
    const countMismatch = [...scanned.keys()]
      .filter((k) => manifest.has(k) && manifest.get(k) !== scanned.get(k))
      .map((k) => `${k}: scan=${scanned.get(k)} manifest=${manifest.get(k)}`)
      .sort()
    expect({
      unregistered,
      stale,
      countMismatch,
    }).toEqual({ unregistered: [], stale: [], countMismatch: [] })
  })

  it('登记表结构完整：每个表面一行、家族旗标组齐备（三旗标字段）、kind 语义自洽', () => {
    const seen = new Set<string>()
    for (const entry of MODAL_SURFACE_MANIFEST) {
      expect(seen.has(entry.id), `登记表 id 重复：${entry.id}`).toBe(false)
      seen.add(entry.id)
      const flags = MODAL_SURFACE_FAMILY_FLAGS[entry.family]
      expect(typeof flags.yieldsEsc).toBe('boolean')
      expect(typeof flags.yieldsCmdW).toBe('boolean')
      expect(['none', 'unconditional', 'intersecting']).toContain(flags.shieldsView)
      // 同步查询通道可取到同一旗标组（注册方无权自带旗标的对账）
      expect(modalSurfaceFlags(entry.id)).toEqual(flags)
      expect(modalSurfaceEntry(entry.id).family).toBe(entry.family)
      // kind 语义：excluded 只允许浮层壳（容器非模态，§6.7 末段）
      if (entry.kind === 'excluded') {
        expect(entry.family).toBe('overlay-shell')
        expect(entry.basis.length).toBeGreaterThan(10)
      }
    }
  })

  it('豁免与低 z 面不入基线：HoverCard（z-[90]）/ PlanCommentPopover（--z-overlay: 20）零登记零扫描', () => {
    const keys = [...scannedCounts().keys()]
    expect(keys.some((k) => k.includes('HoverCard'))).toBe(false)
    expect(keys.some((k) => k.includes('PlanCommentPopover'))).toBe(false)
  })
})
