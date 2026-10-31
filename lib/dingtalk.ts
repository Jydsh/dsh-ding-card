import { randomUUID } from 'node:crypto';

export const DINGTALK_API = 'https://api.dingtalk.com';
export const DINGTALK_CARD_TOPIC = '/v1.0/card/instances/callback';
const TOKEN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_EARLY_REFRESH_MS = 60_000;

/** 钉钉卡片投放目标（单聊 / 群）。 */
export interface CardTarget {
  kind: 'user' | 'group';
  userId?: string;
  openConversationId?: string;
  atUserIds?: Record<string, string>;
}

/** 钉钉 API 客户端。 */
export interface DingTalkApi {
  accessToken(opts: { clientId: string; clientSecret: string; signal?: AbortSignal; force?: boolean }): Promise<string>;
  invalidate(clientId: string): void;
  createAndDeliverCard(opts: {
    clientId: string; clientSecret: string; target: CardTarget;
    cardTemplateId: string; outTrackId: string; cardParamMap: Record<string, any>; signal?: AbortSignal;
  }): Promise<Record<string, any>>;
  updateCard(opts: { clientId: string; clientSecret: string; outTrackId: string; cardParamMap: Record<string, any>; signal?: AbortSignal }): Promise<Record<string, any>>;
  streamCard(opts: {
    clientId: string; clientSecret: string; outTrackId: string; key: string; content: string;
    isFinalize?: boolean; isError?: boolean; signal?: AbortSignal;
  }): Promise<Record<string, any>>;
  createTopBox(opts: {
    clientId: string; clientSecret: string; target: CardTarget;
    cardTemplateId: string; outTrackId: string; cardParamMap: Record<string, any>; signal?: AbortSignal;
  }): Promise<Record<string, any>>;
  closeTopBox(opts: { clientId: string; clientSecret: string; target: CardTarget; outTrackId: string; signal?: AbortSignal }): Promise<Record<string, any>>;
  recallMessage(opts: { clientId: string; clientSecret: string; target: CardTarget; processQueryKeys: string | string[]; signal?: AbortSignal }): Promise<Record<string, any>>;
}

export class DingTalkError extends Error {
  name = 'DingTalkError';
  code: string;
  status?: number;
  detail?: unknown;

  constructor(code: string, message: string, options: { status?: number; detail?: unknown; cause?: unknown } = {}) {
    super(message, options as ErrorOptions);
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function providerMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  for (const key of ['message', 'errmsg', 'errorMsg', 'msg']) {
    if (typeof (body as Record<string, any>)[key] === 'string' && (body as Record<string, any>)[key].trim()) {
      return (body as Record<string, any>)[key].trim();
    }
  }
  return '';
}

function rejectedCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, any>;
  if (record.success === false) return 'rejected';
  for (const key of ['code', 'errcode', 'errorCode']) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== 0 && value !== '0' && value !== 'ok') {
      return String(value);
    }
  }
  return null;
}

