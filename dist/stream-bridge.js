import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
    if (shared.names[userId] === name)
        return;
    shared.names[userId] = name;
    try {
        mkdirSync(dirname(USER_NAMES_PATH), { recursive: true });
        let existing = {};
        try {
            existing = JSON.parse(readFileSync(USER_NAMES_PATH, 'utf8').replace(/^\uFEFF/, ''));
        }
        catch {
            existing = {};
        }
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            existing[userId] = name;
        }
        else {
            existing = { [userId]: name };
        }
        writeFileSync(USER_NAMES_PATH, JSON.stringify(existing), 'utf8');
    }
    catch { /* ignore */ }
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
    }
    catch (bareError) {
        // DSH 启动插件时并不总是注入 DSH_PROFILE_DIR/DSH_HOME；缺失时回退到
        // 最常见的 `~/.dsh/profiles/<profile>`，避免插件在 --link 开发模式下
        // 因无法解析 profile 的 node_modules 而挂接失败（表现为“回调通道未连接”）。
        const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(os.homedir(), '.dsh');
        const currentProfile = process.env.DSH_PROFILE ?? 'desktop';
        const candidates = [];
        const push = (dir) => {
            if (!dir)
                return;
            const abs = resolve(dir);
            if (!candidates.includes(abs))
                candidates.push(abs);
        };
        push(process.env.DSH_PROFILE_DIR);
        push(join(home, 'profiles', currentProfile));
        // 网页环境（web profile）通常只装了 web bundle、没有 dsh-im / dingtalk-stream：
        // 扫描其它 profile（如 desktop）复用已安装的实例，避免挂接失败。
        try {
            const profilesRoot = join(home, 'profiles');
            for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
                if (entry.isDirectory())
                    push(join(profilesRoot, entry.name));
            }
        }
        catch { /* profiles 目录不存在时忽略 */ }
        for (const profileDir of candidates) {
            try {
                const require = createRequire(join(profileDir, 'package.json'));
                const packageJsonPath = require.resolve('dingtalk-stream/package.json');
                const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
                const entry = manifest.module
                    ?? manifest.exports?.['.']?.import
                    ?? manifest.main
                    ?? 'dist/index.mjs';
                return await import(pathToFileURL(join(dirname(packageJsonPath), entry)).href);
            }
            catch { /* 该 profile 没有 dingtalk-stream，试下一个 */ }
        }
        throw bareError;
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
    if (shared.patched)
        return api();
    let DWClient;
    try {
        ({ DWClient } = await loadDingtalkStream());
    }
    catch (error) {
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
    /** 解析 Stream 回调消息的 data（字符串 JSON 或对象）。 */
    function parsePayload(message) {
        try {
            return typeof message?.data === 'string' ? JSON.parse(message.data) : message?.data;
        }
        catch {
            return null;
        }
    }
    /** 把回调数据分发给插件内部监听器。 */
    function emitToListeners(data, meta, label) {
        for (const listener of shared.listeners) {
            try {
                const result = listener(data, meta);
                if (result && typeof result.catch === 'function') {
                    result.catch((error) => logger.warn?.(`[dsh-ding-card] ${label} handler failed:`, error?.message ?? error));
                }
            }
            catch (error) {
                logger.warn?.(`[dsh-ding-card] ${label} listener failed:`, error?.message ?? error);
            }
        }
    }
    /**
     * 在一个 DWClient 实例上挂接卡片/吊顶/入站消息监听。
     *
     * dsh-im 先 `registerCallbackListener(topic, cb)` 再 `connect()`（已从其
     * 打包代码确认），因此无论插件在 register 之前还是 connect 之前完成 patch，
     * 都能在同一实例上补挂 emitter 监听：钉钉消息到达时 SDK 会按 topic emit，
     * dsh-im 与插件各自的监听器并行运行。
     */
    function attachClient(client) {
        if (!client || typeof client.on !== 'function' || client.__dshDingCardHooked)
            return false;
        client.__dshDingCardHooked = true;
        shared.clients.set(client, {
            clientId: typeof client?.config?.clientId === 'string' ? client.config.clientId : null,
            since: new Date().toISOString(),
        });
        const metaOf = (message, extra) => ({
            clientId: client?.config?.clientId ?? null,
            messageId: message?.headers?.messageId ?? null,
            source: 'stream',
            ...extra,
        });
        // 卡片回调（按需点按钮后的回传）
        try {
            client.on(CARD_CALLBACK_TOPIC, (message) => {
                const data = parsePayload(message);
                if (!data || typeof data !== 'object')
                    return;
                emitToListeners(data, metaOf(message), 'card callback');
            });
        }
        catch (error) {
            logger.warn?.('[dsh-ding-card] failed to attach the card callback listener', error?.message ?? error);
        }
        // 吊顶卡回调候选 topic：dsh-im 不订阅，由插件补注册并监听
        for (const ceilTopic of CEILING_CALLBACK_TOPICS) {
            try {
                original.call(client, ceilTopic, () => ({ statusCode: 200, body: '{}' }));
            }
            catch { /* 未知 topic 钉钉会忽略，无副作用 */ }
            try {
                client.on(ceilTopic, (message) => {
                    const data = parsePayload(message);
                    if (!data || typeof data !== 'object')
                        return;
                    emitToListeners(data, metaOf(message, { topic: ceilTopic }), 'ceiling callback');
                });
            }
            catch { /* ignore */ }
        }
        // 入站消息：记录 senderNick 供界面显示昵称
        try {
            const robotTopic = '/v1.0/im/bot/messages/get';
            client.on(robotTopic, (message) => {
                const data = parsePayload(message);
                if (!data || typeof data !== 'object')
                    return;
                const userId = data?.senderStaffId ?? data?.senderId ?? data?.userId ?? null;
                const name = data?.senderNick ?? data?.senderName ?? null;
                if (typeof userId === 'string' && userId.trim() && typeof name === 'string' && name.trim()) {
                    recordUserName(shared, userId.trim(), name.trim());
                }
            });
        }
        catch { /* ignore */ }
        return true;
    }
    prototype.registerCallbackListener = function registerCallbackListener(topic, callback) {
        const result = original.call(this, topic, callback);
        try {
            attachClient(this);
        }
        catch (error) {
            logger.warn?.('[dsh-ding-card] failed to attach the card callback listener', error?.message ?? error);
        }
        return result;
    };
    // 连接建立时补挂：覆盖“插件在 dsh-im 已注册回调、尚未 connect 的窗口内加载”
    // 以及 dsh-im 重启/重建连接的情况，不必重启 DSH。
    const originalConnect = prototype.connect;
    if (typeof originalConnect === 'function' && !prototype.__dshDingCardConnectPatched) {
        prototype.connect = function connect(...args) {
            try {
                attachClient(this);
            }
            catch (error) {
                logger.warn?.('[dsh-ding-card] failed to attach listeners on connect', error?.message ?? error);
            }
            return originalConnect.apply(this, args);
        };
        prototype.__dshDingCardConnectPatched = true;
    }
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
                    if (!connected)
                        continue;
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
                    // 已 patch 但始终没有观察到任何 client：说明 dsh-im 的连接在插件加载前
                    // 就已建立（实例不可达），需要重启 DSH 或等 dsh-im 重建连接后才能挂接。
                    hookPending: shared.patched && seen === 0,
                    seenClients: seen,
                };
            },
        });
    }
}
