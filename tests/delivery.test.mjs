import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFetch } from '../delivery.js';
import { createRetryFetch } from '../fetch-retry.js';

const payload = { type: 'normal', stream: true, chat_completion_source: 'makersuite', model: 'gemini-4-carbon',
    reverse_proxy: 'https://api.doggego.online', tools: [{ type: 'function', function: {
        name: 'dispatch_stream_payload_0123456789abcdef', parameters: { properties: { display_stream: { type: 'string' } } },
    } }] };
const frame = value => new TextEncoder().encode('data: ' + JSON.stringify(value) + '\n\n');
const heartbeat = new TextEncoder().encode(': keepalive\n\n');
const partial = frame({ candidates: [{ content: { parts: [{ text: 'OLD' }] } }] });
const finish = frame({ candidates: [{ content: { parts: [{ text: 'NEW' }] }, finishReason: 'STOP' }] });
const id = '0123456789abcdef0123456789abcdef';
const ticket = 'fedcba9876543210fedcba9876543210';
const proofValue = 'abcdef0123456789'.repeat(4);
const actionFromProxy = proxy => new URL(proxy).pathname.split('/').filter(Boolean)[2] ?? new URL(proxy).hostname;
const action = opts => actionFromProxy(JSON.parse(opts.body).reverse_proxy);
const withPrepare = fetch => (url, opts) => action(opts) === 'prepare'
    ? Promise.resolve(new Response(JSON.stringify({ g4keep: { version: 1, outcome: 'prepared', ticket, proof: proofValue } })))
    : fetch(url, opts);
