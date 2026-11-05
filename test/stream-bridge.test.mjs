import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { CARD_CALLBACK_TOPIC, installStreamBridge } from '../dist/stream-bridge.js';

// 探测 dsh-im / dingtalk-stream 所在的 DSH profile：
// 优先取环境变量，缺省时回退到用户默认安装位置，并扫描所有 profile
//（如 dsh-im 装在 web profile 而 desktop 未装）。
// 该测试的目的是验证 patch 作用在 dsh-im 实际加载的 DWClient 原型上，
// 因此必须使用真实的 dingtalk-stream；找不到 profile 时跳过而非失败。
const profilesRoot = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'profiles')
  : join(homedir(), '.dsh', 'profiles');
const scanned = [];
try {
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) scanned.push(join(profilesRoot, entry.name));
  }
} catch { /* profiles 目录不存在 */ }
const candidates = [
  process.env.DSH_PROFILE_DIR,
  process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop') : null,
  join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop'),
  ...scanned,
].filter(Boolean);
const profileDir = candidates.find((dir) => existsSync(join(dir, 'package.json')) && hasStream(dir));

function hasStream(dir) {
  try {
    createRequire(join(dir, 'package.json')).resolve('dingtalk-stream/package.json');
    return true;
  } catch {
    return false;
  }
}
if (profileDir) process.env.DSH_PROFILE_DIR = profileDir;

async function loadDingtalkStream() {
  const require = createRequire(join(profileDir, 'package.json'));
  const packageJsonPath = require.resolve('dingtalk-stream/package.json');
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const entry = manifest.module ?? manifest.exports?.['.']?.import ?? manifest.main;
  return import(pathToFileURL(join(dirname(packageJsonPath), entry)).href);
}

test('bridge patches the exact DWClient prototype dsh-im uses', async (t) => {
  if (!profileDir) {
    t.skip('未找到 DSH profile（DSH_PROFILE_DIR / DSH_HOME 未设置，默认位置 ~/.dsh/profiles/desktop 不存在），无法加载真实 dingtalk-stream');
    return;
  }
  const bridge = await installStreamBridge({ logger: { warn() {}, info() {} } });
  assert.equal(bridge.patched(), true);
  const { DWClient } = await loadDingtalkStream();
  assert.equal(DWClient.prototype.__dshDingCardPatched, true);

  const calls = [];
  const client = new DWClient({ clientId: 'ding-test', clientSecret: 'secret' });
  client.connected = true; // status() 只统计已连接的 client，测试实例不真正建连
  client.registerCallbackListener(CARD_CALLBACK_TOPIC, () => calls.push('dsh-im'));
  assert.equal(bridge.status().clients.length, 1);
  assert.equal(bridge.status().clients[0].clientId, 'ding-test');

  client.emit(CARD_CALLBACK_TOPIC, {
    headers: { messageId: 'message-1' },
    data: JSON.stringify({ outTrackId: 'unknown' }),
  });
  assert.deepEqual(calls, ['dsh-im']);
});

test('bridge patches connect so a client is attached even without a card-topic register', async (t) => {
  if (!profileDir) {
    t.skip('未找到 DSH profile，无法加载真实 dingtalk-stream');
    return;
  }
  const bridge = await installStreamBridge({ logger: { warn() {}, info() {} } });
  const { DWClient } = await loadDingtalkStream();
  // connect 补挂：插件在 dsh-im 注册回调之后、建立连接之前加载时，仍能挂上监听。
  assert.equal(DWClient.prototype.__dshDingCardConnectPatched, true);
  assert.equal(typeof DWClient.prototype.connect, 'function');

  // 不注册任何回调 topic，只走 connect：应同样登记到 shared.clients（补挂生效）。
  const client = new DWClient({ clientId: 'ding-connect-only', clientSecret: 'secret' });
  client.connected = true;
  try { await client.connect(); } catch { /* 无效凭据会立即失败，不影响挂接断言 */ }
  const status = bridge.status();
  assert.ok(
    status.clients.some((entry) => entry.clientId === 'ding-connect-only'),
    `connect 后应登记 client，实际：${JSON.stringify(status.clients)}`,
  );
  try { await client.disconnect?.(); } catch { /* ignore */ }
});

test('status reports hookPending while patched but no client observed', async (t) => {
  if (!profileDir) {
    t.skip('未找到 DSH profile，无法加载真实 dingtalk-stream');
    return;
  }
  const bridge = await installStreamBridge({ logger: { warn() {}, info() {} } });
  const streamState = globalThis[Symbol.for('dsh-ding-card.stream-bridge')];
  const saved = new Map(streamState.clients);
  streamState.clients.clear();
  try {
    const status = bridge.status();
    assert.equal(status.patched, true);
    assert.equal(status.seenClients, 0);
    assert.equal(status.hookPending, true);
  } finally {
    for (const [client, meta] of saved) streamState.clients.set(client, meta);
  }
});
