import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCardData, sampleData } from './export.js';

const CLOSED_STATE = '已完成';
const TIMEOUT_STATE = '已超时';
const CANCELLED_STATE = '已取消';
const MAX_CONTENT = 2_800;

/** 发送测试卡的回调上下文持久化文件：DSH 重启后仍能处理重启前发送的测试卡片。 */
const CALLBACK_TRACKS_PATH = path.join(os.homedir(), '.dsh', 'integrations', 'dsh-ding-card', 'callback_tracks.json');
const TRACKS_MAX = 200;
const TRACKS_TTL_MS = 7 * 24 * 3600 * 1000;

function loadTracks() {
  try {
    const text = readFileSync(CALLBACK_TRACKS_PATH, 'utf8').replace(/^\uFEFF/, '');
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

function saveTracks(map) {
  try {
    mkdirSync(path.dirname(CALLBACK_TRACKS_PATH), { recursive: true });
    writeFileSync(CALLBACK_TRACKS_PATH, JSON.stringify(map), 'utf8');
  } catch { /* 持久化失败不影响主流程 */ }
}

function writeDebug(obj) {
  try {
    const dir = path.join(os.homedir(), '.dsh', 'integrations', 'dsh-ding-card');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'debug_recall.json'), `${JSON.stringify(obj)}\n`, 'utf8');
  } catch {}
}

