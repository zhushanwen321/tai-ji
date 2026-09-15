/**
 * Sample project entry — E2E fixture for file-tree rendering tests.
 *
 * Not executed; exists only to provide a deterministic top-level source node
 * (src/index.ts) and a nested file (src/utils/format.ts) for the 文件树 panel.
 */
import { formatGreeting } from './utils/format.js'

export function main(): string {
  return formatGreeting('world')
}
