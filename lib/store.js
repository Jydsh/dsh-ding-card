import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MIN_TIMEOUT_MS = 30 * 1000;
const MAX_OPTIONS = 6;

export const CARD_TYPES = Object.freeze(['message', 'ceiling', 'contact', 'workbench', 'calendar', 'standard']);

// 钉钉卡片变量类型（与钉钉卡片搭建器「变量类型」一一对应）；
// 「button」为插件扩展的单个按钮类型（文案 + 回传内容），用于成组按钮模板识别与变量集双向绑定。
export const DING_VAR_TYPES = Object.freeze([
  'string', 'stringArray', 'boolean', 'booleanArray', 'number', 'numberArray',
  'object', 'objectArray', 'richText', 'chart', 'table', 'form',
  'dynamicEvent', 'buttonGroup', 'button', 'selectArray', 'user', 'userArray',
]);

export const CARD_TYPE_META = Object.freeze({
  message: { label: '消息卡片', deliverable: true, hint: '在钉钉会话中直接投放，支持按钮回调。' },
  ceiling: { label: '吊顶卡片', deliverable: true, hint: '固定在单聊会话顶部，需要会话管理权限。' },
  contact: { label: '通讯录卡片', deliverable: false, hint: '用于通讯录场景，当前仅支持设计与导出模板。' },
  workbench: { label: '工作台卡片', deliverable: false, hint: '用于工作台场景，当前仅支持设计与导出模板。' },
  calendar: { label: '日程卡片', deliverable: false, hint: '用于日程场景，当前仅支持设计与导出模板。' },
  standard: { label: '标准卡片', deliverable: true, hint: '钉钉标准卡片，适合展示结构化信息。' },
});

export const DESIGN_ORDER = Object.freeze(['title', 'subtitle', 'content', 'fields', 'image', 'buttons', 'state']);

export const DEFAULT_DESIGN = Object.freeze({
  title: '${title}',
  subtitle: '',
  content: '${content}',
  fields: Object.freeze([]),
  options: Object.freeze([]),
  image: '',
  state: '${state}',
  showButtons: true,
  allowCustom: true,
  showOptionValue: true,
  maxOptions: 4,
  theme: 'blue',
  buttonStyle: 'fill',
  order: DESIGN_ORDER,
});

export const DEFAULT_VARIABLES = Object.freeze({
  title: 'title',
  subtitle: 'subtitle',
  content: 'content',
  fields: 'fields',
  image: 'image',
  state: 'state',
  actions: 'actions',
  optionVars: Object.freeze(['option1', 'option2', 'option3', 'option4', 'option5', 'option6']),
  actionsMode: 'fixed',
  optionParam: 'dsh_option',
  maxOptions: 4,
});

