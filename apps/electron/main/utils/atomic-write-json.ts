/**
 * main 侧 JSON 落盘原子写单一助手（MF-1-9 收敛点）。
 *
 * 此前 main 进程三套写纪律并存：remote-access 手写 tmp+fsync+rename+0600、
 * window-state 持有 runtime fs-utils atomicWrite 的手抄副本、update 三文件
 * （update-settings / pending-update / preloaded-update）裸 writeFileSync——崩溃
 * 窗口半写会把用户偏好静默重置。本模块是这四处写方的唯一实现（[替换不叠层]，
 * 各调用方不再保留本地副本）。
 *
 * 纪律（取三套中的最强段）：
 * - 原子性：先写同目录 tmp 再 rename——rename 在 POSIX/NTFS 上都是原子替换，
 *   并发读方（runtime 热读 / 下次启动读取）要么读到完整旧内容要么完整新内容。
 * - tmp 失败清理：写 / fsync / rename 任一环节失败时删除刚建的 tmp 再原样上抛
 *   （rename 失败留 tmp 是永久垃圾）；清理自身失败只残留一个 tmp，吞掉不掩盖
 *   原错误。
 * - tmp 名含 pid+进程内序号且以 `.tmp` 结尾：跨进程并发写同一 filePath 时 tmp 名
 *   互不碰撞（固定名会互相踩踏——A 的 rename 携带 B 的半截内容）；`.tmp` 结尾
 *   使 update 工作目录的孤儿 tmp 能被 update-self-healer 的 *.tmp 扫描兜底清理。
 * - fsync 档（opts.fsync，缺省关）：writeFileSync 返回 ≠ 数据已落盘，掉电时
 *   rename 可能先于数据刷写落定，留下内容为空的「完整」新文件；rename 前对
 *   tmp 的 fd 做 fsyncSync 强制刷盘，失败（掉电前兆）即中止写入不 rename。
 *   fsync 段以只读 fd 打开（fsync 不要求写权限）。
 * - mode 档（opts.mode，缺省 0o666 同 writeFileSync 缺省）：writeFileSync 的 mode
 *   只在创建文件时生效且受 umask 影响，rename 后再 chmodSync 兜底归位（承载
 *   凭据类文件传 0o600，禁 group/other 读取）。
 *
 * 序列化形态：JSON.stringify(data, null, 2) + 尾换行（人类可读落盘，与 dataDir
 * 内其他 JSON 配置一致；读取方全部 JSON.parse，对空白宽容）。
 *
 * 归属：main/utils 叶子工具，不依赖 electron 运行时，可单测。runtime 包的同语义
 * 实现在 packages/runtime/src/utils/fs-utils.ts（atomicWrite）——main 进程不依赖
 * runtime 包（依赖方向 main → @taiji/shared），语义同构各自持有。
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** JSON 缩进空格数（人类可读落盘） */
const JSON_INDENT_SPACES = 2

/** tmp / 目标文件缺省创建 mode（与 writeFileSync 缺省一致，实际生效受 umask 影响） */
const DEFAULT_FILE_MODE = 0o666

/** 进程内 tmp 序号：与 pid 组合保证同进程多次写、跨进程并发写的 tmp 名互不碰撞 */
let tmpSeq = 0

/**
 * 原子写 JSON 文件：自动建父目录 → 写同目录 tmp（pid+序号后缀，`.tmp` 结尾）→
 * （可选）fsync → rename → （可选）chmod 归位；任一环节失败清 tmp 后原样上抛，
 * 目标文件保持旧内容。
 *
 * @param filePath 目标文件绝对路径
 * @param data 可 JSON 序列化的数据（落盘形态 = 缩进 2 + 尾换行）
 * @param opts.mode 文件权限（仅创建时生效的 writeFileSync mode + rename 后 chmodSync
 *   兜底归位，缺省 0o666 同 writeFileSync 缺省）——承载凭据类内容（token 等）的
 *   调用方传 0o600，禁 group/other 读取
 * @param opts.fsync rename 前对 tmp 做 fsyncSync（掉电半写防护：保证 rename 落定
 *   时刻数据已在盘上，缺省关）——fsync 失败（掉电前兆）即中止写入裸抛，不 rename
 *   可能半写的文件
 */
export function atomicWriteJsonFile(
  filePath: string,
  data: unknown,
  opts: { mode?: number; fsync?: boolean } = {},
): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  tmpSeq = (tmpSeq + 1) % Number.MAX_SAFE_INTEGER
  const tmpPath = `${filePath}.${process.pid}-${tmpSeq}.tmp`
  const mode = opts.mode ?? DEFAULT_FILE_MODE
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, JSON_INDENT_SPACES)}\n`, { mode })
    if (opts.fsync) {
      const fd = openSync(tmpPath, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    renameSync(tmpPath, filePath)
    chmodSync(filePath, mode)
  } catch (e) {
    try {
      unlinkSync(tmpPath)
    } catch {
      void 0 /* 清理失败不掩盖原错误；残留 tmp 无害（update 目录内由 *.tmp 孤儿清扫兜底） */
    }
    throw e
  }
}