export function createDingTalkApi({ logger = console, fetchImpl = fetch }: { logger?: Console; fetchImpl?: typeof fetch } = {}): DingTalkApi {
  const tokenCache = new Map<string, { token: string; expiresAt: number }>();

  async function requestJson(path: string, {
    method = 'GET', token, body, signal, timeoutMs = REQUEST_TIMEOUT_MS, retried = false,
  }: {
    method?: string; token?: string; body?: unknown; signal?: AbortSignal;
    timeoutMs?: number; retried?: boolean;
  } = {}): Promise<Record<string, any>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['x-acs-dingtalk-access-token'] = token;
    let response: Response;
    try {
      response = await fetchImpl(`${DINGTALK_API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutSignal(signal, timeoutMs),
      });
    } catch (cause) {
      if (signal?.aborted) throw new DingTalkError('cancelled', '钉钉请求已取消。', { cause });
      throw new DingTalkError('network-error', '无法访问钉钉开放平台，请检查网络或代理。', { cause });
    }
    const payload = await readBody(response);
    if (!response.ok) {
      const code = rejectedCode(payload) ?? `http-${response.status}`;
      if (!retried && (response.status === 429 || /busy|throttl|rate/i.test(code))) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return requestJson(path, { method, token, body, signal, timeoutMs, retried: true });
      }
      throw new DingTalkError('provider-rejected',
        providerMessage(payload) || `钉钉接口返回 HTTP ${response.status}。`,
        { status: response.status, detail: { code, path, body: payload } });
    }
    const code = rejectedCode(payload);
    if (code) {
      throw new DingTalkError('provider-rejected',
        providerMessage(payload) || `钉钉接口拒绝了请求（${code}）。`,
        { status: response.status, detail: { code, path, body: payload } });
    }
    return payload as Record<string, any>;
  }

  async function accessToken({ clientId, clientSecret, signal, force = false }: {
    clientId: string; clientSecret: string; signal?: AbortSignal; force?: boolean;
  }): Promise<string> {
    const id = nonEmpty(clientId);
    const secret = nonEmpty(clientSecret);
    if (!id || !secret) throw new DingTalkError('missing-credentials', '缺少钉钉应用 Client ID 或 Client Secret。');
    const cached = tokenCache.get(id);
    if (!force && cached && cached.expiresAt - TOKEN_EARLY_REFRESH_MS > Date.now()) {
      return cached.token;
    }
    let payload: Record<string, any>;
    try {
      payload = await requestJson('/v1.0/oauth2/accessToken', {
        method: 'POST',
        body: { appKey: id, appSecret: secret },
        signal,
        timeoutMs: TOKEN_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof DingTalkError && error.code === 'provider-rejected') {
        throw new DingTalkError('invalid-credentials', '钉钉拒绝了应用凭据，请检查 Client ID 与 Client Secret。', { cause: error });
      }
      throw error;
    }
    const token = nonEmpty(payload?.accessToken);
    if (!token) throw new DingTalkError('invalid-response', '钉钉未返回 accessToken。');
    const expireIn = Number(payload?.expireIn);
    tokenCache.set(id, {
      token,
      expiresAt: Date.now() + (Number.isFinite(expireIn) && expireIn > 0 ? expireIn * 1000 : 7_000_000),
    });
    return token;
  }

  function invalidate(clientId: string): void {
    tokenCache.delete(clientId);
  }

  /**
   * Create a card instance and deliver it into a DingTalk chat.
   * callbackType STREAM routes button presses to the app's Stream connection.
   */
  async function createAndDeliverCard({
    clientId, clientSecret, target, cardTemplateId, outTrackId, cardParamMap, signal,
  }: {
    clientId: string; clientSecret: string; target: CardTarget; cardTemplateId: string;
    outTrackId: string; cardParamMap: Record<string, any>; signal?: AbortSignal;
  }): Promise<Record<string, any>> {
    if (target?.kind !== 'user' && target?.kind !== 'group') {
      throw new DingTalkError('invalid-target', '缺少钉钉会话目标。');
    }
    const robotCode = nonEmpty(clientId);
    const space = target.kind === 'group'
      ? {
        openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
        imGroupOpenDeliverModel: {
          robotCode,
          ...(target.atUserIds ? { atUserIds: target.atUserIds } : {}),
        },
      }
      : {
        openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
        imRobotOpenDeliverModel: {
          spaceType: 'IM_ROBOT',
          robotCode,
          extension: { dynamicSummary: 'true' },
        },
      };
    const token = await accessToken({ clientId, clientSecret, signal });
    const payload = await requestJson('/v1.0/card/instances/createAndDeliver', {
      method: 'POST',
      token,
      signal,
      body: {
        cardTemplateId,
        outTrackId,
        callbackType: 'STREAM',
        userIdType: 1,
        ...space,
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true },
        cardData: { cardParamMap },
        ...(target.kind === 'group' && target.atUserIds
          ? { cardAtUserIds: Object.keys(target.atUserIds) }
          : {}),
      },
    });
    const results = payload?.result?.deliverResults;
    const failed = Array.isArray(results) && results.length > 0 && results.every((item: Record<string, any>) => item?.success === false)
      ? results[0]
      : null;
    if (failed) {
      throw new DingTalkError('delivery-rejected',
        `钉钉拒绝了卡片投放：${failed.errorMsg || '目标会话不可用'}`, {
          detail: { deliverResults: results, outTrackId },
        });
    }
    if (payload?.success === false) {
      throw new DingTalkError('delivery-rejected', '钉钉拒绝了卡片投放。', {
        detail: { payload, outTrackId },
      });
    }
    return payload;
  }

  /** Merge new values into an existing card instance (preserves other variables). */
  async function updateCard({ clientId, clientSecret, outTrackId, cardParamMap, signal }: {
    clientId: string; clientSecret: string; outTrackId: string;
    cardParamMap: Record<string, any>; signal?: AbortSignal;
  }): Promise<Record<string, any>> {
    const token = await accessToken({ clientId, clientSecret, signal });
    return requestJson('/v1.0/card/instances', {
      method: 'PUT',
      token,
      signal,
      body: {
        outTrackId,
        cardData: { cardParamMap },
        cardUpdateOptions: { updateCardDataByKey: true },
      },
    });
  }

  /** One AI-card streaming frame. Used to keep a card in the "输入中" state. */
  async function streamCard({
    clientId, clientSecret, outTrackId, key, content, isFinalize = false, isError = false, signal,
  }: {
    clientId: string; clientSecret: string; outTrackId: string; key: string; content: string;
    isFinalize?: boolean; isError?: boolean; signal?: AbortSignal;
  }): Promise<Record<string, any>> {
    const token = await accessToken({ clientId, clientSecret, signal });
    return requestJson('/v1.0/card/streaming', {
      method: 'PUT',
      token,
      signal,
      body: {
        outTrackId,
        guid: randomUUID(),
        key,
        content: String(content ?? ''),
        isFull: true,
        isFinalize,
        isError,
      },
    });
  }

  /** Open an interactive-card ceiling (吊顶) in a single-chat assistant conversation. */
  async function createTopBox({
    clientId, clientSecret, target, cardTemplateId, outTrackId, cardParamMap, signal,
  }: {
    clientId: string; clientSecret: string; target: CardTarget; cardTemplateId: string;
    outTrackId: string; cardParamMap: Record<string, any>; signal?: AbortSignal;
  }): Promise<Record<string, any>> {
    if (target?.kind !== 'user') {
      throw new DingTalkError('unsupported-target', '吊顶卡片目前仅支持单聊机器人会话。');
    }
    const token = await accessToken({ clientId, clientSecret, signal });
    return requestJson('/v2.0/im/topBoxes', {
      method: 'POST',
      token,
      signal,
      body: {
        cardTemplateId,
        outTrackId,
        callbackType: 'STREAM',
        cardData: { cardParamMap },
        conversationType: 2,
        userId: target.userId,
        robotCode: clientId,
      },
    });
  }

  /** Close an interactive-card ceiling (吊顶) previously opened via createTopBox. */
  async function closeTopBox({
    clientId, clientSecret, target, outTrackId, signal,
  }: {
    clientId: string; clientSecret: string; target: CardTarget; outTrackId: string; signal?: AbortSignal;
  }): Promise<Record<string, any>> {
    if (target?.kind !== 'user') {
      throw new DingTalkError('unsupported-target', '吊顶卡片目前仅支持单聊机器人会话。');
    }
    const token = await accessToken({ clientId, clientSecret, signal });
    return requestJson('/v2.0/im/topBoxes/close', {
      method: 'POST',
      token,
      signal,
      body: {
        outTrackId,
        conversationType: 2,
        userId: target.userId,
        robotCode: clientId,
      },
    });
  }

  /**
   * Withdraw (recall) an interactive-card message from the chat so it looks as
   * if it never appeared. Uses the processQueryKey returned by the delivery
   * API (createAndDeliver / createTopBox). Only works within 24h of sending.
   */
  async function recallMessage({ clientId, clientSecret, target, processQueryKeys, signal }: {
    clientId: string; clientSecret: string; target: CardTarget;
    processQueryKeys: string | string[]; signal?: AbortSignal;
  }): Promise<Record<string, any>> {
    const token = await accessToken({ clientId, clientSecret, signal });
    const path = target?.kind === 'group'
      ? '/v1.0/robot/groupMessages/batchRecall'
      : '/v1.0/robot/otoMessages/batchRecall';
    return requestJson(path, {
      method: 'POST',
      token,
      signal,
      body: { robotCode: clientId, processQueryKeys: Array.isArray(processQueryKeys) ? processQueryKeys : [processQueryKeys] },
    });
  }

  return Object.freeze({
    accessToken,
    invalidate,
    createAndDeliverCard,
    updateCard,
    streamCard,
    createTopBox,
    closeTopBox,
    recallMessage,
  });
}
