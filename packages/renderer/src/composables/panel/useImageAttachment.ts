/**
 * 图片粘贴附件处理（Cmd+V/Ctrl+V 统一通路）。
 *
 * 职责单一：把剪贴板 image blob 转成 base64，经 writeSessionImage IPC 落地到
 * <getDataDir>/attachments/<sessionId>/（持久化），返回联合结果（badge / text 降级）
 * 由调用方（useContenteditableInput.onPaste / useComposerDragDrop.onDrop）决定如何写入 DOM
 * ——本 composable 不碰 DOM。
 *
 * 降级矩阵：
 * - base64 读取失败（FileReader.onerror）→ {kind:'text', text:'[图片读取失败]'}
 * - 非 electron 环境（writeSessionImage 返回 undefined）→ {kind:'text', text:'[图片粘贴：需桌面环境]'}
 * - IPC 写入失败（throw，含超大被拒）→ {kind:'text', text:'[图片粘贴失败]'}
 * - 成功 → {kind:'badge', path, fileName, displayName}，调用方调
 *   insertImageBadge(path, fileName, displayName)（fileName 磁盘全名，displayName 用户可读名）
 *
 * sessionId：landing 态（session 延迟创建）为 null → IPC 内降级走 OS tmpdir
 * （landing 粘图后通常立即发送，session 随即创建；丢失走 w2 降级 badge 兜底）。
 *
 * [HISTORICAL] 曾有 metaKey 区分（Cmd+V 富呈现 vs Ctrl+V 纯文本通路），onPaste 统一通路后
 * handleImagePaste 不再接受 metaKey——所有调用方都走富呈现，避免 Ctrl+V 截图静默丢弃。
 *
 * 依赖方向：useImageAttachment → lib/ipc（唯一 electronAPI 适配点）
 */
import { session as sessionApi } from '@/api'

/** handleImagePaste 返回联合类型。
 *  badge 分支含 path（磁盘绝对路径，local-file:// 加载用）+ fileName（磁盘全名，含 uuid 前缀，
 *  日志/磁盘定位）+ displayName（用户可读名，badge label / 缩略图 alt 用）。
 *  needsMigrate：是否需要 tmpdir → attachments 迁移（landing 态 writeSessionImage 落 tmpdir 时 true）。 */
export type HandleImagePasteResult =
  | { kind: 'badge'; path: string; fileName: string; displayName: string; needsMigrate: boolean }
  | { kind: 'text'; text: string }

/**
 * 字节数组 → base64（分块 btoa 防 stack 溢出，大图直接 btoa 二进制串会爆栈）。
 *
 * 从原 fileToBase64 抽出的公共工具：send 闭环的 extractImages 读 local-file 文件后
 * 也要把 Uint8Array 转 base64（同一编码逻辑），抽公共函数 DRY 且单测覆盖一处。
 */
export function fileBytesToBase64(bytes: Uint8Array): string {
  // 二进制字符串分块 btoa：每块 0x8000 字节（btoa 单次安全上限经验值），避免大图爆栈
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}

/** File → base64（委托 fileBytesToBase64 做 UTF-8 安全的分块编码）。 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const buf = reader.result
      if (!(buf instanceof ArrayBuffer)) {
        reject(new Error('FileReader did not return ArrayBuffer'))
        return
      }
      resolve(fileBytesToBase64(new Uint8Array(buf)))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * 处理剪贴板图片粘贴（Cmd/Ctrl+V 统一通路，不区分按键）。
 *
 * @param blob      剪贴板取出的 image File（clipboardData.items[i].getAsFile()）或拖入的图片文件
 * @param sessionId 当前会话 id（决定持久化目录）；landing 态为 null → IPC 内降级 tmpdir
 * @returns 联合结果，调用方按 kind 决定写 badge / 降级文本
 */
export async function handleImagePaste(
  blob: File,
  sessionId: string | null,
): Promise<HandleImagePasteResult> {
  let base64: string
  try {
    base64 = await fileToBase64(blob)
  } catch {
    return { kind: 'text', text: '[图片读取失败]' }
  }

  let result: { path: string; fileName: string; displayName: string; id: string; persisted: boolean } | undefined
  try {
    // sanitize name（defense in depth，与 main 进程 privileged-handlers.ts 的清理对称）：
    // 剥离路径分隔符 + 控制字符，防恶意/异常 blob.name（如 ../etc/passwd）穿越。
    // renderer 是第一个信任边界，提前清理；main 进程会再 sanitize 一次，双层防护。
    const rawName = blob.name || 'image'
    const sanitizedName = rawName.replace(/[/\\:\x00-\x1f]/g, '').trim() || 'image'
    result = await sessionApi.writeImage({
      sessionId: sessionId ?? '',
      base64,
      mimeType: blob.type,
      name: sanitizedName,
    })
  } catch {
    // IPC 写入失败（磁盘满 / 权限 / 主进程 throw / 超大被拒）→ 降级文本提示
    return { kind: 'text', text: '[图片粘贴失败]' }
  }
  // 非 electron 环境（web/mock）：writeSessionImage 返回 undefined → 降级文本提示
  if (!result) return { kind: 'text', text: '[图片粘贴：需桌面环境]' }
  // needsMigrate：persisted=false（落 tmpdir 的 landing 态图）→ true（session 创建后需迁移到 attachments）
  return { kind: 'badge', path: result.path, fileName: result.fileName, displayName: result.displayName, needsMigrate: !result.persisted }
}

/** composable 入口（保留 useXxx 范式，当前无实例状态，纯函数导出便于未来扩展） */
export function useImageAttachment() {
  return { handleImagePaste }
}
