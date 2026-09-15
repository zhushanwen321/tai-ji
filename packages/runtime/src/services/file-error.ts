/**
 * FileError 错误类型（code-architecture §3，#2 F-2）。
 *
 * FileService 所有越界/权限/超时/未实现失败抛 FileError(code)。§6 来源 B NFR-AC-S2/S5
 * 断言按 code 锚定；handler 按 code 转 error envelope。
 *
 * 与 GitService.GitError（git-service.ts，readonly code: string）范式对称，
 * 区别是 FileErrorCode 为联合字面量（穷举分类），handler 可据此做精确分支。
 */
export type FileErrorCode =
  | 'session_not_found'
  | 'permission_denied'
  | 'out_of_cwd' // NFR-AC-S2 越界统一守门
  | 'timeout' // AC-2.5 / K-2 fs-executor 超时
  | 'not_found'
  | 'read_failed'
  | 'not_implemented' // AC-14.4 file.write 骨架（#14 实现延后，handler 转 { implemented:false }）

/** 文件操作失败错误类型。handler 按 code 转 error envelope（D10/P0-B）。 */
export class FileError extends Error {
  readonly code: FileErrorCode
  constructor(code: FileErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'FileError'
    this.code = code
  }
}
