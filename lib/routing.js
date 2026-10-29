import { readDingtalkBots, readSessionRoutes, resolveSecret } from './dshim.js';

const ROUTE_TTL_MS = 1_500;

/**
 * Resolve a DSH Session to the DingTalk bot + chat dsh-im recorded for it.
 * Reads dsh-im's state at most once per 1.5 seconds.
 */
export function createRouteResolver(ctx, { store, events, logger = console }) {
  let cache = { at: 0, map: new Map() };

  async function routes() {
    if (Date.now() - cache.at < ROUTE_TTL_MS) return cache.map;
    try {
      cache = { at: Date.now(), map: await readSessionRoutes() };
    } catch (error) {
      logger.warn?.('[dsh-ding-card] failed to read dsh-im session routes:', error?.message ?? error);
    }
    return cache.map;
  }

  return async function resolveTarget(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const map = await routes();
    const route = map.get(sessionId);
    if (!route) return null;
    const config = store.get();
    if (route.kind === 'group' && !config.interactions.allowGroup) return null;
    const bots = await readDingtalkBots();
    const bot = bots.find((item) => item.botId === route.botId);
    if (!bot) {
      events.record('warn', '会话所属的钉钉机器人已不在 dsh-im 配置中', { botId: route.botId, sessionId });
      return null;
    }
    const secret = await resolveSecret(ctx, bot.secretRef);
    if (!secret) {
      events.record('warn', '未找到钉钉应用密钥，无法投放卡片', { botId: bot.botId, secretRef: bot.secretRef });
      return null;
    }
    return {
      sessionId,
      botId: bot.botId,
      bot: { clientId: bot.clientId, clientSecret: secret, botId: bot.botId },
      target: route.kind === 'group'
        ? { kind: 'group', openConversationId: route.openConversationId }
        : { kind: 'user', userId: route.userId },
    };
  };
}
