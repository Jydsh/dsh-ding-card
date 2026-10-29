import { readFile } from 'node:fs/promises';
import { CARD_TYPE_META, sanitizeCard } from './store.js';

const ASSET_ROOT = new URL('../assets/', import.meta.url);
const baseCache = new Map();

function clone(value) {
  return structuredClone(value);
}

async function loadBase(name) {
  if (!baseCache.has(name)) {
    baseCache.set(name, readFile(new URL(name, ASSET_ROOT), 'utf8').then((text) => JSON.parse(text)));
  }
  return baseCache.get(name);
}

function findNode(nodes, componentName) {
  for (const node of nodes ?? []) {
    if (node?.componentName === componentName) return node;
    const hit = findNode(node?.children, componentName);
    if (hit) return hit;
  }
  return null;
}

function dynamicString(text) {
  return { i18n: false, type: 'dynamicString', content: String(text ?? '') };
}

function variableDef(name, description, type = 'string') {
  return { name, private: false, type, id: name, description, editorVarType: 'variables' };
}

function textVariables(card) {
  const names = ['title', 'subtitle', 'content', 'fields', 'image', 'state'];
  const variables = names.map((name) => variableDef(name, `${name} 变量`));
  const count = Math.max(1, Math.min(6, card.design.maxOptions || 4));
  for (let index = 0; index < count; index += 1) {
    variables.push(variableDef(`option${index + 1}`, `选项 ${index + 1} 文案`));
  }
  if (card.design.allowCustom) {
    variables.push(variableDef('customText', '用户自行输入的内容'));
    variables.push(variableDef('input_status', '输入框状态'));
  }
  return variables;
}

export function sampleData(card) {
  const fallback = ['选项 A', '选项 B', '选项 C', '选项 D', '选项 E', '选项 F'];
  const designOptions = Array.isArray(card.design.options) && card.design.options.length
    ? card.design.options
    : fallback.map((label) => ({ label, value: label }));
  const data = {
    title: card.name || '卡片标题',
    subtitle: CARD_TYPE_META[card.type]?.label ?? '卡片',
    content: '这是一张由 dsh-ding-card 设计的卡片。',
    fields: [{ label: '场景', value: CARD_TYPE_META[card.type]?.label ?? '消息' }],
    state: '等待处理',
    options: designOptions.slice(0, Math.max(1, Math.min(6, card.design.maxOptions || 4))),
  };
  return data;
}

export function resolvePlaceholders(template, values) {
  return String(template ?? '').replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, key) => (
    values[key] === undefined || values[key] === null ? '' : String(values[key])
  ));
}

function fieldsText(fields) {
  if (!Array.isArray(fields)) return '';
  return fields
    .filter((row) => row && (row.label || row.value))
    .map((row) => `${row.label ?? ''}：${row.value ?? ''}`)
    .join('\n');
}

/** Build the cardParamMap and normalized option list for one send. */
/** 从选项文本提取短按钮标签："A. 选项按钮列表" → "A"、"1、内容" → "1"；无序号前缀则原样返回。 */
function shortOptionLabel(text) {
  const s = String(text ?? '').trim();
  if (!s) return s;
  const m = s.match(/^([A-Za-z0-9一二三四五六七八九十①②③④⑤]{1,2})[.、．:：\s]/);
  return m ? m[1] : s;
}

/** 去掉选项文本的序号前缀，仅保留内容："A. 中国神话中的神" → "中国神话中的神"；无前缀原样返回。 */
function stripOptionPrefix(text) {
  const s = String(text ?? '').trim();
  return s.replace(/^([A-Za-z0-9一二三四五六七八九十①②③④⑤]{1,2})[.、．:：\s]\s*/, '') || s;
}

