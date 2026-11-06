import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginConfig } from './store.js';

const PACKAGE_NAME = '@xmanrui/dsh-im';
const BOT_PREFIX = 'dt_';

/** dsh-im 集成：DSH 环境检测、钉钉机器人读取、会话路由（宽松类型：dsh-im 数据来自 JSON）。 */

export function dshHome(): string {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}

export function profileDir(): string {
  if (process.env.DSH_PROFILE_DIR) return resolve(process.env.DSH_PROFILE_DIR);
  return join(dshHome(), 'profiles', currentProfileName());
}

/** 当前 profile 名称：宿主显式指定优先，其次按插件自身安装路径推断。 */
export function currentProfileName(): string {
  if (process.env.DSH_PROFILE_DIR) {
    const parts = resolve(process.env.DSH_PROFILE_DIR).split(/[\\/]/).filter(Boolean);
    if (parts.length) return parts[parts.length - 1] as string;
  }
  const fromInstall = profileFromInstallPath();
  if (fromInstall) return fromInstall;
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
  return 'desktop';
}

/**
 * 从插件自身安装位置推断 profile：.../profiles/<name>/node_modules/dsh-ding-card/...
 * 同一台机器同时装桌面端与网页端时，两个进程各自加载自己 profile 下的副本，
 * 以此判断环境比 DSH_PROFILE 环境变量（未设置时默认 desktop）可靠。
 */
