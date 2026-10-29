import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { CARD_CALLBACK_TOPIC, installStreamBridge } from '../lib/stream-bridge.js';

// 探测 dsh-im / dingtalk-stream 所在的 DSH profile：
// 优先取环境变量，缺省时回退到用户默认安装位置（~/.dsh/profiles/desktop）。
// 该测试的目的是验证 patch 作用在 dsh-im 实际加载的 DWClient 原型上，
// 因此必须使用真实的 dingtalk-stream；找不到 profile 时跳过而非失败。
const candidates = [
  process.env.DSH_PROFILE_DIR,
  process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop') : null,
  join(homedir(), '.dsh', 'profiles', 'desktop'),
].filter(Boolean);
const profileDir = candidates.find((dir) => existsSync(join(dir, 'package.json')));
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