export const DEFAULT_CONFIG = Object.freeze({
  version: 2,
  enabled: true,
  bot: Object.freeze({ mode: 'auto', clientId: '', secretRef: '' }),
  interactions: Object.freeze({
    questions: true,
    approvals: true,
    ceiling: false,
    timeoutMs: 10 * 60 * 1000,
    allowGroup: true,
    questionCardId: '',
    approvalCardId: '',
    ceilingCardId: '',
  }),
  cards: Object.freeze([]),
  // 模板变量（标准集）：与钉钉模板变量一一对应，可像自定义变量一样编辑/增删/Mock，
  // 钉钉侧变量变动后在此同步。初始为内置标准变量清单。
  templateVariables: Object.freeze([
    Object.freeze({ name: 'title', type: 'string', desc: '卡片主标题，通常作为问题的主题或卡片名称。' }),
    Object.freeze({ name: 'subtitle', type: 'string', desc: '副标题，一行补充说明（分类 / 来源 / 时间）。' }),
    Object.freeze({ name: 'content', type: 'richText', desc: '正文内容，承载主要信息、问题或详情，支持 Markdown。' }),
    Object.freeze({ name: 'fields', type: 'objectArray', desc: '结构化字段区，按“标签：值”换行展示（审批、表单类）。' }),
    Object.freeze({ name: 'image', type: 'string', desc: '配图，向正文插入一张图片（传图片 URL）。' }),
    Object.freeze({ name: 'state', type: 'string', desc: '状态文本，如 待处理 / 已完成 / 已通过，用于流程状态展示。' }),
    Object.freeze({ name: 'actions', type: 'objectArray', desc: '按钮数据（JSON 数组），由 dsh 生成选项按钮列表。' }),
    Object.freeze({ name: 'actionsMode', type: 'string', desc: '按钮排布方式：fixed=固定竖排按钮；actions=由 actions 数据驱动。' }),
    Object.freeze({ name: 'optionParam', type: 'string', desc: '按钮回传参数名，dsh 根据它识别用户点击了哪个选项。' }),
    Object.freeze({ name: 'maxOptions', type: 'number', desc: '最多渲染的按钮个数（默认 4）。' }),
    Object.freeze({ name: 'close', type: 'string', desc: '（吊顶卡片专用）✕ 关闭按钮；用户点击回传 close，插件结束该卡片会话。' }),
    Object.freeze({ name: 'option1', type: 'string', desc: '选项按钮 1 文案（钉钉模板自带绑定，与设计器 option1 对应）。' }),
    Object.freeze({ name: 'option2', type: 'string', desc: '选项按钮 2 文案（钉钉模板自带绑定，与设计器 option2 对应）。' }),
    Object.freeze({ name: 'option3', type: 'string', desc: '选项按钮 3 文案（钉钉模板自带绑定，与设计器 option3 对应）。' }),
    Object.freeze({ name: 'customText', type: 'string', desc: '用户自行输入的内容（模板输入框组件绑定的变量）。' }),
    Object.freeze({ name: 'input_status', type: 'string', desc: '输入框状态（如 normal / disabled）。' }),
    Object.freeze({ name: 'grid_object_list', type: 'objectArray', desc: '循环渲染的对象数组（每项含多个字段，如 image/title/link/id）。' }),
  ]),
  // 全局自定义变量集：独立于某张卡片的模板变量，供 Agent 与卡片模板引用。
  customVariables: Object.freeze([]),
  // 侧边栏入口显隐：auto=未绑定可用卡片时显示，配置后自动隐藏；show=始终显示；hide=始终隐藏。
  sidebar: Object.freeze({ mode: 'auto' }),
});

function cleanString(value, fallback, max = 200) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text && text.length <= max ? text : fallback;
}

function multilineString(value, fallback, max = 4_000) {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/\r\n?/g, '\n').slice(0, max);
  return text.trim() ? text : fallback;
}

function cleanBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function cleanTimeout(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(number)));
}

function cleanOptionVars(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  const output = source
    .slice(0, MAX_OPTIONS)
    .map((item) => cleanString(item, '', 64))
    .filter(Boolean);
  return output.length ? output : [...fallback];
}

function cleanFields(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((row) => ({
    label: cleanString(row?.label, '', 60),
    value: cleanString(row?.value, '', 300),
  })).filter((row) => row.label || row.value);
}

function cleanOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_OPTIONS).map((row) => ({
    label: cleanString(row?.label, '', 60),
    value: cleanString(row?.value, '', 300) || cleanString(row?.label, '', 60),
  })).filter((row) => row.label || row.value);
}

