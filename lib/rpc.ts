import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { CardConfig, CardType, PluginConfig } from './store.js';
import {
  detectInstallEnv,
  runUpdate,
  type InstallEnv,
  type LatestVersionInfo,
  type UpdateResult,
  type UpdateTargetOptions,
} from './updater.js';

import { buildCardData, exportDingtalkTemplate, sampleData } from './export.js';
import { importDingtalkJson } from './import.js';
import { selectCard } from './cards.js';
import { CARD_TYPE_META, sanitizeCard } from './store.js';
import {
  chooseBot,
  currentProfileName,
  dshHome,
  inspectDshIm,
  isLinkedToSource,
  parseConversationKey,
  readDingtalkBots,
  readSessionRoutes,
  readUserNames,
  resolveSecret,
} from './dshim.js';

/**
 * RPC 消息契约（client.js ↔ server 管理通道）。
 * 通道：POST /api/dsh-ding-card，JSON body。
 */

/** RPC 客户端请求消息（client.js → server）。 */
export interface RpcClientRequest {
  type: 'client-request';
  /** 请求 ID（响应回填同一 ID） */
  rpcId: string;
  /** 通道名 */
  method: 'dsh-ding-card';
  /** 具体调用 */
  payload: RpcCall;
}

/** RPC 具体调用。 */
export interface RpcCall {
  /** 方法名（如 status / version.check / card.test） */
  method: string;
  /** 方法参数 */
  payload?: unknown;
}

/** RPC 错误信息。 */
export interface RpcError {
  code: string;
  message: string;
  details?: unknown;
}

/** RPC 结果。 */
export interface RpcResult {
  ok: boolean;
  value?: unknown;
  error?: RpcError;
}

/** RPC 服务端响应消息。 */
export interface RpcServerResponse {
  type: 'server-response';
  /** 对应的请求 ID */
  rpcId: string;
  /** 响应结果 */
  result: RpcResult;
}

/** DSH 运行时上下文（宽松类型：DSH API 未提供完整类型定义）。 */
export interface DshCtx {
  get?: (key: string) => unknown;
  inject?: (keys: string[], callback: (connectionCtx: unknown) => void) => unknown;
  connection?: unknown;
}

/** installRpc 依赖注入。 */
export interface RpcDeps {
  /** 配置存储 */
  store: {
    get(): PluginConfig;
    save(input: unknown): Promise<PluginConfig>;
    path: string;
  };
  /** 卡片运行态 */
  cards: Record<string, any>;
  /** 钉钉 API 客户端 */
  api: Record<string, any>;
  /** 事件日志 */
  events: {
    record(level: string, message: string, details?: unknown): void;
    list(limit?: number): unknown[];
    clear(): void;
  };
  logger?: { warn?: (...args: unknown[]) => void };
  /** 版本检查模块（可选装配） */
  updater?: {
    current(): string | null;
    check(): Promise<LatestVersionInfo | null>;
    isAtLeast(current: string | null, latest: string): boolean;
    /** 可选：环境识别（缺省用内置实现；测试可注入固定结果） */
    detectInstallEnv?(options: UpdateTargetOptions): InstallEnv;
    /** 可选：执行安装命令（缺省用内置实现；测试可注入桩，避免真跑 pnpm） */
    runUpdate?(options: UpdateTargetOptions): Promise<UpdateResult>;
  };
}

const RPC_CHANNEL = 'dsh-ding-card';