export function profileFromInstallPath(): string | null {
  try {
    const self = fileURLToPath(import.meta.url).replace(/\\/g, '/');
    const matched = self.match(/\/profiles\/([^/]+)\/node_modules\/dsh-ding-card\//);
    return matched ? matched[1] as string : null;
  } catch {
    return null;
  }
}

/** 插件数据目录的根（DSH_HOME 级，各 profile 在这下面再分目录）。 */
export function pluginDataRoot(): string {
  return join(dshHome(), 'integrations', 'dsh-ding-card');
}

/** 当前 profile 专属的插件数据目录（配置 / 卡片库 / 日志明细 / 昵称表都放这里）。 */
export function profileDataDir(): string {
  return join(pluginDataRoot(), 'profiles', currentProfileName());
}

/** 插件包根目录（dist/*.js 的上一级）。 */
function pluginRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * 插件是否是指向当前源码目录的开发链接（--link / junction）。
 * 一键更新会替换 profile 里的包；若那是本地开发目录则不自动替换，避免冲掉开发中的代码。
 */
export function isLinkedToSource(): boolean {
  try {
    const target = join(profileDir(), 'node_modules', 'dsh-ding-card');
    if (!lstatSync(target).isSymbolicLink()) return false;
    return realpathSync(target) === realpathSync(pluginRoot());
  } catch {
    return false;
  }
}

/** 所有已存在的 profile 目录（desktop / web / …）。仅用于诊断，不参与环境判定。 */
export async function listProfileDirs(): Promise<string[]> {
  const root = join(dshHome(), 'profiles');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export function botIdFor(clientId: unknown): string | null {
  if (typeof clientId !== 'string' || !clientId) return null;
  return `${BOT_PREFIX}${createHash('sha256').update(clientId).digest('hex').slice(0, 24)}`;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** dsh-im 安装信息。 */
export interface DshImInfo {
  installed: boolean;
  version: string | null;
  declared: boolean;
  selected: boolean;
  profileDir: string;
  /** 当前 profile 名（按插件自身安装路径推断）。 */
  profile: string;
  installCommand: string;
  packageName: string;
}

/** 单个 profile 的 dsh-im 状态。 */
async function inspectProfile(dir: string): Promise<{ installed: boolean; version: string | null; declared: boolean; selected: boolean }> {
  const manifest = await readJson(join(dir, 'package.json')) as Record<string, any> | null;
  const installedManifest = await readJson(join(dir, 'node_modules', PACKAGE_NAME, 'package.json')) as Record<string, any> | null;
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const dependency = manifest?.dependencies?.[PACKAGE_NAME] ?? manifest?.devDependencies?.[PACKAGE_NAME];
  return {
    installed: Boolean(installedManifest),
    version: typeof installedManifest?.version === 'string' ? installedManifest.version : null,
    declared: dependency !== undefined || bundles.includes(PACKAGE_NAME),
    selected: bundles.includes(PACKAGE_NAME),
  };
}

/**
 * Installed dsh-im bundle and its selected-bundle state.
 *
 * 只检查当前 profile：网页端与桌面端各自安装、互不借用（web 未装即视为未安装，
 * 不再回退到 desktop 的副本）。当前 profile 由 currentProfileName() 按插件自身
 * 安装路径推断，避免宿主未设置 DSH_PROFILE 时一律当成 desktop。
 */
export async function inspectDshIm(): Promise<DshImInfo> {
  const currentDir = profileDir();
  const current = await inspectProfile(currentDir);
  return {
    ...current,
    profileDir: currentDir,
    profile: currentProfileName(),
    installCommand: `dsh plugin --profile ${currentProfileName()} add ${PACKAGE_NAME}`,
    packageName: PACKAGE_NAME,
  };
}

/** dsh-im 存储的钉钉机器人（不解析密钥）。 */
export interface DingtalkBot {
  clientId: string;
  secretRef: string;
  botId: string;
  approvedSenders: unknown[];
}

/** DingTalk bots stored by dsh-im, without resolving their secrets. */
export async function readDingtalkBots(): Promise<DingtalkBot[]> {
  // 机器人配置由当前 profile 的 dsh-im 维护：未装 dsh-im 时不引用，
  // 避免网页环境显示桌面端机器人的“凭据就绪”。
  const profile = await inspectProfile(profileDir());
  if (!profile.installed) return [];
  const path = join(dshHome(), 'integrations', 'dsh-dingtalk', 'config.json');
  const config = await readJson(path) as Record<string, any> | null;
  const bots = Array.isArray(config?.bots) ? config.bots : [];
  return bots
    .filter((bot: Record<string, any>) => typeof bot?.clientId === 'string' && bot.clientId.trim())
    .map((bot: Record<string, any>) => ({
      clientId: bot.clientId.trim(),
      secretRef: typeof bot.secretRef === 'string' ? bot.secretRef : '',
      botId: botIdFor(bot.clientId.trim())!,
      approvedSenders: Array.isArray(bot?.approvedSenders) ? bot.approvedSenders : [],
    }));
}

/**
 * userId -> displayName resolved from the sources dsh-im already keeps:
 *   1. approvedSenders (staffId -> displayName) persisted by dsh-im on approval,
 *   2. the pre-isolation shared nickname cache (legacy fallback),
 *   3. senderNick captured by this plugin from inbound stream messages
 *      (user_names.json of the current profile). All avoid calling DingTalk
 *      contact APIs, which need permissions this application does not have.
 */
export async function readUserNames(): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  try {
    const config = await readJson(join(dshHome(), 'integrations', 'dsh-dingtalk', 'config.json')) as Record<string, any> | null;
    for (const bot of Array.isArray(config?.bots) ? config.bots : []) {
      for (const sender of Array.isArray(bot?.approvedSenders) ? bot.approvedSenders : []) {
        const staffId = typeof sender?.staffId === 'string' ? sender.staffId.trim() : '';
        const displayName = typeof sender?.displayName === 'string' ? sender.displayName.trim() : '';
        if (staffId && displayName) names[staffId] = displayName;
      }
    }
  } catch { /* ignore */ }
  // profile 隔离之前的共享缓存：老版本只写这一份，升级后按 profile 分文件。
  // 把它当兜底底稿读入，避免早期联系人的昵称在升级后凭空丢失（下面再被 profile 覆盖）。
  try {
    const legacy = await readJson(join(dshHome(), 'integrations', 'dsh-ding-card', 'user_names.json'));
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      for (const [userId, name] of Object.entries(legacy)) {
        if (userId && typeof name === 'string' && name.trim()) names[userId] = name.trim();
      }
    }
  } catch { /* ignore */ }
  try {
    const map = await readJson(join(profileDataDir(), 'user_names.json'));
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [userId, name] of Object.entries(map)) {
        if (userId && typeof name === 'string' && name.trim()) names[userId] = name.trim();
      }
    }
  } catch { /* ignore */ }
  return names;
}

