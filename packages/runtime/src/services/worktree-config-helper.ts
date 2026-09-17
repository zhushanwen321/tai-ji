/**
 * Worktree 偏好配置 helper（git-cwt-anywhere：root dir / setup 脚本 / 超时 / 默认
 * base branch），从 config-service.ts 抽出，控 max-lines 500。
 *
 * 经注入的 AppConfigAccessors 读写，落在 app config.json 顶层字段。本模块只负责
 * 字段级读写 + 校验，不关心 config.json 的落盘细节（由 load/save 回调负责，避免
 * 循环依赖 + 不暴露 ConfigService 的私有方法）。
 *
 * 本文件曾混入 auto-rename / rename-session / smart-context 三个配置域（P1-7 名实
 * 拆分前），已各归其位：rename-session-config.ts（auto-rename 开关 + rename model/
 * mode）、smart-context-config.ts（smart-context 快照），共享 RMW 基建在
 * ext-config-rmw.ts。本文件回归文件名语义 = worktree 偏好单一职责。
 */

/** app config.json 的 load/save 能力（ConfigService 注入，避免暴露其私有方法）。 */
export type AppConfigAccessors = {
  /** 读 app config.json（不存在 / 损坏返回 {}）。 */
  load(): Record<string, unknown>
  /** 全量覆写 app config.json。 */
  save(config: Record<string, unknown>): void
}

/** 默认 worktree 根目录（~/worktrees，与原 ConfigService 内联值一致）。 */
const DEFAULT_WORKTREE_ROOT_DIR = '~/worktrees'
/** 默认 setup 脚本相对路径（裸仓 / 普通仓共用同一默认）。 */
const DEFAULT_SETUP_SCRIPT = 'custom-hooks/setup-worktree.sh'
/** 默认 worktree 操作超时（秒）。 */
const DEFAULT_TIMEOUT = 60
/** 超时上限（秒）：与 setSystemPromptConfig 的窗口约束风格一致，防异常大值卡死 PTY。 */
const TIMEOUT_MAX = 3600
/** 默认 base branch（origin/main）。 */
const DEFAULT_BASE_BRANCH = 'origin/main'

export function getWorktreeRootDir(app: AppConfigAccessors): string {
  const val = app.load()['worktreeRootDir']
  return typeof val === 'string' ? val : DEFAULT_WORKTREE_ROOT_DIR
}

export function setWorktreeRootDir(app: AppConfigAccessors, dir: string): void {
  if (!dir || !dir.trim()) {
    throw new Error('worktreeRootDir cannot be empty')
  }
  const config = app.load()
  config['worktreeRootDir'] = dir
  app.save(config)
}

export function getSetupScript(app: AppConfigAccessors): string {
  const val = app.load()['setupScript']
  return typeof val === 'string' ? val : DEFAULT_SETUP_SCRIPT
}

export function setSetupScript(app: AppConfigAccessors, dir: string): void {
  if (dir.includes('..')) {
    throw new Error('setupScript path cannot contain ..')
  }
  const config = app.load()
  config['setupScript'] = dir
  app.save(config)
}

export function getBareSetupScript(app: AppConfigAccessors): string {
  const val = app.load()['bareSetupScript']
  return typeof val === 'string' ? val : DEFAULT_SETUP_SCRIPT
}

export function setBareSetupScript(app: AppConfigAccessors, script: string): void {
  // 与 setSetupScript 同款防线：裸仓 setup 脚本与普通仓脚本同语义（经 shell 执行），
  // `..` 路径穿越风险面相同，校验与错误信息形态逐字对齐。
  if (script.includes('..')) {
    throw new Error('bareSetupScript path cannot contain ..')
  }
  const config = app.load()
  config['bareSetupScript'] = script
  app.save(config)
}

export function getTimeout(app: AppConfigAccessors): number {
  const val = app.load()['worktreeTimeout']
  return typeof val === 'number' ? val : DEFAULT_TIMEOUT
}

export function setTimeout(app: AppConfigAccessors, timeout: number): void {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > TIMEOUT_MAX) {
    throw new Error(`timeout must be a positive number in (0, ${TIMEOUT_MAX}], got ${timeout}`)
  }
  const config = app.load()
  config['worktreeTimeout'] = timeout
  app.save(config)
}


export function getDefaultBaseBranch(app: AppConfigAccessors): string {
  const val = app.load()['defaultBaseBranch']
  return typeof val === 'string' ? val : DEFAULT_BASE_BRANCH
}

export function setDefaultBaseBranch(app: AppConfigAccessors, baseBranch: string): void {
  const config = app.load()
  config['defaultBaseBranch'] = baseBranch
  app.save(config)
}
