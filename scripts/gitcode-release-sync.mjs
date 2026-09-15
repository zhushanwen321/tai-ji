#!/usr/bin/env node
/**
 * GitCode Release 同步脚本（GitHub Releases → GitCode Release 镜像）
 *
 * 用法：
 *   探针（验证写路径）：node scripts/gitcode-release-sync.mjs probe [--large] [--no-repo]
 *     --large 追加一个 200MB 文件上传 + Range 探测，当场验证「单附件大小上限」
 *     --no-repo 跳过仓库镜像推送（只验证 Release 写路径）
 *   镜像仓库（分支 + tags 强推对齐 GitHub）：node scripts/gitcode-release-sync.mjs push-repo
 *   正式同步：node scripts/gitcode-release-sync.mjs sync <tag> <name> <notes-file> <artifacts-dir> [--prerelease]
 *     把 <artifacts-dir> 下所有文件同步到 GitCode 同 tag 的 Release（幂等：同名同大小跳过）；
 *     --prerelease 在 release 正文加测试版标注
 *   本地中转同步（推荐给国内快速分发）：node scripts/gitcode-release-sync.mjs sync-from-github <tag> [--github-repo owner/repo]
 *     本机 gh 拉取 GitHub Release 附件（走本地 proxy，快）→ 复用并发上传到 GitCode（国内上行，快）。
 *     绕开 GitHub Actions runner → GitCode 的跨境慢链路；与 CI 自动同步幂等互不冲突。
 *
 * 环境变量（必填）：
 *   GITCODE_TOKEN  GitCode 私人令牌（GitHub Actions 中配置为 secret GITCODE_TOKEN）
 *   GITCODE_REPO   GitCode 仓库路径 owner/repo（GitHub Actions 中建议配置为 variable GITCODE_REPO）
 *
 * API 依据（2026-09 调研 docs.gitcode.com，写路径行为以本脚本探针实测为准）：
 *   - 基址 https://api.gitcode.com/api/v5，认证 header `Private-Token`
 *   - 创建  POST   /repos/{repo}/releases                body {tag_name, name, body}
 *   - 查询  GET    /repos/{repo}/releases/tags/{tag}
 *   - 上传  GET    /repos/{repo}/releases/{tag}/upload_url?file_name=x → PUT 到返回的预签名地址
 *   - 删除  DELETE /repos/{repo}/releases/{id}（tag 清理：DELETE /repos/{repo}/tags/{tag}，未验证）
 *   - 匿名下载 https://gitcode.com/{repo}/releases/download/{tag}/{file}（302 → CDN）
 *   - API 限流：实测 8 并发即 429 → 全程串行 + 每次调用间隔 1.5s
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execSync, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(execCb);

const API_BASE = 'https://api.gitcode.com/api/v5';
const WEB_BASE = 'https://gitcode.com';
const CALL_PAUSE_MS = 1500;
const LARGE_PROBE_BYTES = 200 * 1024 * 1024;

const token = process.env.GITCODE_TOKEN;
const repo = process.env.GITCODE_REPO;

function die(msg) {
  console.error(`\n[FAIL] ${msg}`);
  process.exit(1);
}

// 纯逻辑导出面（scripts/__tests__/gitcode-release-sync.test.mjs 单测——MF-3：发布同步
// 关键分支不再只靠人工真发布验证）。token/repo 在模块加载时读 env（测试先设 env 再动态 import）。
export {
  apiCall, assetList, buildExistingAssetMap, checkEnv, createRelease,
  diffNameSets, fetchUploadTarget, verifyUploadedAssets,
}

// env 校验收进 main()：vitest import 纯函数导出时不再因缺 token die（CLI 行为不变）
function checkEnv() {
  if (!token) {
    die('缺少环境变量 GITCODE_TOKEN（GitCode 私人令牌）。'
      + '配置方式：GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret，'
      + 'Name 填 GITCODE_TOKEN；或本地验证时 export GITCODE_TOKEN=<令牌> 后重跑。');
  }
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    die(`缺少或非法的环境变量 GITCODE_REPO="${repo ?? ''}"（应为 GitCode 仓库 owner/repo，如 qq_18433817/tai-ji）。`
      + 'GitHub Actions 中配置为仓库 variable GITCODE_REPO；本地验证时 export GITCODE_REPO=<owner/repo>。');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** GitCode API 调用：串行限速 + 429/5xx 指数退避重试，返回 {status, ok, json, text} */
async function apiCall(method, pathOrUrl, { body, extraHeaders = {} } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      const headers = { 'Private-Token': token, ...extraHeaders };
      // URLSearchParams 由 fetch 自动设置 form content-type；Buffer 由调用方通过 extraHeaders 指定
      if (body !== undefined && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams)) {
        headers['Content-Type'] = 'application/json';
      }
      res = await fetch(url, { method, headers, body });
    } catch (e) {
      lastErr = e;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(2000 * attempt);
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非JSON响应（如纯文本错误页）原样保留在 text */ }
    await sleep(CALL_PAUSE_MS);
    return { status: res.status, ok: res.ok, json, text };
  }
  die(`GitCode API 连续 3 次失败：${method} ${pathOrUrl}，最后错误：${lastErr}。`
    + '恢复：等 1 分钟后重跑（api.gitcode.com 有限流与偶发 5xx）；持续失败到 docs.gitcode.com 查 API 是否变更。');
}

