import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryController, DEFAULT_SETTINGS } from '../controller.js';
import { createRetryFetch } from '../fetch-retry.js';
import { routedOptions } from '../routing.js';

const endpoint = '/api/backends/chat-completions/generate';
const payload = { type: 'normal', stream: false, chat_completion_source: 'makersuite',
    model: 'gemini-4-argon', reverse_proxy: 'https://api.doggego.online/', proxy_password: 'private', messages: ['private'] };
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { headers: { 'Content-Type': 'application/json' } });
const error = () => new Response(JSON.stringify({ error: { type: 'openai_error' } }), { status: 524 });
const sse = data => new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
const route = options => {
    const path = new URL(JSON.parse(options.body).reverse_proxy).pathname;
    const match = /^\/g4r1\/([0-9a-f]{32})\/(\d+)$/.exec(path);
    assert.ok(match, path);
    return [match[1], Number(match[2])];
};

function harness(responses = [ok]) {
    const calls = [], timers = [];
    const state = { key: 'chat-1', chat: [{ mes: 'user', is_user: true }], groupId: null, blocked: '', busy: false };
    const settings = { ...DEFAULT_SETTINGS };
    let retryAction = async () => {};
    const controller = createRetryController({ getState: () => state, getSettings: () => settings,
        retry: (...args) => retryAction(...args),
        setTimer: callback => { const timer = { callback }; timers.push(timer); return timer; },
        clearTimer: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    });
    const fetch = createRetryFetch({ controller, baseUrl: 'http://localhost/', fetch: async (url, options) => {
        calls.push({ url, options });
        return responses[Math.min(calls.length - 1, responses.length - 1)]();
    } });
    const options = { method: 'POST', body: JSON.stringify(payload), headers: { 'X-Test': 'unchanged' } };
    const tick = async () => { const timer = timers.shift(); assert.ok(timer); await timer.callback(); };
    return { state, settings, controller, calls, options, fetch, tick, timers,
        send: (body = payload, extra = {}) => fetch(endpoint, { ...options, ...extra, body: JSON.stringify(body) }),
        onRetry: action => { retryAction = action; } };
}

test('HTTP 524 increments route and leaves original payload and options intact', async () => {
    const h = harness([error, ok]);
    h.controller.onStart('normal');
    const optionsBefore = structuredClone(h.options);
    const original = structuredClone(payload);
    const result = h.fetch(endpoint, h.options);
    await new Promise(resolve => setImmediate(resolve));
    await h.tick();
    assert.equal((await result).status, 200);
    const [id0, n0] = route(h.calls[0].options), [id1, n1] = route(h.calls[1].options);
    assert.equal(id0, id1); assert.deepEqual([n0, n1], [0, 1]);
    assert.deepEqual(h.options, optionsBefore); assert.deepEqual(payload, original);
    for (const call of h.calls) {
        const sent = JSON.parse(call.options.body);
        sent.reverse_proxy = payload.reverse_proxy;
        assert.deepEqual(sent, payload);
        assert.equal(call.options.headers, h.options.headers);
    }
});

test('early SSE error increments route', async () => {
    const h = harness([() => sse({ error: 'openai_error' }), () => sse({ choices: [{ delta: { content: 'ok' } }] })]);
    h.controller.onStart('normal');
    const text = (await h.send({ ...payload, stream: true })).text();
    await new Promise(resolve => setImmediate(resolve)); await h.tick();
    assert.match(await text, /ok/);
    const [id0, n0] = route(h.calls[0].options), [id1, n1] = route(h.calls[1].options);
    assert.equal(id0, id1); assert.deepEqual([n0, n1], [0, 1]);
});

test('late error from an old partially delivered stream cannot cancel the new run', async () => {
    let oldStream;
    const h = harness([() => new Response(new ReadableStream({ start(stream) {
        oldStream = stream;
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"old"}}]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } }), error, ok]);
    h.controller.onStart('normal');
    const reader = (await h.send({ ...payload, stream: true })).body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /old/);
    h.state.key = 'chat-2'; h.state.chat = [{ mes: 'new user', is_user: true }];
    h.controller.onStart('normal');
    const second = h.send();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.timers.length, 1);
    oldStream.error(new TypeError('old stream failed'));
    await assert.rejects(reader.read());
    assert.equal(h.timers.length, 1);
    await h.tick();
    assert.equal((await second).status, 200);
    assert.equal(h.calls.length, 3);
    const [newId, newAttempt] = route(h.calls[1].options);
    assert.equal(newAttempt, 0);
    assert.deepEqual(route(h.calls[2].options), [newId, 1]);
});

test('cancelling while an early stream error waits for retry sends no further request', async () => {
    const h = harness([() => sse({ error: 'openai_error' }), ok]);
    h.controller.onStart('normal');
    const reader = (await h.send({ ...payload, stream: true })).body.getReader();
    const reading = reader.read();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.timers.length, 1);
    const timer = h.timers[0];
    await reader.cancel();
    await reading;
    assert.equal(h.timers.length, 0);
    await timer.callback();
    assert.equal(h.calls.length, 1);
});

