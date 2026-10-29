import test from 'node:test';
import assert from 'node:assert/strict';

import { installCardTools } from '../lib/tools.js';

test('card tools register list and send with the current session', async () => {
  const registered = [];
  let prompt = '';
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['tools', 'systemPrompt']);
      callback({
        tools: {
          register(definition) {
            registered.push(definition);
          },
        },
        systemPrompt: {
          context(block) {
            prompt = block.text();
          },
        },
      });
    },
  };
  const config = {
    templateVariables: [{ name: 'option1', type: 'string', mock: '是' }],
    customVariables: [{ name: 'customText', type: 'string' }],
    cards: [{
      id: 'card_q',
      name: '选择卡片',
      type: 'message',
      description: '用于选择',
      templateId: 'tpl',
      design: { maxOptions: 2 },
      variables: { optionVars: ['option1', 'option2'], optionParam: 'dsh_option' },
      customVariables: [{ name: 'customText', type: 'string', exampleValue: '示例值' }],
      sourceJson: JSON.stringify({ variableList: [{ name: 'option1' }, { name: 'option2' }, { name: 'customText' }] }),
    }],
  };
  const sent = [];
  const cards = {
    async sendChosen(request) {
      sent.push(request);
      return { card: { id: 'card_q', name: '选择卡片' }, outTrackId: 'dsh_card_x' };
    },
  };
  const events = { record() {} };
  installCardTools(ctx, {
    store: { get: () => config },
    cards,
    resolveTarget: async (sessionId) => (sessionId === 'session-1'
      ? { sessionId, bot: { clientId: 'ding' }, target: { kind: 'user', userId: 'u1' }, botId: 'dt' }
      : null),
    events,
    logger: { warn() {} },
  });

  assert.deepEqual(registered.map((definition) => definition.name), ['ding_card_list', 'ding_var_list', 'ding_card_send']);
  assert.match(prompt, /选择卡片/);

  const listed = await registered[0].execute({}, {});
  assert.equal(listed.cards[0].name, '选择卡片');
  assert.equal(listed.cards[0].bound, true);
  const variables = listed.cards[0].variables;
  assert.equal(variables.some((v) => v.name === 'title' && v.description.includes('标题')), true);
  assert.equal(variables.some((v) => v.name === 'option1' && v.description.includes('选项按钮')), true);
  assert.deepEqual(
    variables.find((v) => v.name === 'customText'),
    { name: 'customText', type: 'string', description: '用户自行输入的内容（模板输入框变量）' },
  );
  assert.equal(variables.some((v) => v.name === 'input_status' && v.description.includes('输入框状态')), true);
  // ding_card_list 每张卡返回发送测试实际可配变量（sendVariables），含角色与来源。
  assert.equal(Array.isArray(listed.cards[0].sendVariables), true);
  assert.equal(listed.cards[0].sendVariables.some((v) => v.name === 'option1' && v.role === 'option' && v.source === 'template'), true);

  // ding_var_list 返回完整变量集（模板 + 自定义），含 mock 与绑定。
  const varListed = await registered[1].execute({}, {});
  assert.equal(Array.isArray(varListed.variables), true);
  assert.equal(varListed.variables.some((v) => v.name === 'customText' && v.source === 'custom'), true);

  const result = await registered[2].execute(
    { card: '选择卡片', title: '标题', content: '内容', options: ['A'] },
    { agent: { session: { id: 'session-1' } } },
  );
  assert.equal(result.sent, true);
  assert.equal(result.card, '选择卡片');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.userId, 'u1');
  assert.deepEqual(sent[0].data.options, ['A']);

  await assert.rejects(
    () => registered[2].execute({ card: 'x' }, { agent: { session: { id: 'web-session' } } }),
    /不是钉钉会话/,
  );
});