/** 拿到 release（按 tag），不存在返回 null；其它错误直接终止 */
async function findReleaseByTag(tag) {
  const r = await apiCall('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (r.ok) return r.json;
  if (r.status === 404) return null;
  die(`查询 release ${tag} 失败（HTTP ${r.status}）：${r.text.slice(0, 400)}。`
    + `恢复：401/403 检查 GITCODE_TOKEN 是否有效、是否过期；404 且确认仓库存在则可能是权限不足。`);
}

/** 按编码形态构造创建请求：json 请求体 / form 表单 / query 查询串（body 空） */
function encodeReleaseRequest(enc, payload) {
  const base = `/repos/${repo}/releases`;
  if (enc === 'json') {
    return { path: base, body: JSON.stringify(payload) };
  }
  const form = new URLSearchParams(Object.entries(payload));
  if (enc === 'form') {
    return { path: base, body: form };
  }
  return { path: `${base}?${form.toString()}`, body: undefined };
}

/** 凭据/仓库问题的失败是编码无关的，降级无意义，直接终止并给恢复动作 */
function dieOnEncodingIrrelevantFailure(r) {
  if (r.status === 401 || r.status === 403) {
    die(`令牌无效或无写权限（HTTP ${r.status}）：${r.text.slice(0, 300)}。恢复：到 GitCode 个人设置检查私人令牌是否过期、是否授予目标仓库写权限`);
  }
  if (r.status === 404) {
    die(`仓库 ${repo} 不存在或不可见（HTTP 404）。恢复：核对 GitHub variable GITCODE_REPO 与 GitCode 仓库路径一致（含大小写），仓库已创建`);
  }
}

/** 创建成功响应 → release 对象：带 id 直接用；缺 id 按 tag 回查（回查不到才 die） */
async function resolveCreatedRelease(r, tag) {
  const created = r.json?.id ? r.json : await findReleaseByTag(tag);
  if (created) return created;
  die(`创建 release 返回 ${r.status} 但按 tag 回查不到，响应片段：${r.text.slice(0, 400)}`);
}

/** 创建 release。GitCode 对 body 编码的行为未写明文档且实测 JSON 被 400 拒
 * （"Request body parsing error, please check if the header content-type"），
 * 故按 json → form → query 三种编码自动降级，成功形态打印进日志留档。 */
async function createRelease({ tag, name, body, prerelease = false }) {
  const payload = { tag_name: tag, name, body, prerelease: String(prerelease) };
  let lastResp;
  for (const enc of ['json', 'form', 'query']) {
    const { path, body: reqBody } = encodeReleaseRequest(enc, payload);
    const r = await apiCall('POST', path, { body: reqBody });
    lastResp = r;
    if (r.ok) {
      if (enc !== 'json') console.log(`[info] createRelease: json 编码被拒，${enc} 编码成功（后续调用沿用）`);
      return resolveCreatedRelease(r, tag);
    }
    console.log(`[info] createRelease ${enc} 编码失败（HTTP ${r.status}）：${r.text.slice(0, 200)}`);
    dieOnEncodingIrrelevantFailure(r);
  }
  die(`创建 release 三种编码均失败，最后响应（HTTP ${lastResp.status}）：${lastResp.text.slice(0, 500)}。`
    + `恢复：到 docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-releases 核对接口契约后调整本脚本`);
}

/** release 的附件列表。GitCode 实测条目无 size 字段（仅 browser_download_url/name/type/id），
 * size 返回 null 表示服务端不可比；候选字段名留作 GitCode 未来补齐 size 时自动生效。 */
function assetList(releaseJson) {
  const assets = releaseJson?.assets ?? releaseJson?.attach_files ?? releaseJson?.attachFiles ?? [];
  return (Array.isArray(assets) ? assets : [])
    .map((a) => {
      const raw = a.size ?? a.filesize ?? a.file_size ?? a.attach_size;
      return {
        name: a.name ?? a.file_name ?? a.path ?? a.filename ?? '',
        size: raw === undefined ? null : Number(raw),
      };
    })
    .filter((a) => a.name);
}

/** release 既有附件 → Map（同名去重取最后条目；runSync 幂等跳过判定的唯一入口） */
function buildExistingAssetMap(releaseJson) {
  return new Map(assetList(releaseJson).map((a) => [a.name, a.size]));
}

/** 取预签名上传参数（最终 URL + curl header 参数串）。响应缺 upload_url/url 或 headers
 * 缺 Content-Type 时就地补默认（octet-stream），错误 throw（文案与恢复指引保持不变）。 */
async function fetchUploadTarget(tag, fileName) {
  const r = await apiCall('GET',
    `/repos/${repo}/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(fileName)}`);
  if (!r.ok) {
    throw new Error(`获取附件上传地址失败（HTTP ${r.status}）：${r.text.slice(0, 300)}。`
      + `恢复：确认 release ${tag} 存在；持续失败核对 docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-releases-tag-upload-url 是否变更。`);
  }
  const uploadUrl = r.json?.upload_url || r.json?.url;
  if (!uploadUrl) {
    throw new Error(`upload_url 接口响应中无 upload_url/url 字段，原始响应：${r.text.slice(0, 300)}。`
      + 'GitCode API 形态可能已变化，按上方文档链接人工核对。');
  }
  const finalUrl = uploadUrl.startsWith('/') ? `https://api.gitcode.com${uploadUrl}` : uploadUrl;
  const headerPairs = Object.entries(r.json?.headers || {});
  if (!headerPairs.some(([k]) => /content-type/i.test(k))) {
    headerPairs.push(['Content-Type', 'application/octet-stream']);
  }
  const headerArgs = headerPairs.map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`).join(' ');
  return { finalUrl, headerArgs };
}

/** curl PUT 到预签名地址，返回 { code, elapsedMs }。网络/超时错误 throw（文案不变）。
 * PUT 走 curl 子进程：Node fetch(undici) 的 headersTimeout 默认 300s，200MB 级附件
 * 在跨境链路下必然 UND_ERR_HEADERS_TIMEOUT（2026-09-05 CI 实测），curl 无此限制。
 * 跨境单连接吞吐波动大（实测 0.09-0.4MB/s，晚高峰最低），必须配合 runSync 的
 * 多路并发使用；--max-time 1800 为单附件兜底。 */
async function curlPutUpload(filePath, finalUrl, headerArgs) {
  const t0 = performance.now();
  let code = '';
  try {
    const res = await execP(
      `curl -sS --max-time 1800 -o /dev/null -w "%{http_code}" -X PUT ${headerArgs} `
      + `--data-binary @${shellQuote(filePath)} ${shellQuote(finalUrl)}`,
      { encoding: 'utf8', timeout: 1800000, shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024 },
    );
    code = String(res.stdout || '').trim();
  } catch (e) {
    const timedOut = e.killed === true || /curl: \(28\)/.test(String(e.stderr || ''));
    throw new Error(`curl 上传失败${timedOut ? '（30 分钟单附件超时）' : ''}：${String(e.stderr || e.message || e).slice(0, 200)}`);
  }
  return { code, elapsedMs: Math.round(performance.now() - t0) };
}

/** 取预签名上传地址并 PUT 上传单个文件；返回上传耗时 ms。错误 throw（并发上传时
 * 由调用方收集汇总，不直接终止进程）。两阶段：fetchUploadTarget（API 限速内）→
 * curlPutUpload（预签名直传，不占 API 配额）。 */
async function uploadAsset(tag, filePath, fileName) {
  const { finalUrl, headerArgs } = await fetchUploadTarget(tag, fileName);
  const { code, elapsedMs } = await curlPutUpload(filePath, finalUrl, headerArgs);
  if (!/^2\d\d$/.test(code)) {
    throw new Error(`HTTP ${code}。恢复：429/5xx 直接重跑（脚本幂等）；403 可能是预签名地址过期（脚本每次现取，重跑即可）`);
  }
  return elapsedMs;
}

/** 匿名下载回读比对（走与终端用户相同的稳定直链） */
async function verifyAnonymousDownload(tag, fileName, expectedContent) {
  const url = `${WEB_BASE}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    return { ok: false, detail: `匿名下载 HTTP ${res.status}（${url}）——终端用户可能无法下载，需排查` };
  }
  const text = await res.text();
  if (expectedContent !== undefined && text !== expectedContent) {
    return { ok: false, detail: `下载内容与上传内容不一致（长度 ${text.length} vs ${expectedContent.length}）` };
  }
  return { ok: true, detail: `匿名下载成功（HTTP ${res.status}，${text.length} bytes）` };
}

