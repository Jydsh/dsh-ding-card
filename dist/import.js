import { sanitizeCard, CARD_TYPES } from './store.js';
/**
 * Import a DingTalk card-template JSON (as exported from the DingTalk card
 * platform, or round-tripped from this plugin's own export) back into a
 * dsh-ding-card card configuration, so the result is immediately usable.
 *
 * The importer is tolerant of the container shapes DingTalk uses:
 *   - this plugin's export: `{ type, mode, editorData: "<json>", widgetInfo }`
 *   - DingTalk editor export: `{ editorData, cardTemplateId, ... }` or a direct
 *     `{ schema: { componentsTree, ... }, variableList, mockData, ... }`
 *
 * For this plugin's own IM export (BaseText nodes whose text keeps ${title} /
 * ${content} / ... placeholders) it restores the structure precisely so the
 * round-trip keeps variable placeholders instead of flattening to sample data.
 * For other DingTalk templates it walks componentsTree generically.
 */
const TEXT_COMPONENTS = new Set(['BaseText', 'Markdown', 'Text', 'RichText']);
const BUTTON_COMPONENTS = new Set(['ButtonList', 'SingleButton', 'ButtonBlock', 'ActionButton']);
const ROOT_COMPONENTS = new Set(['Card', 'StdCard']);
/** 递归扫描组件树中所有被引用的变量名：
 * 1) ${var} 形式（钉钉 dynamicString 占位符）；
 * 2) { type: 'variableValue'|'dynamicImage'|..., variable: 'name' } 形式（钉钉变量值引用，variable 非空）。 */
function collectBoundVariables(tree) {
    const found = new Set();
    const regex = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    (function scan(node) {
        if (Array.isArray(node)) {
            node.forEach(scan);
            return;
        }
        if (!node || typeof node !== 'object')
            return;
        for (const value of Object.values(node)) {
            if (typeof value === 'string') {
                let match;
                while ((match = regex.exec(value)))
                    found.add(match[1]);
            }
            else if (value && typeof value === 'object') {
                if (typeof value.variable === 'string' && String(value.variable).trim()) {
                    found.add(String(value.variable).trim());
                }
                scan(value);
            }
        }
    })(tree);
    return found;
}
/** 收集文本组件（BaseText/Markdown/Text/RichText）中绑定的变量：
 * 用于识别「按钮回传变量」是否有对应的文本控件展示（如按钮旁显示回传内容）。 */
