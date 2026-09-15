/**
 * system 持久化 —— IF3：getSystem/updateSystem 经 KVStorage（PlatformPort.storage）。
 *
 * [迁移] strangler 迁移自 packages/renderer/src/api/domains/settings.ts 的 localStorage
 * 直连实现（D8 收编）。core 零 localStorage 直连——读写全部经 KVStorage 接口；
 * renderer 壳（W4）providePlatform 时注入 LocalStorageAdapter。
 *
 * 语义保留：损坏数据回退默认值（ES2，不抛错不吞错）；写入失败 throw（调用方 toast）。
 */
import type { KVStorage } from '../../platform/port'
import { DEFAULT_SYSTEM, type SystemSettings } from './types'

/** localStorage key（与 renderer 原值一致；W4 收编时替换 renderer 本地常量）。 */
export const SYSTEM_KEY = 'taiji:system-settings'

/**
 * 读取系统偏好：SYSTEM_KEY 缺失或 JSON 损坏时显式回退默认值
 * （空对象 spread 兜底，与 renderer 原实现语义一致）。
 */
export async function getSystem(storage: KVStorage): Promise<SystemSettings> {
  const raw = await storage.get(SYSTEM_KEY)
  let parsed: Partial<SystemSettings> = {}
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Partial<SystemSettings>
    } catch {
      // 数据损坏：显式回退到默认值（空对象 → 下行 spread 自动用 DEFAULT_SYSTEM 兜底）
      parsed = {}
    }
  }
  return { ...DEFAULT_SYSTEM, ...parsed }
}

/**
 * 合并写入系统偏好：读当前值 → 合并 → 写回。
 * 写入失败（storage.set reject）自然向上 throw（调用方可据 toast 反馈）。
 */
export async function updateSystem(
  storage: KVStorage,
  patch: Partial<SystemSettings>,
): Promise<void> {
  const cur = await getSystem(storage)
  await storage.set(SYSTEM_KEY, JSON.stringify({ ...cur, ...patch }))
}