function cleanDesignOrder(value, fallback = DESIGN_ORDER) {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set();
  const out = [];
  for (const key of value) {
    if (DESIGN_ORDER.includes(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  for (const key of fallback) {
    if (!seen.has(key)) out.push(key);
  }
  return out;
}

export function sanitizeDesign(input, base = DEFAULT_DESIGN) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    title: multilineString(source.title, base.title, 200),
    subtitle: multilineString(source.subtitle, base.subtitle, 200),
    content: multilineString(source.content, base.content, 4_000),
    fields: source.fields === undefined ? structuredClone(base.fields ?? []) : cleanFields(source.fields),
    options: source.options === undefined ? structuredClone(base.options ?? []) : cleanOptions(source.options),
    image: cleanString(source.image, base.image, 600),
    state: multilineString(source.state, base.state, 200),
    showButtons: cleanBool(source.showButtons, base.showButtons),
    allowCustom: cleanBool(source.allowCustom, base.allowCustom),
    showOptionValue: cleanBool(source.showOptionValue, base.showOptionValue),
    // 回传变量中被文本组件绑定的部分（点击按钮回传的内容会显示在卡片文本控件中）。
    textValueVars: Array.isArray(source.textValueVars)
      ? source.textValueVars.map((v) => cleanString(v, '', 64)).filter(Boolean).slice(0, 12)
      : [],
    maxOptions: Math.min(MAX_OPTIONS, Math.max(1, Number.isSafeInteger(source.maxOptions)
      ? source.maxOptions : base.maxOptions)),
    theme: ['blue', 'green', 'orange', 'red', 'neutral'].includes(source.theme) ? source.theme : base.theme,
    buttonStyle: source.buttonStyle === 'outline' ? 'outline' : 'fill',
    order: cleanDesignOrder(source.order, base.order ?? DESIGN_ORDER),
    // 音频播放器（AudioPlayer）变量绑定：{url, coverUrl, title, artist}，效果预览渲染用。
    audioPlayer: source.audioPlayer && typeof source.audioPlayer === 'object' && !Array.isArray(source.audioPlayer)
      ? {
        ...(cleanString(source.audioPlayer.url, '', 64) ? { url: cleanString(source.audioPlayer.url, '', 64) } : {}),
        ...(cleanString(source.audioPlayer.coverUrl, '', 64) ? { coverUrl: cleanString(source.audioPlayer.coverUrl, '', 64) } : {}),
        ...(cleanString(source.audioPlayer.title, '', 64) ? { title: cleanString(source.audioPlayer.title, '', 64) } : {}),
        ...(cleanString(source.audioPlayer.artist, '', 64) ? { artist: cleanString(source.audioPlayer.artist, '', 64) } : {}),
      }
      : undefined,
  };
}

export function sanitizeVariables(input, base = DEFAULT_VARIABLES) {
  const source = input && typeof input === 'object' ? input : {};
  // 只清洗输入中实际存在的键；缺失键不再用默认值补全——
  // 这样钉钉模板 JSON 导入的卡片只暴露模板真正声明的变量（模板没有的字段不显示、不发送）。
  // 新建卡片（newCard）与旧配置迁移（cardFromLegacy）会显式带全量变量，不受影响。
  const result = {};
  for (const key of ['title', 'subtitle', 'content', 'fields', 'image', 'state', 'actions']) {
    if (key in source) result[key] = cleanString(source[key], '', 64);
  }
  if ('optionVars' in source) result.optionVars = cleanOptionVars(source.optionVars, []);
  // 成组按钮模板（如 btnsA ↔ btnsAvalue）：回传内容变量的名称列表，发送时写入选项 value。
  if ('optionValueVars' in source) result.optionValueVars = cleanOptionVars(source.optionValueVars, []);
  if ('actionsMode' in source) result.actionsMode = source.actionsMode === 'actions' ? 'actions' : 'fixed';
  if ('optionParam' in source) result.optionParam = cleanString(source.optionParam, '', 64);
  if ('maxOptions' in source) result.maxOptions = Math.min(MAX_OPTIONS, Math.max(1, Number.isSafeInteger(source.maxOptions)
    ? source.maxOptions : DEFAULT_VARIABLES.maxOptions));
  // 发送测试弹窗里用户拖拽的变量/选项按钮顺序（含哨兵 '__option_block__'），持久化保存。
  if ('varOrder' in source) result.varOrder = cleanVarOrder(source.varOrder);
  return result;
}

/** 变量排序透传：只保留字符串元素、去重、限量，不设默认值（未配置则返回 undefined）。 */
function cleanVarOrder(input) {
  if (!Array.isArray(input)) return undefined;
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.slice(0, 64);
}

/** 模板自定义变量：来自钉钉编辑器 JSON 的 variableList（内置变量名会去重跳过）。 */
export function sanitizeCustomVariables(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set([
    'title', 'subtitle', 'content', 'fields', 'image', 'state', 'actions',
    'customText', 'input_status',
    ...DEFAULT_VARIABLES.optionVars,
  ]);
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()) continue;
    const name = item.name.trim().slice(0, 64);
    if (seen.has(name)) continue;
    seen.add(name);
    // 类型取钉钉官方变量类型全集（含插件扩展的「button」），并兼容旧别名 image/text/date/time；
    // value 保留原结构（按钮类型的 {text, value} Mock、对象/数组等），仅做基础长度/类型约束。
    const type = (DING_VAR_TYPES.includes(item.type) || ['image', 'text', 'date', 'time'].includes(item.type))
      ? item.type : 'string';
    const value = item.value !== undefined && item.value !== null
      ? (typeof item.value === 'string' ? cleanString(item.value, '', 2000) : item.value)
      : '';
    out.push({
      name,
      type,
      exampleValue: cleanString(item.exampleValue, '', 200),
      value,
      // 按钮类型变量（type=button）：绑定的回传内容文本变量名（点击按钮回传的内容写入该变量，
      // 通常由按钮旁文本控件显示）。导入时按模板识别自动配对，用户可在变量集手动改绑。
      bindVar: cleanString(item.bindVar, '', 64),
    });
    if (out.length >= 50) break;
  }
  return out;
}