function collectTextBoundVariables(tree) {
    const found = new Set();
    const regex = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    walkTree(tree, (node) => {
        if (!TEXT_COMPONENTS.has(node?.componentName ?? ''))
            return;
        const props = node?.props ?? {};
        const stack = [props];
        while (stack.length) {
            const item = stack.pop();
            if (typeof item === 'string') {
                let match;
                while ((match = regex.exec(item)))
                    found.add(match[1]);
            }
            else if (item && typeof item === 'object') {
                stack.push(...Object.values(item));
            }
        }
    });
    return found;
}
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Pull plain text out of a dynamicString/dynamicMarkdown/fixed prop. */
function unwrapText(value) {
    if (value == null)
        return '';
    if (typeof value === 'string')
        return value;
    if (isObject(value)) {
        if (typeof value.content === 'string')
            return value.content;
        if (typeof value.value === 'string')
            return value.value;
        if (typeof value.text === 'string')
            return value.text;
    }
    return '';
}
function walkTree(nodes, visit) {
    for (const node of nodes ?? []) {
        if (!isObject(node))
            continue;
        visit(node);
        walkTree(node?.children, visit);
    }
}
/** Locate the editor object whether it is a JSON string or an object. */
function resolveEditor(data) {
    if (!isObject(data))
        return null;
    if (typeof data.editorData === 'string') {
        try {
            return JSON.parse(data.editorData);
        }
        catch {
            return null;
        }
    }
    if (isObject(data.editorData))
        return data.editorData;
    if (isObject(data.editor))
        return data.editor;
    if (isObject(data.schema))
        return data; // direct editor body
    return null;
}
/** 从单个按钮对象提取文案/回传参数（兼容 SingleButton 的 props 与 ButtonList 的子项）。 */
function extractButton(button) {
    const label = unwrapText(button?.text) || unwrapText(button?.label) || '';
    const params = Array.isArray(button?.params) ? button.params : [];
    const param = params.find((p) => p && typeof p?.name === 'string' && p.name) ?? params[0];
    const paramName = param && typeof param?.name === 'string' ? param.name : '';
    // 钉钉可视化编辑器：回传参数可绑定模板变量（{type:'variable', variable:'btnsAvalue'}）。
    const paramVariable = param && typeof param?.variable === 'string' && param.variable ? param.variable : '';
    const match = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(label);
    const labelVar = match ? match[1] : '';
    let value = label;
    if (param) {
        if (param.value != null && param.value !== '')
            value = String(param.value);
        else if (paramVariable)
            value = `\${${paramVariable}}`;
    }
    return { label, value, paramName, paramVariable, labelVar };
}
function collectButtons(tree) {
    const out = [];
    walkTree(tree, (node) => {
        if (!BUTTON_COMPONENTS.has(node?.componentName ?? ''))
            return;
        const props = node?.props ?? {};
        if (node.componentName === 'SingleButton' || node.componentName === 'ActionButton') {
            // 单按钮组件：文案在 props.text，回传参数在 props.params。
            out.push(extractButton(props));
            return;
        }
        const raw = props.buttons?.list ?? props.buttons ?? props.buttonList ?? [];
        const list = Array.isArray(raw) ? raw : [];
        for (const button of list) {
            if (!isObject(button))
                continue;
            const label = unwrapText(button?.text) || unwrapText(button?.label) || '';
            if (!label)
                continue;
            out.push(extractButton(button));
        }
    });
    return out;
}
function collectTexts(tree) {
    const out = [];
    walkTree(tree, (node) => {
        if (!TEXT_COMPONENTS.has(node?.componentName ?? ''))
            return;
        const props = node?.props ?? {};
        const text = unwrapText(props.text ?? props.content ?? props.textContent);
        if (text)
            out.push(text);
    });
    return out;
}
function collectRoot(tree) {
    return (tree ?? []).find((n) => ROOT_COMPONENTS.has(n?.componentName ?? '')) ?? null;
}
function firstValue(obj, keys) {
    for (const key of keys) {
        const value = obj?.[key];
        if (value !== undefined && value !== null && value !== '')
            return value;
    }
    return '';
}
/** This plugin's IM export uses BaseText nodes that keep ${...} placeholders. */
function isPluginImExport(tree) {
    let found = false;
    walkTree(tree, (node) => {
        if (node?.componentName === 'BaseText')
            found = true;
    });
    return found;
}
function parseFieldsText(text) {
    if (!text)
        return [];
    return text.split('\n').map((line) => {
        const idx = line.indexOf('：');
        if (idx === -1)
            return { label: '', value: line.trim() };
        return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    }).filter((f) => f.label || f.value).slice(0, 12);
}
/** Precise restore of this plugin's IM export (placeholder-aware). */
/** 递归收集文本组件（BaseText/Markdown/Text/RichText）的文本：
 * 覆盖 children 与 props 内嵌套组件（如 CardHeaderV2.titleAfterSlot 的 JSSlot 结构），
 * 避免头部/插槽内的 ${title} 等变量绑定被漏掉导致 title/subtitle 错配。 */
function collectTextNodesDeep(node, out) {
    if (Array.isArray(node)) {
        for (const child of node)
            collectTextNodesDeep(child, out);
        return;
    }
    if (!node || typeof node !== 'object')
        return;
    if (typeof node.componentName === 'string' && TEXT_COMPONENTS.has(node.componentName)) {
        const t = unwrapText(node.props?.text ?? node.props?.content) || '';
        if (t.trim())
            out.push(t);
    }
    if (Array.isArray(node.children))
        collectTextNodesDeep(node.children, out);
    const props = node.props;
    if (props && typeof props === 'object') {
        for (const value of Object.values(props)) {
            if (value && typeof value === 'object') {
                // JSSlot 结构：{ type: 'JSSlot', value: [组件...] }
                if (Array.isArray(value.value))
                    collectTextNodesDeep(value.value, out);
                else if (typeof value.componentName === 'string')
                    collectTextNodesDeep(value, out);
            }
        }
    }
}
/** 提取音频播放器组件的变量绑定（url / 封面 / 标题 / 歌手），
 * 供发送测试的效果预览渲染成钉钉风格的播放器卡片。无该组件时返回 null。
 * 兼容钉钉设计器两种组件名：Music（设计器导出名）与 AudioPlayer（官方文档组件名）。
 * 变量取值兼容两种形式：dynamicString ${var}、variableValue/dynamicImage 的 variable 字段。 */