/** Range 探测远端文件总大小（GitCode 禁 HEAD，用 GET Range 206） */
async function probeRemoteSize(tag, fileName) {
  const url = `${WEB_BASE}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
  const res = await fetch(url, { headers: { Range: 'bytes=0-1023' }, redirect: 'follow' });
  const range = res.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  if (res.status !== 206 || !Number.isFinite(total)) {
    return { ok: false, detail: `Range 探测异常（HTTP ${res.status}，content-range="${range}"）` };
  }
  return { ok: true, detail: `远端文件大小 ${total} bytes`, total };
}

async function deleteReleaseQuietly(releaseId, tag) {
  const r = await apiCall('DELETE', `/repos/${repo}/releases/${releaseId}`);
  if (!r.ok) {
    console.log(`[WARN] 删除探针 release 失败（HTTP ${r.status}），请手动到 ${WEB_BASE}/${repo}/releases 删除 "${tag}"`);
  }
  const t = await apiCall('DELETE', `/repos/${repo}/tags/${encodeURIComponent(tag)}`);
  if (!t.ok) {
    console.log(`[WARN] 删除探针 tag 失败（HTTP ${t.status}），请手动到 ${WEB_BASE}/${repo}/tags 删除 "${tag}"`);
  }
}

/* ── 仓库镜像：把 origin 分支 + 全部 tags 强推对齐到 GitCode ── */

/** GitCode https push 的认证格式官方未写明，按常见三种自动探测 */
function resolveGitcodeRemote() {
  const owner = repo.split('/')[0];
  const candidates = [
    `https://${owner}:${token}@gitcode.com/${repo}.git`,
    `https://oauth2:${token}@gitcode.com/${repo}.git`,
    `https://${token}@gitcode.com/${repo}.git`,
  ];
  for (const url of candidates) {
    try {
      execSync(`git ls-remote "${url}" HEAD`, { stdio: 'pipe', timeout: 60000 });
      return url;
    } catch { /* 试下一种认证格式 */ }
  }
  throw new Error(`GitCode 仓库 https 认证三种格式（user:token / oauth2:token / token）均失败。`
    + `恢复：确认令牌未过期、对 ${repo} 有写权限、仓库已创建且已解除镜像状态（镜像仓锁写）`);
}

