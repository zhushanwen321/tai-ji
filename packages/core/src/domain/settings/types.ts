/**
 * settings 域类型 SSOT —— core 包内唯一 SystemSettings 定义点。
 *
 * [迁移] strangler 迁移自 packages/renderer/src/api/domains/settings.ts 的本地定义（DM1）。
 * 与 @taiji/shared 核对结果（C-W1-1）：
 * - shared 无 SystemSettings（shared/src/settings.ts 仅 ToolPermission/ThemeMode/ThemePreset）
 *   → 本文件定义并导出，renderer 侧 W4 收编为从 core import。
 * - ThemeMode 与 shared 的 'light'|'dark'|'system' 等价（= SystemSettings['theme']）。
 * - themePreset 保持宽松 string（renderer 消费方按 string 处理；shared 的 ThemePreset
 *   联合属后续收紧项，不在迁移 wave 内展开）。
 */
import type { ExtensionInfo } from '@taiji/shared'

export interface SystemSettings {
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  themePreset: string
  /** 字体大小：small/medium/large，缺省按 medium（D17） */
  fontSize?: 'small' | 'medium' | 'large'
  /**
   * 分区字号档位（sidebar/chat/drawer 三区域独立缩放；档位→倍率映射见 style.css data-fs-* 规则）。
   * 缺省 medium（×1）。区域子树内 --text-* 链乘以对应 --font-scale-<region>。
   */
  fontScales?: FontScales
  /** 后台完成提示音开关 */
  completionSound?: boolean
  /**
   * 成功完成提示音：系统声音 id（如 'Glass' / 'complete' / 'Windows Notify System Generic'）。
   * undefined / 空串 → 用平台默认（mac=Glass, win=Windows Notify System Generic, linux=complete）。
   * 跨平台失效兜底（W3）：保存的 id 在当前平台不存在时（如 mac 的 'Hero' 切到 linux），
   * main 侧 sound:play 据 kind 回落到对应平台默认（成功音→平台默认成功音），不再静默。
   */
  successSound?: string
  /** 失败完成提示音：语义同 successSound，默认 mac=Funk / win=Windows Notify Email / linux=message-new-instant */
  errorSound?: string
}

/** 外观模式：暗色 / 亮色 / 跟随系统（与 SystemSettings.theme 对齐） */
export type ThemeMode = SystemSettings['theme']

/** 分区字号档位（与 fontSize 档位范式一致，档位→倍率映射在 style.css data-fs-* 规则） */
export type FontScaleTier = 'small' | 'medium' | 'large' | 'xlarge'

/** 分区字号：key = 区域（sidebar/chat/drawer），value = 档位；setSystem 浅合并，更新须传完整对象 */
export interface FontScales {
  sidebar?: FontScaleTier
  chat?: FontScaleTier
  drawer?: FontScaleTier
}

/** 配色主题：由 settings-shell spec §4 System 菜单定义，默认 cold-blue */
export type ColorTheme = string

/**
 * Extension 类型：直接复用 shared ExtensionInfo（SSOT）。
 * 此前本地重复定义 ExtensionItem（tools 必填），但 shared ExtensionInfo 的 tools
 * 是可选（runtime 扫描到时才填），本地必填假设在真实 runtime 下导致 undefined.length 报错。
 * 现在 import ExtensionInfo 并 alias 为 ExtensionItem 保持现有 import 路径兼容。
 */
export type ExtensionItem = ExtensionInfo

/** 默认系统偏好（getSystem 损坏回退与 store system 初始值共用）。 */
export const DEFAULT_SYSTEM: SystemSettings = {
  locale: 'zh-CN',
  theme: 'dark',
  themePreset: 'cold-blue',
  fontSize: 'medium',
  completionSound: true,
}
