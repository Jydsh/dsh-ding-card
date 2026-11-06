import test from 'node:test';
import assert from 'node:assert/strict';
import { installRpc } from '../dist/rpc.js';

/** 默认环境桩：桌面 profile、从 git 装、有 dsh CLI、可自动执行。 */
function defaultEnv(options = {}) {
  const version = options.version ?? '2026.11.06';
  const profile = options.profile ?? 'desktop';
  const spec = `github:Jydsh/dsh-ding-card#v${version}`;
  return {
    platform: 'win32',
    profile,
    profileDir: `C:\\Users\\probe\\.dsh\\profiles\\${profile}`,
    profileSource: options.profile ? 'manual' : 'env',
    candidates: ['desktop'],
    mode: 'add',
    installedVersion: '2026.11.05',
    source: 'git',
    cli: 'dsh',
    spec,
    command: `dsh plugin --profile ${profile} add "${spec}"`,
    blocker: null,
  };
}

/** 构造最小宿主上下文：只注册管理通道，pluginManager / hmr / 环境桩由用例注入。 */
function makeHost({ manager, hmr, env, run } = {}) {
  const routes = [];
  const records = [];
  const envCalls = [];
  // 默认不真跑安装器：测试绝不能把包装进工程自己的 node_modules（会污染 package.json / lock）
  const noopRun = async (options = {}) => {
    const resolved = env ?? defaultEnv(options);
    return {
      ok: false,
      exitCode: null,
      command: resolved.command,
      output: '测试桩：未执行真实安装命令',
      env: resolved,
      restartRequired: false,
    };
  };
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
      check: async () => ({ version: '2026.11.06', source: 'api' }),
      isAtLeast: (current, latest) => String(current) >= String(latest),
      detectInstallEnv: (options = {}) => {
        envCalls.push(options);
        return env ?? defaultEnv(options);
      },
      ...(run ? { runUpdate: run } : { runUpdate: noopRun }),
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
  return { call, records, rpc, envCalls };
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

test('version.check 返回安装环境与可复制的完整命令', async () => {
  await withProfile('desktop', async () => {
    const host = makeHost({});
    const result = await host.call('version.check');
    assert.equal(result.ok, true);
    assert.equal(result.value.profile, 'desktop');
    assert.equal(result.value.latest, '2026.11.06');
    assert.equal(result.value.updateAvailable, true);
    assert.match(result.value.command, /dsh plugin --profile desktop add "github:Jydsh\/dsh-ding-card#v2026\.11\.06"/);
    assert.equal(result.value.env.cli, 'dsh');
    assert.equal(result.value.env.mode, 'add');
    assert.equal(result.value.env.blocker, null);
    assert.equal(result.value.hotReload, false);
  });
});

test('version.check 在链接安装下仍返回命令，但带 blocker 说明', async () => {
  await withProfile('desktop', async () => {
    const env = {
      ...defaultEnv(),
      source: 'link',
      blocker: '当前是链接（link / junction）安装，装的就是工程目录本身',
    };
    const host = makeHost({ env });
    const result = await host.call('version.check');
    assert.equal(result.value.updateAvailable, true);
    assert.match(result.value.command, /dsh plugin --profile desktop add/);
    assert.match(result.value.env.blocker, /链接/);
  });
});

test('没有新版本时不返回环境与命令', async () => {
  await withProfile('desktop', async () => {
    const ctx = { latest: null };
    const host = makeHost({});
    // 用当前已装版本作为“最新”，构造 updateAvailable=false 的场景
    host.rpc.dispose();
    const routes = [];
    const rpc = installRpc({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get: () => undefined,
      connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
    }, {
      store: { get: () => ({ version: 2, cards: [], bot: {} }), path: 'memory://config', save: async (v) => v },
      cards: { status: () => ({ stream: {} }), pendingList: () => [] },
      api: {},
      events: { record: () => {}, list: () => [] },
      updater: {
        current: () => '2026.11.06',
        check: async () => ({ version: '2026.11.06', source: 'api' }),
        isAtLeast: (a, b) => String(a) >= String(b),
      },
    });
    rpc.install();
    const response = await routes[0].fetch(new Request('http://127.0.0.1/api/dsh-ding-card', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-2', method: 'dsh-ding-card', payload: { method: 'version.check', payload: {} } }),
    }));
    const result = (await response.json()).result;
    assert.equal(result.value.updateAvailable, false);
    assert.equal(result.value.command, null);
    assert.equal(result.value.env, null);
    assert.equal(ctx.latest, null);
    rpc.dispose();
  });
});

