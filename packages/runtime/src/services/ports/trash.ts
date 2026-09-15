/**
 * ITrash port —— 文件软删除（mac 废纸篓 / 非 mac unlink）的 seam
 * （memory-leak-remediation §3.2-B5，2026-09-14）。
 *
 * 动机：B5 将 SessionDataStore 的磁盘删除从 rmSync 永久删改为 trash 软删除（与
 * session 本体持久性对齐——支持废纸篓还原/import 同 id 复活工作流），但
 * SessionDataStore（services 层）不得 value import infra/system/trash.ts
 * （C-comm-03 三层约束「services 层 IO 一律经 port」）——本接口是该约束下的收口：
 * services 依赖此 port 类型，infra/system/trash.ts 的 trash 函数（结构匹配
 * trashFile 成员签名）由组合根 index.ts 经 PluginService deps 注入。
 *
 * 语义（继承 trash.ts G4 裁决）：mac 路径 trash 命令失败/超时**不降级** unlink——
 * 文件保留原地并抛结构化错误（「可撤销操作永不静默变不可逆」由构造保证）；
 * 调用方 best-effort 消费（void…catch(warn)），失败 = B5 对该 session 不生效的
 * 登记降级（重启后 restoreFromDisk 仍预载，见设计 §3.2-B5 降级登记）。
 */
export interface ITrash {
  /**
   * 软删除单个文件：mac 移入系统废纸篓（trash CLI / Finder AppleScript，5s 超时），
   * 非 mac 平台 unlink。失败 = 文件保留原地 + rejection 上抛（不静默永久删）。
   */
  trashFile(filePath: string): Promise<void>
}