const forever = () => new Promise(() => {});
const stream = chunks => new Response(new ReadableStream({ start(c) {
    for (const chunk of chunks) c.enqueue(chunk);
    if (!chunks.includes(null)) c.close();
} }), { headers: { 'Content-Type': 'text/event-stream' } });
function fakeClock() {
    let time = 0, callback;
    const listeners = new Set();
    const doc = { visibilityState: 'visible', addEventListener(_n, f) { listeners.add(f); }, removeEventListener(_n, f) { listeners.delete(f); },
        change(state) { this.visibilityState = state; for (const f of listeners) f(); } };
    return { doc, now: () => time, interval: f => { callback = f; return 1; }, clear: () => { callback = null; },
        step(n = 1000) { time += n; callback?.(); }, get callbacks() { return listeners.size; } };
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
function setup(fetch, extra = {}) {
    const clock = fakeClock(), abort = new AbortController(), blocked = [];
    let live = true;
    const args = { fetch: withPrepare(fetch), input: '/api/backends/chat-completions/generate',
        options: { method: 'POST', body: JSON.stringify(payload), signal: abort.signal }, payload,
        baseUrl: 'http://127.0.0.1:8000/', context: { runId: id }, valid: () => live,
        blockRetry: reason => blocked.push(reason), makeId: () => id, ...clock, ...extra };
    return { args, clock, abort, blocked, invalidate: () => { live = false; } };
}

for (const model of ['gemini-4-carbon', 'gemini-4-carbon-low', 'gemini-4-carbon-high']) {
    test(`${model} recovers the same ID and preserves model, effort and payload`, async () => {
        const calls = [];
        const original = { ...payload, model, reasoning_effort: 'medium', max_tokens: 40000,
            messages: [{ role: 'user', content: 'synthetic input unchanged' }] };
        const env = setup((_url, options) => {
            calls.push(JSON.parse(options.body));
            return Promise.resolve(calls.length === 1 ? stream([heartbeat, partial]) : stream([finish]));
        });
        env.args.payload = original; env.args.options.body = JSON.stringify(original);
        assert.match(await (await deliveryFetch(env.args)).text(), /NEW/);
        assert.deepEqual(calls.map(x => actionFromProxy(x.reverse_proxy)), ['commit', 'resume']);
        for (const call of calls) {
            assert(call.reverse_proxy.includes(id));
            assert(call.reverse_proxy.endsWith('/' + ticket));
            assert.deepEqual({ ...call, reverse_proxy: original.reverse_proxy }, original);
        }
        assert.deepEqual(env.blocked, []);
    });
}

test('other models and unknown Carbon suffixes do not opt into delivery', async () => {
    for (const model of ['gemini-4-argon', 'gemini-4-hydrogen', 'gemini-4-carbon-medium',
        'gemini-4-carbon-high-extra', 'gemini-4-carbon-high-keepalive', 'gemini-4-carbonx']) {
        const calls = [], original = { ...payload, model };
        const env = setup((_url, options) => { calls.push(options.body); return Promise.resolve(stream([finish])); });
        env.args.payload = original; env.args.options.body = JSON.stringify(original);
        await (await deliveryFetch(env.args)).text();
        assert.deepEqual(calls, [JSON.stringify(original)]);
    }
});

test('resume before first response uses same ID and never repeats start', async () => {
    const calls = [];
    const env = setup((_url, opts) => { calls.push(JSON.parse(opts.body).reverse_proxy); return action(opts) === 'commit' ? forever() : Promise.resolve(stream([finish])); });
    const pending = deliveryFetch(env.args);
    await flush();
    for (let i = 0; i < 40; i++) env.clock.step();
    const response = await pending;
    assert.match(await response.text(), /NEW/);
    assert.deepEqual(calls.map(actionFromProxy), ['commit', 'resume']);
    assert(calls.every(x => x.includes(id)));
    assert.equal(env.blocked.length, 0);
});

test('Tavern HTTP 500 after a lost upstream connection resumes the same ID without changing content or effort', async () => {
    const calls = [], requests = [];
    const env = setup((_url, opts) => {
        const request = JSON.parse(opts.body); calls.push(action(opts)); requests.push(request);
        return Promise.resolve(action(opts) === 'commit'
            ? new Response(JSON.stringify({ error: true }), { status: 500 }) : stream([finish]));
    });
    env.args.payload = { ...payload, reasoning_effort: 'high', max_tokens: 40000,
        messages: [{ role: 'user', content: 'synthetic original prompt' }] };
    env.args.options.body = JSON.stringify(env.args.payload);
    assert.match(await (await deliveryFetch(env.args)).text(), /NEW/);
    assert.deepEqual(calls, ['commit', 'resume']); assert.deepEqual(env.blocked, []);
    for (const request of requests) {
        assert.match(request.reverse_proxy, new RegExp('/' + id + '/'));
        assert.deepEqual({ ...request, reverse_proxy: payload.reverse_proxy }, env.args.payload);
    }
});

test('transient HTTP errors during recovery use the same three-attempt budget, not new generations', async () => {
    for (const success of [true, false]) {
        const calls = [];
        const env = setup((_url, opts) => {
            calls.push(action(opts));
            return Promise.resolve(success && calls.length === 4 ? stream([finish])
                : new Response('temporary proxy error', { status: calls.length === 1 ? 500 : 503 }));
        });
        if (success) { assert.match(await (await deliveryFetch(env.args)).text(), /NEW/); assert.deepEqual(env.blocked, []); }
        else { await assert.rejects(deliveryFetch(env.args), /可能已扣费/); assert.equal(env.blocked.length, 1); }
        assert.deepEqual(calls, ['commit', 'resume', 'resume', 'resume']); assert.equal(env.clock.callbacks, 0);
    }
});

test('a lost stream can recover through an intermediate HTTP 502', async () => {
    const calls = [];
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        return Promise.resolve(calls.length === 1 ? stream([heartbeat, partial])
            : calls.length === 2 ? new Response('proxy error', { status: 502 }) : stream([finish]));
    });
    const text = await (await deliveryFetch(env.args)).text();
    assert.match(text, /NEW/); assert.doesNotMatch(text, /OLD/);
    assert.deepEqual(calls, ['commit', 'resume', 'resume']); assert.deepEqual(env.blocked, []);
});

test('definitive delivery and authorization rejections do not cause recovery loops', async () => {
    for (const [status, code] of [[401, 'AUTH'], [403, 'G4_DELIVERY_AUTH'], [409, 'G4_DELIVERY_CONFLICT'],
        [410, 'G4_DELIVERY_EXPIRED'], [503, 'G4_DELIVERY_BUSY']]) {
        const calls = [];
        const env = setup((_url, opts) => { calls.push(action(opts)); return Promise.resolve(new Response(
            JSON.stringify({ error: { code } }), { status })); });
        await assert.rejects(deliveryFetch(env.args), /可能已扣费/);
        assert.deepEqual(calls, ['commit']); assert.equal(env.blocked.length, 1);
    }
});

