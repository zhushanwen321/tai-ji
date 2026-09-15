import { execFileSync } from 'node:child_process'

const WINDOWS_NO_PROCESS_EXIT_CODE = 128

export function terminateWindowsProcessTree(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return true
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
    if (status !== WINDOWS_NO_PROCESS_EXIT_CODE) {
      console.warn(
        `[runtime] taskkill failed for PID ${pid}:`,
        error instanceof Error ? error.message : String(error),
      )
    }
    return false
  }
}
