import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryController, DEFAULT_SETTINGS, normalizeSettings } from '../controller.js';

function harness(overrides = {}) {
    const timers = new Map();
    const notices = [];
    const calls = [];
    const state = { key: 'character:chat', groupId: null, chat: [], busy: false, blocked: '', streamFailed: false };
    const settings = { ...DEFAULT_SETTINGS, ...overrides };
    let sequence = 0;
    let nextReply = '正常回答';
    let action;
    const controller = createRetryController({
        getState: () => state,
        getSettings: () => settings,
        notify: event => notices.push(event),
        setTimer: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
        clearTimer: id => timers.delete(id),
        retry: async id => {
            calls.push(id);
            if (action) return action(id);
            controller.onSwiped(); // Native swipe event precedes generation start.
            controller.onStart('swipe');
            state.chat[id].mes = nextReply;
            state.chat[id].swipe_id++;
            controller.onReceived(id, 'swipe');
            controller.onEnded();
        },
    });
    function reply(text, { streaming = false, type = 'normal', extra = {} } = {}) {
        controller.onStart(type);
        const message = { mes: text, is_user: false, swipe_id: 0, extra };
        state.chat.push(message);
        if (streaming) controller.onEnded();
        controller.onReceived(state.chat.length - 1, type);
        if (!streaming) controller.onEnded();
        return message;
    }
    async function tick() {
        const entry = timers.entries().next().value;
        assert.ok(entry, 'expected a scheduled callback');
        timers.delete(entry[0]);
        await entry[1].callback();
    }
    return { controller, state, settings, notices, timers, calls, reply, tick,
        setReply: text => { nextReply = text; }, setAction: fn => { action = fn; } };
}

test('delivery failure emits a visible-error event once; manual and stale cancellation do not', () => {
    const h = harness(), request = { type: 'normal' };
    h.controller.onStart('normal'); assert.equal(h.controller.onRequestStarted(request), true);
    h.controller.cancelRequest(request, 'synthetic retrieval failure', { deliveryFailure: true });
    h.controller.cancelRequest(request, 'duplicate', { deliveryFailure: true });
    assert.equal(h.notices.filter(x => x.kind === 'delivery-error').length, 1);
    assert.equal(h.notices.at(-1).reason, 'synthetic retrieval failure');
    h.controller.onStart('normal');
    h.controller.cancelRequest(request, 'stale', { deliveryFailure: true });
    assert.equal(h.notices.at(-1).kind, 'monitoring');
    h.controller.cancel();
    assert.equal(h.notices.filter(x => x.kind === 'delivery-error').length, 1);
});

test('defaults to 20 extra attempts, two seconds, and clamps corrupt settings', () => {
    assert.equal(DEFAULT_SETTINGS.maxRetries, 20);
    assert.equal(DEFAULT_SETTINGS.delayMs, 2000);
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    const value = normalizeSettings({ enabled: 'false', maxRetries: Infinity, delayMs: -1, keywords: '' });
    assert.equal(value.enabled, true);
    assert.equal(value.maxRetries, 20);
    assert.equal(value.delayMs, 500);
    assert.equal(value.keywords, '');
    assert.equal(normalizeSettings({ maxRetries: 200, delayMs: 90000 }).maxRetries, 20);
    assert.equal(normalizeSettings({ maxRetries: 0, delayMs: 90000 }).delayMs, 60000);
});

test('refresh safety gate includes initial generation and pending automatic swipe', async () => {
    const h=harness();
    assert.equal(h.controller.hasPendingWork(),false);
    h.controller.onStart('normal');assert.equal(h.controller.hasPendingWork(),true);
    h.controller.cancel();assert.equal(h.controller.hasPendingWork(),false);
    h.reply('');assert.equal(h.controller.hasPendingWork(),true);
    // The old stop-button predicate deliberately has different semantics.
    assert.equal(h.controller.isRetrying(),false);
    await h.tick();assert.equal(h.controller.hasPendingWork(),false);
    h.reply('');h.controller.cancel();assert.equal(h.controller.hasPendingWork(),false);
});

for (const streaming of [false, true]) {
    test(`one retry after empty completion, streaming=${streaming}`, async () => {
        const h = harness();
        h.reply('', { streaming });
        assert.equal(h.calls.length, 0);
        assert.equal([...h.timers.values()][0].delay, 2000);
        await h.tick();
        assert.deepEqual(h.calls, [0]);
        assert.equal(h.timers.size, 0);
        assert.equal(h.notices.at(-1).kind, 'success');
        assert.equal(h.notices.at(-1).attempts, 1);
    });
}

