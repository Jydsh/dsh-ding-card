import test from 'node:test';
import assert from 'node:assert/strict';

import { botIdFor, parseConversationKey } from '../lib/dshim.js';
import { callbackParams, pickApproval, pickChoice, questionMarkdown } from '../lib/cards.js';
import { buildCardData, resolvePlaceholders } from '../lib/export.js';
import { DEFAULT_VARIABLES, sanitizeCard, sanitizeConfig } from '../lib/store.js';

test('sanitizeConfig fills defaults', () => {
  const config = sanitizeConfig({
    interactions: { timeoutMs: 1, questions: false },
    cards: [{ id: 'card_a', name: 'A', type: 'message', design: { maxOptions: 99 } }],
  });
  assert.equal(config.interactions.questions, false);
  assert.equal(config.interactions.timeoutMs, 30_000);
  assert.equal(config.cards[0].design.maxOptions, 6);
  assert.equal(config.cards[0].variables.optionParam, DEFAULT_VARIABLES.optionParam);
});

test('botIdFor mirrors dsh-im bot ids', () => {
  assert.equal(botIdFor('ding0ebgff1ufwjolhnn'), 'dt_83d23d791faa3f3e6bebe652');
});

test('parseConversationKey understands dsh-im routes', () => {
  assert.deepEqual(parseConversationKey('p2p:021724185801860353'), {
    kind: 'user', userId: '021724185801860353', openConversationId: null,
  });
  assert.deepEqual(parseConversationKey('group:cidABC=='), {
    kind: 'group', userId: null, openConversationId: 'cidABC==',
  });
  assert.equal(parseConversationKey('p2p:'), null);
});

const options = [
  { id: '1', label: '选项 A' },
  { id: '2', label: '选项 B' },
];

test('pickChoice reads cardPrivateData params from a string callback', () => {
  const callback = {
    outTrackId: 'dsh_card_1',
    content: JSON.stringify({
      cardPrivateData: { actionIds: ['2'], params: { dsh_option: '2' } },
    }),
  };
  assert.deepEqual(pickChoice(callback, 'dsh_option', options), options[1]);
  assert.deepEqual(callbackParams(callback).params, { dsh_option: '2' });
});

test('pickChoice accepts string-encoded params', () => {
  const callback = {
    content: JSON.stringify({ cardPrivateData: { params: '{"dsh_option":"2"}' } }),
  };
  assert.deepEqual(pickChoice(callback, 'dsh_option', options), options[1]);
});

test('pickChoice falls back to actionIds and labels', () => {
  assert.deepEqual(pickChoice({ content: { cardPrivateData: { actionIds: ['1'], params: {} } } }, 'dsh_option', options), options[0]);
  assert.deepEqual(pickChoice({ content: { cardPrivateData: { params: { choice: '选项 B' } } } }, 'dsh_option', options), options[1]);
  assert.equal(pickChoice({ content: { cardPrivateData: { params: {} } } }, 'dsh_option', options), null);
});

test('pickApproval understands the public approval card vocabulary', () => {
  const approved = { content: JSON.stringify({ cardPrivateData: { params: { action: 'approved' } } }) };
  const denied = { content: JSON.stringify({ cardPrivateData: { actionIds: ['denied'] } }) };
  assert.equal(pickApproval(approved, 'dsh_decision').id, 'allow');
  assert.equal(pickApproval(denied, 'dsh_decision').id, 'deny');
  assert.equal(pickApproval({ content: { cardPrivateData: { params: {} } } }, 'dsh_decision'), null);
});

test('resolvePlaceholders fills known values and blanks unknown ones', () => {
  assert.equal(resolvePlaceholders('标题：${title} / ${missing}', { title: 'T' }), '标题：T / ');
});

test('buildCardData writes title, content, state and fixed option variables', () => {
  const card = sanitizeCard({
    id: 'card_a',
    name: '选择卡片',
    type: 'message',
    templateId: 'tpl',
    design: {
      title: '${title}',
      content: '${content}',
      state: '${state}',
      fields: [{ label: '工具', value: '${tool}' }],
      showButtons: true,
      maxOptions: 2,
    },
  });
  const built = buildCardData(card, {
    title: '请选择',
    content: '正文',
    state: '等待选择',
    options: ['A', 'B'],
    variables: { tool: 'Bash' },
  });
  assert.deepEqual(built.options.map((option) => option.value), ['A', 'B']);
  assert.equal(built.params.title, '请选择');
  assert.equal(built.params.content, '正文');
  assert.equal(built.params.state, '等待选择');
  assert.equal(built.params.fields, '工具：Bash');
  assert.equal(built.params.option1, 'A');
  assert.equal(built.params.option2, 'B');
});

test('buildCardData accepts button-group options {text, value} and maps to optionN', () => {
  const card = sanitizeCard({
    id: 'card_btns',
    name: '按钮组卡片',
    type: 'message',
    templateId: 'tpl',
    design: { title: '${title}', showButtons: true, showOptionValue: false, maxOptions: 3 },
  });
  const built = buildCardData(card, {
    title: '请选择',
    options: [
      { text: '确定', value: 'ok' },
      { text: '取消', value: 'cancel' },
      { text: '清空', value: '' },
    ],
  });
  assert.deepEqual(built.options.map((option) => option.value), ['ok', 'cancel', '清空']);
  assert.equal(built.params.option1, '确定');
  assert.equal(built.params.option2, '取消');
  assert.equal(built.params.option3, '清空');
});