/** tags 镜像源：把 refSource 远端的 tags 强制 fetch 到独立命名空间
 * refs/remotes/<src>-tags/*（--prune 清理命名空间内已删条目）。
 * [HISTORICAL] 禁止直接推本地 refs/tags/*：本仓还会 fetch pi-mono upstream，
 * 两边同为 v* semver tag 空间，上游 tag 会混入本地（2026-09-07 实测本地 478
 * vs GitHub 191，285 个为 pi 上游 tag）；且普通 fetch 永不更新已有 tag，
 * 本地 tag 可能是远端重打前的过期旧位置（同日 v0.3.15 实测）——推本地 tags
 * 会把上游提交/过期位置注入 GitCode 镜像造成 drift。 */
function syncTagNamespace(refSource) {
  execSync(`git fetch ${refSource} --prune "+refs/tags/*:refs/remotes/${refSource}-tags/*"`,
    { stdio: 'pipe', timeout: 600000 });
}

/** 强推 origin 分支 + tags 到 GitCode（--prune 保证与 refSource 完全一致，防 drift）。
 * 超时 30 分钟：GitHub runner（海外）→ GitCode（国内）实测上行约 0.8MB/s，
 * 首次全量（本仓 pack ≈ 490MB）需 10-20 分钟，仅首次；后续发布只推增量。
 * push 前必须确保非 shallow：GitCode receive 端拒绝 shallow update
 * （探针实测 "remote rejected ... (shallow update not allowed)"）。
 *
 * [HISTORICAL] 分支 refspec 前必须删掉 <src>/HEAD 跟踪 symref（symbolic-ref --delete
 * 只删 symref 本体不伤目标分支）：refspec glob 会把它展开成创建 refs/heads/HEAD，
 * GitCode 判 HEAD 为保留关键字拒收（"The tag or branch name: HEAD is keyword and
 * cannot be created"），而 git pre-receive hook 一票否决整个 push → 全部引用（含 main）
 * 全量拒收。2026-09-07 v0.9.14 发布事故根因；git 负向 refspec（^...）只支持 fetch
 * 不支持 push，故用删除 symref 方案。 */
function pushRepoMirror(refSource = 'origin') {
  const url = resolveGitcodeRemote();
  const isShallow = execSync('git rev-parse --is-shallow-repository', { encoding: 'utf8' }).trim() === 'true';
  if (isShallow) {
    console.log(`[push-repo] 当前仓库为 shallow，先 fetch ${refSource} 全量历史（约 1-3 分钟）…`);
    execSync(`git fetch --unshallow ${refSource} "+refs/heads/*:refs/remotes/${refSource}/*"`,
      { stdio: 'inherit', timeout: 600000 });
  }
  // 推送前刷新分支跟踪视图：GitHub 旁路变更（web 端合并 / 他人 push / force-push）不经过
  // 本地 fetch 时，refs/remotes/<src>/* 停在旧位置——push 会把旧位置推上 GitCode，再被
  // verifyMirrorAlignment 打回缺失/改动（响而不错，但白跑一轮 30 分钟级 push）。
  console.log(`[push-repo] 刷新 ${refSource} 分支视图（fetch --prune）…`);
  execSync(`git fetch ${refSource} --prune "+refs/heads/*:refs/remotes/${refSource}/*"`,
    { stdio: 'pipe', timeout: 600000 });
  execSync(`git symbolic-ref --delete refs/remotes/${refSource}/HEAD 2>/dev/null || true`,
    { stdio: 'pipe', shell: '/bin/bash' });
  syncTagNamespace(refSource);
  // URL 直推不经 git remote add：带 token 的 URL 不落 .git/config（旧方案靠 finally 里
  // remote remove 清理，进程被 SIGKILL 时 token 持久残留）。
  execSync(
    `git push ${shellQuote(url)} --progress --force --prune "+refs/remotes/${refSource}/*:refs/heads/*" "+refs/remotes/${refSource}-tags/*:refs/tags/*" 2>&1`,
    { stdio: 'inherit', timeout: 1800000, shell: '/bin/bash' },
  );
  console.log(`[push-repo] 仓库镜像完成：${refSource} 分支 + tags 已对齐到 GitCode`);
  return url;
}

