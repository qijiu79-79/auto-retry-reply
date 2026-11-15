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
const action = proxy => new URL(proxy).pathname.split('/').filter(Boolean)[2];

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

test('stream recovery errors preserve the server Retry-After delay', async () => {
    const h = harness('gemini-4-carbon', (_proxy, count) => count === 1 ? sse(partial) : count === 2
        ? new Response('{"error":{"code":"G4_DELIVERY_BUSY"}}', {status:429,headers:{'Retry-After':'30'}})
        : sse(complete));
    assert.match(await (await h.send()).text(), /NEW-RESULT/);
    assert.deepEqual(h.delays,[30000]);assert.deepEqual(h.calls.map(action), ['start', 'resume', 'start']);
});

test('an invalid initial Retry-After does not mask a valid recovery delay', async () => {
    const h = harness('gemini-4-carbon', (_proxy, count) => count <= 2
        ? new Response('{"error":true}', {status:503,headers:{'Retry-After':count === 1 ? 'invalid-value' : '90'}})
        : count === 3 ? json({error:{code:'G4_DELIVERY_MISSING'}},410) : sse(complete));
    assert.match(await (await h.send()).text(), /NEW-RESULT/);
    assert.deepEqual(h.delays,[90000]);
    assert.deepEqual(h.calls.map(action),['start','resume','resume','start']);
});

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
        assert(paths.every(parts => parts.length === 3));
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

for (const model of ['gemini-4-carbon-low', 'gemini-4-carbon-high']) {
    test(`${model} honors recorded 401/403 and retries recorded 502/504`, async () => {
        for (const code of [401, 403, 502, 504]) {
            const h = harness(model, (_proxy, count) => count === 1 ? sse(failed(code)) : sse(complete));
            const result = (await h.send()).text();
            if (code === 401 || code === 403) {
                await assert.rejects(result);
                assert.equal(h.calls.length, 1); assert.deepEqual(h.delays, []);
            } else {
                assert.match(await result, /NEW-RESULT/);
                assert.equal(h.calls.length, 2); assert.deepEqual(h.delays, [1500]);
            }
        }
    });
}

test('4c G4 delivery failures follow the original retry rules', async () => {
    const h = harness('gemini-4-carbon', (_proxy, count) => count === 1
        ? sse({ error: { code: 'G4_DELIVERY_FAILED' } }) : sse(complete));
    assert.match(await (await h.send()).text(), /NEW-RESULT/);
    assert.deepEqual(h.calls.map(action), ['start', 'start']);
    assert.deepEqual(h.delays, [1500]);
});

test('4c Tavern HTTP 500 and missing recovery retry with a fresh ID under original settings', async () => {
    const h = harness('gemini-4-carbon', (_proxy, count) => count === 1 ? json({ error: true }, 500)
        : count === 2 ? json({ error: { code: 'G4_DELIVERY_MISSING' } }, 410) : sse(complete));
    assert.match(await (await h.send()).text(), /NEW-RESULT/);
    const paths = h.calls.map(url => new URL(url).pathname.split('/'));
    assert.deepEqual(paths.map(x => x[3]), ['start', 'resume', 'start']);
    assert.equal(paths[0][2], paths[1][2]); assert.notEqual(paths[0][2], paths[2][2]);
    assert.deepEqual(h.delays, [1500]);
    assert.equal(h.notices.filter(x => x.kind === 'delivery-error').length, 0);
});

