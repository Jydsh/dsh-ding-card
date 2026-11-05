import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDshIm, listProfileDirs } from '../dist/dshim.js';

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

test('web profile 未装 dsh-im 时回退到 desktop 识别', () => {
  const home = makeHome({ desktop: { installed: true, version: '5.6.0' }, web: {} });
  const prevHome = process.env.DSH_HOME;
  const prevProfile = process.env.DSH_PROFILE;
  const prevDir = process.env.DSH_PROFILE_DIR;
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'web';
  delete process.env.DSH_PROFILE_DIR;
  return inspectDshIm().then(async (info) => {
    const dirs = await listProfileDirs();
    assert.equal(dirs.length, 2);
    assert.equal(info.installed, true);
    assert.equal(info.version, '5.6.0');
    assert.equal(info.resolvedFrom, 'desktop');
    assert.equal(info.fallback, true);
    assert.equal(info.profileDir, join(home, 'profiles', 'desktop'));
    assert.match(info.installCommand, /--profile web/);
  }).finally(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    if (prevProfile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = prevProfile;
    if (prevDir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = prevDir;
    rmSync(home, { recursive: true, force: true });
  });
});

test('desktop profile 直接识别，无 fallback', () => {
  const home = makeHome({ desktop: { installed: true, version: '5.6.0' } });
  const prevHome = process.env.DSH_HOME;
  const prevProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'desktop';
  return inspectDshIm().then((info) => {
    assert.equal(info.installed, true);
    assert.equal(info.resolvedFrom, 'desktop');
    assert.equal(info.fallback, undefined);
  }).finally(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    if (prevProfile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  });
});

test('所有 profile 都未装 dsh-im 时报未安装', () => {
  const home = makeHome({ web: {} });
  const prevHome = process.env.DSH_HOME;
  const prevProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'web';
  return inspectDshIm().then((info) => {
    assert.equal(info.installed, false);
    assert.equal(info.version, null);
  }).finally(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    if (prevProfile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  });
});
