import test from 'node:test';
import assert from 'node:assert/strict';

import { createCardService } from '../lib/cards.js';
import { sanitizeConfig } from '../lib/store.js';

function makeConfig(overrides = {}) {
  return sanitizeConfig({
    version: 2,
    enabled: true,
    interactions: {
      questionCardId: 'card_q',
      approvalCardId: 'card_a',
      ceilingCardId: 'card_c',
      ceiling: false,
      ...(overrides.interactions ?? {}),
    },
    cards: overrides.cards ?? [
      {
        id: 'card_q',
        name: '提问卡片',
        type: 'message',
        templateId: 'tpl-q',
        variables: {
          title: 'title', subtitle: 'subtitle', content: 'content', fields: 'fields', image: 'image',
          state: 'state', actions: 'actions', optionVars: ['option1', 'option2'], actionsMode: 'fixed',
          optionParam: 'dsh_option', maxOptions: 2,
        },
        design: { title: '${title}', content: '${content}', state: '${state}', showButtons: true, maxOptions: 2 },
      },
      {
        id: 'card_a',
        name: '审批卡片',
        type: 'message',
        templateId: 'tpl-a',
        variables: {
          title: 'title', subtitle: 'subtitle', content: 'content', fields: 'fields', image: 'image',
          state: 'state', actions: 'actions', optionVars: ['option1', 'option2'], actionsMode: 'fixed',
          optionParam: 'dsh_decision', maxOptions: 2,
        },
        design: { title: '${title}', content: '${content}', state: '${state}', showButtons: true, maxOptions: 2 },
      },
      {
        id: 'card_c',
        name: '吊顶卡片',
        type: 'ceiling',
        templateId: 'tpl-c',
        variables: {
          title: 'title', subtitle: 'subtitle', content: 'content', fields: 'fields', image: 'image',
          state: 'state', actions: 'actions', optionVars: ['option1', 'option2'], actionsMode: 'fixed',
          optionParam: 'dsh_option', maxOptions: 2,
        },
        design: { title: '${title}', content: '${content}', state: '${state}', showButtons: true, maxOptions: 2 },
      },
    ],
  });
}

function fakeStore(config) {
  const state = structuredClone(config);
  return { get: () => structuredClone(state) };
}