test('missing recovery respects retry switch, limit and manual cancellation', async () => {
    const respond = proxy => action(proxy) === 'start' ? json({ error: true }, 500)
        : json({ error: { code: 'G4_DELIVERY_MISSING' } }, 410);
    const disabled = harness('gemini-4-carbon', respond, { retryApiErrors: false });
    assert.equal((await disabled.send()).status, 410);
    assert.deepEqual(disabled.calls.map(action), ['start', 'resume']); assert.deepEqual(disabled.delays, []);
    const limited = harness('gemini-4-carbon', respond, { maxRetries: 2 });
    assert.equal((await limited.send()).status, 410);
    assert.deepEqual(limited.calls.map(action), ['start', 'resume', 'start', 'resume', 'start', 'resume']);
    assert.deepEqual(limited.delays, [1500, 1500]); assert.equal(limited.notices.at(-1).kind, 'limit');
    for (const change of [h => h.abort.abort(), h => { h.state.key = 'another-chat'; }]) {
        const stopped = harness('gemini-4-carbon', respond);
        stopped.onNotice(notice => { if (notice.kind === 'pending') change(stopped); });
        assert.equal((await stopped.send()).status, 410);
        assert.deepEqual(stopped.calls.map(action), ['start', 'resume']);
    }
});

test('stream recovery authorization and permanent quota errors are not retried', async () => {
    for (const [status, detail] of [[401, { error: { message: 'unauthorized' } }],
        [403, { error: { message: 'forbidden' } }], [500, { error: { code: 'insufficient_quota' } }]]) {
        const h = harness('gemini-4-carbon', (_proxy, count) => count === 1 ? sse(partial) : json(detail, status));
        await assert.rejects((await h.send()).text());
        assert.deepEqual(h.calls.map(action), ['start', 'resume']); assert.deepEqual(h.delays, []);
    }
});

test('4c generic proxy 500 is recovered, then a recorded API failure follows the original policy', async () => {
    const h = harness('gemini-4-carbon', (_proxy, count) => count === 1 ? json({ error: true }, 500)
        : count === 2 ? sse(failed(502)) : sse(complete));
    assert.match(await (await h.send()).text(), /NEW-RESULT/);
    const paths = h.calls.map(url => new URL(url).pathname.split('/'));
    assert.deepEqual(paths.map(x => x[3]), ['start', 'resume', 'start']);
    assert(paths.every(x => x.length === 4));
    assert.equal(paths[0][2], paths[1][2]); assert.notEqual(paths[0][2], paths[2][2]);
    assert.deepEqual(h.delays, [1500]); assert.equal(h.notices.filter(x => x.kind === 'delivery-error').length, 0);
});

test('4c plain or malformed failure markers follow original SSE retry rules', async () => {
    for (const marker of [undefined, { version: 2, outcome: 'failed' }, { version: 1, outcome: 'unknown' },
        { version: 1, outcome: 'not_dispatched' }]) {
        const h = harness('gemini-4-carbon', (_proxy, count) => count === 1
            ? sse({ error: { code: 502, message: 'unverified' }, g4keep: marker }) : sse(complete));
        assert.match(await (await h.send()).text(), /NEW-RESULT/);
        assert.equal(h.calls.length, 2);
        assert.deepEqual(h.delays, [1500]);
    }
});

test('start HTTP 500 insufficient quota is permanent and does not resume or retry', async () => {
    const h = harness('gemini-4-carbon', () => json({ error: { code: 'insufficient_quota', message: 'insufficient quota' } }, 500));
    assert.equal((await h.send()).status, 500);
    assert.deepEqual(h.calls.map(action), ['start']); assert.deepEqual(h.delays, []);
});

for (const status of [429, 503]) {
    for (const failure of ['missing', 'network']) {
        test(`initial ${status} Retry-After survives ${failure} recovery failure`, async () => {
            const h = harness('gemini-4-carbon', (_proxy, count) => {
                if (count === 1) return new Response('{"error":true}', { status, headers: { 'Retry-After': '90' } });
                if (failure === 'missing' && count === 2) return json({ error: { code: 'G4_DELIVERY_MISSING' } }, 410);
                if (failure === 'network' && count <= 4) throw new TypeError('network unavailable');
                return sse(complete);
            });
            assert.match(await (await h.send()).text(), /NEW-RESULT/);
            assert.deepEqual(h.delays, [90000]);
            assert.deepEqual(h.calls.map(action), failure === 'missing'
                ? ['start', 'resume', 'start'] : ['start', 'resume', 'resume', 'resume', 'start']);
        });
    }
}

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