test('Tavern HTTP 500 followed by missing recovery stops without a second start', async () => {
    const calls = [];
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        return Promise.resolve(action(opts) === 'commit' ? new Response('{"error":true}', { status: 500 })
            : new Response('{"error":{"code":"G4_DELIVERY_MISSING"}}', { status: 410 }));
    });
    await assert.rejects(deliveryFetch(env.args), /可能已扣费/);
    assert.deepEqual(calls, ['commit', 'resume']); assert.equal(env.blocked.length, 1);
});

test('HTTP 500 while hidden waits for foreground and manual stop does not report a delivery failure', async () => {
    for (const stop of [false, true]) {
        const calls = []; let resolveStart;
        const env = setup((_url, opts) => {
            calls.push(action(opts));
            return action(opts) === 'commit' ? new Promise(resolve => { resolveStart = resolve; }) : Promise.resolve(stream([finish]));
        });
        const pending = deliveryFetch(env.args).then(r => r.text()).then(text => ({ text }), error => ({ error }));
        await flush();
        env.clock.doc.change('hidden'); resolveStart(new Response('{"error":true}', { status: 500 }));
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(calls, ['commit']); assert.deepEqual(env.blocked, []);
        if (stop) {
            env.abort.abort(); assert.equal((await pending).error?.name, 'AbortError'); await flush();
            assert.deepEqual(calls, ['commit', 'cancel']); assert.deepEqual(env.blocked, []);
        } else {
            env.clock.doc.change('visible'); assert.match((await pending).text, /NEW/);
            assert.deepEqual(calls, ['commit', 'resume']); assert.deepEqual(env.blocked, []);
        }
        assert.equal(env.clock.callbacks, 0);
    }
});
test('all four randomly selected preset tool prefixes opt in', async () => {
    for (const prefix of ['dispatch_stream_payload_', 'render_document_chunk_', 'stream_response_segment_', 'deliver_formatted_view_']) {
        const calls=[]; const env=setup((_url,opts)=>{calls.push(action(opts));return Promise.resolve(stream([finish]));});
        env.args.payload=JSON.parse(JSON.stringify(payload));env.args.payload.tools[0].function.name=prefix+'0123456789abcdef';
        env.args.options.body=JSON.stringify(env.args.payload);
        assert.match(await(await deliveryFetch(env.args)).text(),/NEW/);assert.deepEqual(calls,['commit']);
    }
});

test('partial data discarded on disconnect, recovered complete event closes without EOF', async () => {
    const calls = [];
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        return Promise.resolve(action(opts) === 'commit'
            ? stream([heartbeat, partial, new TextEncoder().encode('data: {"cand')])
            : new Response(new ReadableStream({ start(c) { c.enqueue(finish); } })));
    });
    const response = await deliveryFetch(env.args);
    const text = await response.text();
    assert.match(text, /NEW/); assert.doesNotMatch(text, /OLD/);
    assert.deepEqual(calls, ['commit', 'resume']);
});

test('hidden time and a frozen callback do not count; foreground has grace', async () => {
    const calls = [];
    const env = setup((_url, opts) => { calls.push(action(opts)); return action(opts) === 'commit' ? forever() : Promise.resolve(stream([finish])); });
    const pending = deliveryFetch(env.args);
    await flush();
    for (let i = 0; i < 20; i++) env.clock.step();
    env.clock.doc.change('hidden'); env.clock.step(500000);
    env.clock.doc.change('visible');
    for (let i = 0; i < 69; i++) env.clock.step();
    assert.deepEqual(calls, ['commit']);
    env.clock.step();
    assert.match(await (await pending).text(), /NEW/);
    assert.deepEqual(calls, ['commit', 'resume']);
});

