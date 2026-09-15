/**
 * supportedLevelsOf —— 单源 re-export shim。
 *
 * 实现已收编至 @taiji/core/domain/new-task-search（supported-levels.ts）：
 * 原本文件实现与 core flow.ts 内逐字镜像的双副本收编为 core 单源（core 域不能
 * import renderer 模块，单源只能落 core 侧）。本文件保留维持消费方 import 路径
 * 不变（useNewTaskFlow / composer-shell / 测试），并保持独立模块形态——composer
 * 系列测试 vi.mock 整个 useNewTaskFlow 模块时，显示侧从本模块 import 不被该
 * mock 波及（设计动机详见 core 侧头注）。
 */
export { supportedLevelsOf } from '@taiji/core/domain/new-task-search'