export function buildCardData(cardInput, input = {}) {
  const card = sanitizeCard(cardInput);
  const vars = card.variables;
  const values = {
    title: input.title ?? card.name,
    subtitle: input.subtitle ?? '',
    content: input.content ?? '',
    fields: Array.isArray(input.fields) ? fieldsText(input.fields) : (input.fields ?? ''),
    image: input.image ?? '',
    state: input.state ?? '已完成',
    ...(input.variables && typeof input.variables === 'object' ? input.variables : {}),
  };
  const sourceOptions = Array.isArray(input.options) && input.options.length > 0
    ? input.options
    : (card.design.options ?? []);
  const showValue = card.design.showOptionValue && !input.optionIds;
  const options = sourceOptions
    .slice(0, Math.min(6, card.design.maxOptions || 4))
    .map((entry, index) => {
      const isStringEntry = typeof entry === 'string';
      const rawLabel = isStringEntry ? entry : (entry?.label ?? entry?.text ?? '');
      // 模板设计器导出的默认选项 label 可能是占位符（如 ${btnsA}）：先用 values（含 variables 透传）解析，
      // 让 AI 走 variables 传按钮文案时默认选项也能解析为实际文案。
      const fullLabel = String(resolvePlaceholders(String(rawLabel), values) ?? rawLabel ?? '');
      const rawValue = Array.isArray(input.optionIds) && input.optionIds[index] !== undefined
        ? String(input.optionIds[index])
        : (isStringEntry ? fullLabel : (entry?.value || fullLabel));
      // 默认选项的 value 若为模板占位符或回传变量名（如 btnsAvalue），它不是真实回传值：
      // 兜底为完整文案（回传值宜全），避免按钮旁文本显示变量名。
      const value = /^\$\{.*\}$/.test(rawValue)
        || (Array.isArray(vars.optionValueVars) && vars.optionValueVars.includes(rawValue))
        ? fullLabel : rawValue;
      const explicitOptions = Array.isArray(input.options) && input.options.length > 0;
      // 成组卡片（有旁文本回传变量，如 btnsA ↔ btnsAvalue）：按钮文案宜短、回传值宜全，
      // 拆短标签 + 交换 + 去前缀；
      // 非成组卡片（只有按钮、无旁文本，如 option1..N / 审批的同意/取消）：
      // 按钮是唯一显示区域，按钮文案与回传值保持一致（完整文案），不拆不换。
      const paired = Array.isArray(vars.optionValueVars) && vars.optionValueVars.length > 0;
      let label;
      let finalValue;
      if (!paired) {
        label = fullLabel;
        finalValue = String(value ?? fullLabel);
      } else if (explicitOptions && value && value !== fullLabel && fullLabel.length > 8 && String(value).length < fullLabel.length) {
        // ① 显式 {label,value} 中 label 明显长于 value（>8 且 value 更短）→ 交换（按钮短、回传全）
        label = String(value);
        finalValue = fullLabel;
      } else {
        // ② 其余来源（字符串选项 / design.options 占位符解析 / 未交换对象）的带序号前缀长文案拆短标签，
        //    value 保持完整内容。
        const short = shortOptionLabel(fullLabel);
        label = short;
        finalValue = short !== fullLabel ? fullLabel : String(value ?? fullLabel);
      }
      // 成对去前缀：按钮已用短标签（序号前缀，如 "A"）时，回传值去掉相同前缀，
      // 避免 "A" + "A. 中国神话中的神" 重复显示（按钮只显示短标签，旁文本显示内容）。
      if (label && shortOptionLabel(finalValue) === label) {
        const stripped = stripOptionPrefix(finalValue);
        if (stripped && stripped !== label) finalValue = stripped;
      }
      const text = showValue && finalValue && finalValue !== label ? `${label} — ${finalValue}` : label;
      return { label, value: finalValue, text };
    })
    // 解析后仍是占位符的默认选项视为无效（AI 应通过 options 数组提供真实选项），过滤掉。
    .filter((option) => option.label.trim() && !/^\$\{.*\}$/.test(option.label));
  const params = {};
  const set = (name, value) => {
    if (name && value !== undefined && value !== null) params[name] = String(value);
  };
  set(vars.title, resolvePlaceholders(card.design.title, values) || values.title || '');
  set(vars.subtitle, resolvePlaceholders(card.design.subtitle, values) || values.subtitle || '');
  set(vars.content, resolvePlaceholders(card.design.content, values) || values.content || '');
  const designFields = resolvePlaceholders(fieldsText(card.design.fields), values);
  set(vars.fields, values.fields || designFields);
  set(vars.state, resolvePlaceholders(card.design.state, values));
  if (vars.image) set(vars.image, values.image);
  if (values.image && vars.content && !String(params[vars.content] ?? '').includes('![')) {
    params[vars.content] = `${params[vars.content] ?? ''}\n\n![图片](${values.image})`;
  }

  if (card.design.showButtons && options.length > 0) {
    // Write both shapes: legacy templates bind an `actions` JSON list, while
    // templates exported by this plugin use fixed ${optionN} buttons.
    // optionVars/optionParam 可能未被模板声明（缺失时按默认处理，避免空引用）。
    const optionParam = vars.optionParam || 'dsh_option';
    // 回传变量列表：发送方（bindVar 用户配置优先）可传入覆盖，否则用导入识别结果。
    const optionValueVars = Array.isArray(input.optionValueVars)
      ? input.optionValueVars
      : (Array.isArray(vars.optionValueVars) ? vars.optionValueVars : []);
    // 按钮文案一律写纯文案（label）：成组模板（btnsA ↔ btnsAvalue）的按钮变量写 label，
    // 回传内容写回传变量（由按钮旁文本控件显示，不显示在按钮上）；
    // 普通 optionN 模板同样只写按钮文案，回传值走 actions 的 value。
    const isPaired = optionValueVars.length > 0;
    (vars.optionVars ?? []).forEach((name, index) => set(name, options[index]?.label ?? options[index]?.text ?? ''));
    (optionValueVars ?? []).forEach((name, index) => set(name, options[index]?.value ?? ''));
    if (vars.actions) {
      set(vars.actions, JSON.stringify(options.map((option) => ({
        id: option.value,
        label: option.label || option.text,
        style: 'default',
        disabled: false,
        value: { [optionParam]: option.value },
      }))));
    }
    // legacy 模板可能把 actionsMode 与 actions 绑定到同一变量名（值都是 'actions'），
    // 此时后写 mode 值会覆盖掉 actions JSON；同名时以 actions JSON 为准，不另写 mode。
    if (vars.actionsMode && vars.actionsMode !== vars.actions) {
      set(vars.actionsMode, card.variables.actionsMode === 'actions' ? 'actions' : 'fixed');
    }
    if (vars.maxOptions) set(vars.maxOptions, String(card.design.maxOptions));
  }
  // 模板扩展变量（customText/input_status 等模板声明变量）直接透传填充：
  // 它们不在 vars 白名单里，若不写入 params，发送时这些模板变量永远是空值。
  if (input.variables && typeof input.variables === 'object') {
    for (const [key, value] of Object.entries(input.variables)) {
      if (value === undefined || value === null) continue;
      // 已填充的内置变量不覆盖；但初始值为模板占位符字面量（如 ${btnsA}）视为未填充，允许 variables 覆盖。
      if (Object.prototype.hasOwnProperty.call(params, key) && !/^\$\{.*\}$/.test(String(params[key]))) continue;
      if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;
      // 兜底：AI 若把选项按钮变量当普通变量传字符串（未走 options 数组），
      // 按钮取短标签（"A. 选项按钮列表" → "A"）、回传值 = 去前缀的内容（"中国神话中的神"），
      // 避免按钮短标签与回传文本重复显示前缀。
      if (Array.isArray(vars.optionVars) && vars.optionVars.includes(key) && typeof value === 'string') {
        const v = String(value);
        const valueVar = optionValueVars[vars.optionVars.indexOf(key)];
        if (valueVar) params[valueVar] = stripOptionPrefix(v) || v;
        params[key] = shortOptionLabel(v);
        continue;
      }
      params[key] = String(value);
    }
  }
  return { params, options };
}

