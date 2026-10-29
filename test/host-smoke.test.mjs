import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

test('host plugin mounts and serves the status RPC', async () => {
  const handlers = [];
  const effects = [];
  const provides = [];
  const routes = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect(fn, label) {
      effects.push({ fn, label });
      return () => {};
    },
    on(name, listener, options) {
      handlers.push({ name, listener, options });
      return () => {};
    },
    inject(names, callback) {
      callback(ctx);
    },
    provide(name, value) {
      provides.push({ name, value });
    },
    get() {
      return undefined;
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
    },
    credentials: {
      async resolve() {
        return { value: 'secret' };
      },
    },
  };

  await apply(ctx, {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(provides.some((entry) => entry.name === 'dshDingCard'));
  assert.ok(routes.some((route) => route.path === '/api/dsh-ding-card'));
  assert.ok(handlers.some((entry) => entry.name === 'user-questions/request'));
  assert.ok(handlers.some((entry) => entry.name === 'approval/request'));

  const route = routes.find((entry) => entry.path === '/api/dsh-ding-card');
  const response = await route.fetch(new Request('http://127.0.0.1/api/dsh-ding-card', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'dsh-ding-card',
      payload: { method: 'status', payload: {} },
    }),
  }));
  const body = await response.json();
  assert.equal(body.type, 'server-response');
  assert.equal(body.rpcId, 'rpc-1');
  assert.equal(body.result.ok, true);
  assert.equal(typeof body.result.value.dshim.installed, 'boolean');
  assert.ok(Array.isArray(body.result.value.events));

  const installResponse = await route.fetch(new Request('http://127.0.0.1/api/dsh-ding-card', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-2',
      method: 'dsh-ding-card',
      payload: { method: 'dshim.install', payload: {} },
    }),
  }));
  const installBody = await installResponse.json();
  assert.equal(installBody.result.ok, true);
  assert.equal(installBody.result.value.manual, true);
  assert.match(installBody.result.value.command, /@xmanrui\/dsh-im/);

  for (const effect of effects) {
    const disposer = effect.fn();
    if (typeof disposer === 'function') disposer();
  }
});