function extractAudioPlayer(tree) {
    let found = null;
    const varNameOf = (value) => {
        if (!value || typeof value !== 'object')
            return '';
        if (typeof value.variable === 'string' && String(value.variable).trim()) {
            return String(value.variable).trim();
        }
        if (typeof value.content === 'string') {
            const match = value.content.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
            if (match)
                return match[1];
        }
        return '';
    };
    const scan = (node) => {
        if (!node || typeof node !== 'object')
            return;
        if (Array.isArray(node)) {
            for (const item of node)
                scan(item);
            return;
        }
        const record = node;
        const name = record.componentName ?? record.component ?? '';
        if ((name === 'Music' || name === 'AudioPlayer') && !found) {
            const props = record.props ?? {};
            found = {
                url: varNameOf(props.music) || varNameOf(props.url),
                coverUrl: varNameOf(props.cover) || varNameOf(props.coverUrl),
                title: varNameOf(props.title),
                artist: varNameOf(props.artist),
            };
            return;
        }
        if (Array.isArray(record.children))
            scan(record.children);
        const props = record.props;
        if (props && typeof props === 'object') {
            for (const value of Object.values(props)) {
                if (value && typeof value === 'object') {
                    if (Array.isArray(value.value))
                        scan(value.value);
                    else if (typeof value.componentName === 'string' || typeof value.component === 'string')
                        scan(value);
                }
            }
        }
    };
    scan(tree);
    if (!found)
        return null;
    // 只保留真正绑定了变量的字段（未绑定 = 模板静态值，不在发送测试编辑范围）。
    const result = {};
    const foundRecord = found;
    for (const [key, value] of Object.entries(foundRecord)) {
        if (value)
            result[key] = value;
    }
    return Object.keys(result).length > 0 ? result : null;
}
function parsePluginIm(tree, cardData) {
    const textNodes = [];
    collectTextNodesDeep(tree, textNodes);
    const buttons = collectButtons(tree);
    const options = buttons.map((b) => ({ label: b.label, value: b.value || b.label }));
    const optionParam = buttons.map((b) => b.paramName).find(Boolean) ?? 'dsh_option';
    let title = '';
    let subtitle = '';
    let content = '';
    let state = '';
    let fieldsText = '';
    const staticTexts = [];
    for (const text of textNodes) {
        if (text.includes('${title}'))
            title = text;
        else if (text.includes('${subtitle}'))
            subtitle = text;
        else if (text.includes('${content}'))
            content = text;
        else if (text.includes('${fields}'))
            fieldsText = text;
        else if (text.includes('${state}'))
            state = text;
        else if (text.includes('${option')) { /* option placeholder on a button, ignore */ }
        else
            staticTexts.push(text);
    }
    for (const text of staticTexts) {
        if (!title)
            title = text;
        else if (!subtitle)
            subtitle = text;
        else if (!content)
            content = text;
        else if (!state)
            state = text;
    }
    return {
        title,
        subtitle,
        content,
        fields: parseFieldsText(fieldsText),
        options,
        optionParam,
        state,
        image: firstValue(cardData, ['image']),
    };
}
/** Generic walk for arbitrary DingTalk templates. */
function parseGeneric(tree, cardData) {
    const root = collectRoot(tree);
    const title = unwrapText(root?.props?.cardName) || firstValue(cardData, ['title']);
    const subtitle = unwrapText(root?.props?.tagText) || firstValue(cardData, ['subtitle']);
    const texts = collectTexts(tree);
    const buttons = collectButtons(tree);
    const options = buttons.map((b) => ({ label: b.label, value: b.value || b.label }));
    const optionParam = buttons.map((b) => b.paramName).find(Boolean) ?? 'dsh_option';
    const body = texts.filter((t) => t && t !== title && t !== subtitle).join('\n')
        || firstValue(cardData, ['content']);
    return {
        title,
        subtitle,
        content: body,
        fields: [],
        options,
        optionParam,
        state: firstValue(cardData, ['state']),
        image: firstValue(cardData, ['image']),
    };
}
/**
 * Convert a DingTalk / plugin card-template JSON into a usable card config.
 * opts.name 可指定卡片名（例如导入文件去掉 .json 后缀的文件名），优先于 JSON 内标题。
 * @returns sanitized card (id will be regenerated by caller on save)
 */
