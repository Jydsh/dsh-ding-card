import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildCardData, exportDingtalkTemplate, sampleData } from './export.js';
import { importDingtalkJson } from './import.js';
import { selectCard } from './cards.js';
import { CARD_TYPE_META, sanitizeCard } from './store.js';
import {
  chooseBot,
  dshHome,
  inspectDshIm,
  parseConversationKey,
  readDingtalkBots,
  readSessionRoutes,
  readUserNames,
  resolveSecret,
} from './dshim.js';

const RPC_CHANNEL = 'dsh-ding-card';

function reply(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeConfigForClient(config) {
  return config;
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** All chats dsh-im has delivered to, deduped by conversation; newest first. */
async function listChats(botId) {
  const botsDir = join(dshHome(), 'integrations', 'dsh-dingtalk', 'bots');
  const bots = await readDingtalkBots();
  const names = await readUserNames();
  const seen = new Set();
  const candidates = [];
  for (const bot of bots) {
    if (botId && bot.botId !== botId) continue;
    const state = await readJson(join(botsDir, bot.botId, 'state.json'));
    for (const item of Array.isArray(state?.recentOutboundMessages) ? state.recentOutboundMessages : []) {
      const parsed = parseConversationKey(item?.conversationKey);
      if (parsed) {
        const dedupe = parsed.kind === 'group' ? `g:${parsed.openConversationId}` : `u:${parsed.userId}`;
        if (!seen.has(dedupe)) {
          seen.add(dedupe);
          candidates.push({ ...parsed, bot, sentAt: Number(item?.sentAt) || 0, name: parsed.kind === 'user' ? names[parsed.userId] ?? null : null });
        }
      }
    }
    for (const key of Object.keys(state?.sessions ?? {})) {
      const parsed = parseConversationKey(key);
      if (parsed) {
        const dedupe = parsed.kind === 'group' ? `g:${parsed.openConversationId}` : `u:${parsed.userId}`;
        if (!seen.has(dedupe)) {
          seen.add(dedupe);
          candidates.push({ ...parsed, bot, sentAt: 0, name: parsed.kind === 'user' ? names[parsed.userId] ?? null : null });
        }
      }
    }
  }
  candidates.sort((a, b) => b.sentAt - a.sentAt);
  return candidates;
}

/** Most recent chat dsh-im delivered to, used by the "send test card" action. */
async function lastChat(botId) {
  const candidates = await listChats(botId);
  return candidates[0] ?? null;
}

export function installRpc(ctx, { store, cards, api, events, logger = console }) {
  let registered = null;

  async function status() {
    const config = store.get();
    const [dshim, bots] = await Promise.all([inspectDshIm(), readDingtalkBots()]);
    const bot = chooseBot(config, bots, null);
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
      bots: bots.map(({ clientId, botId, secretRef }) => ({ clientId, botId, hasSecretRef: Boolean(secretRef) })),
      bot: bot ? { clientId: bot.clientId, botId: bot.botId, source: bot.source, secretReady } : null,
      stream: cards.status().stream,
      cards: cards.status(),
      routes: routes.size,
      events: events.list(20),
      paths: { config: store.path },
    };
  }

  async function testCard(payload) {
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
    const bot = chooseBot(config, bots, null);
    if (!bot) throw Object.assign(new Error('没有可用的钉钉机器人，请先安装并配置 dsh-im。'), { code: 'no-bot' });
    const secret = await resolveSecret(ctx, bot.secretRef);
    if (!secret) throw Object.assign(new Error('没有找到钉钉应用密钥。'), { code: 'no-secret' });
    const pickedUserId = typeof payload?.target?.userId === 'string' && payload.target.userId
      ? payload.target.userId
      : (typeof payload?.userId === 'string' && payload.userId ? payload.userId : null);
    let target;
    if (pickedUserId) {
      target = { kind: 'user', userId: pickedUserId };
    } else {
      const chat = await lastChat(bot.botId);
      if (!chat) throw Object.assign(new Error('没有找到最近会话，请先在钉钉里给机器人发一条消息。'), { code: 'no-chat' });
      target = chat.kind === 'group'
        ? { kind: 'group', openConversationId: chat.openConversationId }
        : { kind: 'user', userId: chat.userId };
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
    const { params } = buildCardData(card, data);
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
        const failedKeys = [];
        for (let index = 0; index < streamKeys.length; index++) {
          const key = streamKeys[index];
          await api.streamCard({
            clientId: bot.clientId,
            clientSecret: secret,
            outTrackId,
            key,
            content: params[key] ?? '',
            isFinalize: index === streamKeys.length - 1,
          }).catch((error) => {
            failedKeys.push(key);
            console.warn(`[dsh-ding-card] AI 卡片测试流式填充失败（变量 ${key}）：${error?.message ?? error}`);
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
      const payload = await api.createAndDeliverCard({
        clientId: bot.clientId,
        clientSecret: secret,
        target,
        cardTemplateId: card.templateId,
        outTrackId,
        cardParamMap: params,
      });
      const testCarrier = payload?.result?.deliverResults?.[0]?.carrierId ?? payload?.result?.processQueryKey ?? null;
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
      chat: target.kind === 'group' ? `群 ${target.openConversationId}` : `单聊 ${target.userId}`,
    };
  }

  async function exportCard(payload) {
    const config = store.get();
    const card = payload?.draft && typeof payload.draft === 'object'
      ? sanitizeCard(payload.draft)
      : config.cards.find((item) => item.id === payload?.id);
    if (!card) throw Object.assign(new Error('没有找到要导出的卡片。'), { code: 'unknown-card' });
    const exported = await exportDingtalkTemplate(card);
    events.record('info', `已导出卡片「${card.name}」`, { type: card.type });
    return exported;
  }

  async function importCard(payload) {
    const source = payload?.json ?? payload?.file;
    if (typeof source !== 'string' && !isRecord(source)) {
      throw Object.assign(new Error('请粘贴或上传钉钉导出的 JSON 内容。'), { code: 'bad-request' });
    }
    let card;
    try {
      card = importDingtalkJson(source, { name: payload?.name });
    } catch (error) {
      throw Object.assign(new Error(`JSON 解析失败：${error?.message ?? error}`), { code: 'bad-json' });
    }
    events.record('info', `已导入卡片「${card.name}」`, { type: card.type });
    return { card };
  }

  async function chatList() {
    const config = store.get();
    const bots = await readDingtalkBots();
    const bot = chooseBot(config, bots, null);
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

  async function checkBot() {
    const config = store.get();
    const bots = await readDingtalkBots();
    const bot = chooseBot(config, bots, null);
    if (!bot) throw Object.assign(new Error('没有可用的钉钉机器人。'), { code: 'no-bot' });
    const secret = await resolveSecret(ctx, bot.secretRef);
    if (!secret) throw Object.assign(new Error('没有找到钉钉应用密钥。'), { code: 'no-secret' });
    await api.accessToken({ clientId: bot.clientId, clientSecret: secret, force: true });
    events.record('info', '钉钉应用凭据校验通过', { clientId: bot.clientId });
    return { ok: true, clientId: bot.clientId };
  }

  async function installDshIm() {
    const manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined;
    if (!manager || typeof manager.installBundle !== 'function') {
      return {
        manual: true,
        command: `dsh plugin --profile ${process.env.DSH_PROFILE ?? 'desktop'} add @xmanrui/dsh-im`,
        message: '当前 DSH 未暴露插件管理服务，请用命令安装 dsh-im。',
      };
    }
    events.record('info', '开始安装 dsh-im…');
    try {
      const result = await manager.installBundle('@xmanrui/dsh-im', { enabled: true });
      events.record('info', 'dsh-im 安装完成，请重启 DSH', { application: result?.application });
      return { manual: false, result };
    } catch (error) {
      events.record('error', `dsh-im 安装失败：${error?.message ?? error}`);
      throw Object.assign(new Error(`dsh-im 安装失败：${error?.message ?? error}`), {
        code: error?.code ?? 'install-failed',
        detail: { command: `dsh plugin --profile ${process.env.DSH_PROFILE ?? 'desktop'} add @xmanrui/dsh-im` },
      });
    }
  }

  function sidebarVisibleFor(config) {
    const mode = config.sidebar?.mode ?? 'auto';
    if (mode === 'show') return true;
    if (mode === 'hide') return false;
    // auto：没有任何已绑定模板的可用卡片时显示入口（引导配置），配置后自动隐藏。
    const hasBound = (Array.isArray(config.cards) ? config.cards : [])
      .some((card) => card.templateId && (card.type === 'message' || card.type === 'standard'));
    return !hasBound;
  }

  async function dispatch(method, payload) {
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
    if (method === 'card.test') return testCard(payload);
    if (method === 'card.import') return importCard(payload);
    if (method === 'chat.list') return chatList();
    if (method === 'cards.export') return exportCard(payload);
    if (method === 'bot.check') return checkBot();
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

  function registerOn(target) {
    const connection = target?.connection ?? target?.get?.('connection') ?? ctx?.connection;
    if (typeof connection?.fetch?.register !== 'function') {
      events.record('warn', '当前 DSH 版本不提供 connection.fetch，管理接口未注册');
      return;
    }
    registered = connection.fetch.register({
      path: `/api/${RPC_CHANNEL}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        let message;
        try { message = await request.json(); } catch { return new Response('body is not JSON', { status: 400 }); }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
        const call = message?.payload;
        if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
          || message.method !== RPC_CHANNEL || !isRecord(call) || typeof call.method !== 'string'
          || !Object.hasOwn(call, 'payload')) {
          return reply(rpcId, { ok: false, error: { code: 'bad-request', message: 'Invalid dsh-ding-card request.' } });
        }
        try {
          const value = await dispatch(call.method, call.payload, request.signal);
          return reply(rpcId, { ok: true, value });
        } catch (error) {
          logger.warn?.(`[dsh-ding-card] ${call.method} failed:`, error?.message ?? error);
          return reply(rpcId, {
            ok: false,
            error: {
              code: error?.code ?? 'operation-failed',
              message: error?.message ?? '操作失败，请稍后重试。',
              details: error?.detail ?? {},
            },
          });
        }
      },
    });
  }

  function install() {
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
