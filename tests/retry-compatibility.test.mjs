import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRetryFetch } from '../fetch-retry.js';
import { createRetryController, DEFAULT_SETTINGS } from '../controller.js';

// These are in-memory responses only: no Tavern, network, or model calls.
globalThis.crypto ??= webcrypto;
const endpoint = '/api/backends/chat-completions/generate';
const common = { type: 'normal', stream: true, chat_completion_source: 'makersuite',
    reverse_proxy: 'https://api.doggego.online', tools: [{ type: 'function', function: {
        name: 'dispatch_stream_payload_0123456789abcdef', parameters: { properties: { display_stream: { type: 'string' } } },
    } }] };
const failed = code => ({ error: { code, message: 'synthetic error' }, g4keep: { version: 1, outcome: 'failed' } });
const partial = { candidates: [{ content: { parts: [{ text: 'OLD-PARTIAL' }] } }] };
const complete = { candidates: [{ content: { parts: [{ text: 'NEW-RESULT' }] }, finishReason: 'STOP' }] };
const sse = (...frames) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } });
const json = (value, status) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function harness(model, respond, overrides = {}, payloadChanges = {}) {
    const calls = [], notices = [], delays = [];
    const abort = new AbortController();
    const settings = { ...DEFAULT_SETTINGS, delayMs: 1500, maxRetries: 2, ...overrides };
    const state = { key: 'test-chat', groupId: null, chat: [{ mes: 'synthetic user input', is_user: true }], busy: true, blocked: '' };
    let onNotice = () => {};
    const controller = createRetryController({
        getState: () => state, getSettings: () => settings,
        retry: () => assert.fail('API retry must not create a swipe'),
        notify: notice => { notices.push(notice); onNotice(notice); },
        setTimer: (callback, delay) => { delays.push(delay); return setTimeout(callback, 0); },
    });
    const adapter = createRetryFetch({ controller, baseUrl: 'http://localhost:8000/', fetch: async (_url, options) => {
        const proxy = JSON.parse(options.body).reverse_proxy;
        calls.push(proxy);
        return respond(proxy, calls.length);
    } });
    controller.onStart('normal');
    return { calls, notices, delays, settings, state, abort, controller,
        onNotice: fn => { onNotice = fn; },
        send: () => adapter(endpoint, { method: 'POST', signal: abort.signal,
            body: JSON.stringify({ ...common, model, ...payloadChanges }) }) };
}

for (const code of [502, 504]) {
    test(`4c recorded ${code} retries with a fresh delivery ID and no old partial`, async () => {
        const h = harness('gemini-4-carbon', (_proxy, count) => count === 1 ? sse(partial, failed(code)) : sse(complete));
        const response = await h.send();
        const body = await response.text();
        assert.match(body, /NEW-RESULT/);
        assert.doesNotMatch(body, /OLD-PARTIAL|synthetic error/);
        assert.equal(h.calls.length, 2);
        const paths = h.calls.map(url => new URL(url).pathname.split('/').filter(Boolean));
        assert.deepEqual(paths.map(parts => [parts[0], parts[2]]), [['g4d1', 'start'], ['g4d1', 'start']]);
        assert.match(paths[0][1], /^[0-9a-f]{32}$/);
        assert.match(paths[1][1], /^[0-9a-f]{32}$/);
        assert.notEqual(paths[0][1], paths[1][1]);
        assert.deepEqual(h.delays, [1500]);
        assert.equal(h.notices.filter(x => x.kind === 'retrying').at(-1)?.attempts, 1);
    });
}

test('4c respects retry limit, interval and disabled API retries', async () => {
    const h = harness('gemini-4-carbon', () => sse(failed(502)));
    await assert.rejects((await h.send()).text());
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.delays, [1500, 1500]);
    assert.equal(h.notices.at(-1).kind, 'limit');
    assert.deepEqual(h.notices.filter(x => x.kind === 'retrying').map(x => x.attempts), [1, 2]);
    const disabled = harness('gemini-4-carbon', () => sse(failed(502)), { retryApiErrors: false });
    await assert.rejects((await disabled.send()).text());
    assert.equal(disabled.calls.length, 1);
    assert.deepEqual(disabled.delays, []);
});

test('4c does not retry recorded 401 or 403 embedded in HTTP 200 SSE', async () => {
    for (const code of [401, 403]) {
        const h = harness('gemini-4-carbon', () => sse(failed(code)));
        await assert.rejects((await h.send()).text());
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.delays, []);
    }
});

test('4c manual stop or chat change cancels a scheduled API retry', async () => {
    for (const change of [h => h.abort.abort(), h => { h.state.key = 'another-chat'; }]) {
        const h = harness('gemini-4-carbon', () => sse(failed(502)));
        h.onNotice(notice => { if (notice.kind === 'pending') change(h); });
        await assert.rejects((await h.send()).text());
        assert.equal(h.calls.length, 1);
    }
});

