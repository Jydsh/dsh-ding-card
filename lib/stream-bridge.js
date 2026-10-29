import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STATE_KEY = Symbol.for('dsh-ding-card.stream-bridge');

export const CARD_CALLBACK_TOPIC = '/v1.0/card/instances/callback';
// 吊顶卡片（/v2.0/im/topBoxes 创建）的回传实测不走 /v1.0/card/instances/callback，
// 可能是独立的回调路径。全部订阅候选 topic 并分发到同一批回调监听器，定位真实通道。
const CEILING_CALLBACK_TOPICS = [
  '/v1.0/im/topBoxes/callback',
  '/v2.0/im/topBoxes/callback',
  '/v1.0/card/tops/callback',
];
const INBOUND_MSG_MARK = 'messages/get';
const USER_NAMES_PATH = join(os.homedir(), '.dsh', 'integrations', 'dsh-ding-card', 'user_names.json');

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
    // DSH 启动插件时并不总是注入 DSH_PROFILE_DIR/DSH_HOME；缺失时回退到
    // 最常见的 `~/.dsh/profiles/<profile>`，避免插件在 --link 开发模式下
    // 因无法解析 profile 的 node_modules 而挂接失败（表现为“回调通道未连接”）。
    const profileDir = process.env.DSH_PROFILE_DIR
      ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop') : null)
      ?? join(os.homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop');
    if (!profileDir) throw bareError;
    const require = createRequire(join(profileDir, 'package.json'));
    const packageJsonPath = require.resolve('dingtalk-stream/package.json');
    const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const entry = manifest.module
      ?? manifest.exports?.['.']?.import
      ?? manifest.main
      ?? 'dist/index.mjs';
    return import(pathToFileURL(join(dirname(packageJsonPath), entry)).href);
  }
}

/**
 * dsh-im owns the only DingTalk Stream connection for a bot: DingTalk delivers
 * each event to a single consumer, so a second connection would steal messages.
 * We therefore attach an extra EventEmitter listener on the very same client
 * dsh-im registers, instead of opening our own. dsh-im acknowledges the
 * callback and ignores unknown outTrackIds; both listeners run.
 */
export async function installStreamBridge({ logger = console } = {}) {
  const shared = state();
  if (shared.patched) return api();
  let DWClient;
  try {
    ({ DWClient } = await loadDingtalkStream());
  } catch (error) {
    shared.error = {
      code: 'dingtalk-stream-unavailable',
      message: '未安装 dingtalk-stream，无法接收卡片回调。dsh-im 安装后会自动带出该依赖。',
    };
    logger.warn?.('[dsh-ding-card] dingtalk-stream is unavailable:', error?.message ?? error);
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
  prototype.registerCallbackListener = function registerCallbackListener(topic, callback) {
    const result = original.call(this, topic, callback);
    try {
      if (topic === CARD_CALLBACK_TOPIC && !this.__dshDingCardHooked) {
        this.__dshDingCardHooked = true;
        shared.clients.set(this, {
          clientId: typeof this?.config?.clientId === 'string' ? this.config.clientId : null,
          since: new Date().toISOString(),
        });
        this.on(CARD_CALLBACK_TOPIC, (message) => {
          let data;
          try {
            data = typeof message?.data === 'string' ? JSON.parse(message.data) : message?.data;
          } catch {
            return;
          }
          if (!data || typeof data !== 'object') return;
          const meta = {
            clientId: this?.config?.clientId ?? null,
            messageId: message?.headers?.messageId ?? null,
            source: 'stream',
          };
          for (const listener of shared.listeners) {
            try {
              const result = listener(data, meta);
              if (result && typeof result.catch === 'function') {
                result.catch((error) => logger.warn?.('[dsh-ding-card] card callback handler failed:', error?.message ?? error));
              }
            } catch (error) {
              logger.warn?.('[dsh-ding-card] card callback listener failed:', error?.message ?? error);
            }
          }
        });
      }
      if (typeof topic === 'string' && CEILING_CALLBACK_TOPICS.includes(topic) && !this.__dshDingCardHookedCeiling) {
        this.__dshDingCardHookedCeiling = true;
        for (const ceilTopic of CEILING_CALLBACK_TOPICS) {
          try {
            original.call(this, ceilTopic, () => ({ statusCode: 200, body: '{}' }));
          } catch { /* 未知 topic 钉钉会忽略，无副作用 */ }
          this.on(ceilTopic, (message) => {
            let data;
            try {
              data = typeof message?.data === 'string' ? JSON.parse(message.data) : message?.data;
            } catch {
              return;
            }
            if (!data || typeof data !== 'object') return;
            const meta = {
              clientId: this?.config?.clientId ?? null,
              messageId: message?.headers?.messageId ?? null,
              source: 'stream',
              topic: ceilTopic,
            };
            for (const listener of shared.listeners) {
              try {
                const result = listener(data, meta);
                if (result && typeof result.catch === 'function') {
                  result.catch((error) => logger.warn?.('[dsh-ding-card] ceiling callback handler failed:', error?.message ?? error));
                }
              } catch (error) {
                logger.warn?.('[dsh-ding-card] ceiling callback listener failed:', error?.message ?? error);
              }
            }
          });
        }
      }
      if (typeof topic === 'string' && topic !== CARD_CALLBACK_TOPIC && topic.includes(INBOUND_MSG_MARK) && !this.__dshDingCardHookedMsg) {
        this.__dshDingCardHookedMsg = true;
        this.on(topic, (message) => {
          let data;
          try {
            data = typeof message?.data === 'string' ? JSON.parse(message.data) : message?.data;
          } catch {
            return;
          }
          if (!data || typeof data !== 'object') return;
          const userId = data?.senderStaffId ?? data?.senderId ?? data?.userId ?? null;
          const name = data?.senderNick ?? data?.senderName ?? null;
          if (typeof userId === 'string' && userId.trim() && typeof name === 'string' && name.trim()) {
            recordUserName(shared, userId.trim(), name.trim());
          }
        });
      }
    } catch (error) {
      logger.warn?.('[dsh-ding-card] failed to attach the card callback listener', error?.message ?? error);
    }
    return result;
  };
  prototype.__dshDingCardPatched = true;
  shared.patched = true;
  shared.error = null;
  return api();

  function api() {
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
        return {
          patched: shared.patched,
          error: shared.error,
          connected: clients.length > 0,
          clients,
        };
      },
    });
  }
}
