import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CARD_CALLBACK_TOPIC, installStreamBridge } from '../dist/stream-bridge.js';

const STATE_KEY = Symbol.for('dsh-ding-card.stream-bridge');

/**
 * 在临时 profile 里放一个假的 dingtalk-stream 包。
 * DWClient 复刻真实 SDK 的关键语义：
 *  - on(topic, cb) 追加监听（EventEmitter 语义，不是覆盖）
 *  - onCallback(message) 是 prototype 方法，按 topic 分发给所有监听
 */
function writeFakeStream(profileRoot) {
  const pkgDir = join(profileRoot, 'node_modules', 'dingtalk-stream');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: 'dingtalk-stream',
    version: '1.0.0',
    module: './index.mjs',
    exports: { '.': { import: './index.mjs' }, './package.json': './package.json' },
  }), 'utf8');
  writeFileSync(join(pkgDir, 'index.mjs'), [
    'export class DWClient {',
    '  constructor(config){ this.config = config ?? {}; this.handlers = new Map(); this.connected = true; this.socket = { readyState: 1 }; }',
    '  on(topic, handler){ const list = this.handlers.get(topic) ?? []; list.push(handler); this.handlers.set(topic, list); return this; }',
    '  registerCallbackListener(topic, callback){ this.on(topic, callback); return this; }',
    '  connect(){ this.connected = true; return Promise.resolve(); }',
    '  onCallback(message){ for (const handler of this.handlers.get(message.headers.topic) ?? []) handler(message); }',
    '}',
    '',
  ].join('\n'), 'utf8');
  return join(pkgDir, 'index.mjs');
}

function resetBridgeState() {
  delete globalThis[STATE_KEY];
}

async function runWith(home, profile, fn) {
  const prev = { DSH_HOME: process.env.DSH_HOME, DSH_PROFILE: process.env.DSH_PROFILE, DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR };
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = profile;
  delete process.env.DSH_PROFILE_DIR;
  resetBridgeState();
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const quietLogger = { warn() {}, info() {} };

test('dsh-im 先建连、插件后加载：旧实例的回调照样能收到（不用重启）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-hot-'));
  try {
    const entry = writeFakeStream(join(home, 'profiles', 'desktop'));
    const { DWClient } = await import(pathToFileURL(entry).href);

    // 模拟 dsh-im 在插件加载之前完成的一切：注册回调 + 建连
    const client = new DWClient({ clientId: 'ding-aaa' });
    client.registerCallbackListener(CARD_CALLBACK_TOPIC, () => ({ statusCode: 200, body: '{}' }));
    await client.connect();

    await runWith(home, 'desktop', async () => {
      const bridge = await installStreamBridge({ logger: quietLogger });
      assert.equal(bridge.patched(), true);

      const received = [];
      const off = bridge.onCardCallback((data, meta) => received.push({ data, meta }));
      const message = {
        headers: { topic: CARD_CALLBACK_TOPIC, messageId: 'm-1' },
        data: JSON.stringify({ outTrackId: 'track-1', userId: 'user-1' }),
      };
      client.onCallback(message);
      assert.equal(received.length, 1, '插件加载前建立的连接也应收到回调');
      assert.equal(received[0].meta.clientId, 'ding-aaa');
      assert.equal(received[0].meta.messageId, 'm-1');
      assert.equal(received[0].data.outTrackId, 'track-1');

      const status = bridge.status();
      assert.equal(status.seenClients, 1, '应在 prototype 钩子里记录到 client 实例');
      assert.equal(status.clients[0].connected, true);
      assert.equal(status.hookPending, false, '不再需要重启即可挂接');

      // 同一条消息经 prototype 钩子 + 实例监听器只分发一次
      client.onCallback(message);
      assert.equal(received.length, 1, '同一 message 只分发一次');

      // 钉钉重推：新对象、同 messageId，也要按 messageId 去重
      const redelivered = {
        headers: { topic: CARD_CALLBACK_TOPIC, messageId: 'm-1' },
        data: message.data,
      };
      client.onCallback(redelivered);
      assert.equal(received.length, 1, '同 messageId 的重推只分发一次');

      off();
      bridge.dispose();
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dingtalk-stream 后到：首轮未挂接并开启自动重试，装好后再次初始化即挂接', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-late-'));
  try {
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
    await runWith(home, 'desktop', async () => {
      const first = await installStreamBridge({ logger: quietLogger });
      assert.equal(first.patched(), false);
      assert.equal(first.error()?.code, 'dingtalk-stream-unavailable');
      assert.equal(first.status().autoRetry, true, '未挂接时应保留自动重试');
      first.dispose();
    });

    // 用户随后装好 dsh-im（带着 dingtalk-stream）
    writeFakeStream(join(home, 'profiles', 'desktop'));
    await runWith(home, 'desktop', async () => {
      const second = await installStreamBridge({ logger: quietLogger });
      assert.equal(second.patched(), true);
      assert.equal(second.error(), null);
      assert.equal(second.status().autoRetry, false, '挂接成功后应停止重试');
      second.dispose();
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
