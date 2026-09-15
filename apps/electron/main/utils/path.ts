import { homedir } from 'node:os'

/**
 * 展开本地文件 URL/路径中的 ~ 为当前用户 home 目录。
 *
 * Electron 渲染进程无法安全获取 homedir，因此 ~ 展开统一在主进程处理。
 * 仅当路径以 ~ 或 ~/ 开头时展开；其他路径原样返回。
 */
export function expandLocalFilePath(filePath: string): string {
  if (filePath === '~' || filePath.startsWith('~/')) {
    return filePath.replace(/^~/, homedir())
  }
  return filePath
}
