/**
 * shutdown 链 dispose-terminal-ptys 步骤本体（孤儿 shell 加固③，runtime 退出链显式收口）。
 *
 * 提取成可 import 的单步函数：index.ts 组合根 import 即执行 main() 不可直测（index.ts
 * 内多处同款注释），单步语义（先打点再 destroyAll）经本模块单测锁定。
 * 挂点契约（index.ts shutdown 内）：server.stop（传输层关停）之前——先收自己受托的
 * 资源再关门；空表 no-op（TerminalService.destroyAll 幂等），shutdown 双信号重入安全。
 */
import type { ShutdownStepName } from '../session/rolling-restart.js'
import type { ITerminalService } from '../ports/terminal-service.js'

export function disposeTerminalPtysStep(
  terminalService: Pick<ITerminalService, 'destroyAll'>,
  shutdownStep: (name: ShutdownStepName) => void,
): void {
  shutdownStep('dispose-terminal-ptys')
  terminalService.destroyAll()
}
