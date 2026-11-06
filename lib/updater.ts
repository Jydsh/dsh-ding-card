/**
 * dsh-ding-card 版本检查：从 GitHub Release 读取最新版本号。
 *
 * 版本号统一为 YYYY.MM.DD 年月日格式（与 package.json 的 version 字段一致），
 * 发布流程：改版本号 → push → gh release create vYYYY.MM.DD（自动打 tag）。
 *
 * 检查来源（按顺序尝试）：
 * 1. GitHub REST API：https://api.github.com/repos/{repo}/releases/latest
 * 2. 回退 releases.atom（github.com 域名，无需令牌、无速率限制）
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentProfileName, dshHome, isLinkedToSource, profileDir, profileFromInstallPath } from './dshim.js';

/** 本插件包名 / 默认仓库（与 package.json 一致）。 */
export const PACKAGE_NAME = 'dsh-ding-card';
export const DEFAULT_REPO = 'Jydsh/dsh-ding-card';

/** 最新版本信息（GitHub Release 检查结果）。 */
export interface LatestVersionInfo {
  /** 最新版本号（YYYY.MM.DD） */
  version: string;
  /** 来源：api=GitHub REST API / atom=releases.atom 回退 */
  source: 'api' | 'atom';
}

const REPO = 'Jydsh/dsh-ding-card';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const ATOM_URL = `https://github.com/${REPO}/releases.atom`;
const REQUEST_TIMEOUT_MS = 8000;

/** 归一化为年月日版本号（去掉 v 前缀；支持 prerelease 后缀如 -bate1），不合法返回 null */
export function normalizeVersion(value: unknown): string | null {
  const v = String(value ?? '').trim().replace(/^v/i, '');
  return /^\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
}

/** 当前已安装版本（读 package.json），读取失败返回 null */
export function getCurrentVersion(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return normalizeVersion(pkg.version);
  } catch {
    return null;
  }
}

/**
 * 检查 GitHub 最新 Release 版本。
 * @returns 网络不可达或解析失败时返回 null
 */
export async function checkLatestVersion(): Promise<LatestVersionInfo | null> {
  // 1) GitHub REST API
  try {
    const res = await fetch(API_LATEST, {
      headers: { 'User-Agent': 'dsh-ding-card', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: unknown };
      const tag = normalizeVersion(data?.tag_name);
      if (tag) return { version: tag, source: 'api' };
    }
  } catch {
    /* 回退 atom */
  }

  // 2) releases.atom（github.com 域名）
  try {
    const res = await fetch(ATOM_URL, {
      headers: { 'User-Agent': 'dsh-ding-card' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const text = await res.text();
      const match = text.match(/<entry>[\s\S]*?<title[^>]*>([^<]+)<\/title>/);
      const tag = normalizeVersion(match?.[1]);
      if (tag) return { version: tag, source: 'atom' };
    }
  } catch {
    /* 网络不可达 */
  }

  return null;
}

/** 年月日版本比较：current 是否不低于 latest（同格式，字符串按位补零后比较） */
export function isAtLeast(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const norm = (v: string) => v.split('.').map((n) => n.padStart(2, '0')).join('.');
  return norm(current) >= norm(latest);
}

/* ---------------------------------------------------------------------------
 * 一键更新：识别本机安装环境（profile / 安装来源 / 可用 CLI），据此拼出与
 * 「立即更新」完全一致的安装命令，供界面展示、复制，以及宿主未暴露插件
 * 管理服务时兜底执行（spawn）。与 dsh-mrrp 的更新能力保持同一套判定口径。
 * ------------------------------------------------------------------------- */

/** 更新动作：update=版本号未变、按已装声明原地刷新；add=安装到目标版本 */
export type UpdateMode = 'update' | 'add';

/** 当前安装环境识别结果 */
export interface InstallEnv {
  platform: NodeJS.Platform;
  /** profile 名（desktop / web 等）；无法确定时为 null */
  profile: string | null;
  /** profile 目录（…/.dsh/profiles/<profile>） */
  profileDir: string | null;
  /** profile 结论的判定依据：env=宿主注入 / path=按安装路径推断 / manual=界面选择 / default=兜底 */
  profileSource: 'env' | 'path' | 'manual' | 'default';
  /** 本机装了本插件的 profile 列表（多命中时交给界面选择） */
  candidates: string[];
  /** 该用的更新动作 */
  mode: UpdateMode;
  /** 当前 profile 里已安装的版本号（读不到为 null） */
  installedVersion: string | null;
  /** 安装来源：git=仓库源码装 / tgz=Release 安装包 / link=链接到工程目录 / unknown */
  source: 'git' | 'tgz' | 'link' | 'unknown';
  /** 实际使用的安装 CLI */
  cli: 'dsh' | 'pnpm' | 'npm' | null;
  /** 安装规格（CLI 的 add 参数） */
  spec: string;
  /** 可直接复制执行的完整命令 */
  command: string;
  /** 无法自动执行时的原因说明 */
  blocker: string | null;
}

/** 识别 / 更新用的目标参数 */
export interface UpdateTargetOptions {
  /** 目标版本，缺省取本包 package.json 的 version */
  version?: string;
  /** 用户指定的 profile（界面选择后立即生效） */
  profile?: string;
  /** 执行超时（仅 runUpdate 使用） */
  timeoutMs?: number;
  /** 命令可用性探测（测试注入；缺省查 PATH），返回路径或布尔值 */
  hasCommand?: (name: string) => string | null | boolean;
}

/** 在 PATH 中查找可执行文件（Windows 需兼顾 .cmd/.exe/.bat） */
function findOnPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['', '.sh'];
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      try {
        if (existsSync(full)) return full;
      } catch {
        /* 忽略不可访问目录 */
      }
    }
  }
  return null;
}

