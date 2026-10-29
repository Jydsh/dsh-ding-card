import { selectCard } from './cards.js';
import { createRouteResolver } from './routing.js';

function userQuestionError(message, code) {
  const error = new Error(message);
  error.name = 'UserQuestionError';
  error.code = code;
  return error;
}

/**
 * Register answerers for the two human-interaction seams.
 * We present a card and still call next() so the Web UI stays usable; the
 * first surface to answer settles the request.
 */
export function installInteractions(ctx, { store, cards, events, logger = console }) {
  const disposers = [];
  const resolveTarget = createRouteResolver(ctx, { store, events, logger });

  function questionEligible(request, card) {
    const questions = request?.questions;
    if (!Array.isArray(questions) || questions.length !== 1) return false;
    const question = questions[0];
    if (!question || typeof question.question !== 'string') return false;
    if (!Array.isArray(question.options) || question.options.length === 0) return false;
    if (question.multiSelect === true) return false;
    if (question.intent) return false;
    return question.options.length <= Math.min(6, card.design?.maxOptions ?? 4);
  }

  async function presentQuestion(request, next) {
    const config = store.get();
    const card = selectCard(config, 'question');
    if (!config.enabled || !config.interactions.questions || !card?.templateId) return next();
    if (!questionEligible(request, card)) return next();
    const surface = await resolveTarget(request.agent?.session?.id);
    if (!surface) return next();
    if (!cards.status().stream.clients.some((client) => client.connected)) {
      events.record('warn', '钉钉 Stream 尚未连接，本次问题交回原生界面');
      return next();
    }
    const turnSignal = request.signal;
    if (turnSignal?.aborted) {
      return Promise.reject(userQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'));
    }
    const lifetime = new AbortController();
    const forwardAbort = () => lifetime.abort(turnSignal?.reason);
    turnSignal?.addEventListener('abort', forwardAbort, { once: true });
    request.signal = lifetime.signal;

    // Let the native surfaces (Web/CLI) show the question immediately; card
    // delivery may involve several DingTalk round-trips.
    const native = Promise.resolve().then(() => next()).catch((error) => {
      if (error?.code !== 'NO_PROVIDER' && error?.code !== 'ASK_ABORTED') {
        logger.warn?.('[dsh-ding-card] native question answerer unavailable:', error?.message ?? error);
      }
      return new Promise(() => {});
    });
    const presented = await cards.presentQuestion({
      ...surface,
      questions: request.questions,
      timeoutMs: config.interactions.timeoutMs,
    });
    let answeredByCard = false;
    try {
      const result = await Promise.race([
        native.then((value) => ({ source: 'native', value })),
        presented.promise.then((value) => ({ source: 'card', value })),
      ]);
      if (result.source === 'native') return result.value;
      const { outcome, reason } = result.value ?? {};
      if (outcome === 'answered' && reason) {
        answeredByCard = true;
        const question = request.questions[0];
        const selectedLabel = reason.rawLabel ?? reason.label;
        const answer = reason.custom
          ? { id: question.id, selected: [], custom: reason.label }
          : { id: question.id, selected: [selectedLabel] };
        events.record('info', '钉钉卡片已提交答案', {
          sessionId: surface.sessionId, selection: selectedLabel,
        });
        return { answers: [answer] };
      }
      // Timed out or unavailable: leave the question to the native surfaces.
      return await native;
    } finally {
      presented.dismiss('question-settled');
      turnSignal?.removeEventListener('abort', forwardAbort);
      if (answeredByCard && !lifetime.signal.aborted) {
        lifetime.abort(userQuestionError('the question was answered on the DingTalk card', 'ASK_ABORTED'));
      }
    }
  }

  async function presentApproval(request, next) {
    const config = store.get();
    const card = selectCard(config, 'approval');
    if (!config.enabled || !config.interactions.approvals || !card?.templateId) return next();
    const surface = await resolveTarget(request.agent?.session?.id);
    if (!surface) return next();
    if (!cards.status().stream.clients.some((client) => client.connected)) {
      events.record('warn', '钉钉 Stream 尚未连接，本次审批交回原生界面');
      return next();
    }
    const turnSignal = request.signal;
    if (turnSignal?.aborted) return 'cancelled';
    const lifetime = new AbortController();
    const forwardAbort = () => lifetime.abort(turnSignal?.reason);
    turnSignal?.addEventListener('abort', forwardAbort, { once: true });
    request.signal = lifetime.signal;

    const native = Promise.resolve().then(() => next()).catch((error) => {
      logger.warn?.('[dsh-ding-card] native approval answerer unavailable:', error?.message ?? error);
      return new Promise(() => {});
    });
    const presented = await cards.presentApproval({
      ...surface,
      request,
      timeoutMs: config.interactions.timeoutMs,
    });
    // "unavailable" means no native approver is composed; keep the card usable
    // instead of failing the approval closed before the user clicks.
    const nativeUsable = native.then((value) => (value === 'unavailable' ? new Promise(() => {}) : value));
    let answeredByCard = false;
    try {
      const result = await Promise.race([
        nativeUsable.then((value) => ({ source: 'native', value })),
        presented.promise.then((value) => ({ source: 'card', value })),
      ]);
      if (result.source === 'native') return result.value;
      const { outcome } = result.value ?? {};
      if (outcome === 'allowed-once' || outcome === 'rejected') {
        answeredByCard = true;
        return outcome;
      }
      return await native;
    } finally {
      presented.dismiss('approval-settled');
      turnSignal?.removeEventListener('abort', forwardAbort);
      if (answeredByCard && !lifetime.signal.aborted) {
        lifetime.abort(new Error('the approval was answered on the DingTalk card'));
      }
    }
  }

  // Register synchronously. Cordis waterfall listeners delegate through next(),
  // so both dsh-im's IM answerer and this card answerer run regardless of which
  // one is first; the first surface to answer settles the request.
  disposers.push(ctx.on('user-questions/request', (request, next) => (
    Promise.resolve(presentQuestion(request, next))
  ), { global: true, prepend: true }));
  disposers.push(ctx.on('approval/request', (request, next) => (
    Promise.resolve(presentApproval(request, next))
  ), { global: true, prepend: true }));
  events.record('info', '已注册钉钉卡片交互应答器');

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose(); } catch { /* ignore */ }
    }
  };
}