test('4c unknown delivery failure and missing resume never regenerate', async () => {
    const failedDelivery = harness('gemini-4-carbon', () => sse({ error: { code: 'G4_DELIVERY_FAILED' } }));
    await assert.rejects((await failedDelivery.send()).text());
    assert.equal(failedDelivery.calls.length, 1);
    assert.deepEqual(failedDelivery.delays, []);
    const missing = harness('gemini-4-carbon', (proxy) => {
        if (proxy.endsWith('/start')) throw new Error('synthetic connection loss');
        return json({ error: { code: 'G4_DELIVERY_MISSING' } }, 410);
    });
    await assert.rejects(missing.send(), /可能已扣费/);
    assert.deepEqual(missing.calls.map(x => x.split('/').at(-1)), ['start', 'resume']);
    assert.deepEqual(missing.delays, []);
});

test('4c Tavern HTTP 500 queries only the same ID and gives one visible final failure when missing', async () => {
    const h = harness('gemini-4-carbon', proxy => proxy.endsWith('/start')
        ? json({ error: true }, 500) : json({ error: { code: 'G4_DELIVERY_MISSING' } }, 410));
    await assert.rejects(h.send(), /可能已扣费/);
    const paths = h.calls.map(url => new URL(url).pathname.split('/'));
    assert.deepEqual(paths.map(x => x.at(-1)), ['start', 'resume']);
    assert.equal(paths[0][2], paths[1][2]); assert.deepEqual(h.delays, []);
    assert.equal(h.notices.filter(x => x.kind === 'delivery-error').length, 1);
});

test('4c generic proxy 500 is recovered, then only a recorded API failure can authorize a new generation', async () => {
    const h = harness('gemini-4-carbon', (_proxy, count) => count === 1 ? json({ error: true }, 500)
        : count === 2 ? sse(failed(502)) : sse(complete));
    assert.match(await (await h.send()).text(), /NEW-RESULT/);
    const paths = h.calls.map(url => new URL(url).pathname.split('/'));
    assert.deepEqual(paths.map(x => x.at(-1)), ['start', 'resume', 'start']);
    assert.equal(paths[0][2], paths[1][2]); assert.notEqual(paths[0][2], paths[2][2]);
    assert.deepEqual(h.delays, [1500]); assert.equal(h.notices.filter(x => x.kind === 'delivery-error').length, 0);
});

test('4c plain or malformed failure markers do not authorize regeneration', async () => {
    for (const marker of [undefined, { version: 2, outcome: 'failed' }, { version: 1, outcome: 'unknown' },
        { version: 1, outcome: 'not_dispatched' }]) {
        const h = harness('gemini-4-carbon', () => sse({ error: { code: 502, message: 'unverified' }, g4keep: marker }));
        await assert.rejects((await h.send()).text());
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.delays, []);
    }
});

test('unrelated model, proxy and source preserve their original HTTP status classification', async () => {
    for (const [model, payloadChanges] of [
        ['other-model', {}],
        ['gemini-4-carbon', { reverse_proxy: 'https://other.example' }],
        ['gemini-4-argon', { chat_completion_source: 'other-provider' }],
    ]) {
        // An unrelated provider may happen to use the same marker field. Its
        // embedded 401 must not override HTTP 200 under the original rules.
        const h = harness(model, (_proxy, count) => count === 1 ? sse(failed(401)) : sse(complete), {}, payloadChanges);
        assert.match(await (await h.send()).text(), /NEW-RESULT/);
        assert.equal(h.calls.length, 2);
        assert.deepEqual(h.delays, [1500]);
    }
});

test('4a retains first and retry routing, retry budget and original network retry', async () => {
    const h = harness('gemini-4-argon', (_proxy, count) => {
        if (count === 1) throw new TypeError('synthetic network failure');
        return count === 2 ? sse({ error: { code: 502, message: 'synthetic upstream error' } }) : sse(complete);
    });
    assert.match(await (await h.send()).text(), /NEW-RESULT/);
    assert.equal(h.calls.length, 3);
    const routes = h.calls.map(url => new URL(url).pathname.split('/').filter(Boolean));
    assert.deepEqual(routes.map(x => [x[0], x[2]]), [['g4r1', '0'], ['g4r1', '1'], ['g4r1', '2']]);
    assert.match(routes[0][1], /^[0-9a-f]{32}$/);
    assert(routes.every(x => x[1] === routes[0][1] && !x.includes('g4d1')));
    assert.deepEqual(h.delays, [1500, 1500]);
    const disabled = harness('gemini-4-argon', () => json({ error: 'openai_error' }, 503), { retryApiErrors: false });
    assert.equal((await disabled.send()).status, 503);
    assert.equal(disabled.calls.length, 1);
});

test('4a retries initial HTTP rejection and subsequent protected SSE error', async () => {
    const h = harness('gemini-4-argon', (_proxy, count) => count === 1
        ? json({ error: { type: 'openai_error' } }, 503)
        : count === 2 ? sse({ error: { code: 502, message: 'synthetic error' } }) : sse(complete));
    assert.match(await (await h.send()).text(), /NEW-RESULT/);
    const paths = h.calls.map(url => new URL(url).pathname.split('/').filter(Boolean));
    assert.deepEqual(paths.map(x => x[2]), ['0', '1', '2']);
    assert(paths.every(x => x[0] === 'g4r1' && x[1] === paths[0][1]));
    assert.deepEqual(h.delays, [1500, 1500]);
});