/** 本机装了本插件的 profile 列表（junction / 实体包都算） */
function listInstalledProfiles(): string[] {
  const root = join(dshHome(), 'profiles');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'node_modules', PACKAGE_NAME)))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 读 profile 的 package.json 里本包如何声明（决定安装来源） */
function readDeclared(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.dependencies?.[PACKAGE_NAME] ?? pkg.devDependencies?.[PACKAGE_NAME] ?? null;
  } catch {
    return null;
  }
}

/** 读 profile 里真正装上的那份版本（junction / pnpm 虚拟目录都能读到） */
function readInstalledVersion(dir: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dir, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8').replace(/^\uFEFF/, ''),
    ) as { version?: unknown };
    const value = String(pkg.version ?? '').trim();
    return normalizeVersion(value) ?? (value || null);
  } catch {
    return null;
  }
}

/** 识别当前安装环境并生成对应安装命令 */
export function detectInstallEnv(options: UpdateTargetOptions = {}): InstallEnv {
  const targetVersion = normalizeVersion(options.version) ?? getCurrentVersion() ?? null;
  const forced = (options.profile ?? '').trim();
  const profile = forced || currentProfileName();
  const dir = forced ? join(dshHome(), 'profiles', forced) : profileDir();
  const profileSource: InstallEnv['profileSource'] = forced
    ? 'manual'
    : process.env.DSH_PROFILE_DIR
      ? 'env'
      : profileFromInstallPath()
        ? 'path'
        : 'default';
  const candidates = listInstalledProfiles();

  const linked = isLinkedToSource();
  const declared = dir ? readDeclared(dir) : null;
  let source: InstallEnv['source'] = 'unknown';
  if (linked) source = 'link';
  else if (declared) {
    if (/^link:/i.test(declared)) source = 'link';
    else if (/github:|codeload\.github\.com|\.git(?:#|$)/i.test(declared)) source = 'git';
    else if (/\.tgz|\.tar\.gz|file:/i.test(declared)) source = 'tgz';
  }

  const installedVersion = dir ? readInstalledVersion(dir) : null;
  const version = targetVersion ?? installedVersion ?? '';
  const gitSpec = `github:${DEFAULT_REPO}#v${version}`;
  const tgzSpec = `https://github.com/${DEFAULT_REPO}/releases/download/v${version}/${PACKAGE_NAME}-${version}.tgz`;
  // 装法不明时默认走 Release 安装包：tgz 不受 pnpm 的 git 依赖脚本白名单限制
  const spec = source === 'git' ? gitSpec : tgzSpec;

  // 版本号没变却要更新（例如同日替换 Release 资产）：只有 update 会重新解析 tarball，
  // 同一 spec 再 add 会被 pnpm 判成「Lockfile is up to date」直接跳过。
  // link 安装例外：装的就是工程目录本身，“原地刷新”没有意义，一律用 add 换成安装包。
  const sameVersion = source !== 'link' && Boolean(installedVersion && version && installedVersion === version);
  const mode: UpdateMode = sameVersion ? 'update' : 'add';

  const has = (name: string): boolean => {
    const probe = options.hasCommand;
    return probe ? Boolean(probe(name)) : Boolean(findOnPath(name));
  };
  const cli: InstallEnv['cli'] = has('dsh') ? 'dsh' : has('pnpm') ? 'pnpm' : has('npm') ? 'npm' : null;

  let command = '';
  let blocker: string | null = null;
  if (cli === 'dsh') {
    const head = profile ? `dsh plugin --profile ${profile}` : 'dsh plugin';
    command = mode === 'update' ? `${head} update ${PACKAGE_NAME}` : `${head} add "${spec}"`;
  } else if (cli === 'pnpm') {
    command = mode === 'update' ? `pnpm update ${PACKAGE_NAME}` : `pnpm add "${spec}"`;
  } else if (cli === 'npm') {
    command = mode === 'update' ? `npm update ${PACKAGE_NAME}` : `npm add "${spec}"`;
  } else {
    blocker = '未找到 dsh / pnpm / npm 命令，请复制命令到终端手工执行';
  }

  if (!blocker && source === 'link') {
    blocker =
      '当前是链接（link / junction）安装，装的就是工程目录本身：更新请直接改工程后重启 DSH；'
      + '复制这条命令会把该 profile 的链接替换成安装包，仅适用于已脱离开发的情况';
  }

  // 多个 profile 都装了本插件又认不出自己：不猜，交给界面让用户选
  if (!blocker && candidates.length > 1 && profileSource === 'default') {
    blocker = `本机 ${candidates.join(' / ')} 都装了本插件，无法确定当前是哪一个，请选择后再更新`;
  }

  return {
    platform: process.platform,
    profile,
    profileDir: dir,
    profileSource,
    candidates,
    mode,
    installedVersion,
    source,
    cli,
    spec,
    command,
    blocker,
  };
}

/** 一键更新的执行结果 */
export interface UpdateResult {
  ok: boolean;
  exitCode: number | null;
  /** 实际执行的命令 */
  command: string;
  /** 命令输出末尾（最多 5000 字符） */
  output: string;
  env: InstallEnv;
  /** 安装成功后需要重启 DSH 才生效 */
  restartRequired: boolean;
}

/**
 * 执行一键更新：按识别出的环境跑安装命令。
 * 注意：安装会替换当前进程正在使用的插件文件，成功后仍需要重启 DSH 才加载新代码。
 */
export async function runUpdate(options: UpdateTargetOptions = {}): Promise<UpdateResult> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 180_000;
  const env = detectInstallEnv(options);
  if (env.blocker || !env.command) {
    return {
      ok: false,
      exitCode: null,
      command: env.command,
      output: env.blocker ?? '无法执行更新',
      env,
      restartRequired: false,
    };
  }

  // 只在确认存在的 profile 目录里执行：认不出目录宁可不装，
  // 否则 shell 会落在插件自身目录（= 开发工程）里，把包装进工程本身。
  if (!env.profileDir || !existsSync(env.profileDir)) {
    return {
      ok: false,
      exitCode: null,
      command: env.command,
      output: '找不到要安装的 profile 目录，已取消执行（避免把包装到插件自身目录）',
      env,
      restartRequired: false,
    };
  }

  const cwd = env.profileDir;
  const outcome = await new Promise<{ code: number | null; output: string }>((done) => {
    let output = '';
    const push = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-5000);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(env.command, { cwd, shell: true, windowsHide: true, env: process.env });
    } catch (error) {
      done({ code: null, output: `启动失败：${(error as Error)?.message ?? String(error)}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      push(`\n[超时] 安装进程超过 ${Math.round(timeoutMs / 1000)}s 被终止`);
    }, timeoutMs);
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: null, output: `启动失败：${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });

  return {
    ok: outcome.code === 0,
    exitCode: outcome.code,
    command: env.command,
    output: outcome.output,
    env,
    restartRequired: outcome.code === 0,
  };
}