/** 流式填充失败明细落盘（JSONL）：用户/开发者可直接在插件目录自查失败变量、错误码与内容长度。 */
const STREAM_FAILURES_PATH = path.join(os.homedir(), '.dsh', 'integrations', 'dsh-ding-card', 'stream_failures.json');
function writeStreamFailure(record) {
  try {
    mkdirSync(path.dirname(STREAM_FAILURES_PATH), { recursive: true });
    appendFileSync(STREAM_FAILURES_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {}
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Read the button payload out of a DingTalk card callback. */
export function callbackParams(callback) {
  const content = parseJson(callback?.content) ?? {};
  const privateData = parseJson(content?.cardPrivateData) ?? parseJson(callback?.cardPrivateData) ?? {};
  const rawParams = privateData?.params ?? content?.params ?? callback?.params ?? {};
  const params = parseJson(rawParams) ?? (rawParams && typeof rawParams === 'object' ? rawParams : {});
  const actionIds = Array.isArray(privateData?.actionIds)
    ? privateData.actionIds
    : Array.isArray(content?.actionIds) ? content.actionIds : [];
  return {
    params,
    actionIds: actionIds.map(String),
    raw: content,
  };
}

export function pickChoice(callback, optionParam, options) {
  const { params, actionIds } = callbackParams(callback);
  const keys = [optionParam, 'dsh_option', 'choice', 'option', 'actionId', 'action'].filter(Boolean);
  const candidates = [];
  for (const key of keys) {
    const value = params[key];
    if (value !== undefined && value !== null) candidates.push(String(value));
  }
  candidates.push(...actionIds);
  const matchList = Array.isArray(options) ? options : [];
  for (const token of candidates) {
    const match = matchList.find((option) => (
      option.id === token || option.label === token || option.value === token
    ));
    if (match) return match;
  }
  const text = stringValue(params.dsh_text);
  if (text) return { id: 'custom', label: text, custom: true };
  return null;
}

const APPROVAL_ALLOW = new Set(['allow', 'allowed', 'allowed-once', 'approve', 'approved', 'accept', 'agree', 'ok', 'yes', '1']);
const APPROVAL_DENY = new Set(['deny', 'denied', 'reject', 'rejected', 'refuse', 'cancel', 'no', '0', '2']);

/** Approval templates in the wild use action/approved/deny wording. */
export function pickApproval(callback, optionParam) {
  const { params, actionIds } = callbackParams(callback);
  const tokens = [
    params[optionParam], params.dsh_decision, params.action, params.choice,
    params.option, params.actionId, ...actionIds,
  ].filter((value) => value !== undefined && value !== null).map((value) => String(value).trim().toLowerCase());
  for (const token of tokens) {
    if (APPROVAL_ALLOW.has(token)) return { id: 'allow', label: '允许一次' };
    if (APPROVAL_DENY.has(token)) return { id: 'deny', label: '拒绝' };
  }
  return null;
}

export function questionMarkdown(question, options) {
  const lines = [];
  if (question.header) lines.push(`**${question.header}**`);
  lines.push(question.question);
  if (question.detail) lines.push('', question.detail);
  if (options.length) {
    lines.push('');
    for (const option of options) {
      lines.push(`${option.id}. ${option.label}${option.description ? ` — ${option.description}` : ''}`);
    }
    lines.push('', '请点击卡片上的选项，也可以直接在会话里回复。');
  }
  return lines.join('\n').slice(0, MAX_CONTENT);
}

/**
 * Pick the card a human-interaction seam should auto-use.
 * No longer bound to a fixed per-kind card id: same type may have many
 * template variants, so we auto-choose the first bound card of the matching
 * type. Agent-initiated sends go through ding_card_send with an explicit card.
 */
export function selectCard(config, kind) {
  const cards = Array.isArray(config.cards) ? config.cards : [];
  if (kind === 'ceiling') {
    return cards.find((card) => card.type === 'ceiling' && card.templateId)
      ?? cards.find((card) => card.type === 'ceiling')
      ?? null;
  }
  const order = kind === 'approval' ? ['standard', 'message'] : ['message', 'standard'];
  for (const type of order) {
    const chosen = cards.find((card) => card.type === type && card.templateId);
    if (chosen) return chosen;
  }
  return cards.find((card) => card.type === 'message' || card.type === 'standard') ?? null;
}

/**
 * Card lifecycle for questions, approvals and agent-chosen cards.
 */
export function createCardService({ api, store, bridge, events, logger = console }) {
  const serviceId = randomUUID();
  const pending = new Map();
  const ceilingTracks = new Map();
  const seenCallbacks = new Set();
  const testOutTracks = new Map();
  const counters = {
    questions: 0,
    approvals: 0,
    sent: 0,
    answered: 0,
    timedOut: 0,
    failed: 0,
    ceilingOpened: 0,
  };

  function updatePendingCount() {
    counters.pending = pending.size;
  }

  function deliverable(card) {
    // 消息/标准/吊顶卡均可直接投递（吊顶卡在 send() 内走 createTopBox 专用分支）。
    return card && (card.type === 'message' || card.type === 'standard' || card.type === 'ceiling');
  }

  function finish(entry, { state, outcome, reason }) {
    if (entry.closed) return false;
    entry.closed = true;
    pending.delete(entry.outTrackId);
    updatePendingCount();
    clearTimeout(entry.timer);
    entry.timer = null;
    const isCeiling = entry.card?.type === 'ceiling';
    // 吊顶关闭交由用户在钉钉聊天页手动操作（系统 ✕），插件不再自动关闭吊顶；
    // 这里仅清理回调路由索引，避免内存残留。
    if (entry.ceilingOutTrackId) ceilingTracks.delete(entry.ceilingOutTrackId);
    // 回收卡片开关（仅普通/标准卡片）：勾选( recycleOnDone )时，交互后撤回主卡片消息，像没出现过；
    // 交互信息已通过回调用于对话生成，不影响后续。不勾选时卡片保留，仅更新状态为已处理。
    if (!isCeiling) {
      if (entry.recycleOnDone && entry.processQueryKey) {
        writeDebug({ step: 'finish-recall-start', recycleOnDone: entry.recycleOnDone, processQueryKey: entry.processQueryKey, outTrackId: entry.outTrackId, kind: entry.kind });
        api.recallMessage({
          clientId: entry.bot.clientId,
          clientSecret: entry.bot.clientSecret,
          target: entry.target,
          processQueryKeys: [entry.processQueryKey],
        }).then((res) => {
          writeDebug({ step: 'finish-recall-ok', processQueryKey: entry.processQueryKey, result: res });
          events.record('info', `卡片消息已成功回收（${entry.kind === 'approval' ? '审批' : '卡片'}）`, {
            kind: entry.kind,
            outTrackId: entry.outTrackId,
            processQueryKey: entry.processQueryKey,
          });
        }).catch((error) => {
          writeDebug({ step: 'finish-recall-err', processQueryKey: entry.processQueryKey, error: { message: error?.message, code: error?.code, detail: error?.detail } });
          events.record('error', `卡片消息回收失败：${error?.message ?? error}`, {
            code: error?.code,
            detail: error?.detail,
            outTrackId: entry.outTrackId,
          });
        });
      } else if (entry.outTrackId && entry.variables?.state) {
        writeDebug({ step: 'finish-update-state', recycleOnDone: entry.recycleOnDone, processQueryKey: entry.processQueryKey, outTrackId: entry.outTrackId });
        void api.updateCard({
          clientId: entry.bot.clientId,
          clientSecret: entry.bot.clientSecret,
          outTrackId: entry.outTrackId,
          cardParamMap: { [entry.variables.state]: state },
        }).catch(() => undefined);
      } else {
        writeDebug({ step: 'finish-skip', recycleOnDone: entry.recycleOnDone, processQueryKey: entry.processQueryKey, outTrackId: entry.outTrackId, hasState: Boolean(entry.variables?.state) });
      }
    }
    entry.settle({ outcome, reason });
    events.record('info', `卡片已结束：${entry.kind === 'approval' ? '审批' : '卡片'}（${state}）`, {
      kind: entry.kind,
      outTrackId: entry.outTrackId,
      sessionId: entry.sessionId,
    });
    return true;
  }

  function armTimeout(entry, timeoutMs) {
    const timer = setTimeout(() => {
      if (entry.closed) return;
      // 等待超时是正常路径（用户不点卡片就交回会话），记录为信息而非警告，避免刷屏。
      events.record('info', '卡片等待超时，交回会话继续', { kind: entry.kind, outTrackId: entry.outTrackId });
      counters.timedOut += 1;
      finish(entry, { state: TIMEOUT_STATE, outcome: 'timeout' });
    }, timeoutMs);
    timer.unref?.();
    entry.timer = timer;
  }

  /**
   * 流式填充（钉钉 AI 卡「输入中」动画）：逐 key 填充模板变量，末 key isFinalize 收口。
   * 防御：单个 key 失败重试一次（瞬时网络/限流可解）；仍失败则记录到插件内部
   * stream_failures.json（含错误码与内容长度）并记录事件，便于用户侧自查定位。
   * @returns {Promise<{streamKeys: string[], failures: {key: string, code: string|null, message: string}[]}>}
   */
  async function streamFillCard(card, params, outTrackId, bot) {
    const streamKeys = Object.keys(params).filter((key) => key && key !== card.variables?.image);
    const failures = [];
    for (let index = 0; index < streamKeys.length; index += 1) {
      const key = streamKeys[index];
      const isFinalize = index === streamKeys.length - 1;
      const content = params[key] ?? '';
      const attempt = () => api.streamCard({
        clientId: bot.clientId,
        clientSecret: bot.clientSecret,
        outTrackId,
        key,
        content,
        isFinalize,
      });
      try {
        await attempt();
      } catch (error) {
        // 收口失败会让卡片停留在「输入中/生成中」，进而阻塞该会话后续的 AI 卡片回复；重试一次。
        try {
          await attempt();
        } catch (error2) {
          failures.push({
            key,
            code: error2?.code ?? null,
            message: String(error2?.message ?? error2).slice(0, 200),
          });
        }
      }
    }
    if (failures.length > 0) {
      writeStreamFailure({
        ts: new Date().toISOString(),
        outTrackId,
        card: card.name,
        total: streamKeys.length,
        failures,
      });
      events.record('warn', `AI 卡片「${card.name}」流式填充不完整（${failures.length}/${streamKeys.length} 个变量失败：${failures.map((f) => f.key).join('、')}），卡片可能停留在生成中状态；明细见插件 stream_failures.json`, { outTrackId });
    }
    return { streamKeys, failures };
  }

  /**
   * AI 卡片模板创建的吊顶实例默认停留在「输入中」状态：不调用流式收口接口完结的话，
   * 钉钉会话会一直显示空白的处理中卡片，并顶替/干扰同会话后续的消息回复
   * （表现为机器人回复空白 + “回复生成失败”，而 DSH 桌面端正常）。
   * 创建吊顶后对模板变量做一次流式填充并 isFinalize 完结，与 rpc.js 测试路径一致。
   */
  async function finalizeAiCeiling(card, params, outTrackId, bot, target) {
    if (!card.aiCard) return;
    await streamFillCard(card, params, outTrackId, bot);
  }

  /**
   * 同一会话只保留一张吊顶卡：发送新吊顶前，先关闭该机器人+该用户已有吊顶，
   * 避免同轮/短时间连发多张吊顶卡时出现多个“生成中”实例，导致钉钉会话后续回复失败。
   */
  async function closeCeilingForChat(bot, target) {
    if (target?.kind !== 'user') return;
    const stale = [...ceilingTracks.entries()].filter(([, entry]) =>
      entry?.bot?.clientId === bot?.clientId && entry?.target?.userId === target?.userId);
    for (const [outTrackId] of stale) {
      try {
        await api.closeTopBox({
          clientId: bot.clientId,
          clientSecret: bot.clientSecret,
          target,
          outTrackId,
        });
        events.record('info', '发送新吊顶前已关闭同会话旧吊顶', { outTrackId });
      } catch (error) {
        events.record('warn', `关闭同会话旧吊顶失败：${error?.message ?? error}`, { outTrackId, code: error?.code });
      }
      ceilingTracks.delete(outTrackId);
    }
  }

  async function openCeiling(entry, data) {
    const config = store.get();
    if (!config.interactions.ceiling || entry.target.kind !== 'user') return;
    const ceilingCard = selectCard(config, 'ceiling');
    if (!ceilingCard?.templateId) return;
    const outTrackId = `dsh_ceiling_${randomUUID()}`;
    const { params } = buildCardData(ceilingCard, data);
    try {
      await closeCeilingForChat(entry.bot, entry.target);
      await api.createTopBox({
        clientId: entry.bot.clientId,
        clientSecret: entry.bot.clientSecret,
        target: entry.target,
        cardTemplateId: ceilingCard.templateId,
        outTrackId,
        cardParamMap: params,
      });
      await finalizeAiCeiling(ceilingCard, params, outTrackId, entry.bot, entry.target);
      entry.ceilingOutTrackId = outTrackId;
      ceilingTracks.set(outTrackId, entry);
      counters.ceilingOpened += 1;
      events.record('info', '已开启钉钉吊顶卡片', { outTrackId });
    } catch (error) {
      events.record('warn', `吊顶卡片开启失败：${error?.message ?? error}`, { code: error?.code });
    }
  }

  async function send({ card, bot, target, sessionId, data, kind = 'card' }) {
    const built = buildCardData(card, data);
    const options = built.options.map((option, index) => ({
      id: String(index + 1),
      // 按钮文案一律纯文案（label）：回传内容走 value，不拼进按钮显示文案。
      label: option.label || option.text,
      value: option.value,
      rawLabel: option.label,
    }));
    const outTrackId = `dsh_card_${randomUUID()}`;

    if (card.type === 'ceiling') {
      if (target.kind !== 'user') throw Object.assign(new Error('吊顶卡片仅支持单聊会话。'), { code: 'unsupported-target' });
      await closeCeilingForChat(bot, target);
      const ceilingPayload = await api.createTopBox({
        clientId: bot.clientId,
        clientSecret: bot.clientSecret,
        target,
        cardTemplateId: card.templateId,
        outTrackId,
        cardParamMap: built.params,
      });
      await finalizeAiCeiling(card, built.params, outTrackId, bot, target);
      counters.sent += 1;
      // 记录到内存吊顶索引：后续同一会话再发吊顶卡时先关闭它，保持会话顶部只保留最新一张。
      ceilingTracks.set(outTrackId, { kind: 'agent', card, bot, target, sessionId, outTrackId });
      return {
        outTrackId,
        options,
        built,
        processQueryKey: ceilingPayload?.result?.processQueryKey ?? null,
      };
    }
    if (!deliverable(card)) {
      throw Object.assign(new Error(`「${card.name}」类型为 ${card.type}，当前不能直接投放到会话。`), {
        code: 'unsupported-card-type',
      });
    }
    const deliverPayload = await api.createAndDeliverCard({
      clientId: bot.clientId,
      clientSecret: bot.clientSecret,
      target,
      cardTemplateId: card.templateId,
      outTrackId,
      cardParamMap: built.params,
    });
    const recallKey = deliverPayload?.result?.deliverResults?.[0]?.carrierId
      ?? deliverPayload?.result?.processQueryKey
      ?? null;
    let streamIncomplete = false;
    if (card.aiCard) {
      // AI 卡片的按钮区/文本区为流式渲染：除图片外全部变量都通过 streamCard 逐 key 填充，
      // 否则按钮文案（cardData.btnsA 等）停留在待填充状态不显示。
      // 任一 key 流式失败都会导致收口不完整、卡片停留在“生成中/待发送”：streamFillCard 内
      // 已做一次重试，并把失败明细落盘 stream_failures.json + 记录事件。
      const { failures } = await streamFillCard(card, built.params, outTrackId, bot);
      streamIncomplete = failures.length > 0;
    }
    counters.sent += 1;
    events.record('info', `已投放钉钉卡片「${card.name}」`, {
      outTrackId,
      kind,
      chat: target.kind === 'group' ? `群 ${target.openConversationId}` : `单聊 ${target.userId}`,
      processQueryKey: recallKey,
    });
    return {
      outTrackId,
      options,
      built,
      processQueryKey: recallKey,
      // AI 卡流式填充是否全部成功；false 时卡片可能停留在生成中，明细见插件 stream_failures.json。
      streamIncomplete,
    };
  }

  async function present({ kind, card, bot, target, sessionId, data, timeoutMs }) {
    const entry = {
      kind,
      card,
      variables: card.variables,
      recycleOnDone: card.recycleOnDone === true,
      target,
      bot,
      sessionId,
      outTrackId: null,
      ceilingOutTrackId: null,
      processQueryKey: null,
      ceilingProcessQueryKey: null,
      closed: false,
      timer: null,
      options: [],
      settle: null,
    };
    const promise = new Promise((resolve) => { entry.settle = resolve; });
    armTimeout(entry, timeoutMs);
    try {
      const sent = await send({ card, bot, target, sessionId, data, kind });
      entry.outTrackId = sent.outTrackId;
      entry.options = sent.options;
      entry.processQueryKey = sent.processQueryKey ?? null;
      if (entry.closed) {
        return { get outTrackId() { return entry.outTrackId; }, promise, dismiss() {} };
      }
      // 吊顶卡片不做回调：仅展示（右上角系统 ✕ 由钉钉客户端直接关闭，由用户手动关闭吊顶）。
      // 因此吊顶卡片不注册 pending 等待其回传，避免插件空等吊顶卡片的回调。
      if (entry.card?.type !== 'ceiling') {
        pending.set(sent.outTrackId, entry);
        updatePendingCount();
      }
      if (kind === 'approval') counters.approvals += 1;
      else if (kind === 'question') counters.questions += 1;
      // 吊顶只用于「等待用户操作」的提问/审批卡片（固定在顶部提醒处理）；
      // 普通消息卡片（kind='card'）发送后不自动开吊顶，避免用户感知为「多发了一张吊顶卡」。
      if (entry.kind === 'question' || entry.kind === 'approval') {
        void openCeiling(entry, data);
      }
    } catch (error) {
      counters.failed += 1;
      clearTimeout(entry.timer);
      entry.closed = true;
      entry.settle({ outcome: 'unavailable', reason: error });
      events.record('error', `卡片投放失败：${error?.message ?? error}`, { code: error?.code, detail: error?.detail });
    }
    return {
      get outTrackId() { return entry.outTrackId; },
      promise,
      dismiss(reason = 'cancelled') {
        if (entry.closed) return;
        finish(entry, { state: CANCELLED_STATE, outcome: 'cancelled', reason });
      },
    };
  }

  async function presentQuestion({ bot, target, sessionId, questions, timeoutMs }) {
    const config = store.get();
    const card = selectCard(config, 'question');
    if (!card) throw Object.assign(new Error('没有可用的提问卡片。'), { code: 'no-card' });
    const question = questions[0];
    const options = (question.options ?? []).map((option) => option.label);
    return present({
      kind: 'question',
      card,
      bot,
      target,
      sessionId,
      timeoutMs,
      data: {
        title: question.header || card.name,
        content: questionMarkdown(question, (question.options ?? []).map((option, index) => ({
          id: String(index + 1), label: option.label, description: option.description,
        }))),
        state: '等待选择',
        options,
      },
    });
  }

  async function presentApproval({ bot, target, sessionId, request, timeoutMs }) {
    const config = store.get();
    const card = selectCard(config, 'approval');
    if (!card) throw Object.assign(new Error('没有可用的审批卡片。'), { code: 'no-card' });
    return present({
      kind: 'approval',
      card,
      bot,
      target,
      sessionId,
      timeoutMs,
      data: {
        title: card.name,
        content: '是否允许这一次操作？',
        state: '等待审批',
        fields: [
          { label: '工具', value: request.toolName || '未知工具' },
          ...(request.reason ? [{ label: '原因', value: request.reason }] : []),
        ],
        options: ['允许一次', '拒绝'],
        optionIds: ['allow', 'deny'],
      },
    });
  }

  /** Reject blank card params so the agent cannot send empty values. */
  function assertCardDataNonEmpty(data) {
    if (!data || typeof data !== 'object') return;
    for (const key of ['title', 'subtitle', 'content', 'state', 'image']) {
      if (data[key] !== undefined && data[key] !== null && String(data[key]).trim() === '') {
        throw Object.assign(new Error(`卡片参数 ${key} 不能为空，请提供真实内容。`), { code: 'empty-param' });
      }
    }
    if (Array.isArray(data.options) && data.options.some((o) => !o || (typeof o === 'string' ? !o.trim() : !String(o?.label ?? '').trim()))) {
      throw Object.assign(new Error('卡片选项 options 不能包含空值。'), { code: 'empty-param' });
    }
    if (Array.isArray(data.fields) && data.fields.some((f) => !f || !String(f?.label ?? '').trim())) {
      throw Object.assign(new Error('卡片字段 fields 的 label 不能为空。'), { code: 'empty-param' });
    }
    if (data.variables && typeof data.variables === 'object') {
      for (const [key, value] of Object.entries(data.variables)) {
        if (value === '' || value === null || value === undefined) {
          throw Object.assign(new Error(`模板变量 ${key} 不能为空。`), { code: 'empty-param' });
        }
      }
    }
  }

  async function sendChosen({ cardId, bot, target, sessionId, data, wait, timeoutMs, signal }) {
    assertCardDataNonEmpty(data);
    const config = store.get();
    const card = config.cards.find((item) => item.id === cardId || item.name === cardId);
    if (!card) throw Object.assign(new Error(`没有找到卡片：${cardId}`), { code: 'unknown-card' });
    if (!card.templateId) throw Object.assign(new Error(`卡片「${card.name}」还没有绑定模板 ID。`), { code: 'no-template' });
    const summary = { id: card.id, name: card.name, type: card.type };
    // 吊顶卡片不做回调：无论是否配置选项，一律纯展示发送，不进入 pending 等待回传。
    const isCeilingCard = card.type === 'ceiling';
    const shouldWait = !isCeilingCard && (wait === undefined
      ? ((Array.isArray(data?.options) && data.options.length > 0) || (card.design.options?.length ?? 0) > 0)
      : wait === true);
    if (!shouldWait) {
      const sent = await send({ card, bot, target, sessionId, data, kind: 'agent' });
      return { card: summary, ...sent, answered: false };
    }
    const surface = await present({
      kind: 'agent',
      card,
      bot,
      target,
      sessionId,
      data,
      timeoutMs: timeoutMs ?? config.interactions.timeoutMs,
    });
    const onAbort = () => surface.dismiss('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await surface.promise;
      if (result.outcome === 'answered') {
        return {
          card: summary,
          outTrackId: surface.outTrackId,
          answered: true,
          value: result.reason?.value ?? result.reason?.label,
          label: result.reason?.rawLabel ?? result.reason?.label,
          custom: result.reason?.custom === true,
        };
      }
      return { card: summary, outTrackId: surface.outTrackId, answered: false, outcome: result.outcome };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function handleCallback(callback, meta = {}) {
    const receivedAt = Date.now();
    writeDebug({ step: 'callback-received', at: receivedAt, callback, meta, topic: meta?.topic ?? null });
    const messageId = meta.messageId ?? callback?.messageId ?? null;
    writeDebug({ step: 'cb-1', messageId, seen: Boolean(messageId && seenCallbacks.has(messageId)) });
    if (messageId) {
      if (seenCallbacks.has(messageId)) return;
      seenCallbacks.add(messageId);
      if (seenCallbacks.size > 2_000) seenCallbacks.delete(seenCallbacks.values().next().value);
    }
    const outTrackId = stringValue(callback?.outTrackId ?? callback?.out_track_id);
    writeDebug({ step: 'cb-2', outTrackId });
    if (!outTrackId) return;
    const entry = pending.get(outTrackId) ?? ceilingTracks.get(outTrackId);
    writeDebug({ step: 'cb-3', hasEntry: Boolean(entry), hasTest: testOutTracks.has(outTrackId), testSize: testOutTracks.size });
    if (!entry) {
      let testInfo = null;
      try {
        testInfo = testOutTracks.get(outTrackId) ?? null;
        if (!testInfo) {
          // 内存未命中：DSH 重启后从磁盘恢复发送测试卡的上下文，使重启前发送的
          // 测试卡片仍可回调（回收/记录）。
          const stored = loadTracks()[outTrackId] ?? null;
          if (stored?.info) {
            testInfo = stored.info;
            testOutTracks.set(outTrackId, testInfo);
            writeDebug({ step: 'test-restored-from-disk', serviceId, outTrackId, info: testInfo });
          }
        }
        testOutTracks.delete(outTrackId);
      } catch (error) {
        writeDebug({ step: 'cb-delete-ex', error: String(error?.stack ?? error) });
      }
      writeDebug({ step: 'cb-4', serviceId, gotTestInfo: Boolean(testInfo), recycleOnDone: testInfo?.recycleOnDone, carrier: testInfo?.carrierId ?? testInfo?.processQueryKey, hasBot: Boolean(testInfo?.bot), hasTarget: Boolean(testInfo?.target) });
      writeDebug({ step: 'cb-5', serviceId, outTrackId, testInfoRaw: testInfo });
      // 回调已消费：无论来自内存还是磁盘恢复，删除持久化记录，避免重复处理/无限膨胀。
      try {
        const disk = loadTracks();
        if (disk[outTrackId]) {
          delete disk[outTrackId];
          saveTracks(disk);
        }
      } catch { /* 忽略 */ }
      if (!testInfo) {
        // 无匹配上下文（重启前的交互卡会话已失效/未知 outTrackId）：
        // 仍记录回调详情（回传值），便于日志回看，而不是静默忽略。
        const unknown = callbackParams(callback);
        writeDebug({ step: 'cb-unknown', serviceId, outTrackId, params: unknown.params, actionIds: unknown.actionIds });
        events.record('info', '收到卡片回调：无匹配的等待会话（DSH 重启前的卡片或已过期的卡片），回传值仅记录不处理', {
          outTrackId,
          userId: callback?.userId,
          params: unknown.params,
          actionIds: unknown.actionIds,
        });
        return;
      }
      if (testInfo) {
        try {
          const testCarrier = testInfo.carrierId ?? testInfo.processQueryKey ?? null;
          // 记录用户点击按钮的回传值（params），便于日志回看。
          // 注意：测试卡注册信息不含 options 定义，不能调用 pickChoice（其内部对 options.find 无空值保护）。
          const testParams = callbackParams(callback).params;
          const testRawValue = testParams?.[testInfo.optionParam ?? 'dsh_option'];
          const testChoice = testRawValue != null && testRawValue !== ''
            ? { text: String(testRawValue), value: String(testRawValue) }
            : null;
          const cbRecord = (message, extra = {}) => events.record('info', message, {
            outTrackId,
            userId: callback?.userId,
            params: testParams,
            choice: testChoice ? { text: testChoice.text, value: testChoice.value } : null,
            ...extra,
          });
          if (testInfo.recycleOnDone && testInfo.bot && testInfo.target) {
            if (testCarrier) {
              writeDebug({ step: 'test-recall-start', at: Date.now(), elapsedMs: Date.now() - receivedAt, outTrackId, carrier: testCarrier, recycleOnDone: testInfo.recycleOnDone });
              api.recallMessage({
                clientId: testInfo.bot.clientId,
                clientSecret: testInfo.bot.clientSecret,
                target: testInfo.target,
                processQueryKeys: [testCarrier],
              }).then((res) => {
                writeDebug({ step: 'test-recall-ok', at: Date.now(), elapsedMs: Date.now() - receivedAt, outTrackId, carrier: testCarrier, result: res });
                cbRecord('测试卡片回调已接通并回收', { carrier: testCarrier });
              }).catch((error) => {
                writeDebug({ step: 'test-recall-err', at: Date.now(), elapsedMs: Date.now() - receivedAt, outTrackId, carrier: testCarrier, error: { message: error?.message, code: error?.code, detail: error?.detail } });
                events.record('error', `测试卡片回收失败：${error?.message ?? error}`, { code: error?.code, detail: error?.detail, outTrackId, params: testParams, choice: testChoice?.value ?? testChoice?.id ?? null });
              });
            } else {
              writeDebug({ step: 'test-recall-skip', outTrackId, recycleOnDone: testInfo.recycleOnDone, carrier: testCarrier, hasBot: Boolean(testInfo.bot), hasTarget: Boolean(testInfo.target) });
              cbRecord('测试卡片回调已接通', { carrier: testCarrier, recycleOnDone: Boolean(testInfo.recycleOnDone) });
            }
          } else {
            writeDebug({ step: 'test-recall-skip', outTrackId, recycleOnDone: testInfo.recycleOnDone, carrier: testCarrier, hasBot: Boolean(testInfo.bot), hasTarget: Boolean(testInfo.target) });
            cbRecord('测试卡片回调已接通', { carrier: testCarrier, recycleOnDone: Boolean(testInfo.recycleOnDone) });
          }
        } catch (error) {
          writeDebug({ step: 'test-recall-ex', error: String(error?.stack ?? error) });
        }
      }
      return;
    }
    if (entry.target.kind === 'user' && callback?.userId && entry.target.userId
      && callback.userId !== entry.target.userId) {
      events.record('warn', '忽略了非提问用户的卡片操作', { outTrackId, userId: callback.userId });
      return;
    }
    const optionParam = entry.variables?.optionParam ?? 'dsh_option';
    const isCeilingEntry = entry.card?.type === 'ceiling' || Boolean(entry.ceilingOutTrackId);
    const closeValue = callbackParams(callback).params?.[optionParam];
    if (closeValue === 'close' || closeValue === 'close_ceiling') {
      // 「关闭」回传：兼容旧模板的「✕ / 关闭吊顶」按钮。插件不再关闭吊顶
      // （由用户在钉钉聊天页手动关闭系统 ✕），这里仅结束插件侧卡片会话。
      writeDebug({ step: 'close-by-x', outTrackId, isCeilingEntry, closeValue, userId: callback?.userId ?? entry.target?.userId });
      events.record('info', '卡片「关闭」按钮回调', {
        outTrackId,
        userId: callback?.userId,
        params: callbackParams(callback).params,
      });
      if (isCeilingEntry) finish(entry, { state: '已关闭', outcome: 'closed' });
      return;
    }
    const choice = entry.kind === 'approval'
      ? pickApproval(callback, optionParam)
      : pickChoice(callback, optionParam, entry.options);
    if (!choice) {
      events.record('warn', '卡片回调未包含可识别的选项', { outTrackId, params: callbackParams(callback).params });
      return;
    }
    counters.answered += 1;
    events.record('info', `卡片回调已处理：${choice.text ?? choice.label ?? choice.value ?? choice.id ?? '选项'}`, {
      outTrackId,
      userId: callback?.userId,
      params: callbackParams(callback).params,
      choice: { text: choice.text ?? choice.label, value: choice.value ?? choice.id ?? choice.text ?? choice.label },
      chat: entry.target.kind === 'group' ? `群 ${entry.target.openConversationId}` : `单聊 ${entry.target.userId}`,
    });
    if (entry.kind === 'approval') {
      const outcome = choice.id === 'allow' ? 'allowed-once' : 'rejected';
      finish(entry, { state: choice.id === 'allow' ? '已允许' : '已拒绝', outcome });
      return;
    }
    finish(entry, { state: CLOSED_STATE, outcome: 'answered', reason: choice });
  }

  const offCallback = bridge.onCardCallback(handleCallback);

  return Object.freeze({
    presentQuestion,
    presentApproval,
    sendChosen,
    buildCardData,
    sampleData,
    selectCard: (kind) => selectCard(store.get(), kind),
    dispose() {
      offCallback();
      for (const entry of [...pending.values()]) {
        finish(entry, { state: CANCELLED_STATE, outcome: 'cancelled' });
      }
    },
    registerTestCard(outTrackId, info = {}) {
      if (typeof outTrackId !== 'string' || !outTrackId) return;
      writeDebug({ step: 'test-register', serviceId, outTrackId, info });
      testOutTracks.set(outTrackId, info);
      // 持久化回调上下文：DSH 重启后仍能处理重启前发送的测试卡片回调（回收/记录）。
      try {
        const disk = loadTracks();
        disk[outTrackId] = { at: Date.now(), info };
        const now = Date.now();
        for (const [key, value] of Object.entries(disk)) {
          if (typeof value?.at === 'number' && now - value.at > TRACKS_TTL_MS) delete disk[key];
        }
        const keys = Object.keys(disk);
        while (keys.length > TRACKS_MAX) delete disk[keys.shift()];
        saveTracks(disk);
      } catch { /* 持久化失败不影响主流程 */ }
      writeDebug({ step: 'test-register-stored', serviceId, outTrackId, stored: testOutTracks.get(outTrackId), keys: [...testOutTracks.keys()] });
      while (testOutTracks.size > 20) testOutTracks.delete(testOutTracks.keys().next().value);
    },
    status() {
      return {
        pending: pending.size,
        counters: { ...counters },
        stream: bridge.status(),
      };
    },
    pendingList() {
      return [...pending.values()].map((entry) => ({
        outTrackId: entry.outTrackId,
        kind: entry.kind,
        sessionId: entry.sessionId,
        chat: entry.target.kind === 'group' ? `群 ${entry.target.openConversationId}` : `单聊 ${entry.target.userId}`,
      }));
    },
  });
}
