import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardConfigStore, sanitizeCustomVariables, sanitizeCard, sanitizeTemplateVariables } from '../lib/store.js';

test('legacy config without templateVariables falls back to default template variables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ding-card-'));
  const path = join(dir, 'config.json');
  try {
    const store = new CardConfigStore(path);
    await store.save({ version: 2, enabled: true, cards: [] }); // 旧配置：无 templateVariables 字段
    const cfg = store.get();
    assert.ok(Array.isArray(cfg.templateVariables) && cfg.templateVariables.length >= 15,
      `旧配置应兜底默认模板变量集（实际 ${cfg.templateVariables.length}）`);
    assert.ok(cfg.templateVariables.some((v) => v.name === 'grid_object_list' && v.type === 'objectArray'));
    // 用户显式清空（空数组）不兜底，保持空。
    await store.save({ version: 2, enabled: true, cards: [], templateVariables: [] });
    assert.equal(store.get().templateVariables.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config store round-trips the v2 card library', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ding-card-'));
  const path = join(dir, 'config.json');
  try {
    const store = new CardConfigStore(path);
    await store.load();
    assert.equal(store.get().version, 2);
    assert.deepEqual(store.get().cards, []);

    await store.save({
      version: 2,
      enabled: false,
      interactions: { questions: false, timeoutMs: 120_000 },
      cards: [{
        id: 'card_test',
        name: '测试卡',
        type: 'message',
        templateId: 'tpl-1',
        description: 'desc',
        design: { title: '${title}', content: '${content}', maxOptions: 2 },
        variables: { optionParam: 'dsh_option' },
      }],
    });
    const reloaded = new CardConfigStore(path);
    await reloaded.load();
    const config = reloaded.get();
    assert.equal(config.enabled, false);
    assert.equal(config.interactions.questions, false);
    assert.equal(config.interactions.approvals, true);
    assert.equal(config.interactions.timeoutMs, 120_000);
    assert.equal(config.cards.length, 1);
    assert.equal(config.cards[0].templateId, 'tpl-1');
    assert.equal(config.cards[0].design.maxOptions, 2);

    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.cards[0].name, '测试卡');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config store migrates v1 question/approval cards and keeps the template id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ding-card-'));
  const path = join(dir, 'config.json');
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      enabled: true,
      interactions: { questions: true, approvals: true, ceiling: false },
      cards: {
        question: {
          enabled: true,
          templateId: 'legacy-template',
          title: '需要你的选择',
          titleVar: 'title',
          contentVar: 'content',
          stateVar: 'state',
          actionsVar: 'actions',
          optionVars: ['option1', 'option2'],
          actionsMode: 'actions',
          optionParam: 'dsh_option',
          maxOptions: 4,
        },
        approval: {
          enabled: true,
          templateId: 'legacy-approval',
          title: '需要你的确认',
          optionParam: 'dsh_decision',
          maxOptions: 2,
        },
      },
    }), 'utf8');
    const store = new CardConfigStore(path);
    await store.load();
    const config = store.get();
    assert.equal(config.version, 2);
    assert.equal(config.cards.length, 2);
    assert.equal(config.cards[0].templateId, 'legacy-template');
    assert.equal(config.cards[0].variables.actionsMode, 'actions');
    assert.equal(config.cards[1].variables.optionParam, 'dsh_decision');
    assert.equal(config.interactions.questionCardId, config.cards[0].id);
    assert.equal(config.interactions.approvalCardId, config.cards[1].id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config store ignores unknown and malformed fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ding-card-'));
  const path = join(dir, 'config.json');
  try {
    const store = new CardConfigStore(path);
    await store.load();
    await store.save({
      bot: { mode: 'bogus', clientId: 42 },
      interactions: { timeoutMs: 'nope', allowGroup: 'yes' },
      cards: [{
        id: 'card_x',
        name: 'X',
        type: 'bogus',
        design: { theme: 'bogus', maxOptions: 99, showButtons: 'yes' },
        variables: { actionsMode: 'bogus', optionVars: ['a', 7, 'b'] },
      }],
    });
    const config = store.get();
    assert.equal(config.bot.mode, 'auto');
    assert.equal(config.bot.clientId, '');
    assert.equal(config.interactions.timeoutMs, 600_000);
    assert.equal(config.interactions.allowGroup, true);
    assert.equal(config.cards[0].type, 'message');
    assert.equal(config.cards[0].design.theme, 'blue');
    assert.equal(config.cards[0].design.maxOptions, 6);
    assert.equal(config.cards[0].design.showButtons, true);
    assert.equal(config.cards[0].variables.actionsMode, 'fixed');
    assert.deepEqual(config.cards[0].variables.optionVars, ['a', 'b']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('custom variables are sanitized and built-in variable names are skipped', () => {
  const card = sanitizeCard({
    name: '模板卡',
    type: 'message',
    templateId: 'tpl-1',
    variables: { title: 'title', content: 'content' },
    customVariables: [
      { name: 'user', type: 'string', exampleValue: '何工', value: '' },
      { name: 'title', type: 'string', exampleValue: '内置', value: 'x' },
      { name: 'option1', type: 'string', exampleValue: '内置', value: 'x' },
      { name: '  ', type: 'string', exampleValue: '空', value: 'x' },
      { name: 'count', type: 'number', exampleValue: '3', value: '3' },
      { name: 'imageUrl', type: 'image', exampleValue: 'https://x.png', value: '' },
      { name: 'customText', type: 'string', exampleValue: '内置输入框', value: 'x' },
      { name: 'input_status', type: 'string', exampleValue: 'normal', value: 'x' },
    ],
  });
  assert.deepEqual(card.customVariables, [
    { name: 'user', type: 'string', exampleValue: '何工', value: '', bindVar: '' },
    { name: 'count', type: 'number', exampleValue: '3', value: '3', bindVar: '' },
    { name: 'imageUrl', type: 'image', exampleValue: 'https://x.png', value: '', bindVar: '' },
  ]);
  assert.deepEqual(sanitizeCustomVariables('nope'), []);
  assert.deepEqual(sanitizeCustomVariables(undefined), []);
});

test('templateVariables round-trips and falls back to defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ding-card-'));
  const path = join(dir, 'config.json');
  try {
    const store = new CardConfigStore(path);
    await store.load();
    const defaults = store.get().templateVariables;
    assert.ok(defaults.length >= 15, `默认模板变量集应有 ≥15 项（实际 ${defaults.length}）`);
    assert.ok(defaults.some((v) => v.name === 'title' && v.type === 'string'));
    assert.ok(defaults.some((v) => v.name === 'content' && v.type === 'richText'));
    // 自带绑定的系统模板变量默认在变量集里（选项按钮 / 输入框 / 对象列表）。
    assert.ok(defaults.some((v) => v.name === 'option1' && v.type === 'string'));
    assert.ok(defaults.some((v) => v.name === 'option3' && v.type === 'string'));
    assert.ok(defaults.some((v) => v.name === 'customText' && v.type === 'string'));
    assert.ok(defaults.some((v) => v.name === 'input_status' && v.type === 'string'));
    assert.ok(defaults.some((v) => v.name === 'grid_object_list' && v.type === 'objectArray'));

    // 钉钉侧变量变动后，这里可增删改模板变量（含类型 / 描述 / Mock）。
    await store.save({
      cards: [],
      templateVariables: [
        { name: 'headline', type: 'string', desc: '钉钉侧改名的标题变量' },
        { name: 'grid_object_list', type: 'objectArray', desc: '对象数组循环渲染', mock: [{ text: 'Grid 11' }] },
        { name: 'title', type: 'string', desc: '标题（保留）' },
        { name: '', type: 'string' },
        { name: 'bad type', type: 'nope' },
      ],
    });
    const config = store.get();
    assert.deepEqual(config.templateVariables.map((v) => v.name), ['headline', 'grid_object_list', 'title']);
    assert.equal(config.templateVariables[1].type, 'objectArray');
    assert.deepEqual(config.templateVariables[1].mock, [{ text: 'Grid 11' }]);
    assert.equal(config.templateVariables[2].type, 'string');
    assert.equal(config.templateVariables[2].desc, '标题（保留）');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sanitizeTemplateVariables rejects malformed input', () => {
  assert.deepEqual(sanitizeTemplateVariables(undefined), []);
  assert.deepEqual(sanitizeTemplateVariables('nope'), []);
  assert.deepEqual(sanitizeTemplateVariables([{ name: 'ok', type: 'boolean', desc: '开关' }]), [
    { name: 'ok', type: 'boolean', desc: '开关', note: '', bindVar: '', mock: undefined, createdAt: '', updatedAt: '' },
  ]);
});