function buildImTemplate(card, base, inputAssets, opts = {}) {
  const editor = clone(JSON.parse(base.editorData));
  // 吊顶卡片：合并后台官方吊顶骨架的组件定义（Card 覆盖为吊顶版），其余组件沿用 im 骨架。
  if (opts.componentsMap) {
    const merged = new Map((editor.schema.componentsMap || []).map((m) => [m.componentName, m]));
    for (const m of opts.componentsMap) merged.set(m.componentName, m);
    editor.schema.componentsMap = [...merged.values()];
  }
  const tree = editor.schema.componentsTree;
  const cardNode = findNode(tree, 'Card');
  const textTemplate = findNode(tree, 'BaseText');
  const buttonListTemplate = findNode(tree, 'ButtonList');
  let sequence = 0;
  const nextId = (prefix) => `node_${prefix}_${sequence += 1}`;
  const makeText = (text) => {
    const node = clone(textTemplate);
    node.id = nextId('text');
    node.props = { ...node.props, text: dynamicString(text) };
    return node;
  };

  const keyed = [];
  const add = (key, node) => { if (node) keyed.push({ key, node }); };
  add('title', makeText(card.design.title));
  add('subtitle', card.design.subtitle ? makeText(card.design.subtitle) : null);
  add('content', card.design.content ? makeText(card.design.content) : null);
  const fields = fieldsText(card.design.fields);
  add('fields', fields ? makeText(fields) : null);
  if (buttonListTemplate && card.design.showButtons) {
    const list = clone(buttonListTemplate);
    list.id = nextId('buttons');
    list.props.direction = 'vertical';
    const buttonTemplate = list.props.buttons?.list?.[0];
    if (buttonTemplate) {
      const buttons = [];
      const count = Math.max(1, Math.min(6, card.design.maxOptions || 4));
      for (let index = 0; index < count; index++) {
        const button = clone(buttonTemplate);
        button.id = `opt_${index + 1}`;
        button.text = dynamicString(`\${option${index + 1}}`);
        button.actionId = dynamicString(String(index + 1));
        button.params = [{
          type: 'fixed',
          variable: '',
          value: String(index + 1),
          name: card.variables.optionParam,
          variableType: 'global',
          id: '1',
        }];
        button.color = 'blue';
        // 竖排按钮在钉钉后台不支持「是否显示（显隐）」配置，
        // 必须移除按钮上的 visible，否则导入报「组件显隐不能为空」。
        delete button.visible;
        buttons.push(button);
      }
      list.props.buttons = { ...list.props.buttons, list: buttons };
      // 竖排按钮容器同样不携带显隐配置
      delete list.props.visible;
      add('buttons', list);
    }
  }
  // 自由输入不在卡片内渲染文本输入框/提交按钮：
  // 钉钉后台模板的本地变量目前仅支持布尔值类型，且只有「选择框」组件能操作本地变量，
  // 文本输入组件无法绑定字符串本地变量（localInput/localSelect/submitBtnStatus），
  // 强行引用会导致导入钉钉后台报「选择本地变量未绑定/组件状态未绑定」。
  // 因此允许自定义输入时，引导用户直接在会话中回复文本即可（cards.js 已支持会话文本作答）。
  add('state', card.design.state ? makeText(card.design.state) : null);

  // 按设计器排定的 order 输出，保证「设计器 ↔ JSON ↔ 钉钉」顺序一致。
  const order = card.design.order ?? ['title', 'subtitle', 'content', 'fields', 'image', 'buttons', 'state'];
  const children = order.map((key) => keyed.find((item) => item.key === key)?.node).filter(Boolean);

  // 吊顶卡片使用后台官方吊顶骨架的根 Card（吊顶专属 props：hasCardHeader/showCloseButton/closeButtonColor），
  // 并保留其 linkCondition 显隐配置；消息卡片使用 im 骨架根 Card 并补显式 visible。
  const root = clone(opts.rootCard ?? cardNode);
  root.id = 'card_root';
  root.children = children;
  if (opts.rootCard) {
    // 钉钉官方吊顶关闭机制：根 Card showCloseButton=true 会在吊顶右上角渲染系统「✕」，
    // 用户点击由钉钉客户端直接关闭吊顶（100% 可靠，不依赖插件回传）。
    root.props = { ...root.props, showCloseButton: true };
  } else {
    // Ensure the root container carries an explicit visibility config, otherwise
    // the DingTalk card platform flags "组件显隐不能为空" on save/import.
    root.props = {
      ...root.props,
      visible: { type: 'dynamicVisible', value: true, valueType: 'fixed', condition: { op: 'and', conditions: [] } },
    };
  }
  editor.schema.componentsTree = [root];
  editor.variableList = textVariables(card);
  // Keep the base skeleton's extension (event-chain file list) instead of
  // wiping it, so the exported template passes DingTalk backend validation.
  // 吊顶卡片沿用后台官方吊顶骨架的 extension（extendType=NORMAL + event_chain 文件）。
  editor.extension = opts.extension
    ? clone(opts.extension)
    : {
        extendType: editor.extension?.extendType ?? 'NORMAL',
        fileTypeList: structuredClone(editor.extension?.fileTypeList ?? []),
      };
  editor.mockData = {
    ...(editor.mockData ?? {}),
    cardData: {
      title: card.name,
      subtitle: CARD_TYPE_META[card.type]?.label ?? '卡片',
      content: '这是一张由 dsh-ding-card 设计的卡片。',
      fields: '场景：消息',
      image: '',
      state: '等待处理',
      option1: '选项 A',
      option2: '选项 B',
    },
  };
  return {
    type: opts.type ?? 'im',
    mode: 'card',
    editorData: JSON.stringify(editor),
    widgetInfo: opts.widgetInfo ?? base.widgetInfo,
  };
}

