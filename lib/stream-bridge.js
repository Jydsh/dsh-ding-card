import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { profileDataDir, profileDir } from './dshim.js';

const STATE_KEY = Symbol.for('dsh-ding-card.stream-bridge');

export const CARD_CALLBACK_TOPIC = '/v1.0/card/instances/callback';
// 吊顶卡片（/v2.0/im/topBoxes 创建）的回传实测不走 /v1.0/card/instances/callback，
// 可能是独立的回调路径。全部订阅候选 topic 并分发到同一批回调监听器，定位真实通道。
const CEILING_CALLBACK_TOPICS = [
  '/v1.0/im/topBoxes/callback',
  '/v2.0/im/topBoxes/callback',
  '/v1.0/card/tops/callback',
];
const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';
const WATCHED_TOPICS = new Set([CARD_CALLBACK_TOPIC, ...CEILING_CALLBACK_TOPICS, ROBOT_TOPIC]);
const RETRY_INTERVAL_MS = 10_000;
const RETRY_INTERVAL_SLOW_MS = 60_000;
const RETRY_FAST_ATTEMPTS = 30;
const USER_NAMES_PATH = join(profileDataDir(), 'user_names.json');

/**
 * Capture a senderNick from an inbound DingTalk stream message and persist it
 * so the management UI can show a friendly user name next to a "single chat"
 * entry. DingTalk contact APIs need application permissions this plugin does
 * not have, so the sender name dsh-im already carries on every inbound message
 * is the reliable source.
 */
function recordUserName(shared, userId, name) {
  if (shared.names[userId] === name) return;
  shared.names[userId] = name;
  try {
    mkdirSync(dirname(USER_NAMES_PATH), { recursive: true });
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(USER_NAMES_PATH, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      existing = {};
    }
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      existing[userId] = name;
    } else {
      existing = { [userId]: name };
    }
    writeFileSync(USER_NAMES_PATH, JSON.stringify(existing), 'utf8');
  } catch { /* ignore */ }
}

function state() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = {
      patched: false,
      error: null,
      listeners: new Set(),
      clients: new Map(),
      module: null,
      names: {},
      seenIds: new Set(),
      seenOrder: [],
      timer: null,
      attempts: 0,
    };
  }
  return globalThis[STATE_KEY];
}

/**
 * Load the exact dingtalk-stream module instance dsh-im loads.
 *
 * A linked plugin lives outside the profile, so a bare specifier cannot see
 * the profile's node_modules. Resolve from the profile manifest and import the
 * ESM entry (`dist/index.mjs`), which is the same file URL dsh-im's dynamic
 * import resolves to, so the DWClient prototype we patch is the one in use.
 */
async function loadDingtalkStream() {
  try {
    return await import('dingtalk-stream');
  } catch (bareError) {
    // 严格按当前 profile 解析：网页端与桌面端各自安装 dingtalk-stream，
    // 不再借用其他 profile 的副本（底层依赖隔离）。
    const candidates = [];
    const push = (dir) => {
      if (!dir) return;
      const abs = resolve(dir);
      if (!candidates.includes(abs)) candidates.push(abs);
    };
    push(process.env.DSH_PROFILE_DIR);
    push(profileDir());
    for (const dir of candidates) {
      try {
        const require = createRequire(join(dir, 'package.json'));
        const packageJsonPath = require.resolve('dingtalk-stream/package.json');
        const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
        const entry = manifest.module
          ?? manifest.exports?.['.']?.import
          ?? manifest.main
          ?? 'dist/index.mjs';
        return await import(pathToFileURL(join(dirname(packageJsonPath), entry)).href);
      } catch { /* 当前 profile 没有 dingtalk-stream */ }
    }
    throw bareError;
  }
}

/** 解析 Stream 回调消息的 data（字符串 JSON 或对象）。 */
function parsePayload(message) {
  try {
    return typeof message?.data === 'string' ? JSON.parse(message.data) : message?.data;
  } catch {
    return null;
  }
}

/** 把回调数据分发给插件内部监听器。 */
function emitToListeners(shared, logger, data, meta, label) {
  for (const listener of shared.listeners) {
    try {
      const result = listener(data, meta);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => logger.warn?.(`[dsh-ding-card] ${label} handler failed:`, error?.message ?? error));
      }
    } catch (error) {
      logger.warn?.(`[dsh-ding-card] ${label} listener failed:`, error?.message ?? error);
    }
  }
}

/** 记录一个 dsh-im 的 DWClient 实例（不需要实例引用即可从 prototype 钩子拿到）。 */
function observeClient(shared, client) {
  if (!client) return null;
  let meta = shared.clients.get(client);
  if (!meta) {
    meta = {
      clientId: typeof client?.config?.clientId === 'string' ? client.config.clientId : null,
      since: new Date().toISOString(),
    };
    shared.clients.set(client, meta);
  }
  return meta;
}