test('waits for both completion events, ignores duplicate events', async () => {
    const h = harness();
    h.controller.onStart('normal');
    h.state.chat.push({ mes: '抱歉', is_user: false, swipe_id: 0 });
    h.controller.onReceived(0, 'normal');
    assert.equal(h.timers.size, 0);
    h.controller.onEnded();
    h.controller.onReceived(0, 'normal');
    h.controller.onEnded();
    assert.equal(h.timers.size, 1);
    await h.tick();
    assert.equal(h.calls.length, 1);
});

test('stops at exactly 20 retries and resets the budget on a new manual generation', async () => {
    const h = harness();
    h.setReply('对不起，我无法继续');
    h.reply('');
    for (let i = 0; i < 20; i++) await h.tick();
    assert.equal(h.calls.length, 20);
    assert.equal(h.timers.size, 0);
    assert.equal(h.notices.at(-1).kind, 'limit');
    h.setReply('正常回答');
    h.reply('抱歉');
    await h.tick();
    assert.equal(h.calls.length, 21);
    assert.equal(h.notices.at(-1).attempts, 1);
});

test('respects a lower user limit', async () => {
    const h = harness({ maxRetries: 2 });
    h.setReply('I am unable to fulfill this request.');
    h.reply('抱歉');
    await h.tick();
    await h.tick();
    assert.equal(h.calls.length, 2);
    assert.equal(h.timers.size, 0);
});

test('normal text and media-only responses do not retry', () => {
    const h = harness();
    h.reply('这是正常的回复');
    h.reply('', { extra: { media: [{ url: '/image.png', type: 'image' }] } });
    assert.equal(h.timers.size, 0);
});

test('apology detection is strictly limited to replies shorter than 1000 characters', () => {
    for (const length of [999, 1000, 1001]) {
        const h = harness();
        h.reply('抱歉' + '文'.repeat(length - 2));
        assert.equal(h.timers.size, length < 1000 ? 1 : 0, `length ${length}`);
    }
});

test('a short apology appended to a long reply is not retried, but an empty continuation is', () => {
    const h = harness();
    h.state.chat.push({ mes: '文'.repeat(1000), swipe_id: 0 });
    h.controller.onStart('continue');
    h.state.chat[0].mes += '抱歉';
    h.controller.onReceived(0, 'appendFinal');
    h.controller.onEnded();
    assert.equal(h.timers.size, 0);
    h.controller.onStart('continue');
    h.controller.onReceived(0, 'appendFinal');
    h.controller.onEnded();
    assert.equal(h.timers.size, 1);
});

test('network failures without a new message never retry an old apology', () => {
    const h = harness();
    h.state.chat.push({ mes: '抱歉' });
    h.controller.onStart('regenerate');
    h.controller.onEnded();
    assert.equal(h.timers.size, 0);
});

test('failed or aborted streaming is not treated as an empty reply', () => {
    const h = harness();
    h.state.streamFailed = true;
    h.reply('', { streaming: true });
    assert.equal(h.timers.size, 0);
});

test('a stop after end but before receive suppresses retry', () => {
    const h = harness();
    h.controller.onStart('normal');
    h.state.chat.push({ mes: '' });
    h.controller.onEnded();
    h.controller.cancel();
    h.controller.onReceived(0, 'normal');
    assert.equal(h.timers.size, 0);
});

for (const method of ['cancel', 'onSwiped', 'cancelPending']) {
    test(`${method} cancels the pending timer`, () => {
        const h = harness();
        h.reply('');
        h.controller[method]();
        assert.equal(h.timers.size, 0);
        assert.equal(h.calls.length, 0);
    });
}

for (const mutate of [
    h => { h.state.key = 'different-chat'; },
    h => { h.state.chat = [...h.state.chat]; },
    h => { h.state.chat.push({ mes: 'new user message', is_user: true }); },
    h => { h.state.chat[0].mes = 'edited'; },
    h => { h.state.chat[0].swipe_id = 3; },
    h => { h.settings.enabled = false; },
    h => { h.state.blocked = 'offline'; },
    h => { h.settings.retryEmpty = false; },
]) {
    test(`revalidates before retry: ${mutate}`, async () => {
        const h = harness();
        h.reply('');
        mutate(h);
        await h.tick();
        assert.equal(h.calls.length, 0);
        assert.equal(h.timers.size, 0);
    });
}