function buildStandardTemplate(card, base, inputAssets) {
  const editor = clone(JSON.parse(base.editorData));
  const tree = editor.schema.componentsTree;
  const cardNode = findNode(tree, 'StdCard');
  const markdownTemplate = findNode(tree, 'Markdown');
  const buttonBlockTemplate = findNode(tree, 'ButtonBlock');
  let sequence = 0;
  const nextId = (prefix) => `node_${prefix}_${sequence += 1}`;
  const makeMarkdown = (variable, fallback = '') => {
    const node = clone(markdownTemplate);
    node.id = nextId('md');
    node.props = {
      ...node.props,
      content: variable
        ? { type: 'dynamicMarkdown', valueType: 'variable', value: '', variable, variableType: 'global' }
        : { type: 'dynamicMarkdown', valueType: 'fixed', value: fallback, variable: '', variableType: 'global' },
    };
    return node;
  };

  const keyed = [];
  const add = (key, node) => { if (node) keyed.push({ key, node }); };
  add('content', makeMarkdown('content'));
  add('fields', makeMarkdown('fields'));
  // 自由输入同样不在卡片内渲染文本输入框（钉钉本地变量仅支持布尔值+选择框，
  // 文本输入组件无法绑定本地变量），改由用户在会话中直接回复文本。
  if (card.design.showButtons && buttonBlockTemplate) {
    const block = clone(buttonBlockTemplate);
    block.id = nextId('buttons');
    block.props.direction = 'vertical';
    const buttonTemplate = block.props.buttons?.[0];
    if (buttonTemplate) {
      const count = Math.max(1, Math.min(6, card.design.maxOptions || 4));
      const buttons = Array.from({ length: count }, (_item, index) => {
        const button = clone(buttonTemplate);
        button['$$key'] = String(index);
        button.id = `opt_${index + 1}`;
        button.text = dynamicString(`\${option${index + 1}}`);
        button.actionId = dynamicString(String(index + 1));
        button.params = [{
          type: 'fixed',
          variable: '',
          value: String(index + 1),
          name: card.variables.optionParam,
          variableType: 'global',
          id: '1',
        }];
        button.successCondition = { op: 'and', conditions: [] };
        button.color = 'blue';
        // 竖排按钮不支持显隐，移除按钮上的 visible
        delete button.visible;
        return button;
      });
      block.props.buttons = buttons;
      // 竖排按钮容器同样不携带显隐配置
      delete block.props.visible;
      add('buttons', block);
    }
  }
  add('state', makeMarkdown('state'));

  // 按设计器排定的 order 输出，保证「设计器 ↔ JSON ↔ 钉钉」顺序一致。
  const order = card.design.order ?? ['title', 'subtitle', 'content', 'fields', 'image', 'buttons', 'state'];
  const children = order.map((key) => keyed.find((item) => item.key === key)?.node).filter(Boolean);

  const root = clone(cardNode);
  root.id = 'card_root';
  root.props = {
    ...root.props,
    cardName: dynamicString(card.design.title),
    tagText: dynamicString(card.design.subtitle || ''),
  };
  root.children = children;
  editor.schema.componentsTree = [root];
  editor.variableList = textVariables(card);
  editor.extension = { extendType: 'NORMAL', fileTypeList: [] };
  editor.mockData = {
    ...(editor.mockData ?? {}),
    cardData: {
      title: card.name,
      subtitle: CARD_TYPE_META[card.type]?.label ?? '卡片',
      content: '这是一张由 dsh-ding-card 设计的标准卡片。',
      fields: '场景：标准卡片',
      state: '等待处理',
      option1: '选项 A',
      option2: '选项 B',
    },
  };
  return {
    type: 'standard',
    mode: 'card',
    editorData: JSON.stringify(editor),
    widgetInfo: base.widgetInfo,
  };
}