export function importDingtalkJson(textOrObject, opts = {}) {
    const raw = typeof textOrObject === 'string' ? JSON.parse(textOrObject) : textOrObject;
    const editor = resolveEditor(raw);
    const tree = editor?.schema?.componentsTree ?? raw?.schema?.componentsTree ?? [];
    const variableList = Array.isArray(editor?.variableList)
        ? editor.variableList
        : (Array.isArray(raw?.variableList) ? raw.variableList : []);
    const cardData = isObject(editor?.mockData?.cardData)
        ? editor.mockData.cardData
        : (isObject(raw?.mockData?.cardData) ? raw.mockData.cardData : (isObject(raw?.cardData) ? raw.cardData : {}));
    const declaredNames = new Set(variableList.map((v) => (typeof v?.name === 'string' ? v.name : '')));
    const hasStd = (tree ?? []).some((n) => n?.componentName === 'StdCard');
    // 自动识别卡片类型：StdCard 组件 → 标准卡片；插件导出的吊顶模板顶层 type=onebox → 吊顶卡片；
    // 其余（含钉钉原生导出的消息模板）→ 消息卡片。
    const type = hasStd ? 'standard' : (raw?.type === 'onebox' ? 'ceiling' : 'message');
    const parsed = isPluginImExport(tree)
        ? parsePluginIm(tree, cardData)
        : parseGeneric(tree, cardData);
    const options = parsed.options;
    // 选项数量以模板声明的 optionN 变量为准（钉钉后台模板可能只声明部分选项变量，
    // 或像纯展示吊顶卡一样没有按钮组件但声明了选项变量），其次才看组件按钮数。
    const declaredOptions = variableList
        .map((v) => (typeof v?.name === 'string' ? v.name : ''))
        .filter((name) => /^option\d+$/.test(name))
        .map((name) => Number(name.replace('option', '')));
    const maxOptions = Math.min(6, Math.max(1, declaredOptions.length || options.length || 4));
    // 组件树实际绑定（${var} 占位符引用）的变量；测试参数只显示组件真正用到的字段，
    // 模板声明了但组件没绑定的变量（如副标题固定文本、未放置图片组件）不再出现。
    const bound = collectBoundVariables(tree);
    const builtinVariables = {};
    for (const key of ['title', 'subtitle', 'content', 'fields', 'image', 'state']) {
        if (bound.has(key))
            builtinVariables[key] = key;
    }
    // 按钮成组识别：SingleButton/ButtonList 按钮文案绑定变量（如 ${btnsA}）→ optionVars，
    // 回传参数绑定的变量（如 btnsAvalue）→ optionValueVars，发送时分别写入按钮文案与回传内容。
    // 校正模板中的绑定笔误：按钮文案变量名 + "value" 与回传变量名不符且预期变量存在时，以预期为准
    // （例如按钮 B 文案 ${btnsB} 却把回传参数绑到 btnsAvalue → 校正为 btnsBvalue）。
    const rawButtons = collectButtons(tree);
    const buttons = rawButtons.length > 0
        ? rawButtons
        : (parsed.options ?? []).map((o) => ({ label: o.label, value: o.value, paramName: '', paramVariable: '', labelVar: '' }));
    const correctedButtons = buttons.map((b) => {
        if (!b.labelVar || !declaredNames.has(b.labelVar))
            return b;
        const expected = `${b.labelVar}value`;
        const originalValid = !b.paramVariable || declaredNames.has(b.paramVariable);
        if ((!originalValid || b.paramVariable !== expected) && declaredNames.has(expected)) {
            return { ...b, paramVariable: expected };
        }
        return b;
    });
    let optionVars = correctedButtons.map((b) => b.labelVar).filter((n) => n && declaredNames.has(n));
    const optionValueVars = correctedButtons.map((b) => b.paramVariable).filter((n) => n && declaredNames.has(n));
    const effectiveOptions = correctedButtons.length > 0
        ? correctedButtons.map((b) => ({
            label: b.labelVar ? `\${${b.labelVar}}` : (b.label || ''),
            value: b.paramVariable || b.value || b.label,
            paramName: b.paramName || 'dsh_option',
            paramVariable: b.paramVariable || '',
        }))
        : parsed.options;
    // 回传变量中，被文本组件（BaseText/Markdown/Text/RichText）绑定的部分：
    // 表示「按钮点击回传的内容会显示在卡片文本控件中」，供发送测试区块标注提示。
    const textBound = collectTextBoundVariables(tree);
    const textValueVars = optionValueVars.filter((name) => textBound.has(name));
    if (optionVars.length === 0) {
        // 无变量占位符的按钮（legacy 固定文案）或纯 optionN 模板：回退原有 optionN 声明逻辑。
        optionVars = Array.from({ length: maxOptions }, (_e, i) => `option${i + 1}`)
            .filter((name) => bound.has(name) && declaredNames.has(name));
    }
    // 钉钉可视化模板的 mockData 提供真实示例值：导入时按变量名填充到自定义变量，
    // 发送测试与变量集 Mock 直接拿到可用默认值（仅 string 类型取字符串）。
    // 选项按钮文案变量（optionVars）标记为「按钮」类型：mock 合并为 {text: 文案, value: 回传内容}，
    // 与发送测试选项按钮区块、变量集按钮 Mock 双向绑定使用同一数据结构。
    const mockOf = (name) => (typeof name === 'string' && name && typeof cardData?.[name] === 'string' ? cardData[name] : undefined);
    const optionVarSet = new Set(optionVars);
    const customVariables = variableList.map((v) => {
        const name = firstValue(v, ['name', 'varKey', 'key']) ?? '';
        const example = firstValue(v, ['exampleValue', 'example', 'value', 'defaultValue', 'default']) ?? '';
        const mock = mockOf(name);
        if (optionVarSet.has(name)) {
            const valueMock = mockOf(`${name}value`);
            const pairIdx = optionVars.indexOf(name);
            // 按钮类型变量绑定回传内容变量：按按钮组件识别结果自动配对（用户可后续在变量集手动改绑）。
            const bindVar = (optionValueVars[pairIdx] ?? '') || `${name}value`;
            return {
                name,
                type: 'button',
                bindVar,
                exampleValue: example,
                value: { text: mock !== undefined ? mock : (example || ''), value: valueMock !== undefined ? valueMock : '' },
            };
        }
        return {
            name,
            type: firstValue(v, ['type']) ?? 'string',
            exampleValue: example,
            value: mock !== undefined ? mock : example,
        };
    });
    const card = sanitizeCard({
        // 导入文件名（去掉 .json 后缀）优先作为卡片名；没有指定时回退 JSON 内标题。
        name: (typeof opts?.name === 'string' && opts.name.trim())
            ? opts.name.trim().slice(0, 60)
            : (firstValue(cardData, ['title']) || (parsed.title || '导入的卡片')),
        type: CARD_TYPES.includes(type) ? type : 'message',
        templateId: firstValue(raw, ['cardTemplateId', 'templateId', 'cardTemplateKey']),
        aiCard: !hasStd,
        // 原始模板 JSON 与卡片绑定，供卡片库展示与下载。
        sourceJson: typeof textOrObject === 'string' ? textOrObject : JSON.stringify(textOrObject),
        variables: {
            ...builtinVariables,
            actions: 'actions',
            optionVars,
            optionValueVars,
            actionsMode: 'fixed',
            optionParam: parsed.optionParam || 'dsh_option',
            maxOptions,
        },
        customVariables,
        design: {
            title: parsed.title || '${title}',
            subtitle: parsed.subtitle || '',
            content: parsed.content || '${content}',
            fields: parsed.fields,
            options: effectiveOptions,
            image: parsed.image,
            state: parsed.state || '${state}',
            showButtons: effectiveOptions.length > 0,
            allowCustom: true,
            showOptionValue: true,
            maxOptions,
            textValueVars,
            theme: 'blue',
            buttonStyle: 'fill',
            order: ['title', 'subtitle', 'content', 'fields', 'image', 'buttons', 'state'],
            // 音频播放器（AudioPlayer）组件的变量绑定，效果预览据此渲染音乐播放器卡片。
            audioPlayer: extractAudioPlayer(tree),
        },
    });
    return card;
}