function reply(rpcId: string, result: RpcResult): Response {
  return Response.json({ type: 'server-response', rpcId, result });
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeConfigForClient(config: PluginConfig): PluginConfig {
  return config;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 会话信息（dsh-im 投递过的会话）。 */
interface ChatLike {
  kind: 'user' | 'group';
  userId?: string;
  openConversationId?: string;
  name?: string | null;
  bot?: unknown;
  sentAt?: number;
}

/** All chats dsh-im has delivered to, deduped by conversation; newest first. */
async function listChats(botId?: string): Promise<ChatLike[]> {
  const botsDir = join(dshHome(), 'integrations', 'dsh-dingtalk', 'bots');
  const bots = await readDingtalkBots();
  const names = await readUserNames() as Record<string, any>;
  const seen = new Set<string>();
  const candidates: ChatLike[] = [];
  for (const bot of bots) {
    if (botId && bot.botId !== botId) continue;
    const state = await readJson(join(botsDir, bot.botId, 'state.json')) as Record<string, any> | null;
    for (const item of Array.isArray(state?.recentOutboundMessages) ? state.recentOutboundMessages : []) {
      const parsed = parseConversationKey(item?.conversationKey) as ChatLike | null;
      if (parsed) {
        const dedupe = parsed.kind === 'group' ? `g:${parsed.openConversationId}` : `u:${parsed.userId}`;
        if (!seen.has(dedupe)) {
          seen.add(dedupe);
          candidates.push({ ...parsed, bot, sentAt: Number(item?.sentAt) || 0, name: parsed.kind === 'user' ? names[parsed.userId ?? ''] ?? null : null });
        }
      }
    }
    for (const key of Object.keys(state?.sessions ?? {})) {
      const parsed = parseConversationKey(key) as ChatLike | null;
      if (parsed) {
        const dedupe = parsed.kind === 'group' ? `g:${parsed.openConversationId}` : `u:${parsed.userId}`;
        if (!seen.has(dedupe)) {
          seen.add(dedupe);
          candidates.push({ ...parsed, bot, sentAt: 0, name: parsed.kind === 'user' ? names[parsed.userId ?? ''] ?? null : null });
        }
      }
    }
  }
  candidates.sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0));
  return candidates;
}

/** Most recent chat dsh-im delivered to, used by the "send test card" action. */
async function lastChat(botId?: string): Promise<ChatLike | null> {
  const candidates = await listChats(botId);
  return candidates[0] ?? null;
}

