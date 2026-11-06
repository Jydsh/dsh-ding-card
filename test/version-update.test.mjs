import test from 'node:test';
import assert from 'node:assert/strict';
import { installRpc } from '../dist/rpc.js';

/** 构造最小宿主上下文：只注册管理通道，pluginManager / hmr 由用例注入。 */
function makeHost({ manager, hmr } = {}) {
  const routes = [];
  const records = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(name) {
      if (name === 'pluginManager') return manager;
      if (name === 'hmr') return hmr;
      return undefined;
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
    },
  };
  const deps = {
    store: { get: () => ({ version: 2, cards: [], bot: {} }), path: 'memory://config', save: async (value) => value },
    cards: { status: () => ({ stream: {} }), pendingList: () => [] },
    api: {},
    events: { record: (...args) => records.push(args), list: () => [] },
    logger: ctx.logger,
    updater: {
      current: () => '2026.11.05',
      check: async () => ({ version: '2026.11.06', source: 'release' }),
      isAtLeast: (current, latest) => String(current) >= String(latest),
    },
  };
  const rpc = installRpc(ctx, deps);
  rpc.install();
  const route = routes[0];
  const call = async (method, payload = {}) => {
    const response = await route.fetch(new Request('http://127.0.0.1/api/dsh-ding-card', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'dsh-ding-card', payload: { method, payload } }),
    }));
    return (await response.json()).result;
  };
  return { call, records, rpc };
}

/** 每个用例固定在同一 profile 下运行，避免依赖本机真实 profile。 */
async function withProfile(profile, fn) {
  const prev = { DSH_HOME: process.env.DSH_HOME, DSH_PROFILE: process.env.DSH_PROFILE, DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR };
  process.env.DSH_HOME = process.env.DSH_HOME ?? 'C:\\nonexistent-dsh-home';
  process.env.DSH_PROFILE = profile;
  delete process.env.DSH_PROFILE_DIR;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('version.check 返回当前环境、覆盖安装命令与热更新能力', async () => {
  await withProfile('web', async () => {
    const host = makeHost({});
    const result = await host.call('version.check');
    assert.equal(result.ok, true);
    assert.equal(result.value.profile, 'web');
    assert.equal(result.value.latest, '2026.11.06');
    assert.equal(result.value.updateAvailable, true);
    assert.match(result.value.command, /dsh plugin --profile web add github:Jydsh\/dsh-ding-card#v2026\.11\.06/);
    assert.equal(result.value.hotReload, false);
  });
});

test('无 pluginManager 时退回手动命令，不尝试安装', async () => {
  await withProfile('desktop', async () => {
    const host = makeHost({});
    const result = await host.call('version.update');
    assert.equal(result.ok, true);
    assert.equal(result.value.manual, true);
    assert.equal(result.value.updated, false);
    assert.match(result.value.command, /--profile desktop add github:Jydsh\/dsh-ding-card#v2026\.11\.06/);
  });
});

test('宿主热应用（application=applied）时表示无需重启', async () => {
  await withProfile('desktop', async () => {
    const calls = [];
    const manager = {
      async installBundle(spec, options) {
        calls.push({ spec, options });
        return { application: 'applied', target: 'dsh-ding-card', version: '2026.11.06' };
      },
    };
    const host = makeHost({ manager });
    const result = await host.call('version.update');
    assert.equal(result.ok, true);
    assert.equal(result.value.updated, true);
    assert.equal(result.value.applied, true);
    assert.equal(result.value.requiresRestart, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].spec, 'github:Jydsh/dsh-ding-card#v2026.11.06');
    assert.deepEqual(calls[0].options, { enabled: true });
  });
});

test('宿主标记 restart-required 时返回重启提示与重启方式', async () => {
  await withProfile('desktop', async () => {
    const manager = {
      async installBundle() {
        return { application: 'restart-required', restartReason: 'no-hmr' };
      },
    };
    const host = makeHost({ manager });
    const result = await host.call('version.update');
    assert.equal(result.ok, true);
    assert.equal(result.value.updated, true);
    assert.equal(result.value.applied, false);
    assert.equal(result.value.requiresRestart, true);
    assert.equal(typeof result.value.restart?.kind, 'string');
    assert.match(result.value.message, /重启 DSH 后生效/);
  });
});

test('安装失败时把宿主错误码翻成中文原因', async () => {
  await withProfile('desktop', async () => {
    const manager = {
      async installBundle() {
        return { application: 'failed', error: { code: 'incompatible-version' } };
      },
    };
    const host = makeHost({ manager });
    const result = await host.call('version.update');
    assert.equal(result.ok, false);
    assert.match(result.error.message, /不兼容/);
  });
});

test('HMR 可用时改为“卸载后立即重装”，返回热更新排队状态', async () => {
  await withProfile('desktop', async () => {
    const calls = [];
    const manager = {
      async removeBundle(name) { calls.push(['remove', name]); },
      async installBundle(spec) { calls.push(['install', spec]); return { application: 'applied' }; },
    };
    const host = makeHost({ manager, hmr: {} });
    const check = await host.call('version.check');
    assert.equal(check.value.hotReload, true);
    const result = await host.call('version.update');
    assert.equal(result.ok, true);
    assert.equal(result.value.hotReload, true);
    assert.equal(result.value.queued, true);
    assert.equal(result.value.requiresRestart, false);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.deepEqual(calls[0], ['remove', 'dsh-ding-card']);
    assert.equal(calls[1][2] ?? calls[1][1], 'github:Jydsh/dsh-ding-card#v2026.11.06');
    host.rpc.dispose();
  });
});

test('version.restart 在没有 Electron app 的宿主上退回手动重启', async () => {
  await withProfile('web', async () => {
    const host = makeHost({});
    const result = await host.call('version.restart');
    assert.equal(result.ok, true);
    const value = result.value;
    assert.equal(typeof value.restarted, 'boolean');
    if (!value.restarted) {
      assert.equal(value.manual, true);
      assert.match(value.message, /手动重启/);
      assert.equal(typeof value.command === 'string' || value.command === null, true);
    }
  });
});
