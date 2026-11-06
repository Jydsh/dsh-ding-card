import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstallEnv, PACKAGE_NAME, runUpdate } from '../dist/updater.js';

/** 在临时 DSH_HOME 里造一个装了本插件的 profile。 */
function installProfile(home, name, declared, version) {
  const dir = join(home, 'profiles', name);
  mkdirSync(join(dir, 'node_modules', PACKAGE_NAME), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dependencies: { [PACKAGE_NAME]: declared } }), 'utf8');
  writeFileSync(join(dir, 'node_modules', PACKAGE_NAME, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version }), 'utf8');
  return dir;
}

async function withHome(setup, fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-'));
  const prev = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE: process.env.DSH_PROFILE,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
  };
  process.env.DSH_HOME = home;
  try {
    if (setup) setup(home);
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

/** 只有 dsh 可用 */
const onlyDsh = (name) => (name === 'dsh' ? 'C:\\bin\\dsh.cmd' : null);
/** 只有 pnpm 可用 */
const onlyPnpm = (name) => (name === 'pnpm' ? 'C:\\bin\\pnpm.cmd' : null);
/** 什么 CLI 都没有 */
const noCli = () => null;

test('装法不明时按 Release 安装包拼命令（dsh CLI）', async () => {
  await withHome(null, async () => {
    const env = detectInstallEnv({ version: '2026.11.06', profile: 'probe', hasCommand: onlyDsh });
    assert.equal(env.profile, 'probe');
    assert.equal(env.profileSource, 'manual');
    assert.equal(env.source, 'unknown');
    assert.equal(env.cli, 'dsh');
    assert.equal(env.mode, 'add');
    assert.equal(env.blocker, null);
    assert.equal(
      env.command,
      'dsh plugin --profile probe add "https://github.com/Jydsh/dsh-ding-card/releases/download/v2026.11.06/dsh-ding-card-2026.11.06.tgz"',
    );
  });
});

test('从 git 装时沿用 github 规格', async () => {
  await withHome((home) => installProfile(home, 'desktop', 'github:Jydsh/dsh-ding-card#v2026.11.05', '2026.11.05'), async () => {
    const env = detectInstallEnv({ version: '2026.11.06', hasCommand: onlyDsh });
    assert.equal(env.profile, 'desktop');
    assert.equal(env.source, 'git');
    assert.equal(env.installedVersion, '2026.11.05');
    assert.equal(env.mode, 'add');
    assert.match(env.command, /dsh plugin --profile desktop add "github:Jydsh\/dsh-ding-card#v2026\.11\.06"/);
  });
});

test('版本号相同时改用 update，原地刷新已装包', async () => {
  await withHome((home) => installProfile(home, 'desktop', 'https://example.com/dsh-ding-card-2026.11.06.tgz', '2026.11.06'), async () => {
    const env = detectInstallEnv({ version: '2026.11.06', hasCommand: onlyDsh });
    assert.equal(env.source, 'tgz');
    assert.equal(env.mode, 'update');
    assert.equal(env.command, 'dsh plugin --profile desktop update dsh-ding-card');
  });
});

test('用 pnpm 时命令不带 profile 参数', async () => {
  await withHome((home) => installProfile(home, 'web', 'github:Jydsh/dsh-ding-card#v2026.11.05', '2026.11.05'), async () => {
    const env = detectInstallEnv({ version: '2026.11.06', profile: 'web', hasCommand: onlyPnpm });
    assert.equal(env.cli, 'pnpm');
    assert.equal(
      env.command,
      'pnpm add "github:Jydsh/dsh-ding-card#v2026.11.06"',
    );
  });
});

test('link 安装时用 add 换成安装包，并给出 blocker 说明', async () => {
  await withHome((home) => installProfile(home, 'desktop', 'link:D:/dsh/dsh-ding-card', '2026.11.06'), async () => {
    const env = detectInstallEnv({ version: '2026.11.06', hasCommand: onlyPnpm });
    assert.equal(env.source, 'link');
    // link 不能原地刷新：即使版本号相同，也该用 add 换成安装包
    assert.equal(env.mode, 'add');
    assert.equal(
      env.command,
      'pnpm add "https://github.com/Jydsh/dsh-ding-card/releases/download/v2026.11.06/dsh-ding-card-2026.11.06.tgz"',
    );
    assert.match(env.blocker, /当前是链接（link/);
  });
});

test('profile 目录不存在时取消执行，避免把包装进插件自身目录', async () => {
  await withHome(null, async () => {
    const result = await runUpdate({ version: '2026.11.06', profile: 'ghost', hasCommand: onlyDsh });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /找不到要安装的 profile 目录/);
  });
});

test('找不到任何 CLI 时给出 blocker 而非命令', async () => {
  await withHome(null, async () => {
    const env = detectInstallEnv({ version: '2026.11.06', profile: 'probe', hasCommand: noCli });
    assert.equal(env.cli, null);
    assert.equal(env.command, '');
    assert.match(env.blocker, /未找到 dsh \/ pnpm \/ npm/);
  });
});

test('多个 profile 都装了本插件且认不出当前时给出 blocker', async () => {
  await withHome((home) => {
    installProfile(home, 'desktop', 'github:Jydsh/dsh-ding-card#v2026.11.05', '2026.11.05');
    installProfile(home, 'web', 'github:Jydsh/dsh-ding-card#v2026.11.05', '2026.11.05');
    delete process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE_DIR;
  }, async () => {
    const env = detectInstallEnv({ version: '2026.11.06', hasCommand: onlyDsh });
    assert.equal(env.profileSource, 'default');
    assert.deepEqual(env.candidates.sort(), ['desktop', 'web']);
    assert.match(env.blocker, /都装了本插件/);
  });
});

test('显式选定 profile 后不再因多 profile 被拦', async () => {
  await withHome((home) => {
    installProfile(home, 'desktop', 'github:Jydsh/dsh-ding-card#v2026.11.05', '2026.11.05');
    installProfile(home, 'web', 'github:Jydsh/dsh-ding-card#v2026.11.05', '2026.11.05');
    delete process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE_DIR;
  }, async () => {
    const env = detectInstallEnv({ version: '2026.11.06', profile: 'web', hasCommand: onlyDsh });
    assert.equal(env.profile, 'web');
    assert.equal(env.profileSource, 'manual');
    assert.equal(env.blocker, null);
    assert.match(env.command, /--profile web add/);
  });
});
