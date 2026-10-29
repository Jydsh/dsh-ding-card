import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const PACKAGE_NAME = '@xmanrui/dsh-im';
const BOT_PREFIX = 'dt_';

export function dshHome() {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}

export function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return resolve(process.env.DSH_PROFILE_DIR);
  const profile = process.env.DSH_PROFILE ?? 'desktop';
  return join(dshHome(), 'profiles', profile);
}

export function botIdFor(clientId) {
  if (typeof clientId !== 'string' || !clientId) return null;
  return `${BOT_PREFIX}${createHash('sha256').update(clientId).digest('hex').slice(0, 24)}`;
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** Installed dsh-im bundle and its selected-bundle state in the current profile. */
export async function inspectDshIm() {
  const dir = profileDir();
  const manifest = await readJson(join(dir, 'package.json'));
  const installedManifest = await readJson(join(dir, 'node_modules', PACKAGE_NAME, 'package.json'));
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const dependency = manifest?.dependencies?.[PACKAGE_NAME] ?? manifest?.devDependencies?.[PACKAGE_NAME];
  return {
    installed: Boolean(installedManifest),
    version: typeof installedManifest?.version === 'string' ? installedManifest.version : null,
    declared: dependency !== undefined || bundles.includes(PACKAGE_NAME),
    selected: bundles.includes(PACKAGE_NAME),
    profileDir: dir,
    installCommand: `dsh plugin --profile ${process.env.DSH_PROFILE ?? 'desktop'} add ${PACKAGE_NAME}`,
    packageName: PACKAGE_NAME,
  };
}

/** DingTalk bots stored by dsh-im, without resolving their secrets. */
export async function readDingtalkBots() {
  const path = join(dshHome(), 'integrations', 'dsh-dingtalk', 'config.json');
  const config = await readJson(path);
  const bots = Array.isArray(config?.bots) ? config.bots : [];
  return bots
    .filter((bot) => typeof bot?.clientId === 'string' && bot.clientId.trim())
    .map((bot) => ({
      clientId: bot.clientId.trim(),
      secretRef: typeof bot.secretRef === 'string' ? bot.secretRef : '',
      botId: botIdFor(bot.clientId.trim()),
      approvedSenders: Array.isArray(bot?.approvedSenders) ? bot.approvedSenders : [],
    }));
}

/**
 * userId -> displayName resolved from the sources dsh-im already keeps:
 *   1. approvedSenders (staffId -> displayName) persisted by dsh-im on approval,
 *   2. senderNick captured by this plugin from inbound stream messages
 *      (user_names.json). Both avoid calling DingTalk contact APIs, which need
 *      permissions this application does not have.
 */
export async function readUserNames() {
  const names = {};
  try {
    const config = await readJson(join(dshHome(), 'integrations', 'dsh-dingtalk', 'config.json'));
    for (const bot of Array.isArray(config?.bots) ? config.bots : []) {
      for (const sender of Array.isArray(bot?.approvedSenders) ? bot.approvedSenders : []) {
        const staffId = typeof sender?.staffId === 'string' ? sender.staffId.trim() : '';
        const displayName = typeof sender?.displayName === 'string' ? sender.displayName.trim() : '';
        if (staffId && displayName) names[staffId] = displayName;
      }
    }
  } catch { /* ignore */ }
  try {
    const map = await readJson(join(dshHome(), 'integrations', 'dsh-ding-card', 'user_names.json'));
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [userId, name] of Object.entries(map)) {
        if (userId && typeof name === 'string' && name.trim()) names[userId] = name.trim();
      }
    }
  } catch { /* ignore */ }
  return names;
}

/**
 * sessionId -> DingTalk route recorded by dsh-im in each bot's state.json.
 * The route is only trusted for chats dsh-im itself created.
 */
export async function readSessionRoutes() {
  const botsDir = join(dshHome(), 'integrations', 'dsh-dingtalk', 'bots');
  const routes = new Map();
  let entries = [];
  try {
    entries = await readdir(botsDir, { withFileTypes: true });
  } catch {
    return routes;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const botId = entry.name;
    const state = await readJson(join(botsDir, botId, 'state.json'));
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

export function parseConversationKey(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('p2p:') && value.length > 4) {
    return { kind: 'user', userId: value.slice(4), openConversationId: null };
  }
  if (value.startsWith('group:') && value.length > 6) {
    return { kind: 'group', userId: null, openConversationId: value.slice(6) };
  }
  return null;
}

export async function resolveSecret(ctx, secretRef) {
  if (!secretRef) return null;
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : ctx?.credentials;
  if (!credentials || typeof credentials.resolve !== 'function') return null;
  try {
    const hit = await credentials.resolve(secretRef);
    const value = typeof hit?.value === 'string' ? hit.value.trim() : '';
    return value || null;
  } catch {
    return null;
  }
}

/** Choose the DingTalk bot this plugin should speak through. */
export function chooseBot(config, bots, routes) {
  const configured = config.bot ?? {};
  if (configured.mode === 'manual' && configured.clientId) {
    return {
      clientId: configured.clientId,
      secretRef: configured.secretRef,
      botId: botIdFor(configured.clientId),
      source: 'manual',
    };
  }
  if (bots.length > 0) return { ...bots[0], source: 'dsh-im' };
  return null;
}

export function botDirStatePath(botId) {
  return join(dshHome(), 'integrations', 'dsh-dingtalk', 'bots', basename(botId), 'state.json');
}