test('a connection rejected in the background waits for foreground before spending recovery attempts', async t => {
    const calls = []; let rejectStart;
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        if (action(opts) === 'commit') return new Promise((_, reject) => { rejectStart = reject; });
        if (env.clock.doc.visibilityState === 'hidden') return Promise.reject(new TypeError('background network unavailable'));
        return Promise.resolve(stream([finish]));
    });
    t.after(() => env.abort.abort());
    const result = deliveryFetch(env.args).then(r => r.text()).then(text => ({ text }), error => ({ error }));
    await flush();
    env.clock.doc.change('hidden'); rejectStart(new TypeError('connection lost'));
    await flush(); env.clock.step(4 * 60 * 1000); await flush();
    assert.deepEqual(calls, ['commit']); assert.deepEqual(env.blocked, []);
    env.clock.doc.change('visible');
    assert.match((await result).text, /NEW/);
    assert.deepEqual(calls, ['commit', 'resume']); assert.deepEqual(env.blocked, []);
    assert.equal(env.clock.callbacks, 0);
});

test('a stream lost in the background keeps the same request recoverable on return', async t => {
    const calls = []; let source;
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        if (action(opts) === 'commit') return Promise.resolve(new Response(new ReadableStream({ start(c) { source = c; c.enqueue(heartbeat); } })));
        if (env.clock.doc.visibilityState === 'hidden') return Promise.reject(new TypeError('background network unavailable'));
        return Promise.resolve(stream([finish]));
    });
    t.after(() => env.abort.abort());
    const response = await deliveryFetch(env.args);
    const result = response.text().then(text => ({ text }), error => ({ error }));
    env.clock.doc.change('hidden'); source.error(new TypeError('connection lost'));
    await flush(); env.clock.step(4 * 60 * 1000); await flush();
    assert.deepEqual(calls, ['commit']); assert.deepEqual(env.blocked, []);
    env.clock.doc.change('visible');
    assert.match((await result).text, /NEW/);
    assert.deepEqual(calls, ['commit', 'resume']); assert.deepEqual(env.blocked, []);
    assert.equal(env.clock.callbacks, 0);
});

test('stop or context change while waiting for foreground cancels once and never resumes', async () => {
    for (const invalid of [false, true]) {
        const calls = []; let rejectStart;
        const env = setup((_url, opts) => {
            calls.push(action(opts));
            return action(opts) === 'commit' ? new Promise((_, reject) => { rejectStart = reject; }) : Promise.resolve(new Response('{}'));
        });
        const pending = deliveryFetch(env.args);
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        await flush();
        env.clock.doc.change('hidden'); rejectStart(new TypeError('connection lost')); await flush();
        assert.deepEqual(calls, ['commit']);
        if (invalid) { env.invalidate(); env.clock.step(); } else env.abort.abort();
        await rejected; await flush();
        env.clock.doc.change('visible'); await flush();
        assert.deepEqual(calls, ['commit', 'cancel']); assert.equal(env.clock.callbacks, 0);
    }
});

test('hiding a healthy response does not abort or reconnect it', async () => {
    const calls = []; let source;
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        return Promise.resolve(new Response(new ReadableStream({ start(c) { source = c; c.enqueue(heartbeat); } })));
    });
    const response = await deliveryFetch(env.args), result = response.text();
    env.clock.doc.change('hidden'); env.clock.step(4 * 60 * 1000); source.enqueue(finish);
    assert.match(await result, /NEW/); assert.deepEqual(calls, ['commit']);
    assert.deepEqual(env.blocked, []); assert.equal(env.clock.callbacks, 0);
});

test('persistent foreground network errors still have a bounded recovery budget', async () => {
    const calls = [];
    const env = setup((_url, opts) => { calls.push(action(opts)); return Promise.reject(new TypeError('network unavailable')); });
    await assert.rejects(deliveryFetch(env.args), /可能已扣费/);
    assert.deepEqual(calls, ['commit', 'resume', 'resume', 'resume']);
    assert.equal(env.blocked.length, 1); assert.equal(env.clock.callbacks, 0);
});

test('a long event-loop freeze is not mistaken for lost heartbeats', async () => {
    const calls = [];
    const env = setup((_url, opts) => { calls.push(action(opts)); return action(opts) === 'commit' ? forever() : Promise.resolve(stream([finish])); });
    const pending = deliveryFetch(env.args);
    await flush();
    env.clock.step(400000);
    for (let i = 0; i < 69; i++) env.clock.step();
    assert.deepEqual(calls, ['commit']);
    env.clock.step();
    assert.match(await (await pending).text(), /NEW/);
    assert.deepEqual(calls, ['commit', 'resume']);
});

