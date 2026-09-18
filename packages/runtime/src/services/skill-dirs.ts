/**
 * Skill 目录解析 SSOT —— scanner 与 watcher 共用的唯一目录发现逻辑。
 *
 * 背景（EMFILE 事故 2026-07-22）：原 SkillRegistry.getProjectSkills 用 chokidar
 * 递归 watch 整个项目 cwd，cwd 为 home 目录等巨型目录时 fd 耗尽（EMFILE 10899 次），
 * 级联导致 pi 子进程 spawn EBADF → 发消息超时 / 读历史失败 / runtime 崩溃。
 *
 * 根因：watcher 的监听范围（整个 cwd）远大于 scanner 的扫描范围（仅几个 skill 子目录）。
 * 本模块把"skill 目录在哪"收敛为唯一事实源，scanner（ConfigService.loadSkills）和
 * watcher（SkillRegistry）都从这里取目录列表，从结构上保证 watch 范围 = scan 范围，
 * 不再有 watch 整个 cwd 的可能。
 *
 * v2 显式 scope（方案 §2.5 / §3.2 Must-Fix #1）：project/global 归属不再靠 isAbsolute/startsWith('~/')
 * 推断，而是直接读 discovery.json v2 的 projectPaths/globalPaths——用户在 UI 显式标注的 scope
 * 才真正决定加载归属与优先级。相对路径（projectPaths）resolve 到 projectRoot；绝对/~ 路径
 * （globalPaths）经 expandHome 展开。
 */
import { isAbsolute, join, resolve } from 'node:path'

import { expandHome } from '../utils/path-utils.js'
import type { DirScopes } from './skill-dir-config.js'

/**
 * 强制·项目 skill 目录（ADR-0021 §1.1 桥接层硬编码，项目相对路径，最高优先）。
 * 存在则扫，resolve 基准是用户当前项目 cwd（projectRoot）。
 */
export const FORCED_PROJECT_SKILL_DIR = '.taiji/skills'

/**
 * pi 原生项目 skill 目录（skill-reload-nondestructive D7 扫描集对账）。
 * pi 实装扫描 `resolve(cwd, CONFIG_DIR_NAME, "skills")` 且 CONFIG_DIR_NAME=".pi"
 * （@earendil-works/pi-coding-agent 0.84.4 dist/config.js:402 + dist/core/skills.js:349），
 * taiji 扫描集原本不含它——skill-injector 注入映射切源 taiji SkillRegistry 后，该目录
 * 的 skill 会从 get_commands 权威消失，不补入即回归 skill_missing。scan 与 watch 经
 * resolveProjectSkillDirs SSOT 同源双覆盖（连带良性行为：.pi/skills 变动开始触发 reload）。
 * 顺序：排在 taiji 强制目录之后、discovery 用户配置之前（对齐 pi「defaults 先于 skillPaths」
 * 的装载序；.taiji/skills 是 taiji 自己的强制目录，保持最高项目优先）。
 */
const PI_PROJECT_SKILL_DIR = '.pi/skills'

/**
 * configStore 的窄接口（与 PiConfigStore / SkillRegistryConfigStore 对齐）。
 * 只需要目录发现相关的方法。
 */
export interface SkillDirConfigSource {
  /** pi agent 配置目录（<dataDir>/agent）。 */
  getPiAgentDir(): string
  /**
   * discovery.json skill 的 v2 分 scope 结构（projectPaths / globalPaths）。
   * v2：消费端直接读显式 scope 决定加载归属，不再 isAbsolute 推断（方案 §2.5 路径 A 配套）。
   */
  getSkillPathScopes(): DirScopes
}

/**
 * 全局 skill 目录列表（不依赖 projectRoot）。
 * scanner 扫描这些 + 项目目录；watcher（initGlobal）只 watch 这些。
 *
 * v2：直接读 discovery.skill.globalPaths（显式 global scope），不再用 isAbsolute 推断。
 * 加上两个强制全局目录（piAgentDir/skills、configDir/skills）。
 *
 * @param configDir taiji 配置根目录（~/.taiji/，由调用方传入——ConfigService 传
 *   getConfigDir()，SkillRegistry 传 options.configDir；两者值相同，显式传入避免隐式 env 依赖）。
 *   全局强制目录 <configDir>/skills 由此派生。
 *   返回未去重的有序列表（靠前的优先级高），调用方按需处理。
 */
export function resolveGlobalSkillDirs(
  configStore: SkillDirConfigSource,
  configDir: string,
): string[] {
  return [
    join(configStore.getPiAgentDir(), 'skills'),
    join(configDir, 'skills'),
    ...configStore.getSkillPathScopes().globalPaths.map(d => expandHome(d)),
  ]
}

/**
 * 项目级 skill 目录列表（依赖 projectRoot resolve 的相对路径）。
 * scanner 扫描这些 + 全局目录；watcher（getProjectSkills）只 watch 这些，
 * 不再 watch 整个 cwd。
 *
 * v2：直接读 discovery.skill.projectPaths（显式 project scope），不再 isAbsolute 排除绝对路径。
 * projectPaths 允许相对+绝对（项目级语义）：相对路径 resolve 到 projectRoot，绝对路径原样保留。
 * 加上强制项目目录（.taiji/skills）与 pi 原生项目目录（.pi/skills，D7 扫描集对账，见常量注释）。
 */
export function resolveProjectSkillDirs(
  projectRoot: string,
  configStore: SkillDirConfigSource,
): string[] {
  const resolveDir = (dir: string): string =>
    isAbsolute(dir) ? dir : resolve(projectRoot, dir)
  return [
    resolve(projectRoot, FORCED_PROJECT_SKILL_DIR),
    resolve(projectRoot, PI_PROJECT_SKILL_DIR),
    ...configStore.getSkillPathScopes().projectPaths.map(resolveDir),
  ]
}