/**
 * 一条回调消息只处理一次：
 *  - 对象标记：prototype 钩子与实例监听器共用入口，同一条 message 对象只分发一次；
 *  - messageId 短期去重：钉钉重推 / 两条解析路径可能产生新对象但 messageId 相同。
 */
function markSeenMessage(shared, messageId) {
  if (!messageId) return true;
  if (shared.seenIds.has(messageId)) return false;
  shared.seenIds.add(messageId);
  shared.seenOrder.push(messageId);
  if (shared.seenOrder.length > 500) {
    const oldest = shared.seenOrder.shift();
    shared.seenIds.delete(oldest);
  }
  return true;
}

function dispatchCallback(shared, logger, client, message, label) {
  if (!message || typeof message !== 'object') return;
  if (message.__dshDingCardDispatched) return;
  message.__dshDingCardDispatched = true;
  if (!markSeenMessage(shared, message?.headers?.messageId)) return;
  const data = parsePayload(message);
  if (!data || typeof data !== 'object') return;
  const topic = message?.headers?.topic;
  if (topic === ROBOT_TOPIC) {
    const userId = data?.senderStaffId ?? data?.senderId ?? data?.userId ?? null;
    const name = data?.senderNick ?? data?.senderName ?? null;
    if (typeof userId === 'string' && userId.trim() && typeof name === 'string' && name.trim()) {
      recordUserName(shared, userId.trim(), name.trim());
    }
    return;
  }
  const meta = {
    clientId: client?.config?.clientId ?? null,
    messageId: message?.headers?.messageId ?? null,
    source: 'stream',
    ...(topic === CARD_CALLBACK_TOPIC ? {} : { topic }),
  };
  emitToListeners(shared, logger, data, meta, label);
}

function api() {
  const shared = state();
  return Object.freeze({
    patched: () => shared.patched,
    error: () => shared.error,
    onCardCallback(listener) {
      shared.listeners.add(listener);
      return () => shared.listeners.delete(listener);
    },
    userNames: () => ({ ...shared.names }),
    status() {
      const clients = [];
      for (const [client, meta] of shared.clients) {
        const connected = client?.connected === true || client?.socket?.readyState === 1;
        if (!connected) continue;
        clients.push({
          clientId: meta.clientId,
          connected,
          since: meta.since,
        });
      }
      const seen = shared.clients.size;
      return {
        patched: shared.patched,
        error: shared.error,
        connected: clients.length > 0,
        clients,
        // 回调通道走 DWClient.prototype.onCallback 钩子，patch 完成后即使实例
        // 早已建立（插件晚于 dsh-im 加载）也能收到回调，不再需要重启 DSH。
        hookPending: false,
        seenClients: seen,
        // 未挂接时后台仍在自动重试（等 dingtalk-stream 装好）。
        autoRetry: Boolean(shared.timer),
        attempts: shared.attempts,
      };
    },
    dispose() {
      if (shared.timer) clearInterval(shared.timer);
      shared.timer = null;
    },
  });
}

/**
 * dsh-im owns the only DingTalk Stream connection for a bot: DingTalk delivers
 * each event to a single consumer, so a second connection would steal messages.
 * We therefore hook the very same DWClient dsh-im uses, instead of opening our
 * own. dsh-im acknowledges the callback and ignores unknown outTrackIds; both
 * listeners run.
 *
 * 关键：钩子挂在 `DWClient.prototype.onCallback` 上（SDK 收到 CALLBACK 后就是
 * `this.emit(topic, message)`），所以**不需要持有 client 实例**——即使 dsh-im
 * 的连接在插件加载前就已建立，也能收到后续回调。
 */
