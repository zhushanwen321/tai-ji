import { describe, it, expect, vi } from 'vitest'
import { registerHandler, dispatchHandler } from '../src/services/plugin-service/handler-registry'

describe('handler-registry', () => {
  describe('registerHandler', () => {
    it('stores handler in map by handlerId', () => {
      const map = new Map<string, () => void>()
      registerHandler(map, 'h1', () => {})
      expect(map.has('h1')).toBe(true)
    })

    it('dispose removes handler from map', () => {
      const map = new Map<string, () => void>()
      const { dispose } = registerHandler(map, 'h1', () => {})
      dispose()
      expect(map.has('h1')).toBe(false)
    })

    it('dispose calls optional onDispose callback', () => {
      const map = new Map<string, () => void>()
      const onDispose = vi.fn()
      const { dispose } = registerHandler(map, 'h1', () => {}, onDispose)
      dispose()
      expect(onDispose).toHaveBeenCalledOnce()
    })

    it('dispose works without onDispose (optional)', () => {
      const map = new Map<string, () => void>()
      const { dispose } = registerHandler(map, 'h1', () => {})
      expect(() => dispose()).not.toThrow()
    })
  })

  describe('dispatchHandler', () => {
    it('returns true and invokes handler when handlerId found', () => {
      const map = new Map<string, (x: number) => void>()
      const handler = vi.fn()
      registerHandler(map, 'h1', handler)
      const hit = dispatchHandler(map, { handlerId: 'h1' }, (h) => h(42))
      expect(hit).toBe(true)
      expect(handler).toHaveBeenCalledWith(42)
    })

    it('returns false when handlerId not in map', () => {
      const map = new Map<string, () => void>()
      const hit = dispatchHandler(map, { handlerId: 'missing' }, () => {})
      expect(hit).toBe(false)
    })
  })
})