/** 集合互差（expected/actual 均为字符串数组）：missing = 期望有实际无，extra = 实际有期望无。
 * refs 镜像比对（行 = hash + refname）与附件镜像比对（行 = 文件名）共用同一 diff 语义。 */
function diffNameSets(expected, actual) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((n) => !actualSet.has(n)),
    extra: actual.filter((n) => !expectedSet.has(n)),
  };
}

/** 推后验证：GitCode 的分支+tags 引用集与 refSource 逐条比对（hash+refname 全等），
 * 把「镜像完成」变成 exit 0 的可验证语义。无此验证时 GitCode 平台侧行为（如
 * release API 自动打 tag 到旧 commit，2026-09-07 v0.9.14 实测）会造成静默漂移。 */
async function verifyMirrorAlignment(refSource, gitcodeUrl) {
  const listRefs = async (target) => {
    try {
      const { stdout } = await execP(
        `git ls-remote ${shellQuote(target)} "refs/heads/*" "refs/tags/*"`,
        { encoding: 'utf8', timeout: 120000, shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024 });
      return stdout.trim().split('\n').filter(Boolean);
    } catch (e) {
      die(`镜像验证失败：ls-remote ${target} 不可达：${String(e.message || e).slice(0, 200)}。`
        + '恢复：检查网络后重跑 push-repo。');
    }
  };
  const { missing, extra } = diffNameSets(await listRefs(refSource), await listRefs(gitcodeUrl));
  if (missing.length > 0 || extra.length > 0) {
    die(`镜像验证失败：GitCode 与 ${refSource} 引用集不一致——`
      + `缺失 ${missing.length} 条：${missing.slice(0, 3).join(' ; ')}${missing.length > 3 ? ' …' : ''}；`
      + `多余 ${extra.length} 条：${extra.slice(0, 3).join(' ; ')}${extra.length > 3 ? ' …' : ''}。`
      + `恢复：重跑 push-repo --ref-source ${refSource}（幂等对齐）；持续不一致按缺失 ref 核对 GitCode 平台侧是否被改动。`);
  }
  console.log(`[push-repo] 镜像验证通过：分支+tags 引用集与 ${refSource} 完全一致`);
}

/** 附件推后验证：把「附件镜像完成」也变成 exit 0 语义（与 verifyMirrorAlignment 同构）。
 * [HISTORICAL] 2026-09-07 复盘遗留：refs 镜像有推后集合比对，assets 链路此前只验 PUT 2xx，
 * 而 GitCode asset 条目无 size 字段 → 幂等跳过按「同名即跳过」判定，同名旧附件残留 /
 * 上传截断都静默通过。两级校验补齐：
 * ① name 集合比对——缺失 = 用户拿不到文件，fail；多余只 WARN（sync 是幂等补齐语义而非
 *   强对齐，人工补件不自动删，与 refs 的 --prune 强对齐刻意不同）；
 * ② 逐件 Range 探测远端总大小与本地比对（抓截断/旧件；走匿名直链 = 终端用户同一链路）。
 * @param {string} tag release tag
 * @param {{name: string, size: number}[]} expectedFiles 本地待同步文件清单（rel 名 + 大小） */
async function verifyUploadedAssets(tag, expectedFiles) {
  const release = await findReleaseByTag(tag);
  if (!release) {
    die(`附件镜像验证失败：release ${tag} 回查不到（刚才上传成功过，状态异常）。`
      + `恢复：重跑本命令（幂等）；持续失败人工核对 ${WEB_BASE}/${repo}/releases/tag/${tag}`);
  }
  const { missing, extra } = diffNameSets(expectedFiles.map((f) => f.name), assetList(release).map((a) => a.name));
  for (const name of extra) {
    console.log(`[WARN] GitCode 侧多出附件（人工补件？保留不删）：${name}`);
  }
  const sizeProblems = [];
  const missingSet = new Set(missing);
  for (const f of expectedFiles) {
    if (missingSet.has(f.name)) continue; // 缺失件已在清单里，直链必 404，不再重复探测
    let p = await probeRemoteSize(tag, f.name);
    if (!p.ok) {
      await sleep(5000); // 上传刚完成时 CDN 可能未生效，等一次再探
      p = await probeRemoteSize(tag, f.name);
    }
    if (!p.ok) sizeProblems.push(`${f.name} —— ${p.detail}`);
    else if (p.total !== f.size) sizeProblems.push(`${f.name} —— 远端 ${p.total} != 本地 ${f.size} bytes（截断或同名旧件残留）`);
  }
  if (missing.length > 0 || sizeProblems.length > 0) {
    die(`附件镜像验证失败：缺失 ${missing.length} 件${missing.length ? `：${missing.join(' ; ')}` : ''}；`
      + `大小异常 ${sizeProblems.length} 件：\n  - ${sizeProblems.join('\n  - ')}\n`
      + `恢复：重跑本命令（幂等，已成功件按名跳过只补缺失）；持续失败人工核对 ${WEB_BASE}/${repo}/releases/tag/${tag}`);
  }
  console.log(`[sync] 附件验证通过：${expectedFiles.length} 件全部存在且远端大小与本地一致`);
}

/* ── 模式一：探针 ─────────────────────────────────────────── */

