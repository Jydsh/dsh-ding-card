import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useSyncExternalStore: () => null,
  };
}

test('client bundle registers the panel, sidebar entry and plugin action', async () => {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const react = fakeReact();
  let factory = null;
  const window = {
    __ModuleLoader__: {
      load({ id, factory: created }) {
        assert.equal(id, 'dsh-ding-card');
        factory = created;
      },
    },
  };
  const fn = new Function('window', 'module', 'exports', code);
  fn(window, { exports: {} }, {});
  assert.equal(typeof factory, 'function');
  const exports = factory(() => react);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(typeof exports.__internals.CardEditor, 'function');

  const registrations = [];
  const provides = [];
  const effects = [];
  const pageCtx = {
    slots: {
      inject(name, callback) {
        return callback();
      },
      register(entry) {
        registrations.push(entry);
        return () => {};
      },
    },
    layout: { selectPanel() {} },
  };
  const ctx = {
    locale: {
      register(namespace, dictionary) {
        assert.equal(namespace, 'dsh-ding-card');
        assert.ok(dictionary.zh && dictionary.en);
        return () => {};
      },
      bind: () => (key) => key,
    },
    effect(fn) {
      effects.push(fn);
      return () => {};
    },
    inject(names, callback) {
      assert.deepEqual(names, ['layout']);
      callback(pageCtx);
    },
    provide(name, value) {
      provides.push({ name, value });
    },
    get: () => undefined,
  };

  exports.apply(ctx);
  assert.ok(registrations.some((entry) => entry.name === 'main' && entry.key === 'dsh-ding-card'));
  assert.ok(registrations.some((entry) => entry.name === 'sidebar.panellist' && entry.id === 'dsh-ding-card'));
  assert.ok(registrations.some((entry) => entry.name === 'plugins.detail.actions'));
  assert.ok(provides.some((entry) => entry.name === 'dshDingCardClient'));

  const internals = exports.__internals;
  const config = {
    version: 2,
    enabled: true,
    interactions: {
      questions: true,
      approvals: true,
      allowGroup: true,
      ceiling: false,
      timeoutMs: 600000,
      questionCardId: 'card_q',
      approvalCardId: 'card_a',
      ceilingCardId: '',
    },
    cards: [{
      id: 'card_q',
      name: '提问卡片',
      type: 'message',
      description: '用于选择',
      templateId: 'tpl',
      aiCard: true,
      variables: {
        title: 'title', subtitle: 'subtitle', content: 'content', fields: 'fields',
        image: 'image', state: 'state', actions: 'actions',
        optionVars: ['option1', 'option2'], actionsMode: 'fixed',
        optionParam: 'dsh_option', maxOptions: 2,
      },
      design: {
        title: '${title}', subtitle: '选择', content: '${content}', fields: [],
        image: '', state: '${state}', showButtons: true, maxOptions: 2,
        theme: 'blue', buttonStyle: 'fill',
      },
    }],
  };
  const status = {
    config,
    cardTypes: {},
    dshim: { installed: true, version: '5.4.0', declared: true, selected: true, installCommand: '' },
    bot: { clientId: 'ding-test', source: 'dsh-im', secretReady: true },
    routes: 1,
    stream: { patched: true, clients: [{ clientId: 'ding-test', connected: true }] },
    cards: { pending: 0, counters: { sent: 1, answered: 1, questions: 1, approvals: 0, timedOut: 0, failed: 0 } },
    events: [{ id: 1, at: new Date().toISOString(), level: 'info', message: 'ok' }],
  };
  const noop = () => {};
  assert.equal(internals.Overview({ status, busy: false, onRefresh: noop, onCheckBot: noop, onTest: noop, onOpenCards: noop }).type, 'div');
  assert.equal(internals.CardsTab({
    config, busy: false, onAdd: noop, onEdit: noop, onDelete: noop,
    onDuplicate: noop, onExport: noop, onBind: noop, onTest: noop,
  }).type, 'div');
  assert.equal(internals.CardEditor({
    draft: config.cards[0], busy: false, onChange: noop, onSave: noop, onCancel: noop, onExport: noop,
  }).type, 'div');
  assert.equal(internals.CardPreview({ card: config.cards[0] }).type, 'div');
  assert.equal(internals.InteractionTab({
    config, cards: config.cards, busy: false, onChange: noop, onSave: noop,
  }).type, 'div');
  assert.equal(internals.LogsTab({ status, busy: false, onRefresh: noop, onClear: noop }).type, 'div');

  for (const effect of effects) {
    const disposer = effect();
    if (typeof disposer === 'function') disposer();
  }
});
