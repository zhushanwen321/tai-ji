/**
 * local-file:// 协议 URL 构造（renderer img src 唯一构造点，浏览器安全纯函数）。
 *
 * main.ts protocol.handle('local-file') 拦截加载（白名单 =
 * apps/electron/main/gateway/local-file-handlers getAllowedLocalFilePrefixes：
 * `<dataDir>` 整树 + OS tmpdir + dev 工程根——对话流历史图与 composer 暂存图的
 * attachments/tmpdir 落点均在内）。路径经 encodeURIComponent 整体编码（main 侧
 * decodeURIComponent 还原），处理中文/空格/`#` 等特殊字符路径段。
 *
 * 本文件不进 paths.ts（该模块 Node-only，禁止拉进浏览器 bundle，见 index.ts barrel 注释）。
 * 消费方：对话流 ImageThumb、composer 上下文档与行内 image badge 缩略图——
 * 此前各自内联拼接，收敛单点防协议格式漂移。
 *
 * @param path 文件磁盘绝对路径
 */
export function localFileUrl(path: string): string {
  return 'local-file:///' + encodeURIComponent(path)
}