function fakeBridge() {
  const listeners = new Set();
  return {
    onCardCallback(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire(callback, meta) {
      for (const listener of listeners) listener(callback, meta);
    },
    status: () => ({ patched: true, clients: [] }),
  };
}

function fakeApi() {
  const calls = { created: [], updated: [], streamed: [], topBoxes: [], closedTopBoxes: [] };
  return {
    calls,
    async createAndDeliverCard(request) {
      calls.created.push(request);
      return { success: true };
    },
    async updateCard(request) {
      calls.updated.push(request);
      return { success: true };
    },
    async streamCard(request) {
      calls.streamed.push(request);
      return { success: true };
    },
    async createTopBox(request) {
      calls.topBoxes.push(request);
      return { success: true };
    },
    async closeTopBox(request) {
      calls.closedTopBoxes.push(request);
      return { success: true };
    },
  };
}

function fixture(config = makeConfig()) {
  const bridge = fakeBridge();
  const api = fakeApi();
  const events = { record() {}, list: () => [] };
  const cards = createCardService({
    api,
    store: fakeStore(config),
    bridge,
    events,
    logger: { warn() {}, info() {}, error() {} },
  });
  return { cards, api, bridge, config };
}

const surface = {
  bot: { clientId: 'ding-test', clientSecret: 'secret' },
  target: { kind: 'user', userId: 'user-1' },
  sessionId: 'session-1',
  timeoutMs: 5_000,
};

const question = {
  id: 'q1',
  header: '选择',
  question: '继续吗？',
  options: [{ label: '继续' }, { label: '停止' }],
};

test('question card uses the selected card and resolves on callback', async () => {
  const { cards, api, bridge } = fixture();
  const presented = await cards.presentQuestion({ ...surface, questions: [question] });
  assert.equal(api.calls.created.length, 1);
  assert.equal(api.calls.created[0].cardTemplateId, 'tpl-q');
  assert.equal(api.calls.created[0].target.userId, 'user-1');
  assert.equal(api.calls.created[0].cardParamMap.title, '选择');
  assert.match(api.calls.created[0].cardParamMap.content, /继续吗/);
  assert.equal(api.calls.created[0].cardParamMap.option1, '继续');
  assert.equal(api.calls.created[0].cardParamMap.option2, '停止');
  assert.ok(api.calls.streamed.length >= 2, 'AI card streams all variables so buttons render');
  assert.equal(api.calls.streamed[api.calls.streamed.length - 1].isFinalize, true, 'last stream finalizes the card');
  const streamedKeys = api.calls.streamed.map((r) => r.key);
  assert.ok(streamedKeys.includes('option1') && streamedKeys.includes('option2'), 'button variables are streamed');

  bridge.fire({
    outTrackId: presented.outTrackId,
    userId: 'user-1',
    content: JSON.stringify({ cardPrivateData: { actionIds: ['2'], params: { dsh_option: '2' } } }),
  }, { messageId: 'm1' });

  const result = await presented.promise;
  assert.equal(result.outcome, 'answered');
  assert.equal(result.reason.label, '停止');
  assert.equal(result.reason.rawLabel, '停止');
  assert.equal(result.reason.value, '停止');
  assert.ok(api.calls.updated.length >= 1);
});

test('callback from another user is ignored for a direct chat', async () => {
  const { cards, bridge } = fixture();
  const presented = await cards.presentQuestion({ ...surface, questions: [question] });
  bridge.fire({
    outTrackId: presented.outTrackId,
    userId: 'someone-else',
    content: JSON.stringify({ cardPrivateData: { params: { dsh_option: '1' } } }),
  }, { messageId: 'm2' });
  presented.dismiss('test');
  assert.equal((await presented.promise).outcome, 'cancelled');
});

test('approval card maps allow and deny to approval outcomes', async () => {
  const { cards, bridge } = fixture();
  const presented = await cards.presentApproval({
    ...surface,
    request: { toolName: 'Bash', reason: 'run tests' },
  });
  bridge.fire({
    outTrackId: presented.outTrackId,
    content: JSON.stringify({ cardPrivateData: { params: { dsh_decision: 'allow' } } }),
  }, { messageId: 'm3' });
  assert.equal((await presented.promise).outcome, 'allowed-once');
});

test('free-text submit returns a custom answer', async () => {
  const { cards, bridge } = fixture();
  const presented = await cards.presentQuestion({ ...surface, questions: [question] });
  bridge.fire({
    outTrackId: presented.outTrackId,
    content: JSON.stringify({ cardPrivateData: { params: { dsh_text: '我自己输入的内容' } } }),
  }, { messageId: 'm4' });
  const result = await presented.promise;
  assert.equal(result.outcome, 'answered');
  assert.equal(result.reason.custom, true);
  assert.equal(result.reason.label, '我自己输入的内容');
});

test('agent send waits for a click and returns the option value', async () => {
  const { cards, api, bridge } = fixture();
  const pending = cards.sendChosen({
    cardId: '提问卡片',
    bot: surface.bot,
    target: surface.target,
    sessionId: 's',
    wait: true,
    data: {
      content: '请选择',
      options: [
        { label: 'A', value: 'alpha' },
        { label: 'B', value: 'beta' },
      ],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const outTrackId = api.calls.created[0].outTrackId;
  bridge.fire({
    outTrackId,
    content: JSON.stringify({ cardPrivateData: { params: { dsh_option: '2' } } }),
  }, { messageId: 'm5' });
  const result = await pending;
  assert.equal(result.answered, true);
  assert.equal(result.value, 'beta');
  assert.equal(result.label, 'B');
});

test('cards time out without an answer', async () => {
  const { cards } = fixture();
  const presented = await cards.presentQuestion({ ...surface, questions: [question], timeoutMs: 20 });
  // 保持事件循环存活：armTimeout 的超时计时器是 unref 的，node 22 下不会阻止进程空转，
  // 需要一个额外 ref 的句柄撑到 unref 计时器触发 resolve，否则该测试会被取消。
  const keepAlive = setInterval(() => {}, 50);
  try {
    const result = await presented.promise;
    assert.equal(result.outcome, 'timeout');
  } finally {
    clearInterval(keepAlive);
  }
});

test('ceiling card opens for a direct chat when configured', async () => {
  const config = makeConfig({ interactions: { ceiling: true } });
  const { cards, api } = fixture(config);
  const presented = await cards.presentQuestion({ ...surface, questions: [question] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.calls.topBoxes.length, 1);
  assert.equal(api.calls.topBoxes[0].cardTemplateId, 'tpl-c');
  presented.dismiss('test');
  await presented.promise;
});

test('agent send rejects a card type that cannot be delivered', async () => {
  const config = makeConfig({
    cards: [{
      id: 'card_contact',
      name: '通讯录卡片',
      type: 'contact',
      templateId: 'tpl-contact',
    }],
  });
  const { cards } = fixture(config);
  await assert.rejects(
    () => cards.sendChosen({ cardId: 'card_contact', bot: surface.bot, target: surface.target, sessionId: 's', data: {} }),
    /不能直接投放/,
  );
});

test('agent send uses the chosen card template', async () => {
  const { cards, api } = fixture();
  const result = await cards.sendChosen({
    cardId: '提问卡片',
    bot: surface.bot,
    target: surface.target,
    sessionId: 's',
    wait: false,
    data: { title: '通知', content: '内容', options: ['知道了'] },
  });
  assert.equal(result.card.name, '提问卡片');
  assert.equal(api.calls.created[0].cardTemplateId, 'tpl-q');
  assert.equal(api.calls.created[0].cardParamMap.option1, '知道了');
});

test('sending a second ceiling card closes the previous one in the same chat', async () => {
  const config = makeConfig();
  const { cards, api } = fixture(config);
  const ceiling = config.cards.find((card) => card.type === 'ceiling');
  await cards.sendChosen({
    cardId: ceiling.name,
    bot: surface.bot,
    target: surface.target,
    sessionId: 's',
    wait: false,
    data: { title: '第一次', content: 'A' },
  });
  const firstOutTrackId = api.calls.topBoxes[0].outTrackId;
  assert.equal(api.calls.closedTopBoxes.length, 0, '第一次发送不应关闭任何吊顶');
  await cards.sendChosen({
    cardId: ceiling.name,
    bot: surface.bot,
    target: surface.target,
    sessionId: 's',
    wait: false,
    data: { title: '第二次', content: 'B' },
  });
  assert.equal(api.calls.topBoxes.length, 2, '两张吊顶卡先后创建');
  assert.equal(api.calls.closedTopBoxes.length, 1, '第二次发送应先关闭第一次的吊顶');
  assert.equal(api.calls.closedTopBoxes[0].outTrackId, firstOutTrackId);
  assert.equal(api.calls.closedTopBoxes[0].target.userId, 'user-1', '关闭请求应指向同一用户');
  assert.equal(api.calls.closedTopBoxes[0].clientId, 'ding-test', '关闭请求应使用同一机器人');
});

test('ceiling cards in different chats do not close each other', async () => {
  const config = makeConfig();
  const { cards, api } = fixture(config);
  const ceiling = config.cards.find((card) => card.type === 'ceiling');
  await cards.sendChosen({
    cardId: ceiling.name,
    bot: surface.bot,
    target: surface.target,
    sessionId: 's',
    wait: false,
    data: {},
  });
  await cards.sendChosen({
    cardId: ceiling.name,
    bot: surface.bot,
    target: { kind: 'user', userId: 'user-2' },
    sessionId: 's',
    wait: false,
    data: {},
  });
  assert.equal(api.calls.closedTopBoxes.length, 0, '不同会话的吊顶互不影响');
  assert.equal(api.calls.topBoxes.length, 2);
});

test('openCeiling also closes a previous ceiling in the same chat first', async () => {
  const config = makeConfig({ interactions: { ceiling: true } });
  const { cards, api } = fixture(config);
  // 先通过 agent send 开一张吊顶卡（记录进 ceilingTracks）
  const ceiling = config.cards.find((card) => card.type === 'ceiling');
  await cards.sendChosen({
    cardId: ceiling.name,
    bot: surface.bot,
    target: surface.target,
    sessionId: 's',
    wait: false,
    data: { title: '先发', content: 'A' },
  });
  // 再走提问流程的 openCeiling：应先关闭上一张同会话吊顶
  const presented = await cards.presentQuestion({ ...surface, questions: [question] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.calls.closedTopBoxes.length, 1, 'openCeiling 应先关闭同会话旧吊顶');
  assert.equal(api.calls.closedTopBoxes[0].outTrackId, api.calls.topBoxes[0].outTrackId);
  assert.equal(api.calls.topBoxes.length, 2);
  presented.dismiss('test');
  await presented.promise;
});