/** 全局自定义变量：变量名（不含 ${}）+ 含义 + 一行补充说明（分类 / 来源 / 时间）。 */
export function sanitizeGlobalVariables(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? '').trim();
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      // 兼容旧数据：旧版 label 即含义，迁移到 desc；note 作为补充说明保留。
      type: DING_VAR_TYPES.includes(item.type) ? item.type : 'string',
      desc: cleanString(item.desc ?? item.label ?? '', 200),
      note: cleanString(item.note ?? '', 200),
      // 按钮类型变量绑定的回传内容文本变量名（用户可手动配置）。
      bindVar: cleanString(item.bindVar, '', 64),
      mock: sanitizeMock(item.mock),
      createdAt: cleanString(item.createdAt, '', 40),
      updatedAt: cleanString(item.updatedAt, '', 40),
    });
    if (out.length >= 200) break;
  }
  return out;
}

// Mock 数据：保留任意 JSON 值（字符串/数字/布尔/数组/对象），仅限制体积，避免配置膨胀。
function sanitizeMock(mock) {
  if (mock === undefined || mock === null) return undefined;
  try {
    const text = JSON.stringify(mock);
    if (typeof text !== 'string' || text.length > 100_000) return undefined;
    return mock;
  } catch { return undefined; }
}

// 模板变量（标准集）：与自定义变量同构（name/type/desc/note/mock），可编辑增删。
export function sanitizeTemplateVariables(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? '').trim();
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      type: DING_VAR_TYPES.includes(item.type) ? item.type : 'string',
      desc: cleanString(item.desc ?? item.label ?? '', 200),
      note: cleanString(item.note ?? '', '', 200),
      // 按钮类型变量绑定的回传内容文本变量名（用户可手动配置）。
      bindVar: cleanString(item.bindVar, '', 64),
      mock: sanitizeMock(item.mock),
      createdAt: cleanString(item.createdAt, '', 40),
      updatedAt: cleanString(item.updatedAt, '', 40),
    });
    if (out.length >= 200) break;
  }
  return out;
}

