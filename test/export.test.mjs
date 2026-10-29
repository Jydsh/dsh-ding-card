import test from 'node:test';
import assert from 'node:assert/strict';

import { exportDingtalkTemplate } from '../lib/export.js';
import { sanitizeCard } from '../lib/store.js';

function find(nodes, name) {
  for (const node of nodes ?? []) {
    if (node.componentName === name) return node;
    const hit = find(node.children, name);
    if (hit) return hit;
  }
  return null;
}

test('message card exports an importable IM template with option variables', async () => {
  const card = sanitizeCard({
    id: 'card_msg',
    name: '选择卡片',
    type: 'message',
    templateId: 'tpl',
    design: {
      title: '${title}',
      subtitle: '${subtitle}',
      content: '${content}',
      state: '${state}',
      fields: [{ label: '环境', value: '${env}' }],
      showButtons: true,
      maxOptions: 3,
    },
  });
  const exported = await exportDingtalkTemplate(card);
  assert.equal(exported.template.type, 'im');
  assert.equal(exported.template.mode, 'card');
  assert.match(exported.fileName, /\.card\.json$/);
  const editor = JSON.parse(exported.template.editorData);
  assert.ok(Array.isArray(editor.schema.componentsMap));
  const root = editor.schema.componentsTree[0];
  assert.equal(root.componentName, 'Card');
  const names = editor.variableList.map((item) => item.name);
  for (const name of ['title', 'subtitle', 'content', 'fields', 'image', 'state', 'option1', 'option2', 'option3']) {
    assert.ok(names.includes(name), `missing variable ${name}`);
  }
  const buttons = find(editor.schema.componentsTree, 'ButtonList');
  assert.equal(buttons.props.direction, 'vertical');
  // 按钮数 = maxOptions；自由输入不在卡片内渲染（钉钉后台本地变量仅支持布尔值+选择框，
  // 文本输入组件无法绑定字符串本地变量，强行引用会导致导入钉钉后台报错），改由用户会话内直接回复文本。
  assert.equal(buttons.props.buttons.list.length, 3);
  assert.equal(buttons.props.buttons.list[0].text.content, '${option1}');
  assert.equal(buttons.props.buttons.list[0].params[0].name, 'dsh_option');
  assert.equal(buttons.props.buttons.list[0].params[0].value, '1');
  assert.ok(names.includes('customText'));
  assert.ok(names.includes('input_status'));
});

test('standard card exports the StdCard structure', async () => {
  const card = sanitizeCard({
    id: 'card_std',
    name: '标准通知',
    type: 'standard',
    templateId: 'tpl',
    design: {
      title: '${title}',
      subtitle: '通知',
      content: '${content}',
      state: '${state}',
      showButtons: true,
      maxOptions: 2,
    },
  });
  const exported = await exportDingtalkTemplate(card);
  assert.equal(exported.template.type, 'standard');
  const editor = JSON.parse(exported.template.editorData);
  const root = editor.schema.componentsTree[0];
  assert.equal(root.componentName, 'StdCard');
  assert.equal(root.props.cardName.content, '${title}');
  const buttons = find(editor.schema.componentsTree, 'ButtonBlock');
  assert.equal(buttons.props.direction, 'vertical');
  // 按钮数 = maxOptions（自由输入按钮同样不渲染，见消息卡模板说明）
  assert.equal(buttons.props.buttons.length, 2);
  assert.equal(buttons.props.buttons[1].text.content, '${option2}');
  assert.ok(editor.schema.componentsMap.some((component) => component.exportName === 'Input'));
});
