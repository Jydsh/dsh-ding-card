import { createCardService } from './cards.js';
import { createDingTalkApi } from './dingtalk.js';
import { inspectDshIm, readDingtalkBots } from './dshim.js';
import { installInteractions } from './interactions.js';
import { createEventLog } from './log.js';
import { createRouteResolver } from './routing.js';
import { installRpc } from './rpc.js';
import { CardConfigStore } from './store.js';
import { installStreamBridge } from './stream-bridge.js';
import { installCardTools } from './tools.js';
import { checkLatestVersion, getCurrentVersion, isAtLeast } from './updater.js';

export const name = 'dsh-ding-card';
export const inject = ['connection', 'credentials'];

function makeLogger(ctx) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger('dsh-ding-card') : ctx?.logger;
  const safe = logger && typeof logger === 'object' ? logger : console;
  return {
    info: (...args) => safe.info?.(...args),
    warn: (...args) => safe.warn?.(...args),
    error: (...args) => safe.error?.(...args),
    debug: (...args) => safe.debug?.(...args),
  };
}

/**
 * dsh-ding-card: turns DSH human interactions into DingTalk AI cards.
 *
 * The plugin reuses the DingTalk application that dsh-im already stores and
 * attaches to dsh-im's existing Stream connection, so no second connection is
 * opened and no bot credentials are duplicated.
 */
export async function apply(ctx, config = {}) {
  const logger = makeLogger(ctx);
  const store = new CardConfigStore(config.configPath);
  try {
    await store.load();
  } catch (error) {
    logger.error?.('[dsh-ding-card] failed to load config, using defaults:', error?.message ?? error);
  }
  const events = createEventLog(logger);
  const bridge = await installStreamBridge({ logger });
  const api = createDingTalkApi({ logger });
  const cards = createCardService({ api, store, bridge, events, logger });
  const interactions = installInteractions(ctx, { store, cards, events, logger });
  const resolveTarget = createRouteResolver(ctx, { store, events, logger });
  const tools = installCardTools(ctx, { store, cards, resolveTarget, events, logger });

  const updater = { current: getCurrentVersion, check: checkLatestVersion, isAtLeast };

  // 启动时自动检查一次版本（不阻塞启动，静默失败）。
  (async () => {
    try {
      const current = getCurrentVersion();
      const latest = await checkLatestVersion();
      if (current && latest && !isAtLeast(current, latest.version)) {
        logger.info?.(
          `[dsh-ding-card] 发现新版本 ${current} → ${latest.version}（来源：${latest.source}），`
          + `可运行 dsh plugin --profile ${process.env.DSH_PROFILE ?? 'desktop'} add github:Jydsh/dsh-ding-card#v${latest.version} 更新。`,
        );
        events.record('info', `发现新版本 ${current} → ${latest.version}`, { source: latest.source });
      } else if (current && latest) {
        logger.debug?.(`[dsh-ding-card] 版本检查通过：${current} 已是最新（来源：${latest.source}）`);
      }
    } catch { /* 版本检查失败不影响启动 */ }
  })();

  const rpc = installRpc(ctx, { store, cards, api, events, logger, updater });
  try {
    rpc.install();
  } catch (error) {
    events.record('error', `管理接口注册失败：${error?.message ?? error}`);
  }

  const dispose = () => {
    try { interactions(); } catch { /* ignore */ }
    try { tools(); } catch { /* ignore */ }
    try { cards.dispose(); } catch { /* ignore */ }
    try { rpc.dispose(); } catch { /* ignore */ }
  };
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-ding-card: interaction answerers and management RPC');
  }

  if (typeof ctx?.provide === 'function') {
    ctx.provide('dshDingCard', Object.freeze({
      version: 1,
      status: () => ({
        config: store.get(),
        cards: cards.status(),
        stream: bridge.status(),
      }),
      openPage: () => undefined,
    }));
  }

  const dshim = await inspectDshIm();
  if (!dshim.installed) {
    events.record('warn', '未检测到 dsh-im，卡片无法投递；请先安装 dsh-im 并接入钉钉机器人。', {
      installCommand: dshim.installCommand,
    });
  } else {
    const bots = await readDingtalkBots().catch(() => []);
    events.record('info', `已检测到 dsh-im ${dshim.version ?? ''}`.trim(), {
      bots: bots.length,
      callbackPatched: bridge.patched(),
    });
    if (bots.length === 0) events.record('warn', 'dsh-im 已安装，但还没有配置钉钉机器人。');
    if (!bridge.patched()) {
      events.record('warn', '未能挂接 dsh-im 的钉钉 Stream 回调，请重启 DSH 后再试。');
    }
  }
}
