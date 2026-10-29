import { CARD_TYPE_META } from './store.js';

/** 钉钉卡片变量类型中文名（与钉钉卡片搭建器一致）。 */
const DING_TYPE_LABELS = {
  string: '普通文本', stringArray: '普通文本数组', boolean: '布尔值', booleanArray: '布尔数组',
  number: '数字', numberArray: '数字数组', object: '对象', objectArray: '对象数组',
  richText: '富文本', chart: '图表', table: '表格', form: '表单',
  dynamicEvent: '动态事件', buttonGroup: '按钮组', button: '按钮',
  selectArray: '下拉选项数组', user: '用户信息', userArray: '用户信息数组',
};

/** Mock 示例的展示文本：按钮类对象（{text,value}）以「文案 → 回传内容」呈现，其余 JSON 化；超长内容截断展示（原始值仍在工具 output 里供读取）。 */
function mockText(mock, max = 120) {
  if (mock === undefined || mock === null) return '空';
  let text;
  try {
    if (mock && typeof mock === 'object' && !Array.isArray(mock) && 'text' in mock && 'value' in mock) {
      text = String(mock.text ?? '') + ' → ' + String(mock.value ?? '');
    } else {
      text = JSON.stringify(mock);
    }
  } catch {
    text = String(mock);
  }
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 每张卡片的可用变量及用法说明（模板变量集 + 模板自定义变量 + 选项）。 */
function describeVariables(card, templateVars = []) {
  const tv = new Map(templateVars.map((v) => [v.name, v]));
  const tvDesc = (name, fallback) => tv.get(name)?.desc || fallback;
  const tvType = (name) => tv.get(name)?.type ?? 'string';
  const optionVars = Array.isArray(card.variables?.optionVars) ? card.variables.optionVars : [];
  const optionValueVars = Array.isArray(card.variables?.optionValueVars) ? card.variables.optionValueVars : [];
  const builtin = new Set([
    'title', 'subtitle', 'content', 'fields', 'image', 'state', 'customText', 'input_status',
    ...optionVars, ...optionValueVars,
  ]);
  return [
    { name: 'title', type: tvType('title'), description: tvDesc('title', '卡片标题（普通文本）') },
    { name: 'subtitle', type: tvType('subtitle'), description: tvDesc('subtitle', '副标题（普通文本）') },
    { name: 'content', type: tvType('content'), description: tvDesc('content', '正文内容（支持 Markdown 富文本）') },
    { name: 'fields', type: tvType('fields'), description: tvDesc('fields', '字段列表 [{label,value}]，以描述项展示') },
    { name: 'image', type: tvType('image'), description: tvDesc('image', '图片 URL（普通文本）') },
    { name: 'state', type: tvType('state'), description: tvDesc('state', '状态文案（如 等待选择 / 已完成）') },
    ...optionVars.slice(0, card.design.maxOptions).map((name, index) => ({
      name,
      type: 'string',
      description: `选项按钮 ${index + 1} 文案：显示在按钮上的文字（${name} 变量）`,
    })),
    ...optionValueVars.map((name) => ({
      name,
      type: 'string',
      description: `选项按钮回传内容：点击按钮后回传并显示在按钮旁（${name} 变量）`,
    })),
    { name: 'customText', type: tvType('customText'), description: tvDesc('customText', '用户自行输入的内容（模板输入框变量）') },
    { name: 'input_status', type: tvType('input_status'), description: tvDesc('input_status', '输入框状态（如 normal / disabled）') },
    ...(card.customVariables ?? [])
      .filter((v) => !builtin.has(v.name) && !/^option\d+$/.test(v.name ?? ''))
      .map((v) => ({
        name: v.name,
        type: v.type,
        description: `模板自定义变量（类型：${DING_TYPE_LABELS[v.type] ?? '普通文本'}）${v.exampleValue ? `（示例：${v.exampleValue}）` : ''}`,
      })),
  ];
}

/** 全局变量集（模板变量 + 自定义变量全量）：Agent 可跨卡片填充的变量（名称 / 类型 / 描述 / Mock 示例 / 绑定）。 */
function describeGlobalVariables(templateVars = [], customVars = []) {
  return [...templateVars.map((v) => ({ ...v, source: 'template' })), ...customVars.map((v) => ({ ...v, source: 'custom' }))]
    .map((v) => ({
      name: v.name,
      type: v.type,
      typeLabel: DING_TYPE_LABELS[v.type] ?? v.type,
      description: v.desc || v.note || '',
      mock: v.mock,
      bindVar: v.bindVar || '',
      source: v.source,
    }))
    .filter((v) => v.name);
}

/**
 * 发送测试实际可配变量：模板 JSON 声明 ∩ 变量库定义（与发送测试弹窗左侧完全一致）。
 * 含类型 / 角色（option=选项按钮文案 / optionValue=选项回传内容 / text=文本）/ 来源 / Mock 示例，
 * 让 Agent 拿到与 UI 相同的变量清单，填充更准确。
 */
function describeSendVariables(card, templateVars = [], customVars = []) {
  const defs = new Map([...templateVars, ...customVars].map((v) => [v.name, v]));
  const declared = (() => {
    try {
      const raw = typeof card?.sourceJson === 'string' ? JSON.parse(card.sourceJson) : card?.sourceJson;
      const editor = raw?.editorData && typeof raw.editorData === 'string' ? JSON.parse(raw.editorData) : raw;
      const list = Array.isArray(editor?.variableList) ? editor.variableList : (Array.isArray(raw?.variableList) ? raw.variableList : []);
      return list
        .map((v) => ({
          name: typeof v?.name === 'string' ? v.name : (v?.varKey ?? ''),
          example: v?.exampleValue ?? v?.example ?? v?.defaultValue ?? v?.default ?? v?.value ?? '',
        }))
        .filter((v) => v.name);
    } catch { return []; }
  })();
  const optionVars = Array.isArray(card.variables?.optionVars) ? card.variables.optionVars : [];
  const optionValueVars = Array.isArray(card.variables?.optionValueVars) ? card.variables.optionValueVars : [];
  const roleOf = (name) => {
    if (optionVars.includes(name)) return 'option';
    if (optionValueVars.includes(name)) return 'optionValue';
    return 'text';
  };
  return declared
    .filter((d) => defs.has(d.name))
    .map((d) => {
      const def = defs.get(d.name);
      const role = roleOf(d.name);
      return {
        name: d.name,
        type: def?.type ?? 'string',
        typeLabel: DING_TYPE_LABELS[def?.type] ?? '普通文本',
        role,
        // 成组卡片（按钮 + 旁文本回传区，如 btnsA ↔ btnsAvalue）：true，按钮显示短标签、回传值去前缀；
        // 非成组卡片（只有按钮、无旁文本，如 option1..N / 审批同意取消）：false，按钮文案 = 回传值 = 完整文案。
        paired: role === 'option' ? optionValueVars.length > 0 : undefined,
        source: templateVars.some((v) => v.name === d.name) ? 'template' : 'custom',
        // 必填标记：常规字段 title/content 必须提供非空内容，其余可选。
        required: d.name === 'title' || d.name === 'content',
        description: (def?.desc || def?.note)
          || (role === 'option' ? `选项按钮文案（${d.name} 变量）` : role === 'optionValue' ? `选项按钮回传内容（${d.name} 变量）` : (d.example ? `示例：${d.example}` : '')),
        mock: def?.mock,
      };
    });
}

function catalog(cards, config) {
  const templateVars = config?.templateVariables ?? [];
  const customVars = config?.customVariables ?? [];
  const interactions = config?.interactions ?? {};
  return cards.map((card) => ({
    id: card.id,
    name: card.name,
    type: card.type,
    typeLabel: CARD_TYPE_META[card.type]?.label ?? card.type,
    deliverable: card.type === 'message' || card.type === 'standard',
    // 该卡可配置的选项按钮上限（AI 发送 options 不得超过此数）。
    maxOptions: card.design?.maxOptions ?? 4,
    // 交互式卡片：有选项按钮（点击会回调），AI 发送时应 wait=true 等待用户点击回传；
    // 非交互式卡片：无按钮（纯信息/音乐播放器等），直接发送即可，AI 无需等待回应。
    interactive: (card.variables?.optionVars ?? []).length > 0,
    // 该卡被插件配置用于的场景（问题选择 / 审批 / 吊顶），AI 可按场景直接选用对应卡。
    usedAs: [
      ...(interactions.questionCardId === card.id ? ['question'] : []),
      ...(interactions.approvalCardId === card.id ? ['approval'] : []),
      ...(interactions.ceilingCardId === card.id ? ['ceiling'] : []),
    ],
    description: card.description,
    bound: Boolean(card.templateId),
    variables: describeVariables(card, templateVars),
    // 发送测试弹窗左侧实际显示、可配置的变量（模板声明 ∩ 变量库），含角色与 Mock 示例。
    sendVariables: describeSendVariables(card, templateVars, customVars),
  }));
}

function guidanceFor(cards, globalVars = []) {
  const usable = cards.filter((card) => card.templateId && (card.type === 'message' || card.type === 'standard'));
  if (usable.length === 0) return '';
  const lines = usable.map((card) => (
    `- "${card.name}" (${CARD_TYPE_META[card.type]?.label ?? card.type})${card.description ? `: ${card.description}` : ''}`
  ));
  const gv = globalVars.filter((v) => v.name && v.type);
  const gvLines = gv.length > 0
    ? `Global custom variables (usable with any card, fill by name with the matching type — see ding_var_list for the full variable library and mock examples): ${gv.map((v) => `${v.name}(${DING_TYPE_LABELS[v.type] ?? v.type})`).join(', ')}.`
    : '';
  return [
    'DingTalk cards are available in this deployment (dsh-ding-card):',
    ...lines,
    gvLines,
    'Tools: ding_card_list returns each card with its "sendVariables" — the variables that card actually exposes in its send-test panel (template-declared ∩ variable library), including type, role (option/optionValue/text), paired (whether the option button has a side return-text area), source and mock example; ding_var_list returns the full variable library (template + custom) with types, mock examples and bindings. Read these before filling a card so every passed variable matches the card\'s actual variables. Mock values are reference only (format/structure): always fill real, current data and never send the mock values themselves. Option/button variables (role=option / optionValue) must be passed as {label,value} in ding_card_send\'s options array — never under the variables object, or the buttons lose their return value. For cards whose option variables have paired=false (only buttons, no side text area, e.g. plain message cards or approval agree/refuse buttons), the button shows the full text and the return value equals it — pass string options or {label,value} with value = full text; the plugin keeps the full text on the button (no short-label splitting). For paired=true cards (button + side text, e.g. btnsA↔btnsAvalue), use a short label (1–6 chars) and the full content in value; the plugin also auto-shortens prefixed options like "A. 内容".',
    'Decide which card to use by reading its purpose, parameters and usage scenario in the description above. Each card in ding_card_list also reports its maxOptions (option-button limit: send no more options than that), interactive (true = option buttons with click callbacks: send with wait=true and wait for the user\'s click to return the chosen value; false = no buttons, pure info/music player cards: send with wait=false, do not wait for a reply), usedAs (question/approval/ceiling scenes the card is configured for — use the question card for Q&A choices, the approval card for approve/deny) and sendVariables (variables + roles + paired). You may use any card whose type fits the situation; there is no fixed mapping between scenarios and cards.',
    'When ding_card_send with options returns answered:true ({value, label}) after the user clicks a button, you MUST continue that same turn and reply with an interpretation or confirmation of the chosen option (score the answer, confirm the approval result, give the next step). Never end a turn after a card click with "本轮处理已结束/没有文本回复".',
    'You decide proactively whether to use a card: whenever this conversation needs the user to choose among options, approve/reject, confirm, or wants structured info, call ding_card_send with the best-fitting card name plus title/content/options/fields — do not wait for the user to ask for a card. Fill variables by name: title, subtitle, content (Markdown), fields ([{label,value}]), image (URL), state; option1..N fill the option buttons (string or {label,value}, when provided the tool waits for the click and returns the selected value or the user\'s custom input). Custom template variables imported with a card template (see ding_card_list sendVariables and ding_var_list for names, types and mock examples) can also be passed under their own name.',
    'NEVER send blank values: title, content, options, fields and template variables must all be filled with real, non-empty content — empty or whitespace-only values are rejected and the send fails.',
    'If you need buttons that return specific values, use {label,value} options with ding_card_send. BUTTON LABEL MUST BE SHORT (1–6 chars, e.g. "A", "同意", "方案A"): the label is what renders ON the button and long labels get truncated with "…"; put the full content in value — value is shown next to the button (the button\'s return-text) and returned on click, e.g. options: [{label: "A", value: "A. 选项按钮列表"}]. DO NOT repeat options inside content: cards have their own option-button area, so content must only carry the question/context — never list "A. …/B. …" options or duplicate prompt lines such as "请选择正确答案" in content (they would render twice). Keep options[i] order aligned with the buttons one-to-one and never reuse another option\'s value. For ordinary questions that need an answer inside the agent loop, ask_user_question also renders a card with vertical option buttons and an optional free-text input.',
    'Example (ceiling music card): first call ding_card_list {card: "音乐"} to read its sendVariables (music/musicfm/musictitle/songer), then call ding_card_send {card: "音乐", title: "<real title>", variables: {music: "<real mp3 url>", musicfm: "<real cover url>", musictitle: "<real song title>", songer: "<real artist>"}} — always substitute real, current values, never copy mock examples. Option buttons: ding_card_send {card: "答题卡四选项", title: "…", content: "…", options: [{label: "A", value: "A. 选项按钮列表"}, {label: "B", value: "B. 结构化键值对区域"}]}.',
  ].filter(Boolean).join('\n');
}

export function installCardTools(ctx, { store, cards, resolveTarget, events, logger = console }) {
  if (typeof ctx?.inject !== 'function') return () => {};
  const disposers = [];
  const listDefinition = {
    name: 'ding_card_list',
    description: 'List the DingTalk card templates configured in dsh-ding-card, including name, type, purpose and whether a template ID is bound. Use this when you need to pick the right card for the current scenario — you decide proactively which card fits the conversation, do not wait for the user to request one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        card: { type: 'string', description: 'Optional card name or id to filter (fuzzy on name/description); omit to list all cards.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cards: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                type: { type: 'string' },
                typeLabel: { type: 'string' },
                deliverable: { type: 'boolean' },
                maxOptions: { type: 'number', description: '该卡最多可配置的选项按钮数量（发送 options 不得超过此上限）' },
                interactive: { type: 'boolean', description: '交互式卡片=true：有选项按钮、点击会回调，AI 发送时应 wait=true 等待用户点击回传；非交互式=false：无按钮（纯信息/音乐播放器），直接发送 wait=false，无需等待回应' },
                usedAs: { type: 'array', items: { type: 'string' }, description: '该卡被插件配置用于的场景：question=问题选择卡 / approval=审批卡 / ceiling=吊顶卡；空数组表示仅普通使用' },
                description: { type: 'string' },
                bound: { type: 'boolean' },
                variables: {
                  type: 'array',
                  description: '内置字段说明（title/content/fields/optionN 等固定字段）。该卡发送测试实际可配变量以 sendVariables 为准。',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string' },
                      type: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['name', 'description'],
                  },
                },
                sendVariables: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string' },
                      type: { type: 'string' },
                      typeLabel: { type: 'string' },
                      role: { type: 'string', description: 'option=选项按钮文案 / optionValue=选项回传内容 / text=文本变量' },
                      paired: { type: 'boolean', description: '选项按钮是否有旁文本回传显示区（成组卡 btnsA↔btnsAvalue 为 true）；false=只有按钮，按钮文案即回传值，用字符串 options 或 label=value=完整文案传' },
                      source: { type: 'string', description: '模板变量或自定义变量' },
                      required: { type: 'boolean', description: '该变量是否必填（title/content 必填，其余可选）' },
                      description: { type: 'string' },
                      mock: { description: '该变量的 Mock 示例值，仅作参考；实际发送必须用真实数据（按钮类为 {text, value} 对象）' },
                    },
                    required: ['name', 'type', 'typeLabel', 'role', 'source', 'description'],
                  },
                },
              },
              required: ['id', 'name', 'type', 'typeLabel', 'deliverable', 'description', 'bound', 'variables'],
            },
          },
          globalVariables: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                typeLabel: { type: 'string' },
                description: { type: 'string' },
                source: { type: 'string', description: '模板变量或自定义变量' },
                bindVar: { type: 'string', description: '按钮类型变量绑定的回传文本变量名' },
                mock: { description: '该变量的 Mock 示例值' },
              },
              required: ['name', 'type', 'typeLabel'],
            },
          },
        },
        required: ['cards'],
      },
      render: (_args, value) => {
        const lines = value.cards.length
          ? value.cards.map((card) => {
            const sv = (card.sendVariables ?? []).map((v) => v.name).join('、');
            const buttonCount = (card.sendVariables ?? []).filter((v) => v.role === 'option').length;
            const usage = (card.typeLabel === '吊顶卡片' ? '吊顶：仅单聊可发、一张回复最多一张；' : '')
              + (Array.isArray(card.usedAs) && card.usedAs.length > 0 ? `场景：${card.usedAs.map((u) => ({ question: '问题选择', approval: '审批', ceiling: '吊顶' }[u] ?? u)).join('、')}；` : '')
              + (card.interactive ? '交互：有按钮、点击回调，发送后等待用户回应；' : '非交互：无按钮、直接发送不等待；')
              + (buttonCount > 0 ? `选项按钮 ${buttonCount} 个（上限 ${card.maxOptions ?? 4}）；` : '');
            return card.name + '（' + card.typeLabel + '，' + (card.bound ? '已绑定' : '未绑定模板') + '）' + (card.description ? '：' + card.description : '') + (usage ? '\n  ' + usage : '') + (sv ? '\n  可配变量：' + sv : '');
          }).join('\n')
          : '还没有配置任何钉钉卡片。';
        const gv = (value.globalVariables ?? []).filter((v) => v.name && v.type);
        const gvLines = gv.length > 0
          ? '\n变量集（' + gv.length + ' 个，模板 + 自定义）：\n' + gv.map((v) => '- ${' + v.name + '}（' + v.typeLabel + '，' + (v.source === 'template' ? '模板' : '自定义') + '）' + (v.description ? '：' + v.description : '') + (v.mock !== undefined ? '\n  Mock 示例：' + mockText(v.mock) : '')).join('\n')
          : '';
        return [{ type: 'text', text: lines + gvLines + '\n\n每张卡的 sendVariables 为发送测试实际可配变量（含类型/必填/Mock），变量库明细可用 ding_var_list 查询。' }];
      },
    },
    async execute(args) {
      const config = store.get();
      let cards = config.cards ?? [];
      if (args?.card) {
        const needle = String(args.card).trim().toLowerCase();
        cards = cards.filter((c) => (c.id ?? '').toLowerCase() === needle
          || (c.name ?? '').toLowerCase().includes(needle)
          || (c.description ?? '').toLowerCase().includes(needle));
      }
      return {
        cards: catalog(cards, config),
        globalVariables: describeGlobalVariables(config.templateVariables, config.customVariables),
      };
    },
  };

  const varListDefinition = {
    name: 'ding_var_list',
    description: 'List the full variable library of dsh-ding-card: all template variables and custom variables with name, type, mock example, source and binding (bindVar). Use this to check which variables exist globally, their types and mock examples before filling them into a card, or to confirm a button variable\'s bound return-value variable. For the variables a specific card actually exposes in its send-test panel, use ding_card_list and read that card\'s sendVariables.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variables: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                typeLabel: { type: 'string' },
                source: { type: 'string', description: '模板变量或自定义变量' },
                description: { type: 'string' },
                bindVar: { type: 'string', description: '按钮类型变量绑定的回传文本变量名' },
                mock: { description: '该变量的 Mock 示例值（按钮类为 {text, value} 对象）' },
              },
              required: ['name', 'type', 'typeLabel'],
            },
          },
        },
        required: ['variables'],
      },
      render: (_args, value) => {
        const vs = (value.variables ?? []).filter((v) => v.name);
        const lines = vs.length > 0
          ? vs.map((v) => `- \${${v.name}}（${v.typeLabel}，${v.source === 'template' ? '模板变量' : '自定义变量'}）${v.description ? `：${v.description}` : ''}${v.bindVar ? `（绑定回传 → \${${v.bindVar}}）` : ''}${v.mock !== undefined ? `\n  Mock 示例：${mockText(v.mock)}` : ''}`).join('\n')
          : '变量集为空。';
        return [{ type: 'text', text: `变量集（共 ${vs.length} 个）：\n${lines}` }];
      },
    },
    async execute() {
      const config = store.get();
      return { variables: describeGlobalVariables(config.templateVariables, config.customVariables) };
    },
  };

  const sendDefinition = {
    name: 'ding_card_send',
    timeoutMs: 11 * 60 * 1000,
    description: 'Send one configured DingTalk card to the current DingTalk conversation. Proactively decide when to use it: when the user must choose among options, approve/reject, confirm, or you want to present structured info, call this automatically — even if the user did not ask for a card. Use ding_card_list to pick the card whose purpose, parameters and usage scenario match the situation. HOW TO FILL VARIABLES: ① regular fields title/subtitle/content/fields/image/state go in the same-named parameters; ② template custom variables shown in that card\'s sendVariables (role=text, e.g. music/musicfm/musictitle/songer) go under variables: { name: "value" }; ③ option button variables (role=option / optionValue, e.g. option1..N or btnsA..D) MUST be passed via the options array as {label,value} pairs — never pass option/button variables under variables, otherwise the buttons get no return value. CARDS WITHOUT A SIDE RETURN-TEXT (sendVariables option variables have paired=false, e.g. plain message cards, approval agree/refuse buttons): the button shows the full text and the return value equals it — pass string options or {label,value} with value = full text; the full text stays on the button. CARDS WITH A SIDE RETURN-TEXT (paired=true, e.g. btnsA↔btnsAvalue): use a SHORT label (1–6 chars, e.g. "A") in label and the full content in value (shown next to the button and returned on click); the plugin also auto-shortens prefixed options like "A. 内容" and strips the prefix from the side text. DO NOT repeat the options in content: the card has its own option-button area, so content should only carry the question/context text — never list the A/B/C/D options or duplicate prompt lines like "请选择正确答案" inside content, or they will render twice (once as text, once as buttons). Options array order must match the buttons one-to-one: options[i].value is what button i returns, do not reuse another option\'s value. options can be strings (then label = value = the string) or {label,value} objects; when options are provided the tool waits for the user to click and returns the selected value (or custom input). Set wait=false for an informational card that must not block. AFTER THE USER CLICKS A BUTTON the tool returns {answered:true, value, label} — you MUST continue that same turn by replying with an interpretation or confirmation of the chosen option (score the answer, confirm the approval result, give the next step); never end the turn with "本轮处理已结束/没有文本回复" after a card click. MOCK IS REFERENCE ONLY: mock examples returned by ding_card_list/ding_var_list show format/structure; you MUST substitute real, current data and never send the mock values themselves. NEVER send blank/empty values: title, content, options, fields and template variables must all carry real non-empty content, otherwise the send is rejected. IMPORTANT: only one ceiling card (吊顶) is kept per conversation — sending a ceiling card automatically closes the previous ceiling card in the same conversation first, so a single reply must send at most one ceiling card. For questions that must continue the task, ask_user_question also renders a card with an input box and returns the answer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        card: { type: 'string', description: 'Card name or id from ding_card_list.' },
        title: { type: 'string', description: 'Title text (non-empty). Defaults to the card name.' },
        subtitle: { type: 'string', description: 'Optional subtitle or tag text.' },
        content: { type: 'string', description: 'Main body text or Markdown. Must be non-empty when you intend to show body content.' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Option buttons. Each option can carry a separate callback value; the tool returns that value after the user clicks.',
        },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['label', 'value'],
          },
          description: 'Key-value rows shown in the card.',
        },
        image: { type: 'string', description: 'Optional image URL.' },
        state: { type: 'string', description: 'Footer state text, for example 等待处理.' },
        wait: { type: 'boolean', description: 'Wait for a click and return the option value. Defaults to true when options are provided.' },
        timeoutSeconds: { type: 'integer', description: 'How long to wait for a click, 30–86400 seconds. Defaults to the card library setting.' },
        variables: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra template variables, keyed by variable name.',
        },
      },
      required: ['card'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean' },
          card: { type: 'string' },
          chat: { type: 'string' },
          outTrackId: { type: 'string' },
          answered: { type: 'boolean' },
          value: { type: 'string' },
          label: { type: 'string' },
          custom: { type: 'boolean' },
          outcome: { type: 'string' },
          streamIncomplete: { type: 'boolean', description: 'AI 卡流式填充是否全部成功；true 表示部分变量流式失败，卡片可能停留在“生成中/待发送”，失败明细见插件 stream_failures.json' },
          streamNote: { type: 'string' },
        },
        required: ['sent', 'card', 'chat', 'outTrackId', 'answered'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.answered
          ? `已向${value.chat}发送钉钉卡片「${value.card}」，用户选择了：${value.custom ? value.value : `${value.label}（回传值：${value.value}）`}`
          : `已向${value.chat}发送钉钉卡片「${value.card}」，本次没有选择结果${value.outcome ? `（${value.outcome}）` : ''}。`)
          + (value.streamIncomplete ? '\n注意：卡片部分变量流式填充失败，可能停留在“生成中/待发送”，请查看钉钉；失败明细见插件 stream_failures.json。' : ''),
      }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? exec?.session?.id;
      const surface = await resolveTarget(sessionId);
      if (!surface) {
        throw Object.assign(new Error('当前会话不是钉钉会话，无法发送钉钉卡片。'), { code: 'not-dingtalk' });
      }
      const wait = args.wait;
      const timeoutSeconds = Number.isSafeInteger(args.timeoutSeconds)
        ? Math.min(86_400, Math.max(30, args.timeoutSeconds))
        : undefined;
      const result = await cards.sendChosen({
        cardId: args.card,
        bot: surface.bot,
        target: surface.target,
        sessionId: surface.sessionId,
        wait,
        signal: exec?.signal,
        ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1_000 }),
        data: {
          title: args.title,
          subtitle: args.subtitle,
          content: args.content,
          options: args.options,
          fields: args.fields,
          image: args.image,
          state: args.state,
          variables: args.variables,
        },
      });
      events.record('info', `Agent 使用卡片「${result.card.name}」`, {
        sessionId: surface.sessionId,
        answered: result.answered === true,
      });
      return {
        sent: true,
        card: result.card.name,
        chat: surface.target.kind === 'group' ? `群 ${surface.target.openConversationId}` : '钉钉单聊',
        outTrackId: result.outTrackId,
        answered: result.answered === true,
        // AI 卡流式填充是否全部成功：false 表示部分变量流式失败，卡片可能停留在“生成中/待发送”，
        // 应提醒用户查看钉钉；失败明细在插件目录 stream_failures.json。
        ...(result.streamIncomplete === true ? { streamIncomplete: true, streamNote: '卡片部分变量流式填充失败，可能停留在生成中，请查看钉钉与插件 stream_failures.json' } : {}),
        ...(result.answered ? { value: String(result.value ?? ''), label: String(result.label ?? ''), custom: result.custom === true } : {}),
        ...(!result.answered && result.outcome ? { outcome: result.outcome } : {}),
      };
    },
  };

  ctx.inject(['tools', 'systemPrompt'], (toolCtx) => {
    try {
      if (typeof toolCtx?.tools?.register === 'function') {
        toolCtx.tools.register(listDefinition);
        toolCtx.tools.register(varListDefinition);
        toolCtx.tools.register(sendDefinition);
        disposers.push(() => toolCtx.tools.unregister?.(listDefinition.name));
        disposers.push(() => toolCtx.tools.unregister?.(varListDefinition.name));
        disposers.push(() => toolCtx.tools.unregister?.(sendDefinition.name));
        toolCtx.systemPrompt.context({
          name: 'dsh-ding-card:catalog',
          order: 120,
          text: () => guidanceFor(store.get().cards, store.get().customVariables),
        });
        events.record('info', '已注册钉卡片 Agent 工具（ding_card_list / ding_var_list / ding_card_send）');
      }
    } catch (error) {
      logger.warn?.('[dsh-ding-card] failed to register card tools:', error?.message ?? error);
      events.record('warn', `注册 Agent 工具失败：${error?.message ?? error}`);
    }
  });

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose(); } catch { /* ignore */ }
    }
  };
}