/** 探针步骤 0：仓库镜像（正式链路第一步：先推代码再同步附件）；git push 输出较慢属正常 */
function probeRepoMirror(record) {
  try {
    const t0 = performance.now();
    pushRepoMirror();
    record('镜像仓库（origin 分支 + tags 强推对齐）', true, `${(Math.round(performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    record('镜像仓库（origin 分支 + tags 强推对齐）', false, String(e.message || e).slice(0, 400));
  }
}

/** 探针步骤 1：小文件上传 + API 侧确认在 assets 里。返回是否上传成功（供步骤 2 回读） */
async function probeSmallUpload(record, tag, smallFile) {
  const smallName = 'gitcode-probe.txt';
  let uploaded = false;
  try {
    const ms = await uploadAsset(tag, smallFile, smallName);
    await sleep(1000);
    const fresh = await findReleaseByTag(tag);
    const hit = assetList(fresh).find((a) => a.name === smallName);
    if (!hit) {
      record('上传 4KB 附件', false, `PUT 返回 ${ms}ms 成功但 release assets 列表中找不到该文件（原始 assets：${JSON.stringify(fresh?.assets ?? fresh).slice(0, 500)}）`);
    } else {
      uploaded = true;
      // 打印原始条目：定位 GitCode 真实字段名（sync 幂等的 size 匹配依赖它）
      const rawHit = (fresh?.assets ?? []).find((x) => JSON.stringify(x).includes(smallName));
      record('上传 4KB 附件', true, `PUT ${ms}ms，size=${hit.size}（原始条目：${JSON.stringify(rawHit ?? {}).slice(0, 300)}）`);
    }
  } catch (e) {
    record('上传 4KB 附件', false, e.message);
  }
  return uploaded;
}

/** 探针步骤 3（--large）：200MB 上传 + Range 探测总大小 */
async function probeLargeUpload(record, tag, tmpDir) {
  const bigName = 'gitcode-probe-200mb.bin';
  const bigFile = join(tmpDir, bigName);
  console.log(`生成 ${LARGE_PROBE_BYTES} bytes 测试文件…`);
  // 内容熵无要求（只验证传输与远端大小），用固定字节填充避免 200MB 随机数生成耗时
  writeFileSync(bigFile, Buffer.alloc(LARGE_PROBE_BYTES, 0x61));
  try {
    const ms = await uploadAsset(tag, bigFile, bigName);
    record(`上传 200MB 附件（验证单文件上限）`, true, `PUT ${ms}ms（${Math.round(LARGE_PROBE_BYTES / 1024 / (ms / 1000))} KB/s，GitHub runner → GitCode 上行方向）`);
    const p = await probeRemoteSize(tag, bigName);
    record('Range 探测 200MB 附件', p.ok, `${p.detail}${p.total === LARGE_PROBE_BYTES ? '（与上传大小一致）' : ''}`);
  } catch (e) {
    record('上传 200MB 附件（验证单文件上限）', false, `${e.message}——若为大小上限拒绝，说明 222MB 安装包不能直传 GitCode Release，需回退分卷或对象存储方案`);
  }
}

async function runProbe({ large, skipRepo }) {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` —— ${detail}` : ''}`);
  };

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const tag = `sync-probe-${stamp}`;
  const tmpDir = mkdtempSync(join(tmpdir(), 'gitcode-probe-'));
  const probeContent = randomBytes(4096).toString('hex');
  const smallFile = join(tmpDir, 'gitcode-probe.txt');
  writeFileSync(smallFile, probeContent);

  console.log(`GitCode 写路径探针：repo=${repo}，探针 tag=${tag}${large ? '（含 200MB 大文件验证）' : ''}${skipRepo ? '（跳过仓库镜像）' : ''}\n`);

  // 0. 仓库镜像
  if (!skipRepo) probeRepoMirror(record);

  let release;
  try {
    release = await createRelease({
      tag,
      name: 'GitCode 同步探针（跑完自动清理）',
      body: 'gitcode-release-sync.mjs probe 自动创建，验证写路径后删除。',
    });
    record('创建 release（含不存在的 tag）', true, `release id=${release.id ?? '?'}`);
  } catch (e) {
    record('创建 release（含不存在的 tag）', false, e.message);
    process.exit(1);
  }

  // 1. 小文件上传 + API 侧确认在 assets 里
  const uploaded = await probeSmallUpload(record, tag, smallFile);

  // 2. 匿名下载回读
  if (uploaded) {
    const v = await verifyAnonymousDownload(tag, 'gitcode-probe.txt', probeContent);
    record('匿名（未登录）下载回读', v.ok, v.detail);
  }

  // 3. 大文件（--large）：200MB 上传 + Range 探测总大小
  if (large) await probeLargeUpload(record, tag, tmpDir);

  // 4. 清理
  deleteReleaseQuietly(release.id, tag);
  rmSync(tmpDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 探针结果：${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`} =====`);
  if (failed.length === 0) {
    console.log('写路径可用：下一步把 sync job 挂进 release.yml（正式同步复用本脚本的 sync 模式）。');
  } else {
    console.log('按各 FAIL 项的恢复指引处理后重跑探针。');
    process.exit(1);
  }
}

/* ── 模式二：正式同步 ─────────────────────────────────────── */

async function runSync({ tag, name, notesFile, artifactsDir, prerelease = false }) {
  // GitCode 的 prerelease 展示位（release_status 字段）行为未验证，用文本标注兜底
  const notes = notesFile ? readFileSync(notesFile, 'utf8') : '';
  const body = prerelease ? `【测试版 Pre-release】\n\n${notes}` : notes;
  let release = await findReleaseByTag(tag);
  if (!release) {
    release = await createRelease({ tag, name, body, prerelease });
    console.log(`[sync] 已创建 GitCode release：${WEB_BASE}/${repo}/releases/tag/${tag}`);
  } else {
    console.log(`[sync] GitCode release 已存在，复用（幂等补齐附件）`);
  }

  const existing = buildExistingAssetMap(release);
  const files = listFilesRecursive(artifactsDir);
  if (files.length === 0) die(`产物目录 ${artifactsDir} 下没有文件——检查构建产物路径是否正确`);

  let skipped = 0;
  const pending = [];
  const expectedFiles = [];
  for (const f of files) {
    const rel = f.slice(artifactsDir.length + 1);
    const size = statSync(f).size;
    expectedFiles.push({ name: rel, size });
    const knownSize = existing.get(rel);
    // GitCode 条目无 size 字段（null）：同名即跳过——同一 release 的同名附件语义上不可变，
    // 且 PUT 幂等覆盖，误跳过的代价为零
    if (knownSize !== undefined && (knownSize === null || knownSize === size)) {
      skipped++;
      console.log(`[sync] 跳过（已存在${knownSize === null ? '，服务端无 size 可比' : '同大小'}）：${rel}`);
      continue;
    }
    pending.push({ f, rel, size });
  }

  // 多路并发上传：跨境单连接吞吐波动大（实测 0.09-0.4MB/s，晚高峰最低），串行时
  // 1.1GB 附件最坏要数小时；3 路并行把总时长压进 job 预算。预签名 PUT 不占 API 配额，
  // 并发安全；upload_url 的 GET 仍各自过 apiCall 限速。
  const UPLOAD_CONCURRENCY = 3;
  const failures = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, async () => {
    while (next < pending.length) {
      const t = pending[next++];
      try {
        const ms = await uploadAsset(tag, t.f, t.rel);
        console.log(`[sync] 已上传：${t.rel}（${(t.size / 1048576).toFixed(1)}MB，${(ms / 1000).toFixed(0)}s）`);
      } catch (e) {
        failures.push(`${t.rel} —— ${String(e.message || e).slice(0, 250)}`);
      }
    }
  });
  await Promise.all(workers);

  if (failures.length > 0) {
    die(`上传失败 ${failures.length}/${pending.length} 个附件：\n  - ${failures.join('\n  - ')}\n`
      + '恢复：直接重跑——脚本幂等，已成功上传的附件按名跳过，只补剩余的。');
  }
  await verifyUploadedAssets(tag, expectedFiles);
  console.log(`[sync] 完成：${files.length} 个文件（新传 ${pending.length}，跳过 ${skipped}，并发 ${Math.min(UPLOAD_CONCURRENCY, pending.length)} 路）。`);
  console.log(`[sync] 下载直链格式：${WEB_BASE}/${repo}/releases/download/${tag}/<文件名>`);
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

/* ── 模式三：本地中转同步（gh 下载 GitHub Release → 并发上传 GitCode）── */

async function runSyncFromGithub({ tag, githubRepo }) {
  // prerelease 以版本号含 '-' 判断（beta/alpha 等测试版标注用）
  const prerelease = tag.includes('-');
  const tmpDir = mkdtempSync(join(tmpdir(), 'gitcode-sync-'));
  try {
    console.log(`[sync-from-github] 从 GitHub 拉取 release ${tag}（repo: ${githubRepo}，走本机 proxy）…`);
    const view = execSync(
      `gh release view ${shellQuote(tag)} --repo ${shellQuote(githubRepo)} --json name,body,assets`,
      { encoding: 'utf8', timeout: 60000, shell: '/bin/bash' },
    );
    const meta = JSON.parse(view);
    const notesFile = join(tmpDir, 'release-notes.md');
    writeFileSync(notesFile, meta.body || '');

    // 下载用 curl 直链而非 gh release download：实测 gh 的下载实现把每连接压到
    // 0.07-0.09MB/s（同代理下 curl 单连接 1.36MB/s、4 连接合计 ~5MB/s，2026-09-05 实测），
    // 1.1GB 会拖到 40 分钟以上；curl 多文件并行走满代理容量（~4 分钟）。
    // url 字段：gh release view --json assets 的下载直链字段名是 url（browser_download_url
    // 恒为 null，gh 2.89.0 实测）——曾用错字段致 URL 变字符串 "undefined" 下载段全灭（2026-09-06 实测抓出）。
    // --retry 5 --retry-all-errors：跨境单连接常 80s 零字节 stall（2026-09-06 实测 4 并发只成 1），
    // 无重试时单次运行全灭概率高，只能整条命令重跑。
    const assets = (meta.assets || []).map((a) => ({ name: a.name, url: a.url, size: a.size }));
    if (assets.length === 0) die(`GitHub release ${tag} 没有附件可同步——确认 tag 正确、Release 已发布`);
    const DOWNLOAD_CONCURRENCY = 4;
    const failures = [];
    let next = 0;
    const t0 = performance.now();
    const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, assets.length) }, async () => {
      while (next < assets.length) {
        const a = assets[next++];
        const dest = join(tmpDir, a.name);
        try {
          await execP(
            `curl -sSL --retry 5 --retry-all-errors --max-time 900 -o ${shellQuote(dest)} ${shellQuote(a.url)}`,
            { timeout: 900000, shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024 },
          );
          const actual = statSync(dest).size;
          if (actual !== a.size) throw new Error(`大小不符（${actual} vs ${a.size}）`);
          console.log(`[sync-from-github] 已下载：${a.name}（${(a.size / 1048576).toFixed(1)}MB）`);
        } catch (e) {
          failures.push(`${a.name} —— ${String(e.message || e).slice(0, 200)}`);
        }
      }
    });
    await Promise.all(workers);
    if (failures.length > 0) {
      die(`下载失败 ${failures.length}/${assets.length} 个附件：\n  - ${failures.join('\n  - ')}\n`
        + '恢复：检查本机代理后重跑（已下载完成的附件会被 curl 重下覆盖，耗时可控）。');
    }
    const elapsed = Math.round((performance.now() - t0) / 1000);
    console.log(`[sync-from-github] 下载完成：${assets.length} 个附件，耗时 ${elapsed}s（${(1100.5 / Math.max(elapsed, 1)).toFixed(1)}MB/s 级）。开始上传 GitCode…`);
    await runSync({ tag, name: meta.name || tag, notesFile, artifactsDir: tmpDir, prerelease });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/* ── 入口 ─────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const cmd = argv[0];

/** 位置参数（过滤 -- 开头的选项 token） */
const positionalArgs = (args) => args.filter((a) => !a.startsWith('--'));

