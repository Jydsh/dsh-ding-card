import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentProfileName, inspectDshIm, listProfileDirs, profileDataDir } from '../dist/dshim.js';

/** 构造临时 DSH_HOME：profiles/<name> 及可选的 dsh-im 安装。 */
function makeHome(profiles) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dshim-'));
  for (const [name, opts] of Object.entries(profiles)) {
    const dir = join(home, 'profiles', name);
    mkdirSync(join(dir, 'node_modules', '@xmanrui', 'dsh-im'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `profile-${name}`,
      dsh: { profile: { bundles: opts.installed ? ['@xmanrui/dsh-im'] : [] } },
    }));
    if (opts.installed) {
      writeFileSync(join(dir, 'node_modules', '@xmanrui', 'dsh-im', 'package.json'), JSON.stringify({
        name: '@xmanrui/dsh-im',
        version: opts.version ?? '9.9.9',
      }));
    }
  }
  return home;
}

/** 在临时 home 下运行，结束后恢复环境变量。 */
async function withHome(home, profile, fn) {
  const prev = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE: process.env.DSH_PROFILE,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
  };
  process.env.DSH_HOME = home;
  if (profile) process.env.DSH_PROFILE = profile;
  else delete process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE_DIR;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('web profile 未装 dsh-im 时不借用 desktop 的副本（严格隔离）', async () => {
  const home = makeHome({ desktop: { installed: true, version: '5.6.0' }, web: {} });
  await withHome(home, 'web', async () => {
    const dirs = await listProfileDirs();
    assert.equal(dirs.length, 2);
    const info = await inspectDshIm();
    assert.equal(info.installed, false, 'web 未装 dsh-im 应显示未安装，而不是借用 desktop');
    assert.equal(info.version, null);
    assert.equal(info.profile, 'web');
    assert.equal(info.profileDir, join(home, 'profiles', 'web'));
    assert.match(info.installCommand, /--profile web/);
  });
});

test('desktop profile 已装即识别，命令指向 desktop', async () => {
  const home = makeHome({ desktop: { installed: true, version: '5.6.0' }, web: { installed: true, version: '9.9.9' } });
  await withHome(home, 'desktop', async () => {
    const info = await inspectDshIm();
    assert.equal(info.installed, true);
    assert.equal(info.version, '5.6.0');
    assert.equal(info.profile, 'desktop');
    assert.equal(info.profileDir, join(home, 'profiles', 'desktop'));
    assert.match(info.installCommand, /--profile desktop/);
  });
});

test('两个 profile 都未装 dsh-im 时报未安装', async () => {
  const home = makeHome({ desktop: {}, web: {} });
  await withHome(home, 'web', async () => {
    const info = await inspectDshIm();
    assert.equal(info.installed, false);
    assert.equal(info.version, null);
  });
});

test('未设置 DSH_PROFILE 时不再一律当成 desktop，而是按插件自身安装路径推断', async () => {
  const home = makeHome({ desktop: { installed: true }, web: {} });
  await withHome(home, null, async () => {
    // 测试进程从仓库 dist/ 加载插件，不在 profiles/<name>/node_modules 下，
    // 没有可推断的 profile —— 此时保持 desktop 作为兜底，但不会把 web 的检测错判成 desktop。
    assert.equal(currentProfileName(), 'desktop');
    const info = await inspectDshIm();
    assert.equal(info.profile, 'desktop');
  });
});

test('数据目录按 profile 分开', async () => {
  const home = makeHome({ desktop: {}, web: {} });
  await withHome(home, 'web', async () => {
    const dir = profileDataDir();
    assert.equal(dir, join(home, 'integrations', 'dsh-ding-card', 'profiles', 'web'));
    assert.equal(currentProfileName(), 'web');
  });
});