function safeFileName(name) {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 60);
  return cleaned || 'dsh-card';
}

/** One-click export in the DingTalk card-builder import format. */
export async function exportDingtalkTemplate(cardInput) {
  const card = sanitizeCard(cardInput);
  if (card.type === 'standard') {
    const [base, inputAssets] = await Promise.all([
      loadBase('standard-template-base.json'),
      loadBase('standard-input-template.json'),
    ]);
    return { fileName: `${safeFileName(card.name)}.standard.card.json`, template: buildStandardTemplate(card, base, inputAssets) };
  }
  const [base, inputAssets] = await Promise.all([
    loadBase('im-template-base.json'),
    loadBase('im-input-template.json'),
  ]);
  if (card.type === 'ceiling') {
    // 吊顶卡片：以钉钉后台官方吊顶骨架为根（顶层 type='onebox'、吊顶根 Card、吊顶 widgetInfo），
    // 组件树仍由 im 骨架生成，保证能被「吊顶卡片」类型正确导入（type='im' 只能按消息卡片导入）。
    const ceilingBase = await loadBase('ceiling-template-base.json');
    const ced = JSON.parse(ceilingBase.editorData);
    return {
      fileName: `${safeFileName(card.name)}.card.json`,
      template: buildImTemplate(card, base, inputAssets, {
        type: 'onebox',
        rootCard: ced.schema.componentsTree[0],
        componentsMap: ced.schema.componentsMap,
        extension: ced.extension,
        widgetInfo: ceilingBase.widgetInfo,
      }),
    };
  }
  return { fileName: `${safeFileName(card.name)}.card.json`, template: buildImTemplate(card, base, inputAssets) };
}