test('cancelling an old stream cannot cancel the new run retry wait', async () => {
    const h = harness([() => new Response(new ReadableStream({ start(stream) {
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"old"}}]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } }), error, ok]);
    h.controller.onStart('normal');
    const reader = (await h.send({ ...payload, stream: true })).body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /old/);
    h.state.key = 'chat-2'; h.state.chat = [{ mes: 'new user', is_user: true }];
    h.controller.onStart('normal');
    const second = h.send();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.timers.length, 1);
    await reader.cancel();
    assert.equal(h.timers.length, 1);
    await h.tick();
    assert.equal((await second).status, 200);
    assert.equal(h.calls.length, 3);
    const [id, attempt] = route(h.calls[1].options);
    assert.equal(attempt, 0); assert.deepEqual(route(h.calls[2].options), [id, 1]);
});

test('API retry and later empty swipe share run and attempt budget', async () => {
    const h = harness([error, ok, ok]);
    h.controller.onStart('normal');
    const result = h.send();
    await new Promise(resolve => setImmediate(resolve)); await h.tick(); await result;
    const [id, first] = route(h.calls[0].options);
    assert.equal(first, 0); assert.deepEqual(route(h.calls[1].options), [id, 1]);
    h.onRetry(async () => {
        h.controller.onStart('swipe'); await h.send({ ...payload, type: 'swipe' });
        h.state.chat[1].mes = 'ok'; h.controller.onReceived(1, 'swipe'); h.controller.onEnded();
    });
    h.state.chat.push({ mes: '', swipe_id: 0 });
    h.controller.onReceived(1, 'normal'); h.controller.onEnded(); await h.tick();
    assert.deepEqual(route(h.calls[2].options), [id, 2]);
});

test('empty reply automatic swipe inherits route; manual regenerate and swipe reset', async () => {
    const h = harness();
    h.controller.onStart('normal');
    await h.send();
    const [id] = route(h.calls[0].options);
    h.onRetry(async () => {
        h.controller.onSwiped(); h.controller.onStart('swipe');
        await h.send({ ...payload, type: 'swipe' });
        h.state.chat[1].mes = 'ok';
        h.controller.onReceived(1, 'swipe'); h.controller.onEnded();
    });
    h.state.chat.push({ mes: '', swipe_id: 0 });
    h.controller.onReceived(1, 'normal'); h.controller.onEnded();
    await h.tick();
    assert.deepEqual(route(h.calls[1].options), [id, 1]);
    for (const type of ['regenerate', 'swipe', 'normal']) {
        h.controller.onStart(type); await h.send({ ...payload, type });
        const [newId, attempt] = route(h.calls.at(-1).options);
        assert.notEqual(newId, id); assert.equal(attempt, 0);
    }
});

test('separate controllers and chat changes cannot reuse old routing context', async () => {
    const a = harness(), b = harness();
    a.controller.onStart('normal'); b.controller.onStart('normal');
    const request = { type: 'normal' }; assert.equal(a.controller.onRequestStarted(request), true);
    const first = a.controller.getRoutingContext(request);
    assert.equal(b.controller.getRoutingContext(request), null);
    await a.send(); await b.send();
    assert.notEqual(route(a.calls[0].options)[0], route(b.calls[0].options)[0]);
    a.state.key = 'chat-2'; a.state.chat = [];
    assert.equal(a.controller.getRoutingContext(request), null);
    a.controller.onStart('normal'); await a.send();
    assert.notEqual(route(a.calls.at(-1).options)[0], first.runId);
    assert.equal(a.controller.getRoutingContext(request), null);
});

test('cancellation prevents another call and invalidates routing', async () => {
    const h = harness([error, ok]);
    h.controller.onStart('normal');
    const request = { type: 'normal' }; h.controller.onRequestStarted(request);
    const pending = h.send(); await new Promise(resolve => setImmediate(resolve));
    h.controller.cancel();
    assert.equal((await pending).status, 524);
    assert.equal(h.calls.length, 1); assert.equal(h.controller.getRoutingContext(request), null);
});

test('nonmatching targets, invalid context and aborted or stale requests remain unmarked', async () => {
    const options = { body: JSON.stringify(payload) };
    const ctx = { runId: 'a'.repeat(32), attempt: 1 };
    for (const changed of [
        { model: 'gemini-4-carbon' }, { chat_completion_source: 'openai' },
        ...['https://other.example', 'http://api.doggego.online', 'https://api.doggego.online/other',
            'https://api.doggego.online/?q=1', 'https://api.doggego.online/#a',
            'https://user@api.doggego.online', 'https://api.doggego.online:443',
            'https://api.doggego.online//', 'https://api.doggego.online/../'].map(reverse_proxy => ({ reverse_proxy })),
    ]) assert.equal(routedOptions({ ...payload, ...changed }, options, ctx), options);
    for (const context of [null, { ...ctx, attempt: 21 }, { ...ctx, attempt: -1 }, { ...ctx, runId: 'bad' }])
        assert.equal(routedOptions(payload, options, context), options);
    const h = harness(); const abort = new AbortController(); abort.abort();
    h.controller.onStart('normal');
    await h.send(payload, { signal: abort.signal });
    assert.equal(JSON.parse(h.calls[0].options.body).reverse_proxy, payload.reverse_proxy);
    h.state.key = 'new-chat'; await h.send();
    assert.equal(JSON.parse(h.calls[1].options.body).reverse_proxy, payload.reverse_proxy);
});