test('reader cancel sends one cancel and never resumes', async () => {
    const calls = [];
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        return action(opts) === 'commit' ? Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(heartbeat); } }))) : Promise.resolve(new Response('{}'));
    });
    const response = await deliveryFetch(env.args), reader = response.body.getReader();
    await reader.read(); await reader.cancel(); await flush();
    assert.deepEqual(calls, ['commit', 'cancel']);
    assert.equal(env.clock.callbacks, 0);
});

test('user stop and invalid context send cancel and do not resume', async () => {
    for (const invalid of [false, true]) {
        const calls = [];
        const env = setup((_url, opts) => { calls.push(action(opts)); return action(opts) === 'cancel' ? Promise.resolve(new Response('{}')) : forever(); });
        const pending = deliveryFetch(env.args);
        await flush();
        if (invalid) { env.invalidate(); env.clock.step(); } else env.abort.abort();
        await assert.rejects(pending, { name: 'AbortError' }); await flush();
        assert.deepEqual(calls, ['commit', 'cancel']);
        assert.equal(env.clock.callbacks, 0);
    }
});

test('stopping during prepare cancels without a ticket and never commits', async () => {
    const calls = [];
    const env = setup(() => assert.fail('normal fetch must not be called'));
    env.args.fetch = (_url, opts) => {
        const proxy = JSON.parse(opts.body).reverse_proxy;
        calls.push(proxy);
        return action(opts) === 'prepare' ? forever() : Promise.resolve(new Response('{}'));
    };
    const pending = deliveryFetch(env.args);
    env.abort.abort();
    await assert.rejects(pending, { name: 'AbortError' }); await flush();
    assert.deepEqual(calls.map(actionFromProxy), ['prepare', 'cancel']);
    assert(calls.every(path => !path.includes(ticket)));
    assert.deepEqual(env.blocked, []);
});

test('missing resume blocks automatic retry and never resends start', async () => {
    const calls = [];
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        return action(opts) === 'commit' ? Promise.reject(new Error('lost')) : Promise.resolve(new Response('{"error":{"code":"G4_DELIVERY_MISSING"}}', { status: 410 }));
    });
    await assert.rejects(deliveryFetch(env.args), /可能已扣费/);
    assert.equal(env.blocked.length, 1);
    assert.deepEqual(calls, ['commit', 'resume']);
});

test('ineligible commit can fall back only with matching bypass proof', async () => {
    const calls = [];
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        return Promise.resolve(action(opts) === 'commit'
            ? new Response(JSON.stringify({ error: { code: 'G4_DELIVERY_INELIGIBLE' }, not_dispatched: true,
                g4keep: { version: 1, outcome: 'bypassed', proof: proofValue } }), { status: 403 })
            : stream([finish]));
    });
    assert.match(await (await deliveryFetch(env.args)).text(), /NEW/);
    assert.deepEqual(calls, ['commit', 'api.doggego.online']);
    assert.equal(env.blocked.length, 0);
});

test('ineligible commit without matching bypass proof never falls back', async () => {
    for (const marker of [undefined, { version: 1, outcome: 'bypassed', proof: '0'.repeat(64) },
        { version: 1, outcome: 'not_dispatched', proof: proofValue }, { version: 2, outcome: 'bypassed', proof: proofValue },
        { version: 1, outcome: 'bypassed', ticket }]) {
        const calls = [];
        const env = setup((_url, opts) => {
            calls.push(action(opts));
            return Promise.resolve(new Response(JSON.stringify({ error: { code: 'G4_DELIVERY_INELIGIBLE' },
                not_dispatched: true, g4keep: marker }), { status: 403 }));
        });
        await assert.rejects(deliveryFetch(env.args), /可能已扣费/);
        assert.deepEqual(calls, ['commit']); assert.equal(env.blocked.length, 1);
    }
});

test('ineligible received during resume must not fall back after ambiguous start', async () => {
    const calls = [];
    const env = setup((_url, opts) => {
        calls.push(action(opts));
        return action(opts) === 'commit' ? Promise.reject(Error('lost'))
            : Promise.resolve(new Response(JSON.stringify({ error: { code: 'G4_DELIVERY_INELIGIBLE' }, not_dispatched: true,
                g4keep: { version: 1, outcome: 'bypassed', proof: proofValue } }), { status: 403 }));
    });
    await assert.rejects(deliveryFetch(env.args), /可能已扣费/);
    assert.deepEqual(calls, ['commit', 'resume']);
    assert.equal(env.blocked.length, 1);
});