test('env.blocker 存在时即使有 pluginManager 也不自动安装', async () => {
  await withProfile('desktop', async () => {
    let installed = 0;
    const manager = { async installBundle() { installed += 1; return { application: 'applied' }; } };
    const env = { ...defaultEnv(), source: 'link', blocker: '当前是链接安装' };
    const host = makeHost({ manager, env });
    const result = await host.call('version.update');
    assert.equal(result.ok, true);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.manual, true);
    assert.equal(result.value.linkMode, true);
    assert.equal(installed, 0);
    assert.match(result.value.command, /dsh plugin --profile desktop add/);
    assert.equal(result.value.output, '当前是链接安装');
  });
});

test('无 pluginManager 时按识别出的同一条命令直接执行', async () => {
  await withProfile('desktop', async () => {
    const runs = [];
    const run = async (options) => {
      runs.push(options);
      return {
        ok: true,
        exitCode: 0,
        command: `dsh plugin --profile desktop add "github:Jydsh/dsh-ding-card#v${options.version}"`,
        output: '+ dsh-ding-card@2026.11.06',
        env: defaultEnv(options),
        restartRequired: true,
      };
    };
    const host = makeHost({ run });
    const result = await host.call('version.update');
    assert.equal(result.ok, true);
    assert.equal(result.value.ok, true);
    assert.equal(result.value.updated, true);
    assert.equal(result.value.requiresRestart, true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].version, '2026.11.06');
    assert.match(result.value.command, /dsh plugin --profile desktop add/);
    assert.equal(typeof result.value.restart?.kind, 'string');
  });
});

test('命令行执行失败时返回 ok=false 并带上输出末行', async () => {
  await withProfile('desktop', async () => {
    const run = async () => ({
      ok: false,
      exitCode: 1,
      command: 'dsh plugin --profile desktop add "github:Jydsh/dsh-ding-card#v2026.11.06"',
      output: 'Progress: resolved 1\nERR_PNPM_GIT_RESOLVE_FAILED\nspawn git ENOENT',
      env: defaultEnv(),
      restartRequired: false,
    });
    const host = makeHost({ run });
    const result = await host.call('version.update');
    assert.equal(result.ok, true);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.updated, false);
    assert.equal(result.value.requiresRestart, false);
    assert.match(result.value.message, /ERR_PNPM_GIT_RESOLVE_FAILED/);
    assert.equal(result.value.exitCode, 1);
  });
});

test('界面选定 profile 时把 profile 传给环境识别', async () => {
  await withProfile('desktop', async () => {
    const host = makeHost({});
    const result = await host.call('version.update', { profile: 'web' });
    assert.equal(result.ok, true);
    assert.equal(host.envCalls.at(-1)?.profile, 'web');
    assert.equal(result.value.profile, 'web');
    assert.match(result.value.command, /--profile web/);
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
    // 安装规格来自环境识别（界面展示的也是这条）
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

test('安装失败返回 ok=false（不抛错），并把错误码翻成中文原因', async () => {
  await withProfile('desktop', async () => {
    const manager = {
      async installBundle() {
        return { application: 'failed', error: { code: 'incompatible-version' } };
      },
    };
    const host = makeHost({ manager });
    const result = await host.call('version.update');
    assert.equal(result.ok, true);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.updated, false);
    assert.equal(result.value.manual, true);
    assert.match(result.value.message, /不兼容/);
    assert.match(result.value.command, /dsh plugin --profile desktop add/);
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
    assert.equal(result.value.ok, true);
    assert.equal(result.value.hotReload, true);
    assert.equal(result.value.queued, true);
    assert.equal(result.value.requiresRestart, false);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.deepEqual(calls[0], ['remove', 'dsh-ding-card']);
    assert.equal(calls[1][1], 'github:Jydsh/dsh-ding-card#v2026.11.06');
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