export function installRpc(ctx: DshCtx, deps: RpcDeps): { install(): void; dispose(): void } {
  const { store, cards, api, events, logger = console, updater } = deps;
  let registered: (() => void) | null = null;

  async function status(): Promise<unknown> {
    const config = store.get();
    const [dshim, bots] = await Promise.all([inspectDshIm(), readDingtalkBots()]);
    const bot = chooseBot(config, bots, null) as { clientId: string; botId: string; source: string; secretRef: string } | null;
    let secretReady = false;
    if (bot?.secretRef) secretReady = Boolean(await resolveSecret(ctx, bot.secretRef));
    const key = await resolveSecret(ctx, config.bot.secretRef).catch(() => null);
    if (config.bot.mode === 'manual') secretReady = Boolean(key);
    const routes = await readSessionRoutes().catch(() => new Map());
    return {
      version: 2,
      config: sanitizeConfigForClient(config),
      cardTypes: CARD_TYPE_META,
      dshim,
      bots: bots.map((b: Record<string, any>) => ({ clientId: b.clientId, botId: b.botId, hasSecretRef: Boolean(b.secretRef) })),
      bot: bot ? { clientId: bot.clientId, botId: bot.botId, source: bot.source, secretReady } : null,
      stream: cards.status().stream,
      cards: cards.status(),
      routes: routes.size,
      events: events.list(20),
      paths: { config: store.path },
    };
  }

  async function testCard(payload: Record<string, any> | undefined): Promise<unknown> {
    const config = store.get();
    const kind = payload?.kind === 'approval' ? 'approval' : 'question';
    const card = payload?.cardId
      ? config.cards.find((item) => item.id === payload.cardId)
      : selectCard(config, kind);
    if (!card) throw Object.assign(new Error('没有可用的卡片。'), { code: 'no-card' });
    if (!card.templateId) {
      throw Object.assign(new Error('请先绑定卡片模板 ID。'), { code: 'no-template' });
    }
    if (card.type !== 'message' && card.type !== 'standard' && card.type !== 'ceiling') {
      throw Object.assign(new Error(`「${card.name}」类型为 ${card.type}，不能直接投放到会话。`), {
        code: 'unsupported-card-type',
      });
    }
    const bots = await readDingtalkBots();
    const bot = chooseBot(config, bots, null) as { clientId: string; botId: string; source: string; secretRef: string } | null;
    if (!bot) throw Object.assign(new Error('没有可用的钉钉机器人，请先安装并配置 dsh-im。'), { code: 'no-bot' });
    const secret = await resolveSecret(ctx, bot.secretRef);
    if (!secret) throw Object.assign(new Error('没有找到钉钉应用密钥。'), { code: 'no-secret' });
    const pickedUserId = typeof payload?.target?.userId === 'string' && payload.target.userId
      ? payload.target.userId
      : (typeof payload?.userId === 'string' && payload.userId ? payload.userId : null);
    let target: { kind: 'user'; userId: string } | { kind: 'group'; openConversationId: string };
    if (pickedUserId) {
      target = { kind: 'user', userId: pickedUserId };
    } else {
      const chat = await lastChat(bot.botId);
      if (!chat) throw Object.assign(new Error('没有找到最近会话，请先在钉钉里给机器人发一条消息。'), { code: 'no-chat' });
      target = chat.kind === 'group'
        ? { kind: 'group', openConversationId: chat.openConversationId! }
        : { kind: 'user', userId: chat.userId! };
    }
    // 发送测试支持自定义参数：payload.data 里的字段（title/subtitle/content/fields/image/state/
    // options/variables）优先覆盖默认值，未填的字段回退 sampleData + 测试默认文案。
    const custom = isRecord(payload?.data) ? payload.data : {};
    const data = {
      ...sampleData(card),
      title: `测试：${card.name}`,
      content: '这是一张来自 dsh-ding-card 的测试卡片。',
      state: '测试卡片',
      options: ['选项 A', '选项 B'],
      ...custom,
    };
    const { params } = buildCardData(card, data) as { params: Record<string, any> };
    const outTrackId = `dsh_test_${randomUUID()}`;
    if (card.type === 'ceiling') {
      if (target.kind !== 'user') {
        throw Object.assign(new Error('吊顶卡片仅支持单聊会话。'), { code: 'unsupported-target' });
      }
      await api.createTopBox({
        clientId: bot.clientId,
        clientSecret: secret,
        target,
        cardTemplateId: card.templateId,
        outTrackId,
        cardParamMap: params,
      });
      if (card.aiCard) {
        const streamKeys = Object.keys(params).filter((key) => key && key !== card.variables?.image);
        const failedKeys: string[] = [];
        for (let index = 0; index < streamKeys.length; index++) {
          const key = streamKeys[index];
          await api.streamCard({
            clientId: bot.clientId,
            clientSecret: secret,
            outTrackId,
            key,
            content: params[key] ?? '',
            isFinalize: index === streamKeys.length - 1,
          }).catch((error: unknown) => {
            failedKeys.push(key);
            console.warn(`[dsh-ding-card] AI 卡片测试流式填充失败（变量 ${key}）：${(error as Error)?.message ?? error}`);
          });
        }
        if (failedKeys.length > 0) {
          console.warn(`[dsh-ding-card] AI 卡片测试「${card.name}」流式填充不完整（${failedKeys.length}/${streamKeys.length}：${failedKeys.join('、')}）`);
        }
      }
      cards.registerTestCard(outTrackId, {
        recycleOnDone: card.recycleOnDone === true,
        bot: { clientId: bot.clientId, clientSecret: secret },
        target,
      });
    } else {
      const payloadResult = await api.createAndDeliverCard({
        clientId: bot.clientId,
        clientSecret: secret,
        target,
        cardTemplateId: card.templateId,
        outTrackId,
        cardParamMap: params,
      }) as Record<string, any>;
      const testCarrier = payloadResult?.result?.deliverResults?.[0]?.carrierId ?? payloadResult?.result?.processQueryKey ?? null;
      if (card.aiCard) {
        // AI 卡片的按钮区/文本区为流式渲染：除图片外全部变量都通过 streamCard 逐 key 填充，
        // 否则按钮文案（cardData.btnsA 等）停留在待填充状态不显示（与吊顶卡分支对齐）。
        const streamKeys = Object.keys(params).filter((key) => key && key !== card.variables?.image);
        for (let index = 0; index < streamKeys.length; index++) {
          const key = streamKeys[index];
          await api.streamCard({
            clientId: bot.clientId,
            clientSecret: secret,
            outTrackId,
            key,
            content: params[key] ?? '',
            isFinalize: index === streamKeys.length - 1,
          }).catch(() => undefined);
        }
      }
      cards.registerTestCard(outTrackId, {
        carrierId: testCarrier,
        recycleOnDone: card.recycleOnDone === true,
        bot: { clientId: bot.clientId, clientSecret: secret },
        target,
      });
    }
    events.record('info', `已发送测试卡片「${card.name}」`, { chat: target.kind, kind });
    return {
      sent: true,
      outTrackId,
      cardId: card.id,
      chat: target.kind === 'group' ? `群 ${(target as { openConversationId: string }).openConversationId}` : `单聊 ${(target as { userId: string }).userId}`,
    };
  }

  async function exportCard(payload: Record<string, any> | undefined): Promise<unknown> {
    const config = store.get();
    const card = payload?.draft && typeof payload.draft === 'object'
      ? sanitizeCard(payload.draft)
      : config.cards.find((item) => item.id === payload?.id);
    if (!card) throw Object.assign(new Error('没有找到要导出的卡片。'), { code: 'unknown-card' });
    const exported = await exportDingtalkTemplate(card);
    events.record('info', `已导出卡片「${card.name}」`, { type: card.type });
    return exported;
  }

  async function importCard(payload: Record<string, any> | undefined): Promise<unknown> {
    const source = payload?.json ?? payload?.file;
    if (typeof source !== 'string' && !isRecord(source)) {
      throw Object.assign(new Error('请粘贴或上传钉钉导出的 JSON 内容。'), { code: 'bad-request' });
    }
    let card: CardConfig;
    try {
      card = importDingtalkJson(source, { name: payload?.name });
    } catch (error) {
      throw Object.assign(new Error(`JSON 解析失败：${(error as Error)?.message ?? error}`), { code: 'bad-json' });
    }
    events.record('info', `已导入卡片「${card.name}」`, { type: card.type });
    return { card };
  }

  async function chatList(): Promise<unknown> {
    const config = store.get();
    const bots = await readDingtalkBots();
    const bot = chooseBot(config, bots, null) as { clientId: string; botId: string; source: string; secretRef: string } | null;
    const chats = await listChats(bot?.botId);
    return {
      chats: chats.map((chat) => ({
        userId: chat.userId ?? null,
        name: chat.name ?? null,
        openConversationId: chat.openConversationId ?? null,
        kind: chat.kind,
        sentAt: chat.sentAt ?? 0,
      })),
    };
  }

  async function checkBot(): Promise<unknown> {
    const config = store.get();
    const bots = await readDingtalkBots();
    const bot = chooseBot(config, bots, null) as { clientId: string; botId: string; source: string; secretRef: string } | null;
    if (!bot) throw Object.assign(new Error('没有可用的钉钉机器人。'), { code: 'no-bot' });
    const secret = await resolveSecret(ctx, bot.secretRef);
    if (!secret) throw Object.assign(new Error('没有找到钉钉应用密钥。'), { code: 'no-secret' });
    await api.accessToken({ clientId: bot.clientId, clientSecret: secret, force: true });
    events.record('info', '钉钉应用凭据校验通过', { clientId: bot.clientId });
    return { ok: true, clientId: bot.clientId };
  }

  async function installDshIm(): Promise<unknown> {
    const manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined;
    if (!manager || typeof (manager as Record<string, any>).installBundle !== 'function') {
      return {
        manual: true,
        command: `dsh plugin --profile ${currentProfileName()} add @xmanrui/dsh-im`,
        message: '当前 DSH 未暴露插件管理服务，请用命令安装 dsh-im。',
      };
    }
    events.record('info', '开始安装 dsh-im…');
    try {
      const result = await (manager as Record<string, any>).installBundle('@xmanrui/dsh-im', { enabled: true });
      events.record('info', 'dsh-im 安装完成，请重启 DSH', { application: (result as Record<string, any>)?.application });
      return { manual: false, result };
    } catch (error) {
      events.record('error', `dsh-im 安装失败：${(error as Error)?.message ?? error}`);
      throw Object.assign(new Error(`dsh-im 安装失败：${(error as Error)?.message ?? error}`), {
        code: (error as Record<string, any>)?.code ?? 'install-failed',
        detail: { command: `dsh plugin --profile ${currentProfileName()} add @xmanrui/dsh-im` },
      });
    }
  }

  /** 当前运行时是否提供 HMR（热更新）服务：可用时插件包变更能由宿主热重组，无需重启进程。 */
  function hmrAvailable(): boolean {
    try {
      return typeof (ctx as Record<string, any>)?.get === 'function' && Boolean((ctx as Record<string, any>).get('hmr'));
    } catch {
      return false;
    }
  }

  /** 宿主插件管理服务返回的失败原因 → 面向用户的中文说明。 */
  function updateFailureText(authority: Record<string, any> | undefined): string {
    const code = String(authority?.code ?? authority?.error?.code ?? '');
    const table: Record<string, string> = {
      'already-installed': '当前 DSH 处于热更新模式，已安装的包不能直接覆盖；请改用「卸载后立即重装」。',
      'incompatible-version': '新版本与当前 DSH 版本不兼容，已保持原版本。',
      'ambiguous-install': '安装结果无法定位到唯一的插件包，宿主已回滚 package.json。',
      'not-bundle': '目标包没有声明组合包（dsh.bundle），不能作为插件安装。',
      'invalid-spec': '安装地址无效。',
      network: 'GitHub 连接失败，请检查网络后重试。',
      timeout: '安装超时，请检查网络后重试。',
      'not-removable': '宿主拒绝卸载该插件（可能随 DSH 自带或正在使用）。',
      'stop-profile': '需要先停止当前 DSH 实例才能替换，请退出 DSH 后重试。',
    };
    return table[code] ?? '';
  }

  /** 环境识别：优先用宿主装配的实现（测试可注入），否则用内置实现。 */
  function resolveInstallEnv(options: UpdateTargetOptions): InstallEnv {
    const custom = updater?.detectInstallEnv;
    return custom ? custom(options) : detectInstallEnv(options);
  }

  /** 执行安装命令：同上，测试可注入桩避免真跑安装器。 */
  function execUpdate(options: UpdateTargetOptions): Promise<UpdateResult> {
    const custom = updater?.runUpdate;
    return custom ? custom(options) : runUpdate(options);
  }

  /** 版本检查：对比当前插件版本与 GitHub 最新 Release，并返回本机安装环境识别结果。 */
  async function versionCheck(): Promise<unknown> {
    const current = updater?.current ? updater.current() : null;
    const latest = updater?.check ? await updater.check() : null;
    const updateAvailable = Boolean(current && latest && !updater!.isAtLeast(current, latest.version));
    // 与「立即更新 / 复制命令」共用同一套环境判定，界面显示的 profile 与命令就是实际执行的
    const env = resolveInstallEnv({ version: latest?.version ?? undefined });
    const profile = env.profile ?? currentProfileName();
    return {
      current,
      latest: latest?.version ?? null,
      source: latest?.source ?? null,
      updateAvailable,
      profile,
      command: updateAvailable ? (env.command || null) : null,
      /** 安装环境（profile / 安装来源 / CLI / 是否可自动执行）；无更新时为 null */
      env: updateAvailable ? env : null,
      /** 能否热更新（免重启）：宿主未提供 hmr 时为 false，覆盖更新后必须重启。 */
      hotReload: hmrAvailable(),
      /** 当前环境是本地开发链接（junction / --link）时，更新由工作树决定。 */
      linkMode: isLinkedToSource(),
    };
  }

  /** 更新后需要重启时，给用户的重启方式（桌面端与网页端不同）。 */
  function restartHint(profile: string): { kind: 'desktop' | 'web'; command: string | null; message: string } {
    const electron = Boolean((process.versions as Record<string, string> | undefined)?.electron);
    if (electron) {
      return { kind: 'desktop', command: null, message: '退出并重新打开 DSH 客户端即可生效（当前会话会中断）。' };
    }
    return { kind: 'web', command: 'dsh web', message: '停掉当前 dsh web 进程（Ctrl+C）后重新执行 dsh web。' };
  }

  /** HMR 模式下宿主拒绝对已装包直接覆盖：排队“卸载后立即重装”，由宿主热重组。 */
  function queueHotReload(manager: Record<string, any>, spec: string): void {
    const timer = setTimeout(async () => {
      try {
        await manager.removeBundle('dsh-ding-card');
      } catch (error) {
        events.record('error', `热更新卸载失败：${(error as Error)?.message ?? error}`);
        return;
      }
      // 卸载后必须装回，失败时重试一次；仍失败则记录，靠下次启动的自动更新恢复。
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const result = await manager.installBundle(spec, { enabled: true }) as Record<string, any>;
          events.record('info', `热更新重装完成（${attempt === 1 ? '首次' : '重试'}）`, {
            application: result?.application,
          });
          return;
        } catch (error) {
          events.record('error', `热更新重装失败（第 ${attempt} 次）：${(error as Error)?.message ?? error}`);
        }
      }
      events.record('error', '热更新未完成，插件当前处于未安装状态；重启 DSH 后由自动更新恢复，或执行手动命令安装。');
    }, 1500);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * 一键更新：插件内部自动识别当前 profile，通过宿主的插件管理服务安装最新版本，
   * 不再要求用户复制命令。宿主未暴露插件管理服务、或当前是本地开发链接时，
   * 返回 manual 与对应命令。
   *
   * 生效规则（宿主行为，非本插件决定）：
   * - 宿主提供 HMR 时：改为“卸载后立即重装”，宿主热重组，无需重启；
   * - 宿主无 HMR 时：覆盖更新后宿主标记 restart-required，必须重启 DSH 才生效；
   * - 首次安装：宿主会 publishAndReload，装完即生效。
   */
  async function versionUpdate(payload?: Record<string, any>): Promise<unknown> {
    const current = updater?.current ? updater.current() : null;
    const latest = updater?.check ? await updater.check() : null;
    if (!latest?.version) {
      throw Object.assign(new Error('无法获取最新版本信息，请检查网络后重试。'), { code: 'version-unavailable' });
    }
    const requested = typeof payload?.profile === 'string' ? payload.profile.trim() : '';
    // 命令与 profile 出自同一套环境判定：界面展示的、复制命令复制的、兜底执行的都是这一条
    const env = resolveInstallEnv({ version: latest.version, profile: requested || undefined });
    const profile = env.profile ?? currentProfileName();
    const command = env.command || `dsh plugin --profile ${profile} add github:Jydsh/dsh-ding-card#v${latest.version}`;
    if (current && updater!.isAtLeast(current, latest.version)) {
      return { ok: true, updated: false, profile, command, env, message: `当前已是最新版本 v${current}。`, requiresRestart: false };
    }
    if (env.blocker) {
      // 链接安装 / 找不到 CLI / 无法判定 profile：不自动安装，把原因与命令交给界面
      events.record('warn', `无法自动更新（${profile}）：${env.blocker}`);
      return {
        ok: false,
        updated: false,
        manual: true,
        linkMode: env.source === 'link',
        command,
        profile,
        env,
        output: env.blocker,
        message: env.blocker,
        requiresRestart: false,
      };
    }
    const manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined;
    if (!manager || typeof (manager as Record<string, any>).installBundle !== 'function') {
      // 宿主没暴露插件管理服务：按识别出的同一套命令直接执行，与「复制命令」内容完全一致
      events.record('info', `宿主未暴露插件管理服务，改为执行命令行：${command}`);
      const outcome = await execUpdate({ version: latest.version, profile: requested || undefined });
      const tailText = outcome.output.trim().split(/\r?\n/).slice(-3).join(' / ');
      events.record(
        outcome.ok ? 'info' : 'error',
        outcome.ok
          ? `命令行更新完成（exit ${outcome.exitCode}）：${command}`
          : `命令行更新失败（exit ${outcome.exitCode}）：${tailText || '无输出'}`,
      );
      const hint = outcome.ok ? restartHint(profile) : null;
      return {
        ok: outcome.ok,
        updated: outcome.ok,
        applied: false,
        manual: !outcome.ok,
        requiresRestart: outcome.ok,
        version: latest.version,
        profile,
        command,
        env: outcome.env,
        output: outcome.output,
        exitCode: outcome.exitCode,
        restart: hint,
        message: outcome.ok
          ? `已执行安装命令并通过，重启 DSH 后生效。${hint?.message ?? ''}`
          : `更新失败（exit ${outcome.exitCode ?? '未知'}）：${tailText || '命令没有输出'}`,
      };
    }
    if (hmrAvailable()) {
      queueHotReload(manager as Record<string, any>, env.spec);
      events.record('info', `热更新模式：排队卸载并立即重装 ${env.spec}，宿主将热重组插件`);
      return {
        ok: true,
        updated: false,
        hotReload: true,
        queued: true,
        version: latest.version,
        profile,
        command,
        env,
        requiresRestart: false,
        message: `热更新模式：正在卸载并立即重装 v${latest.version}，插件会短暂断开，宿主热重组后自动恢复。`,
      };
    }
    events.record('info', `开始一键更新插件到 v${latest.version}…`);
    let result: Record<string, any>;
    try {
      result = await (manager as Record<string, any>).installBundle(env.spec, { enabled: true }) as Record<string, any>;
    } catch (error) {
      const reason = updateFailureText(error as Record<string, any>) || ((error as Error)?.message ?? String(error));
      events.record('error', `插件更新失败：${reason}`);
      return {
        ok: false,
        updated: false,
        manual: true,
        command,
        profile,
        env,
        output: reason,
        message: `更新失败：${reason}`,
        requiresRestart: false,
        code: (error as Record<string, any>)?.code ?? 'update-failed',
      };
    }
    const application = String(result?.application ?? 'restart-required');
    if (application === 'failed') {
      const reason = updateFailureText(result?.error) || '宿主未返回具体原因。';
      events.record('error', `插件更新失败：${reason}`);
      return {
        ok: false,
        updated: false,
        manual: true,
        command,
        profile,
        env,
        output: reason,
        message: `更新失败：${reason}`,
        requiresRestart: false,
        code: 'update-failed',
      };
    }
    const applied = application === 'applied';
    const hint = applied ? null : restartHint(profile);
    events.record(
      'info',
      applied
        ? `插件已更新到 v${latest.version}，宿主已应用，无需重启`
        : `插件已更新到 v${latest.version}，需重启 DSH 生效`,
      { application },
    );
    return {
      ok: true,
      updated: true,
      applied,
      requiresRestart: !applied,
      version: latest.version,
      profile,
      command,
      env,
      restart: hint,
      message: applied
        ? `已更新到 v${latest.version}，无需重启即已生效。`
        : `已更新到 v${latest.version}，重启 DSH 后生效。${hint?.message ?? ''}`,
      result,
    };
  }

  /**
   * 重启 DSH：桌面宿主（Electron）用 app.relaunch 自我重启；
   * 网页端 / 纯 node 宿主无法自杀式重启，回退为手动命令。
   */
  async function versionRestart(): Promise<unknown> {
    const profile = currentProfileName();
    const hint = restartHint(profile);
    try {
      const require2 = createRequire(import.meta.url);
      const electron = require2('electron') as Record<string, any>;
      const app = electron?.app;
      if (app && typeof app.relaunch === 'function' && typeof app.exit === 'function') {
        events.record('warn', `按用户确认重启 DSH（${profile} profile）`);
        app.relaunch({ args: process.argv.slice(1) });
        setTimeout(() => { try { app.exit(0); } catch { /* 退出失败由用户手动关闭 */ } }, 300);
        return { restarted: true, profile, message: '正在重启 DSH 客户端…' };
      }
    } catch { /* ELECTRON_RUN_AS_NODE / 纯 node 宿主没有 app，走手动回退 */ }
    events.record('warn', `当前宿主不允许插件自行重启，需要手动重启（${profile} profile）`);
    return {
      restarted: false,
      manual: true,
      profile,
      command: hint.command,
      message: `当前宿主不允许插件自行重启，请手动重启：${hint.message}`,
    };
  }

  function sidebarVisibleFor(config: PluginConfig): boolean {
    const mode = config.sidebar?.mode ?? 'auto';
    if (mode === 'show') return true;
    if (mode === 'hide') return false;
    // auto：没有任何已绑定模板的可用卡片时显示入口（引导配置），配置后自动隐藏。
    const hasBound = (Array.isArray(config.cards) ? config.cards : [])
      .some((card) => card.templateId && (card.type === 'message' || card.type === 'standard'));
    return !hasBound;
  }

  async function dispatch(method: string, payload: Record<string, any> | undefined): Promise<unknown> {
    if (method === 'status') return status();
    if (method === 'config.get') return { config: sanitizeConfigForClient(store.get()) };
    if (method === 'config.save') {
      if (!isRecord(payload?.config)) throw Object.assign(new Error('配置格式无效。'), { code: 'bad-request' });
      const saved = await store.save(payload.config);
      events.record('info', '配置已保存');
      return { config: saved };
    }
    if (method === 'logs.list') return { entries: events.list(payload?.limit) };
    if (method === 'logs.clear') {
      events.clear();
      return { cleared: true };
    }
    if (method === 'card.test') return testCard(payload as Record<string, any>);
    if (method === 'card.import') return importCard(payload as Record<string, any>);
    if (method === 'chat.list') return chatList();
    if (method === 'cards.export') return exportCard(payload as Record<string, any>);
    if (method === 'bot.check') return checkBot();
    if (method === 'version.check') return versionCheck();
    if (method === 'version.update') return versionUpdate(payload as Record<string, any> | undefined);
    if (method === 'version.restart') return versionRestart();
    if (method === 'dshim.install') return installDshIm();
    if (method === 'pending.list') return { pending: cards.pendingList() };
    if (method === 'sidebar-entry.get') {
      const config = store.get();
      const mode = config.sidebar?.mode ?? 'auto';
      return { mode, visible: sidebarVisibleFor(config) };
    }
    if (method === 'sidebar-entry.set') {
      const mode = payload?.mode === 'show' || payload?.mode === 'hide' ? payload.mode : 'auto';
      const saved = await store.save({ ...store.get(), sidebar: { mode } });
      events.record('info', `侧边栏入口已设为：${mode === 'show' ? '始终显示' : mode === 'hide' ? '始终隐藏' : '自动隐藏'}`);
      return { mode, visible: sidebarVisibleFor(saved) };
    }
    throw Object.assign(new Error(`未知操作：${method}`), { code: 'unknown-method' });
  }

  function registerOn(target: unknown): void {
    const connection = (target as Record<string, any>)?.connection ?? (target as Record<string, any>)?.get?.('connection') ?? ctx?.connection;
    if (typeof (connection as Record<string, any>)?.fetch?.register !== 'function') {
      events.record('warn', '当前 DSH 版本不提供 connection.fetch，管理接口未注册');
      return;
    }
    registered = (connection as Record<string, any>).fetch.register({
      path: `/api/${RPC_CHANNEL}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request: Request): Promise<Response> {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        let message: RpcClientRequest;
        try { message = await request.json(); } catch { return new Response('body is not JSON', { status: 400 }); }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
        const call = message?.payload;
        if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
          || message.method !== RPC_CHANNEL || !isRecord(call) || typeof call.method !== 'string'
          || !Object.hasOwn(call, 'payload')) {
          return reply(rpcId, { ok: false, error: { code: 'bad-request', message: 'Invalid dsh-ding-card request.' } });
        }
        try {
          const value = await dispatch(call.method, call.payload as Record<string, any>);
          return reply(rpcId, { ok: true, value });
        } catch (error) {
          logger.warn?.(`[dsh-ding-card] ${call.method} failed:`, (error as Error)?.message ?? error);
          return reply(rpcId, {
            ok: false,
            error: {
              code: (error as Record<string, any>)?.code ?? 'operation-failed',
              message: (error as Error)?.message ?? '操作失败，请稍后重试。',
              details: (error as Record<string, any>)?.detail ?? {},
            },
          });
        }
      },
    });
  }

  function install(): void {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['connection'], (connectionCtx) => registerOn(connectionCtx));
      return;
    }
    registerOn(ctx);
  }

  return {
    install,
    dispose() { registered?.(); registered = null; },
  };
}
