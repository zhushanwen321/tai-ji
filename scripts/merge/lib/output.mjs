/** 统一终端输出（颜色码与原 bash 脚本一致，输出形态零变化）。 */
export const RED = '\x1b[0;31m'
export const GREEN = '\x1b[0;32m'
export const YELLOW = '\x1b[1;33m'
export const BOLD = '\x1b[1m'
export const NC = '\x1b[0m'

export function paint(color, text) {
  return `${color}${text}${NC}`
}
