import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCardService } from './cards.js';
import { createDingTalkApi } from './dingtalk.js';
import { currentProfileName, inspectDshIm, isLinkedToSource, profileDataDir, readDingtalkBots } from './dshim.js';
import { installInteractions } from './interactions.js';
import { createEventLog } from './log.js';
import { createRouteResolver } from './routing.js';
import { installRpc, type DshCtx } from './rpc.js';
import { CardConfigStore } from './store.js';
import { installStreamBridge } from './stream-bridge.js';
import { installCardTools } from './tools.js';
import { checkLatestVersion, getCurrentVersion, isAtLeast } from './updater.js';

export const name = 'dsh-ding-card';
export const inject = ['connection', 'credentials'];

/** 自动更新尝试记录（同一版本只自动尝试一次，失败留给用户一键更新重试）。 */
function autoUpdateStatePath(): string {
  return join(profileDataDir(), 'update_state.json');
}

async function readAutoUpdateVersion(): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(autoUpdateStatePath(), 'utf8'));
    return typeof raw?.autoUpdateVersion === 'string' ? raw.autoUpdateVersion : null;
  } catch {
    return null;
  }
}

async function writeAutoUpdateVersion(version: string): Promise<void> {
  try {
    const path = autoUpdateStatePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ autoUpdateVersion: version, attemptedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch { /* 记录失败不影响更新本身 */ }
}

/** DSH 日志器（宽松类型）。 */
export interface DshLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/** DSH 运行时上下文（宽松类型：DSH API 未提供完整类型定义）。 */
export interface DshContext extends DshCtx {
  logger?: DshLogger | ((scope: string) => DshLogger);
  effect?: (dispose: () => void, label: string) => unknown;
  provide?: (key: string, value: unknown) => unknown;
  [key: string]: unknown;
}

/** apply 配置参数。 */
export interface ApplyConfig {
  configPath?: string;
  [key: string]: unknown;
}

function makeLogger(ctx: DshContext): DshLogger {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger('dsh-ding-card') : ctx?.logger;
  const safe: DshLogger = logger && typeof logger === 'object' ? logger : console;
  return {
    info: (...args: unknown[]) => safe.info?.(...args),
    warn: (...args: unknown[]) => safe.warn?.(...args),
    error: (...args: unknown[]) => safe.error?.(...args),
    debug: (...args: unknown[]) => safe.debug?.(...args),
  };
}

/**
 * dsh-ding-card: turns DSH human interactions into DingTalk AI cards.
 *
 * The plugin reuses the DingTalk application that dsh-im already stores and
 * attaches to dsh-im's existing Stream connection, so no second connection is
 * opened and no bot credentials are duplicated.
 */
export async function apply(ctx: DshContext, config: ApplyConfig = {}): Promise<void> {
  const logger = makeLogger(ctx);
  // .js 模块的 logger 参数推断为 Console（来自默认值），做一次类型适配。
  const loggerArg = logger as unknown as Console;
  const store = new CardConfigStore(config.configPath);
  try {
    await store.load();
  } catch (error) {
    logger.error?.('[dsh-ding-card] failed to load config, using defaults:', (error as Error)?.message ?? error);
  }
  const events = createEventLog(logger);
  const bridge = await installStreamBridge({ logger: loggerArg }) as Record<string, any>;
  const api = createDingTalkApi({ logger: loggerArg });
  const cards = createCardService({ api, store, bridge, events, logger: loggerArg }) as Record<string, any>;
  const interactions = installInteractions(ctx, { store, cards, events, logger: loggerArg });
  const resolveTarget = createRouteResolver(ctx, { store, events, logger: loggerArg });
  const tools = installCardTools(ctx, { store, cards, resolveTarget, events, logger: loggerArg });

  const updater = { current: getCurrentVersion, check: checkLatestVersion, isAtLeast };

  // 启动时检查一次版本；识别到新版本时首次自动更新（宿主提供插件管理服务且非本地开发链接）。
  (async () => {
    try {
      const current = getCurrentVersion();
      const latest = await checkLatestVersion();
      if (!current || !latest) return;
      if (isAtLeast(current, latest.version)) {
        logger.debug?.(`[dsh-ding-card] 版本检查通过：${current} 已是最新（来源：${latest.source}）`);
        return;
      }
      const profile = currentProfileName();
      events.record('info', `发现新版本 ${current} → ${latest.version}`, { source: latest.source });
      if (isLinkedToSource()) {
        logger.info?.(
          `[dsh-ding-card] 发现新版本 ${current} → ${latest.version}；当前为本地开发链接，未自动替换。`
          + '更新本地工作树后在侧边栏点击版本号即可完成安装。',
        );
        return;
      }
      const manager = typeof (ctx as Record<string, any>)?.get === 'function'
        ? (ctx as Record<string, any>).get('pluginManager')
        : undefined;
      if (!manager || typeof manager.installBundle !== 'function') {
        logger.info?.(
          `[dsh-ding-card] 发现新版本 ${current} → ${latest.version}；宿主未提供插件管理服务，`
          + `可执行 dsh plugin --profile ${profile} add github:Jydsh/dsh-ding-card#v${latest.version} 更新（覆盖安装，无需先卸载）。`,
        );
        return;
      }
      // 热更新模式下宿主拒绝对已装包直接覆盖，且自动卸载会打断启动流程：留给侧边栏的一键更新。
      if (typeof (ctx as Record<string, any>).get === 'function' && (ctx as Record<string, any>).get('hmr')) {
        logger.info?.(
          `[dsh-ding-card] 发现新版本 ${current} → ${latest.version}；当前为热更新模式，`
          + '请在侧边栏点击版本号一键更新（会先卸载再重装，由宿主热重组，无需重启）。',
        );
        return;
      }
      events.record('info', `发现新版本 ${current} → ${latest.version}，开始自动更新…`);
      // 同一版本只自动尝试一次；失败后由用户在侧边栏一键更新重试。
      if ((await readAutoUpdateVersion()) === latest.version) {
        logger.debug?.(`[dsh-ding-card] v${latest.version} 已自动尝试过更新，跳过；可在侧边栏点击版本号重试。`);
        return;
      }
      await writeAutoUpdateVersion(latest.version);
      const applied = await manager.installBundle(`github:Jydsh/dsh-ding-card#v${latest.version}`, { enabled: true });
      const application = String((applied as Record<string, any>)?.application ?? 'restart-required');
      if (application === 'applied') {
        events.record('info', `已自动更新到 v${latest.version}（宿主已热应用，无需重启）`);
        logger.info?.(`[dsh-ding-card] 已自动更新到 v${latest.version}，无需重启即已生效。`);
      } else {
        events.record('info', `已自动更新到 v${latest.version}，需重启 DSH 生效`);
        logger.info?.(`[dsh-ding-card] 已自动更新到 v${latest.version}，重启 DSH 后生效。`);
      }
    } catch { /* 版本检查/自动更新失败不影响启动 */ }
  })();

  const rpc = installRpc(ctx, { store, cards, api, events, logger, updater });
  try {
    rpc.install();
  } catch (error) {
    events.record('error', `管理接口注册失败：${(error as Error)?.message ?? error}`);
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
    events.record('warn', `当前环境（${dshim.profile} profile）未检测到 dsh-im，卡片无法投递；请先在该 profile 安装 dsh-im 并接入钉钉机器人。`, {
      installCommand: dshim.installCommand,
    });
  } else {
    const bots = await readDingtalkBots().catch(() => []);
    events.record('info', `已检测到 dsh-im ${dshim.version ?? ''}（${dshim.profile} profile）`.trim(), {
      bots: bots.length,
      callbackPatched: bridge.patched(),
    });
    if (bots.length === 0) events.record('warn', 'dsh-im 已安装，但还没有配置钉钉机器人。');
    if (!bridge.patched()) {
      events.record('warn', '尚未挂接钉钉 Stream 回调：当前环境还看不到 dingtalk-stream。装好 dsh-im 后插件会自动重试挂接，无需重启 DSH。');
    } else {
      // 回调通道自检：钩子挂在 SDK 的 CALLBACK 分发点（DWClient.prototype.onCallback），
      // 因此 dsh-im 的连接即使先于插件建立也能收到后续回调，不必重启。
      const timer = setTimeout(() => {
        try {
          const stream = bridge.status();
          if (!stream?.seenClients) {
            const message = '回调通道已挂在钉钉 SDK 的分发点，还没有收到过回调；'
              + '发一张测试卡片并点击按钮即可确认通道可用（无需重启 DSH）。';
            events.record('info', message);
            logger.info?.(`[dsh-ding-card] ${message}`);
          } else {
            events.record('info', `回调通道已挂接（${stream.clients?.length ?? 0} 个连接就绪）`);
          }
        } catch { /* 自检失败忽略 */ }
      }, 15000);
      timer.unref?.();
    }
  }
}