export function sanitizeCard(input) {
  const source = input && typeof input === 'object' ? input : {};
  const type = CARD_TYPES.includes(source.type) ? source.type : 'message';
  return {
    id: /^card_[A-Za-z0-9_-]{1,40}$/.test(source.id ?? '') ? source.id : `card_${randomUUID().slice(0, 8)}`,
    name: cleanString(source.name, '未命名卡片', 60),
    type,
    description: multilineString(source.description, '', 300),
    templateId: cleanString(source.templateId, '', 200),
    // 导入时绑定的原始钉钉模板 JSON（用于卡片库展示/下载/重新导入）
    sourceJson: cleanString(source.sourceJson, '', 2_000_000),
    aiCard: cleanBool(source.aiCard, type !== 'standard'),
    // 回收卡片开关：交互（点击/回复）后，卡片消息从会话中收回（撤回）；
    // 勾选=true 时收回卡片，但交互信息仍用于对话生成；false 时卡片保留在会话（仅更新状态）。
    recycleOnDone: cleanBool(source.recycleOnDone, false),
    variables: sanitizeVariables(source.variables ?? DEFAULT_VARIABLES),
    design: sanitizeDesign(source.design),
    customVariables: sanitizeCustomVariables(source.customVariables),
  };
}

function cardFromLegacy(id, name, legacy, defaults = {}) {
  const source = legacy && typeof legacy === 'object' ? legacy : {};
  const maxOptions = Number.isSafeInteger(source.maxOptions) ? source.maxOptions : 4;
  return sanitizeCard({
    id,
    name,
    type: defaults.type ?? 'message',
    description: defaults.description ?? '由旧版配置迁移',
    templateId: source.templateId,
    aiCard: source.aiCard,
    variables: {
      title: source.titleVar,
      content: source.contentVar,
      state: source.stateVar,
      actions: source.actionsVar,
      optionVars: source.optionVars,
      actionsMode: source.actionsMode,
      optionParam: source.optionParam,
      maxOptions,
    },
    design: {
      title: source.title ?? defaults.title ?? '需要你的选择',
      content: '${content}',
      state: '${state}',
      showButtons: true,
      maxOptions,
    },
  });
}

function migrateV1(source) {
  const legacyCards = source.cards && typeof source.cards === 'object' ? source.cards : {};
  const cards = [
    cardFromLegacy('card_question', '提问卡片', legacyCards.question, { title: '需要你的选择' }),
    cardFromLegacy('card_approval', '审批卡片', legacyCards.approval, {
      title: '需要你的确认', description: '由旧版配置迁移（审批）',
    }),
  ];
  if (legacyCards.ceiling?.templateId) {
    cards.push(cardFromLegacy('card_ceiling', '吊顶卡片', {
      templateId: legacyCards.ceiling.templateId,
      title: '${title}',
    }, { type: 'ceiling', title: '待处理事项', description: '由旧版配置迁移（吊顶）' }));
  }
  return {
    version: 2,
    enabled: source.enabled,
    bot: source.bot,
    interactions: {
      ...(source.interactions ?? {}),
      questionCardId: 'card_question',
      approvalCardId: 'card_approval',
      ceilingCardId: cards.some((card) => card.id === 'card_ceiling') ? 'card_ceiling' : '',
    },
    cards,
  };
}

function pickDefaultCard(cards, type) {
  return cards.find((card) => card.type === type && (card.type === 'ceiling' || card.templateId))
    ?? cards.find((card) => card.type === type)
    ?? cards.find((card) => card.type === 'message')
    ?? cards[0]
    ?? null;
}