/** 会话路由：sessionId -> 钉钉会话（dsh-im state.json 记录）。 */
export interface SessionRoute {
  botId: string;
  conversationKey: string;
  kind: 'user' | 'group';
  userId: string | null;
  openConversationId: string | null;
}

/**
 * sessionId -> DingTalk route recorded by dsh-im in each bot's state.json.
 * The route is only trusted for chats dsh-im itself created.
 */
export async function readSessionRoutes(): Promise<Map<string, SessionRoute>> {
  const botsDir = join(dshHome(), 'integrations', 'dsh-dingtalk', 'bots');
  const routes = new Map<string, SessionRoute>();
  // 会话路由由当前 profile 的 dsh-im 记录；未装 dsh-im 时不引用其他 profile 的数据。
  const profile = await inspectProfile(profileDir());
  if (!profile.installed) return routes;
  let entries: { isDirectory(): boolean; name: string }[] = [];
  try {
    entries = await readdir(botsDir, { withFileTypes: true });
  } catch {
    return routes;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const botId = entry.name;
    const state = await readJson(join(botsDir, botId, 'state.json')) as Record<string, any> | null;
    const sessions = state?.sessions;
    if (!sessions || typeof sessions !== 'object') continue;
    for (const [conversationKey, sessionId] of Object.entries(sessions)) {
      if (typeof sessionId !== 'string' || !sessionId) continue;
      const parsed = parseConversationKey(conversationKey);
      if (!parsed) continue;
      routes.set(sessionId, { botId, conversationKey, ...parsed });
    }
  }
  return routes;
}

/** 会话 key 解析结果。 */
export type ParsedConversationKey =
  | { kind: 'user'; userId: string; openConversationId: null }
  | { kind: 'group'; userId: null; openConversationId: string };

export function parseConversationKey(value: unknown): ParsedConversationKey | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('p2p:') && value.length > 4) {
    return { kind: 'user', userId: value.slice(4), openConversationId: null };
  }
  if (value.startsWith('group:') && value.length > 6) {
    return { kind: 'group', userId: null, openConversationId: value.slice(6) };
  }
  return null;
}

/** 凭据上下文（宽松类型）。 */
export interface CredentialCtx {
  get?: (key: string) => unknown;
  credentials?: unknown;
}

export async function resolveSecret(ctx: CredentialCtx, secretRef: unknown): Promise<string | null> {
  if (!secretRef) return null;
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : ctx?.credentials;
  if (!credentials || typeof (credentials as Record<string, any>).resolve !== 'function') return null;
  try {
    const hit = await (credentials as Record<string, any>).resolve(secretRef);
    const value = typeof hit?.value === 'string' ? hit.value.trim() : '';
    return value || null;
  } catch {
    return null;
  }
}

/** 机器人选择结果。 */
export interface BotChoice {
  clientId: string;
  secretRef?: string;
  botId: string;
  source: string;
}

/** Choose the DingTalk bot this plugin should speak through. */
export function chooseBot(config: PluginConfig, bots: DingtalkBot[], routes: unknown): BotChoice | null {
  const configured = config.bot ?? {};
  if (configured.mode === 'manual' && configured.clientId) {
    return {
      clientId: configured.clientId,
      secretRef: configured.secretRef,
      botId: botIdFor(configured.clientId)!,
      source: 'manual',
    };
  }
  if (bots.length > 0) return { ...bots[0], source: 'dsh-im' };
  return null;
}

export function botDirStatePath(botId: string): string {
  return join(dshHome(), 'integrations', 'dsh-dingtalk', 'bots', basename(botId), 'state.json');
}
