import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installStreamBridge } from '../dist/stream-bridge.js';

const STATE_KEY = Symbol.for('dsh-ding-card.stream-bridge');

/** 在临时 profile 里放一个假的 dingtalk-stream 包（只有 profile 内有，仓库本身没有）。 */
function writeFakeStream(profileRoot, { broken = false } = {}) {
  const pkgDir = join(profileRoot, 'node_modules', 'dingtalk-stream');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: 'dingtalk-stream',
    version: '1.0.0',
    module: './index.mjs',
    exports: { '.': { import: './index.mjs' }, './package.json': './package.json' },
  }), 'utf8');
  writeFileSync(join(pkgDir, 'index.mjs'), broken
    // 缺 registerCallbackListener：一旦被误用，patch 会失败并暴露成 dingtalk-stream-invalid
    ? 'export class DWClient { constructor(){ this.config = {}; } connect(){ return Promise.resolve(); } }\n'
    : [
      'export class DWClient {',
      '  constructor(config){ this.config = config ?? {}; this.handlers = new Map(); }',
      '  on(topic, handler){ this.handlers.set(topic, handler); }',
      '  connect(){ return Promise.resolve(); }',
      '  registerCallbackListener(){ return { statusCode: 200 }; }',
      '}',
      '',
    ].join('\n'), 'utf8');
}

function resetBridgeState() {
  delete globalThis[STATE_KEY];
}

/** 在临时 DSH_HOME 下执行，结束后恢复环境变量。 */
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

test('当前 profile 没有 dingtalk-stream 时不借用 desktop 的副本（底层隔离）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-iso-'));
  try {
    writeFakeStream(join(home, 'profiles', 'desktop'));
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
    await runWith(home, 'web', async () => {
      const bridge = await installStreamBridge({ logger: { warn() {}, info() {} } });
      assert.equal(bridge.patched(), false, 'web 未装 dingtalk-stream 时不应借用 desktop 的实例');
      assert.equal(bridge.error()?.code, 'dingtalk-stream-unavailable');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('当前 profile 有 dingtalk-stream 时使用自己的副本', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-iso-'));
  try {
    writeFakeStream(join(home, 'profiles', 'desktop'), { broken: true });
    writeFakeStream(join(home, 'profiles', 'web'));
    await runWith(home, 'web', async () => {
      const bridge = await installStreamBridge({ logger: { warn() {}, info() {} } });
      assert.equal(bridge.patched(), true);
      assert.equal(bridge.error(), null);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
