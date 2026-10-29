import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { exportDingtalkTemplate } from './lib/export.js';
import { sanitizeCard } from './lib/store.js';

const configPath = 'C:/Users/shq/.dsh/integrations/dsh-ding-card/config.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const card = (config.cards || []).find((c) => c.id === 'card_1be8e4e1');
if (!card) {
  console.error('ceiling card (card_1be8e4e1) not found in config');
  process.exit(1);
}
console.log('card:', card.name, 'type:', card.type, 'templateId:', card.templateId);
const out = await exportDingtalkTemplate(sanitizeCard(card));
const targetDir = 'D:/dsh/dsh-ding-card/Temp';
await mkdir(targetDir, { recursive: true });
const target = `${targetDir}/${out.fileName}`;
await writeFile(target, JSON.stringify(out.template, null, 2), 'utf8');
const raw = JSON.stringify(out.template);
console.log('wrote:', target, 'bytes:', raw.length);
const editor = JSON.parse(out.template.editorData);
const root = editor.schema.componentsTree[0];
console.log('root children order:', (root.children ?? []).map((c) => c.componentName).join(' -> '));
console.log('first child is closeTop(SingleButton):', root.children?.[0]?.componentName === 'SingleButton');
const first = root.children?.[0];
if (first) {
  const p = Array.isArray(first.props.params) ? first.props.params[0] : null;
  console.log('closeTop text:', first.props.text?.content, '| param name=', p?.name, 'value=', p?.value);
}
console.log('hasCloseBtn:', raw.includes('"close"') || raw.includes('✕'));
console.log('hasOptionParam:', raw.includes('dsh_option'));
console.log('hasTitleVar:', raw.includes('title'));
console.log('hasContentVar:', raw.includes('content'));
console.log('hasFieldsVar:', raw.includes('fields'));
console.log('hasStateVar:', raw.includes('state'));