async function ensurePatched(logger) {
  const shared = state();
  if (shared.patched) return api();
  let DWClient;
  try {
    ({ DWClient } = await loadDingtalkStream());
  } catch (error) {
    shared.error = {
      code: 'dingtalk-stream-unavailable',
      message: '尚未装好 dingtalk-stream（随 dsh-im 一起安装）。装好后会自动挂接，无需重启。',
    };
    logger.warn?.('[dsh-ding-card] dingtalk-stream is unavailable, will retry:', error?.message ?? error);
    return api();
  }
  if (!DWClient?.prototype) {
    shared.error = { code: 'dingtalk-stream-invalid', message: 'dingtalk-stream 未导出 DWClient。' };
    return api();
  }
  const prototype = DWClient.prototype;
  const original = prototype.registerCallbackListener;
  if (typeof original !== 'function') {
    shared.error = { code: 'dingtalk-stream-invalid', message: 'dingtalk-stream client 缺少 registerCallbackListener。' };
    return api();
  }

  /**
   * 在一个 DWClient 实例上补挂监听（同时把吊顶候选 topic 注册给钉钉）。
   * 由 prototype 钩子懒触发，所以实例在插件加载前就已存在也能补上。
   */
  function attachClient(client) {
    if (!client || typeof client.on !== 'function') return false;
    observeClient(shared, client);
    if (client.__dshDingCardHooked) return false;
    client.__dshDingCardHooked = true;
    for (const topic of WATCHED_TOPICS) {
      try {
        // 吊顶候选 topic dsh-im 不订阅，由插件补注册；卡片/机器人 topic 重复注册是幂等的。
        original.call(client, topic, () => ({ statusCode: 200, body: '{}' }));
      } catch { /* 未知 topic 钉钉会忽略，无副作用 */ }
      try {
        client.on(topic, (message) => {
          dispatchCallback(
            shared,
            logger,
            client,
            message,
            topic === CARD_CALLBACK_TOPIC ? 'card callback'
              : topic === ROBOT_TOPIC ? 'inbound message' : 'ceiling callback',
          );
        });
      } catch (error) {
        logger.warn?.('[dsh-ding-card] failed to attach a stream listener', error?.message ?? error);
      }
    }
    return true;
  }

  // 主通道：SDK 的 CALLBACK 分发点。挂在 prototype 上，历史实例同样生效。
  const originalOnCallback = prototype.onCallback;
  if (typeof originalOnCallback === 'function' && !prototype.__dshDingCardOnCallbackPatched) {
    prototype.onCallback = function onCallback(message) {
      try {
        const topic = message?.headers?.topic;
        if (typeof topic === 'string' && WATCHED_TOPICS.has(topic)) {
          observeClient(shared, this);
          // 首次收到回调时给这个（插件加载前就建好的）实例补挂监听与吊顶 topic 订阅。
          // 已挂过的实例由 __dshDingCardHooked 守卫跳过。
          try { attachClient(this); } catch { /* 补挂失败不影响本次分发 */ }
          dispatchCallback(
            shared,
            logger,
            this,
            message,
            topic === CARD_CALLBACK_TOPIC ? 'card callback'
              : topic === ROBOT_TOPIC ? 'inbound message' : 'ceiling callback',
          );
        }
      } catch (error) {
        logger.warn?.('[dsh-ding-card] stream callback hook failed', error?.message ?? error);
      }
      return originalOnCallback.apply(this, arguments);
    };
    prototype.__dshDingCardOnCallbackPatched = true;
  }

  prototype.registerCallbackListener = function registerCallbackListener(topic, callback) {
    const result = original.call(this, topic, callback);
    try {
      attachClient(this);
    } catch (error) {
      logger.warn?.('[dsh-ding-card] failed to attach the card callback listener', error?.message ?? error);
    }
    return result;
  };

  // 连接建立时补挂（给实例补订阅吊顶 topic）。
  const originalConnect = prototype.connect;
  if (typeof originalConnect === 'function' && !prototype.__dshDingCardConnectPatched) {
    prototype.connect = function connect(...args) {
      try {
        attachClient(this);
      } catch (error) {
        logger.warn?.('[dsh-ding-card] failed to attach listeners on connect', error?.message ?? error);
      }
      return originalConnect.apply(this, args);
    };
    prototype.__dshDingCardConnectPatched = true;
  }
  prototype.__dshDingCardPatched = true;
  shared.patched = true;
  shared.error = null;
  if (shared.timer) {
    clearInterval(shared.timer);
    shared.timer = null;
  }
  return api();
}

/**
 * 后台自愈：dingtalk-stream / dsh-im 可能在插件之后才装好，装好后自动挂接，
 * 不要求用户重启 DSH。挂接成功后停止轮询。
 */
function startAutoPatch(logger) {
  const shared = state();
  if (shared.patched) {
    if (shared.timer) clearInterval(shared.timer);
    shared.timer = null;
    return;
  }
  if (shared.timer) return;
  const tick = async () => {
    const current = state();
    if (current.patched) {
      if (current.timer) clearInterval(current.timer);
      current.timer = null;
      return;
    }
    current.attempts += 1;
    await ensurePatched(logger);
    if (state().patched && current.timer) {
      clearInterval(current.timer);
      current.timer = null;
    } else if (current.timer && current.attempts >= RETRY_FAST_ATTEMPTS) {
      // 长时间仍未装好：降频，避免一直空转。
      clearInterval(current.timer);
      const slow = setInterval(() => { void tick(); }, RETRY_INTERVAL_SLOW_MS);
      slow.unref?.();
      current.timer = slow;
    }
  };
  const timer = setInterval(() => { void tick(); }, RETRY_INTERVAL_MS);
  timer.unref?.();
  shared.timer = timer;
}

export async function installStreamBridge({ logger = console } = {}) {
  await ensurePatched(logger);
  startAutoPatch(logger);
  return api();
}