test('waits for native swipe/save cleanup rather than overlapping requests', async () => {
    const h = harness();
    h.reply('');
    h.state.busy = true;
    await h.tick();
    assert.equal(h.calls.length, 0);
    assert.equal([...h.timers.values()][0].delay, 250);
    h.state.busy = false;
    await h.tick();
    assert.equal(h.calls.length, 1);
});

test('bounded cleanup wait stops if the application stays busy', async () => {
    const h = harness();
    h.reply('');
    h.state.busy = true;
    for (let i = 0; i <= 60; i++) await h.tick();
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
});

test('disabled, group, quiet, dry-run, impersonate, first-message and user messages are excluded', () => {
    for (const mode of ['disabled', 'group', 'quiet', 'dry', 'impersonate', 'first_message', 'user']) {
        const h = harness();
        if (mode === 'disabled') h.settings.enabled = false;
        if (mode === 'group') h.state.groupId = 'group';
        const type = ['quiet', 'impersonate'].includes(mode) ? mode : 'normal';
        h.controller.onStart(type, {}, mode === 'dry');
        h.state.chat.push({ mes: '', is_user: mode === 'user' });
        h.controller.onReceived(0, mode === 'first_message' ? mode : type);
        h.controller.onEnded();
        assert.equal(h.timers.size, 0, mode);
    }
});

test('a quiet request or dry run does not reset an active retry budget', async () => {
    const h = harness({ maxRetries: 1 });
    h.reply('');
    h.controller.onStart('quiet');
    h.controller.onStart('normal', {}, true);
    h.setReply('抱歉');
    await h.tick();
    assert.equal(h.notices.at(-1).kind, 'limit');
});

test('continuations inspect only appended text', () => {
    const h = harness();
    h.state.chat.push({ mes: '角色说抱歉，然后出发。', swipe_id: 0 });
    h.controller.onStart('continue');
    h.state.chat[0].mes += '他走到了门口。';
    h.controller.onReceived(0, 'appendFinal');
    h.controller.onEnded();
    assert.equal(h.timers.size, 0);
    h.controller.onStart('continue');
    h.controller.onReceived(0, 'appendFinal');
    h.controller.onEnded();
    assert.equal(h.timers.size, 1, 'empty continuation should retry');
});

test('retry exceptions are handled and do not loop', async () => {
    const h = harness();
    h.setAction(() => { throw new Error('simulated API error'); });
    h.reply('');
    await h.tick();
    assert.equal(h.notices.at(-1).kind, 'error');
    assert.equal(h.timers.size, 0);
});

test('retry that fails to start stops instead of silently looping', async () => {
    const h = harness();
    h.setAction(() => {});
    h.reply('');
    await h.tick();
    assert.equal(h.notices.at(-1).kind, 'cancelled');
    assert.equal(h.timers.size, 0);
});

test('a retry ending without a received message clears its active status', async () => {
    const h = harness();
    h.setAction(() => {
        h.controller.onStart('swipe');
        h.controller.onEnded();
    });
    h.reply('');
    await h.tick();
    assert.equal(h.controller.isRetrying(), false);
    assert.equal(h.notices.at(-1).kind, 'cancelled');
    assert.equal(h.timers.size, 0);
});

test('cancelling during native swipe preparation cannot restart the retry chain', async () => {
    const h = harness();
    let resume;
    h.setAction(async () => {
        await new Promise(resolve => { resume = resolve; });
        h.controller.onStart('swipe');
        h.controller.onReceived(0, 'swipe');
        h.controller.onEnded();
    });
    h.reply('');
    const flight = h.tick();
    h.controller.cancel();
    resume();
    await flight;
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(h.controller.isRetrying(), false);
});

test('a stale failed request cannot cancel a new chat generation', async () => {
    const h = harness();
    let reject;
    h.setAction(() => new Promise((resolve, rejectPromise) => { reject = rejectPromise; }));
    h.reply('');
    const flight = h.tick();
    h.controller.cancel();
    h.state.key = 'new-chat';
    h.state.chat = [];
    h.reply('抱歉');
    reject(new Error('stale failure'));
    await flight;
    assert.equal(h.timers.size, 1);
    assert.notEqual(h.notices.at(-1).kind, 'error');
});