test('Argon and requests without matching tool are unchanged', async () => {
    for (const changed of [{ model: 'gemini-4-argon' }, { tools: [] }]) {
        let called;
        const env = setup((_url, opts) => { called = opts; return Promise.resolve(stream([finish])); });
        env.args.payload = { ...payload, ...changed };
        env.args.options = { ...env.args.options, body: JSON.stringify(env.args.payload) };
        await deliveryFetch(env.args);
        assert.equal(called, env.args.options);
    }
});

test('all SSE errors after delivery was selected are passed through but block retry', async () => {
    for (const code of ['G4_DELIVERY_FAILED', 502, 504]) {
        const env = setup(() => Promise.resolve(stream([frame({ error: { code } })])));
        assert.match(await (await deliveryFetch(env.args)).text(), /error/);
        assert.equal(env.blocked.length, 1);
    }
});

test('createRetryFetch cannot regenerate a delivery-owned 502 even if retry controller asks', async () => {
    const calls = [], blocked = []; let retries = 0;
    const controller = { onRequestStarted: () => true, getRoutingContext: () => ({ runId: id, attempt: 0 }),
        cancelRequest: (_req, reason) => blocked.push(reason), onRequestFailed: async e => { retries++; e.retry = true; } };
    const adapter = createRetryFetch({ controller, baseUrl: 'http://127.0.0.1:8000/', fetch: withPrepare(async (_url, opts) => {
        calls.push(action(opts)); return stream([frame({ error: { code: 502, message: 'synthetic upstream error' } })]);
    }) });
    const res = await adapter('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload) });
    await assert.rejects(res.text());
    assert.deepEqual(calls, ['commit']); assert.equal(retries, 0); assert.equal(blocked.length, 1);
});

test('createRetryFetch uses untouched original route after explicitly ineligible start', async () => {
    const calls = [], blocked = [];
    const controller = { onRequestStarted: () => true, getRoutingContext: () => ({ runId: id, attempt: 0 }),
        cancelRequest: (_req, reason) => blocked.push(reason), onRequestFailed: async () => { throw Error('unexpected retry'); } };
    const adapter = createRetryFetch({ controller, baseUrl: 'http://127.0.0.1:8000/', fetch: withPrepare(async (_url, opts) => {
        const path = JSON.parse(opts.body).reverse_proxy; calls.push(path);
        return path.includes('/g4d1/')
            ? new Response(JSON.stringify({ error: { code: 'G4_DELIVERY_INELIGIBLE' }, not_dispatched: true,
                g4keep: { version: 1, outcome: 'bypassed', proof: proofValue } }), { status: 403 })
            : stream([finish]);
    }) });
    const res = await adapter('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload) });
    assert.match(await res.text(), /NEW/);
    assert.equal(calls.length, 2); assert.match(calls[0], new RegExp('/g4d1/[a-f0-9]{32}/commit/' + ticket + '$')); assert.equal(calls[1], payload.reverse_proxy);
    assert.deepEqual(blocked, []);
});

test('createRetryFetch never regenerates after delivery recovery status is unknown', async () => {
    const calls = [], blocked = []; let live = true, retries = 0;
    const controller = { onRequestStarted: () => true, getRoutingContext: () => live ? ({ runId: id, attempt: 0 }) : null,
        cancelRequest: (_req, reason) => { blocked.push(reason); live = false; },
        onRequestFailed: async e => { retries++; e.retry = true; } };
    const adapter = createRetryFetch({ controller, baseUrl: 'http://127.0.0.1:8000/', fetch: withPrepare(async (_url, opts) => {
        calls.push(action(opts));
        if (action(opts) === 'commit') throw Error('connection disappeared');
        return new Response(JSON.stringify({ error: { code: 'G4_DELIVERY_MISSING' } }), { status: 410 });
    }) });
    await assert.rejects(adapter('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload) }), /可能已扣费/);
    assert.deepEqual(calls, ['commit', 'resume']);
    assert.equal(blocked.length, 1);
    assert.equal(retries, 0);
});
