/**
 * 测试 fixture 常量（跨测试文件共享的 uuid 形态标识符）。
 *
 * 全部用例的项目内数据 = 各测试文件用 mkdtemp 自建自删的最小 session 文件
 *（按测试断言逻辑构造，不读本机真实用户数据目录）。本文件只登记 uuid 常量，
 * 取值约束：
 * - 合法 uuid 形态（满足 extractSessionIdFromFilename / header id 谓词）；
 * - FIX_E6 含十六进制片段 'e6c96'，作 uuid 片段匹配路径（find/resolveSessionId）的锚 id，
 *   且完整 id 以 '019e6c96' 开头，供前缀断言。
 *
 * 本文件无 .test.ts 后缀，vitest include 只收集 `src/__tests__/` 下以 .test.ts 结尾的文件，不收集本文件。
 */

/** 主 fixture session id：片段 'e6c96' 命中 + 完整 id '019e6c96' 前缀断言的锚。 */
export const FIX_E6 = '019e6c96-0a0c-74b8-a73f-d1854d88e2a7'
