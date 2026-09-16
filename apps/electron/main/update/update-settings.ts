/**
 * 升级设置存储读写 SSOT（Single Source Of Truth）。
 *
 * 持久化用户对升级行为的偏好设置，当前含「预下载开关」「自动更新开关」与「更新来源偏好」：
 * - preDownload：检测到新版时自动在后台下载安装包，用户点击更新时跳过下载等待直接进入替换重启
 * - autoUpdate：启动时自动检查更新并提示下载（v6 demo 语义）
 * - updateSource：更新来源偏好（'auto' / 'github' / 'gitcode'）。语义为「优先级」而非
 *   「独占」（设计 update-multi-source §6.3 D3）：显式选某源 = 该源优先，任一环节失败
 *   仍自动降级另一源；缺省/非法值回退默认 'auto'（老 settings 文件无此字段 = auto，向后兼容）
 *
 * 仿 proxy-config.ts 的 SSOT 模式：本模块只依赖 @taiji/shared + node:fs/node:path，
 * 不静态依赖 electron，gateway 层（update-handlers）调用。
 *
 * 落盘位置：升级工作目录（getUpdateDir()）下 update-settings.json（与升级产物同目录，便于统一清理）。
 *
 * 依赖方向：update-settings → constants + @taiji/shared + node:fs/path
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { UpdateSettings, UpdateSourcePref } from '@taiji/shared'
import { getUpdateSettingsFile } from './constants.js'

/**
 * updateSource 的合法值集合（多源 D3 三值枚举 SSOT）。
 *
 * 读取侧逐字段校验（本文件 getUpdateSettings 经 normalizeUpdateSourcePref）与 gateway 层
 * update:setSettings 入参校验共用同一来源，防两处枚举漂移。
 * 命名/形态对齐 shared 的 LAUNCH_RESULT_STATUSES as const 先例。
 */
export const UPDATE_SOURCE_PREFS = ['auto', 'github', 'gitcode'] as const satisfies readonly UpdateSourcePref[]

/**
 * updateSource 归一 + 合法性判定：unknown → UpdateSourcePref | undefined。
 *
 * 旧值兼容（'atomgit' → 'gitcode'）：v0.10.0 落盘的 update-settings.json 与旧版
 * renderer 可能携带 'atomgit'——该源即 GitCode（平台更名前旧称），语义完全等价，
 * 一次性映射为 'gitcode'，存量用户显式偏好不因改名丢失。本字面量是全仓唯一
 * 允许的 'atomgit' 残留（兼容入口，勿在他处复用）。
 *
 * 返回 undefined = 非法值（含其他任意 unknown），调用方回退默认 'auto'。
 * 读取侧（getUpdateSettings）与 gateway 入参校验（update-handlers update:setSettings）
 * 共用本函数——两处「什么算合法来源 + 旧值如何归一」判定恒一致。
 */
export function normalizeUpdateSourcePref(value: unknown): UpdateSourcePref | undefined {
  if (value === 'atomgit') return 'gitcode'
  return (UPDATE_SOURCE_PREFS as readonly string[]).includes(value as string)
    ? (value as UpdateSourcePref)
    : undefined
}

/**
 * 升级设置默认值。
 *
 * preDownload 默认 false：新用户不自动消耗流量/磁盘，需主动到设置页开启。
 * autoUpdate 默认 true（2026-08-28 用户拍板，设计 §3.6 RM1）：存量用户现状即
 * 无条件自动检查（Sidebar.vue 无条件 initAutoCheck），若默认 false 则升级到本批次
 * 后存量用户的自动检查/升级提醒会静默消失，属行为倒退；默认 true 后须在 release
 * note 说明「自动检查现为可在设置中关闭」。
 * updateSource 默认 'auto'（多源 D3）：现状行为 = 按源顺序自动决定，显式偏好由
 * 设置页写入；缺省/非法值回退本默认值。
 */
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  preDownload: false,
  autoUpdate: true,
  updateSource: 'auto',
}

/**
 * 读取升级设置。
 *
 * 容错策略：文件不存在 / JSON 解析失败 / 字段缺失 → 返回默认值（不阻断升级流程）。
 * 逐字段校验类型，确保未知/损坏的字段不污染返回值。
 */
export function getUpdateSettings(): UpdateSettings {
  if (!existsSync(getUpdateSettingsFile())) {
    return { ...DEFAULT_UPDATE_SETTINGS }
  }

  let raw: string
  try {
    raw = readFileSync(getUpdateSettingsFile(), 'utf-8')
  } catch (err) {
    console.warn('[update-settings] read failed, using defaults:', err)
    return { ...DEFAULT_UPDATE_SETTINGS }
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    console.warn('[update-settings] parse failed, using defaults:', err)
    return { ...DEFAULT_UPDATE_SETTINGS }
  }

  // 逐字段校验，缺失/类型错误的字段回退默认值
  const settings: UpdateSettings = { ...DEFAULT_UPDATE_SETTINGS }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (typeof obj.preDownload === 'boolean') {
      settings.preDownload = obj.preDownload
    }
    if (typeof obj.autoUpdate === 'boolean') {
      settings.autoUpdate = obj.autoUpdate
    }
    // updateSource 归一 + 枚举校验（多源 D3）：三值合法原样；旧落盘值归一映射
    // （v0.10.0 旧值兼容，见 normalizeUpdateSourcePref 注释）；非法/缺失保持默认 'auto'，
    // 对齐上方 boolean 字段的「回退默认值」模式
    const normalizedSource = normalizeUpdateSourcePref(obj.updateSource)
    if (normalizedSource !== undefined) {
      settings.updateSource = normalizedSource
    }
  }
  return settings
}

/**
 * 写入升级设置（局部更新语义）。
 *
 * 自动 mkdirSync 父目录（recursive）。best-effort：写入失败抛错由调用方决定容错
 * （gateway 层 IPC handler 已有 try/catch 包裹）。
 *
 * 合并语义：以现有设置（含默认值）为基底合并传入字段后整体写盘，
 * 调用方只传要修改的字段（如仅 { preDownload } 或仅 { updateSource }），不会覆盖其他开关的持久化值。
 * updateSource 的合法性校验在调用方（update:setSettings handler 入参校验 + 读取侧逐字段
 * 枚举校验兜底），本函数不做校验（与 preDownload/autoUpdate 同策略）。
 */
export function setUpdateSettings(settings: Partial<UpdateSettings>): void {
  mkdirSync(path.dirname(getUpdateSettingsFile()), { recursive: true })
  // 合并写入：读现有设置做基底，局部更新不丢其他字段
  const merged: UpdateSettings = { ...getUpdateSettings(), ...settings }
  // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
  writeFileSync(getUpdateSettingsFile(), JSON.stringify(merged, null, 2))
}
