/**
 * local-file:// 协议路径白名单构造（纯函数，integrity-hardening §3.2 D2a）。
 *
 * 白名单只含可信子集（各项的为什么）：
 *   - appPath（app.getAppPath()）：app 资源目录（dev 装配下 = apps/electron 子目录，
 *     非项目根——见 projectRoot 条目）
 *   - dataDir（getDataDir()）：taiji 数据目录（动态推导，dev=~/.taiji-dev，
 *     符合架构约定 #2）+ <dataDir>/attachments：会话级图片附件目录（runtime
 *     session-service 持久化路径，按 sessionId 分区。放行整个 attachments 目录——
 *     全是用户自粘图片非敏感，安全粒度等同 tmpdir；protocol handler 无状态拿不到
 *     session 上下文，无法按 session 推导）
 *   - projectRoot（仅 dev + 装配器注入）：worktree 项目根。dev-instance.mjs 装配的
 *     electron cwd/appPath 都指向 apps/electron 子目录，对话流 <img src="docs/...">
 *     等相对路径解析出的项目根下用户文件命中不了前两者——本成员恢复「项目根」语义
 *     （local-file 图片预览主场景）。是否注入由 main.ts 调用侧条件展开裁决
 *     （isDev && TAIJI_DEV_PROJECT_ROOT），本纯函数不按 isPackaged 过滤——打包态
 *     env 不会被装配器注入，泄漏防线在调用侧双保险
 *   - cwd（仅 dev）：当前项目工作目录。
 *     [HISTORICAL] W3→D2a：打包态剔除 cwd——macOS 打包版从 Finder/Dock 启动时进程
 *     cwd 是 /，前缀匹配 startsWith('/') 对任意绝对路径恒真，白名单塌缩为全盘，
 *     原 [HISTORICAL] 注释「绝不放行 ~ 本身」的护栏被运行时环境击穿。不变量的
 *     守护从注释移到单测：main/test/local-file-prefixes.test.ts
 *     （打包态不含文件系统根 / 不含 homedir 本身）
 *   - tmpdir（os.tmpdir()）：临时文件（导出/截图等 + landing 态图片降级路径）
 *   - 特定用户子目录：~/Documents / ~/Desktop / ~/Downloads（用户内容常见位置）。
 *     绝不放行 ~ 本身（含 ~/.ssh、~/.aws 等敏感文件）——同上由单测守护
 *
 * 每项追加 path.sep 后缀，防止前缀误判（/Users/foo 匹配到 /Users/foobar）。
 *
 * 依赖方向：无下游（纯函数，node:path + node:os）
 */
import path from 'node:path'
import { homedir } from 'node:os'

/** computeLocalFilePrefixes 入参（全部环境参数显式注入，便于单测） */
export interface LocalFilePrefixOptions {
  /** app.isPackaged：打包态剔除 cwd（cwd 语义已失效） */
  isPackaged: boolean
  /** process.cwd()：dev 态的项目工作目录 */
  cwd: string
  /** app.getAppPath()：app 资源目录（缺省跳过该项） */
  appPath?: string
  /**
   * dev 装配器（dev-instance.mjs）注入的项目根（worktree 根）——electron
   * cwd/getAppPath 在 dev 装配下是 apps/electron，白名单需要项目根成员才能放行
   * session cwd 下的用户文件（对话流 <img src="docs/..."> 相对路径解析）。仅 dev
   * 态由 main.ts 调用侧条件展开传入（isDev && TAIJI_DEV_PROJECT_ROOT），打包态
   * 必须缺省（装配器不注入 + 调用侧 isDev 双重防泄漏）。
   */
  projectRoot?: string
  /** getDataDir()：taiji 数据目录（缺省跳过该两项） */
  dataDir?: string
  /** os.tmpdir()（缺省跳过该项） */
  tmpdir?: string
  /** 用户 home（缺省回退 os.homedir()，与 expandLocalFilePath 同范式） */
  home?: string
}

/**
 * 构造 local-file:// 协议的允许前缀列表（每项带 trailing path.sep）。
 *
 * 打包态剔除 cwd（D2a 守卫）；dev 态保留。home 缺省回退 os.homedir()。
 * 可选路径参数缺省时跳过对应项（测试可用最小入参驱动）。
 * projectRoot 是 dev-only 成员，本函数对传入值无条件拼入——是否传（即打包态
 * 不出现该成员）由 main.ts 调用侧 isDev && TAIJI_DEV_PROJECT_ROOT 条件展开裁决。
 */
export function computeLocalFilePrefixes(opts: LocalFilePrefixOptions): string[] {
  const sep = path.sep
  const home = opts.home ?? homedir()
  const userContentSubdirs = ['Documents', 'Desktop', 'Downloads'].map(d => path.join(home, d))
  const prefixes: string[] = [
    ...(opts.appPath ? [opts.appPath] : []),
    // attachments：会话粘贴图片（runtime 持久化）；cache/images：toolResult 图片缓存
    // （D6-⑨，main 经 IPC 落盘后 renderer 以 local-file:// 引用渲染）。
    // 两者均为用户自产图片目录，安全粒度等同 tmpdir，整前缀放行（protocol handler
    // 无状态拿不到 session 上下文，无法按 session 推导）。
    ...(opts.dataDir
      ? [opts.dataDir, path.join(opts.dataDir, 'attachments'), path.join(opts.dataDir, 'cache', 'images')]
      : []),
    // projectRoot：dev 装配器注入的 worktree 根（cwd/appPath 在 dev 装配下都是
    // apps/electron 子目录，命中不了项目根下的用户文件）。dev-only 职责在调用侧。
    ...(opts.projectRoot ? [opts.projectRoot] : []),
    // D2a：打包态 cwd 不可信（Finder 启动时 = /，全盘放行），dev 态保留
    ...(opts.isPackaged ? [] : [opts.cwd]),
    ...(opts.tmpdir ? [opts.tmpdir] : []),
    ...userContentSubdirs,
  ]
  return prefixes.map(p => (p.endsWith(sep) ? p : p + sep))
}