test('option labels and callback values stay separate', () => {
  const card = sanitizeCard({
    id: 'card_v',
    name: '带值卡片',
    type: 'message',
    templateId: 'tpl',
    design: { showButtons: true, showOptionValue: true, maxOptions: 2 },
  });
  const built = buildCardData(card, {
    options: [
      { label: 'A', value: 'alpha' },
      { label: 'B', value: 'beta' },
    ],
  });
  assert.deepEqual(built.options.map((option) => option.value), ['alpha', 'beta']);
  // 按钮文案只写纯文案（label），回传值走 actions/回传变量，不显示在按钮上。
  assert.equal(built.params.option1, 'A');
  const actions = JSON.parse(built.params.actions);
  assert.deepEqual(actions[1].value, { dsh_option: 'beta' });
  assert.equal(actions[0].label, 'A');
});

test('long labels and short values swap so buttons stay short and return text is full', () => {
  const card = sanitizeCard({
    id: 'card_swap',
    name: '答题卡',
    type: 'message',
    templateId: 'tpl',
    variables: { optionVars: ['option1', 'option2'], optionValueVars: ['option1value', 'option2value'] },
    design: { showButtons: true, maxOptions: 4 },
  });
  const built = buildCardData(card, {
    options: [
      { label: 'A. 选项按钮列表', value: 'A' },
      { label: '同意', value: 'ok' },
    ],
  });
  // label 明显长于 value（label > 8 且 value 更短）时自动交换：按钮显示短文案，回传值保留完整内容。
  assert.equal(built.options[0].label, 'A');
  assert.equal(built.options[0].value, '选项按钮列表');
  // 短 label（未超按钮上限）不交换。
  assert.equal(built.options[1].label, '同意');
  assert.equal(built.options[1].value, 'ok');
});

test('string options and variables strings get short labels with full return text', () => {
  const card = sanitizeCard({
    id: 'card_short',
    name: '答题卡',
    type: 'message',
    templateId: 'tpl',
    variables: { optionVars: ['option1', 'option2'], optionValueVars: ['option1value', 'option2value'] },
    design: { showButtons: true, maxOptions: 4 },
  });
  const built = buildCardData(card, {
    options: ['A. 选项按钮列表', 'B. 结构化键值对区域'],
  });
  // 字符串选项拆短标签：按钮显示 "A"，回传值去前缀只保留内容。
  assert.equal(built.options[0].label, 'A');
  assert.equal(built.options[0].value, '选项按钮列表');
  // 无序号前缀的短文案不拆。
  const built2 = buildCardData(card, { options: ['同意', '取消'] });
  assert.equal(built2.options[0].label, '同意');
  assert.equal(built2.options[0].value, '同意');
  // 显式 {label,value} 的回传值带序号前缀时同样去前缀，避免按钮 "A" + "A. 内容" 重复。
  const built3 = buildCardData(card, { options: [{ label: 'A', value: 'A. 中国神话中的神' }] });
  assert.equal(built3.options[0].label, 'A');
  assert.equal(built3.options[0].value, '中国神话中的神');
});

test('cards without a side return-text keep the full text on the button', () => {
  const card = sanitizeCard({
    id: 'card_plain',
    name: '消息卡片',
    type: 'message',
    templateId: 'tpl',
    variables: { optionVars: ['option1', 'option2'], optionValueVars: [] },
    design: { showButtons: true, maxOptions: 3 },
  });
  // 只有按钮、无旁文本回传区：按钮是唯一显示区域，文案 = 回传值，不拆短标签。
  const built = buildCardData(card, { options: ['A. 选项按钮列表', 'B. 结构化键值对区域'] });
  assert.equal(built.options[0].label, 'A. 选项按钮列表');
  assert.equal(built.options[0].value, 'A. 选项按钮列表');
  // 审批场景：显式 label/value 尊重传入（同意 → 回传 agree）。
  const built2 = buildCardData(card, { options: [{ label: '同意', value: 'agree' }, { label: '拒绝', value: 'deny' }] });
  assert.equal(built2.options[0].label, '同意');
  assert.equal(built2.options[0].value, 'agree');
});

test('buildCardData supports dynamic actions variables for legacy templates', () => {
  const card = sanitizeCard({
    id: 'card_legacy',
    name: '旧模板',
    type: 'message',
    templateId: 'tpl',
    variables: { actionsMode: 'actions', actions: 'actions' },
    design: { showButtons: true, maxOptions: 2 },
  });
  const built = buildCardData(card, { options: ['继续', '停止'] });
  const actions = JSON.parse(built.params.actions);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[1].value, { dsh_option: '停止' });
});

test('buildCardData passes template extension variables into params', () => {
  const card = sanitizeCard({
    id: 'card_ext',
    name: '输入卡',
    type: 'message',
    templateId: 'tpl',
    design: { title: '${title}', content: '${content}', showButtons: false },
  });
  const built = buildCardData(card, {
    title: '标题',
    variables: { customText: '用户输入 ABC', input_status: 'normal', extra: '模板自定义变量值' },
  });
  assert.equal(built.params.title, '标题');
  assert.equal(built.params.customText, '用户输入 ABC');
  assert.equal(built.params.input_status, 'normal');
  assert.equal(built.params.extra, '模板自定义变量值');
  // values 展开语义：input.variables 会覆盖同名内置变量（既有的占位符替换通道），
  // 但透传只补齐 params 中尚未写入的键，不会重复写入已存在的内置键。
  const overridden = buildCardData(card, { title: '内置', variables: { title: '覆盖尝试', content: '忽略' } });
  assert.equal(overridden.params.title, '覆盖尝试');
  assert.equal(overridden.params.content, '忽略');
});

test('questionMarkdown lists the recommended options', () => {
  const text = questionMarkdown({
    id: 'q', header: '确认', question: '继续吗？', detail: '细节', options,
  }, options);
  assert.match(text, /继续吗/);
  assert.match(text, /1\. 选项 A/);
  assert.match(text, /2\. 选项 B/);
});