export function sanitizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const migrated = Array.isArray(source.cards) ? null : migrateV1(source);
  const raw = migrated ?? source;
  const cards = Array.isArray(raw.cards) ? raw.cards.slice(0, 60).map(sanitizeCard) : [];
  const ids = new Set(cards.map((card) => card.id));
  const interactions = raw.interactions && typeof raw.interactions === 'object' ? raw.interactions : {};
  const questionDefault = pickDefaultCard(cards.filter((card) => card.type !== 'ceiling'), 'message');
  const approvalDefault = pickDefaultCard(cards.filter((card) => card.type !== 'ceiling'), 'standard')
    ?? questionDefault;
  const ceilingDefault = cards.find((card) => card.type === 'ceiling') ?? null;
  const pick = (value, fallback) => (typeof value === 'string' && ids.has(value) ? value : fallback?.id ?? '');
  return {
    version: 2,
    enabled: cleanBool(raw.enabled, DEFAULT_CONFIG.enabled),
    bot: {
      mode: source.bot?.mode === 'manual' ? 'manual' : 'auto',
      clientId: cleanString(source.bot?.clientId, '', 128),
      secretRef: cleanString(source.bot?.secretRef, '', 128),
    },
    interactions: {
      questions: cleanBool(interactions.questions, DEFAULT_CONFIG.interactions.questions),
      approvals: cleanBool(interactions.approvals, DEFAULT_CONFIG.interactions.approvals),
      ceiling: cleanBool(interactions.ceiling, DEFAULT_CONFIG.interactions.ceiling),
      timeoutMs: cleanTimeout(interactions.timeoutMs, DEFAULT_CONFIG.interactions.timeoutMs),
      allowGroup: cleanBool(interactions.allowGroup, DEFAULT_CONFIG.interactions.allowGroup),
      questionCardId: pick(interactions.questionCardId, questionDefault),
      approvalCardId: pick(interactions.approvalCardId, approvalDefault),
      ceilingCardId: pick(interactions.ceilingCardId, ceilingDefault),
    },
    cards,
    templateVariables: sanitizeTemplateVariables(raw.templateVariables ?? DEFAULT_CONFIG.templateVariables),
    customVariables: sanitizeGlobalVariables(raw.customVariables),
    sidebar: {
      mode: raw.sidebar?.mode === 'show' || raw.sidebar?.mode === 'hide' ? raw.sidebar.mode : 'auto',
    },
  };
}

export function configPath() {
  const home = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  return join(home, 'integrations', 'dsh-ding-card', 'config.json');
}

export class CardConfigStore {
  #path;
  #config = sanitizeConfig(DEFAULT_CONFIG);
  #loaded = false;
  #writing = Promise.resolve();

  constructor(path = configPath()) {
    this.#path = resolve(path);
  }

  get path() {
    return this.#path;
  }

  get() {
    return structuredClone(this.#config);
  }

  async load() {
    try {
      const raw = await readFile(this.#path, 'utf8');
      this.#config = sanitizeConfig(JSON.parse(raw.replace(/^\uFEFF/, '')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#config = sanitizeConfig(DEFAULT_CONFIG);
    }
    this.#loaded = true;
    return this.get();
  }

  async save(input) {
    this.#config = sanitizeConfig(input);
    this.#loaded = true;
    const payload = `${JSON.stringify(this.#config, null, 2)}\n`;
    const path = this.#path;
    this.#writing = this.#writing.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      await writeFile(temp, payload, 'utf8');
      await rename(temp, path);
    });
    await this.#writing;
    return this.get();
  }

  async patch(partial) {
    return this.save(mergeConfig(this.get(), partial));
  }

  get loaded() {
    return this.#loaded;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, partial) {
  if (!isRecord(partial)) return base;
  return {
    ...base,
    ...(partial.enabled === undefined ? {} : { enabled: partial.enabled }),
    bot: isRecord(partial.bot) ? { ...base.bot, ...partial.bot } : base.bot,
    interactions: isRecord(partial.interactions)
      ? { ...base.interactions, ...partial.interactions }
      : base.interactions,
    cards: Array.isArray(partial.cards) ? partial.cards : base.cards,
    templateVariables: Array.isArray(partial.templateVariables)
      ? sanitizeTemplateVariables(partial.templateVariables)
      : base.templateVariables,
    customVariables: Array.isArray(partial.customVariables)
      ? sanitizeGlobalVariables(partial.customVariables)
      : base.customVariables,
    sidebar: isRecord(partial.sidebar)
      ? { mode: partial.sidebar.mode === 'show' || partial.sidebar.mode === 'hide' ? partial.sidebar.mode : 'auto' }
      : base.sidebar,
  };
}