/** --github-repo 取值：缺省用默认仓，显式给出但值缺失时为 undefined（与原 argv 直取一致） */
function githubRepoFromArgs(args) {
  const idx = args.indexOf('--github-repo');
  return idx >= 0 ? args[idx + 1] : 'zhushanwen321/tai-ji';
}

const USAGE = `用法：
  node scripts/gitcode-release-sync.mjs probe [--large] [--no-repo]
  node scripts/gitcode-release-sync.mjs push-repo [--ref-source <remote>]
  node scripts/gitcode-release-sync.mjs sync <tag> <release-name> <notes-file> <artifacts-dir> [--prerelease]
  node scripts/gitcode-release-sync.mjs sync-from-github <tag> [--github-repo owner/repo]
环境变量：GITCODE_TOKEN（必填）；sync-from-github 另需本机 gh 已登录`;

/** 子命令分派表：args = argv.slice(1)（不含子命令名） */
const COMMANDS = {
  probe: async (args) => {
    await runProbe({ large: args.includes('--large'), skipRepo: args.includes('--no-repo') });
  },
  'push-repo': async (args) => {
    // --ref-source <remote>：镜像引用的来源远端（默认 origin = CI checkout 场景）。
    // 本地 bare-repo workspace 里 origin 指向本地 .bare，须显式传 github——
    // 否则会把本地 .bare 的分支状态（可能含已删分支/落后分支）推上 GitCode 造成 drift。
    const srcIdx = args.indexOf('--ref-source');
    const refSource = srcIdx >= 0 ? args[srcIdx + 1] : 'origin';
    if (!refSource || refSource.startsWith('--')) {
      die('用法：node scripts/gitcode-release-sync.mjs push-repo [--ref-source <remote>]（本地环境传 --ref-source github）');
    }
    try {
      const url = pushRepoMirror(refSource);
      await verifyMirrorAlignment(refSource, url);
    } catch (e) {
      die(String(e.message || e));
    }
  },
  'sync-from-github': async (args) => {
    const [tag] = positionalArgs(args);
    const githubRepo = githubRepoFromArgs(args);
    if (!tag) {
      die('用法：node scripts/gitcode-release-sync.mjs sync-from-github <tag> [--github-repo owner/repo]');
    }
    await runSyncFromGithub({ tag, githubRepo });
  },
  sync: async (args) => {
    const [tag, name, notesFile, artifactsDir] = positionalArgs(args);
    if (!tag || !name || !artifactsDir) {
      die('用法：node scripts/gitcode-release-sync.mjs sync <tag> <release-name> <notes-file|空串> <artifacts-dir> [--prerelease]');
    }
    await runSync({
      tag, name, notesFile: notesFile || null, artifactsDir,
      prerelease: args.includes('--prerelease'),
    });
  },
};

async function main() {
  checkEnv();
  const run = COMMANDS[cmd];
  if (!run) {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
  await run(argv.slice(1));
}

// CLI 直跑才执行 main（vitest import 纯函数导出时不触发网络/env 校验）
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
if (isMain) await main();
