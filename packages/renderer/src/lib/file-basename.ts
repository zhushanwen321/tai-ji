/**
 * 文件路径/basename 反查工具 —— 薄 re-export（SSOT 在 @taiji/ui）。
 *
 * findByBasename / collectBasenames / collectFilePaths 的实现已归位
 * ui 包（lib/file-basename.ts，w6 迁入），renderer 经此 shim 消费，
 * import 路径稳定（@/lib/file-basename 不变，ui 重构不影响 renderer）。
 */
export { findByBasename, collectBasenames, collectFilePaths } from '@taiji/ui'
