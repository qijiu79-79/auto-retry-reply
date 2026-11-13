import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRetryFetch } from '../fetch-retry.js';
import { createRetryController, DEFAULT_SETTINGS } from '../controller.js';

const endpoint = '/api/backends/chat-completions/generate';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
});
const error = (status = 500, headers) => json({ error: { type: 'openai_error' } }, status, headers);
const success = () => json({ choices: [{ message: { content: '正常回答' } }] });
const delta = content => ({ choices: [{ delta: { content } }] });
const sse = (...frames) => new Response(frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
});

function harness(responses, overrides = {}) {
    const calls = [], notices = [], delays = [];
    const abort = new AbortController();
    const settings = { ...DEFAULT_SETTINGS, ...overrides };
    const state = { key: 'chat', groupId: null, chat: [{ mes: '原消息', is_user: true }], busy: true, blocked: '' };
    let onNotice = () => {};
    const controller = createRetryController({
        getState: () => state, getSettings: () => settings,
        retry: () => assert.fail('API retries must not create a swipe or duplicate user messages'),
        notify: notice => { notices.push(notice); onNotice(notice); },
        setTimer: (callback, delay) => { delays.push(delay); return setTimeout(callback, 0); },
    });
    const fetch = createRetryFetch({ controller, baseUrl: 'http://localhost:8000/', fetch: async (url, options) => {
        calls.push({ url, options });
        return responses[Math.min(calls.length - 1, responses.length - 1)](url, options);
    } });
    const send = (payload = {}, options = {}) => fetch(endpoint, {
        method: 'POST', body: JSON.stringify({ type: 'normal', stream: false, messages: ['private'], ...payload }),
        signal: abort.signal, headers: { 'X-Test': 'unchanged' }, ...options,
    });
    controller.onStart('normal');
    return { fetch, send, calls, notices, delays, state, settings, abort, controller,
        onNotice: fn => { onNotice = fn; } };
}

test('HTTP/network/JSON errors retry the identical request without changing chat', async () => {
    const h = harness([() => { throw new TypeError('Failed to fetch'); }, () => error(), () => error(200), success]);
    const before = structuredClone(h.state.chat);
    assert.equal((await (await h.send()).json()).choices[0].message.content, '正常回答');
    assert.equal(h.calls.length, 4);
    for (const call of h.calls) assert.equal(call.options, h.calls[0].options);
    assert.deepEqual(h.state.chat, before);
    assert.deepEqual(h.delays, [2000, 2000, 2000]);
});

test('malformed JSON and response body read failure retry', async () => {
    const h = harness([() => new Response('{broken'), () => new Response(new ReadableStream({
        start(stream) { stream.error(new TypeError('connection closed')); },
    })), success]);
    assert.equal((await (await h.send()).json()).choices[0].message.content, '正常回答');
    assert.equal(h.calls.length, 3);
});

test('stops after exactly 20 additional attempts', async () => {
    const h = harness([() => error()]);
    assert.equal((await h.send()).status, 500);
    assert.equal(h.calls.length, 21);
    assert.equal(h.notices.at(-1).kind, 'limit');
});

test('HTTP 429 respects Retry-After and shares the SSE budget', async () => {
    const h = harness([() => error(429, { 'Retry-After': '7' }), () => sse({ error: 'openai_error' }), () => sse(delta('ok'), '[DONE]')]);
    assert.match(await (await h.send({ stream: true })).text(), /ok/);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.delays, [7000, 2000]);
});

for (const [status, data] of [[401, { error: 'invalid_api_key' }], [402, { error: 'insufficient balance' }],
    [500, { error: 'insufficient_quota' }], [400, { error: 'content_policy_violation' }]]) {
    test(`permanent failure does not retry (${status}, ${data.error})`, async () => {
        const h = harness([() => json(data, status), success]);
        assert.equal((await h.send()).status, status);
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.delays, []);
    });
}

test('quiet/impersonate/group/disabled requests are untouched', async () => {
    for (const type of ['quiet', 'impersonate']) {
        const h = harness([() => error()]);
        assert.equal((await h.send({ type })).status, 500);
        assert.equal(h.calls.length, 1);
    }
    for (const override of [{ enabled: false }, { retryApiErrors: false }]) {
        const h = harness([() => error()], override);
        await h.send();
        assert.equal(h.calls.length, 1);
    }
    const h = harness([() => error()]);
    h.state.groupId = 'group';
    await h.send();
    assert.equal(h.calls.length, 1);
});

test('unrelated URL, foreign origin, GET and Request inputs pass through', async () => {
    const h = harness([() => error()]);
    for (const url of ['/api/settings/save', `https://example.com${endpoint}`]) {
        await h.fetch(url, { method: 'POST', body: '{"type":"normal"}' });
    }
    await h.fetch(endpoint, { method: 'GET' });
    await h.fetch(new Request(`http://localhost:8000${endpoint}`, { method: 'POST', body: '{}' }));
    assert.equal(h.calls.length, 4);
    assert.deepEqual(h.delays, []);
});

test('manual stop, chat switch and setting changes cancel delayed retries', async () => {
    for (const change of [h => h.abort.abort(), h => { h.state.key = 'other-chat'; },
        h => { h.settings.enabled = false; }, h => h.controller.cancel()]) {
        const h = harness([() => error(), success]);
        h.onNotice(notice => { if (notice.kind === 'pending') change(h); });
        await h.send();
        assert.equal(h.calls.length, 1);
    }
});

test('early SSE errors retry, preserving normal streaming frames', async () => {
    const h = harness([() => sse({ error: 'openai_error' }), () => sse(delta('中文'), delta('回答'), '[DONE]')]);
    const body = await (await h.send({ stream: true })).text();
    assert.match(body, /中文/);
    assert.match(body, /回答/);
    assert.doesNotMatch(body, /openai_error/);
    assert.equal(h.calls.length, 2);
});

test('partial output is preserved without replaying or merging a new response', async () => {
    const h = harness([() => sse(delta('已有片段'), { error: 'openai_error' }), () => sse(delta('不该发送'))]);
    const reader = (await h.send({ stream: true })).body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /已有片段/);
    await assert.rejects(reader.read());
    assert.equal(h.calls.length, 1);
    assert.match(h.notices.at(-1).reason, /已保留片段/);
    assert.deepEqual(h.delays, []);
});

test('early stream transport failure and malformed SSE can retry', async () => {
    const h = harness([() => new Response(new ReadableStream({ start(stream) { stream.error(new TypeError('network')); } })),
        () => sse('{broken'), () => sse(delta('ok'), '[DONE]')]);
    assert.match(await (await h.send({ stream: true })).text(), /ok/);
    assert.equal(h.calls.length, 3);
});

test('SSE comments, CRLF, multiline data, split UTF-8 and backpressure are supported', async () => {
    const wire = ': heartbeat\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"中文"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(wire);
    const h = harness([() => new Response(new ReadableStream({ start(stream) {
        for (let i = 0; i < bytes.length; i++) stream.enqueue(bytes.slice(i, i + 1));
        stream.close();
    } }))]);
    const response = await h.send({ stream: true });
    assert.equal(await response.text(), wire);
    assert.equal(h.calls.length, 1);
});

test('early truncated SSE retries, but a partial answer followed by truncation does not', async () => {
    const h = harness([() => new Response('data: {"broken"'), () => sse(delta('ok'), '[DONE]')]);
    assert.match(await (await h.send({ stream: true })).text(), /ok/);
    assert.equal(h.calls.length, 2);
    const partial = harness([() => new Response('data: {"choices":[{"delta":{"content":"old"}}]}\n\ndata: {')]);
    await assert.rejects((await partial.send({ stream: true })).text());
    assert.equal(partial.calls.length, 1);
});

test('cancelled response does not start an unused retry', async () => {
    const h = harness([() => sse({ error: 'openai_error' }), success]);
    const response = await h.send({ stream: true });
    await response.body.cancel();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.delays, []);
});

test('API errors and empty/apology retries share the same limit', async () => {
    const h = harness([() => error(), success], { maxRetries: 1 });
    await h.send();
    h.state.chat.push({ mes: '', is_user: false });
    h.controller.onReceived(1, 'normal');
    h.controller.onEnded();
    assert.equal(h.notices.at(-1).kind, 'limit');
    assert.equal(h.delays.length, 1);
});

test('integration: actual unpatched SillyTavern request function works with the adapter', {
    skip: !process.env.AUTO_RETRY_CORE_SOURCE,
}, async () => {
    const source = await readFile(process.env.AUTO_RETRY_CORE_SOURCE, 'utf8');
    const start = source.indexOf('async function sendOpenAIRequest(');
    const end = source.indexOf('\n/**', start);
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(source.slice(start, end), /CHAT_COMPLETION_REQUEST_FAILED/);
    for (const streaming of [false, true]) {
        const h = harness([() => error(), streaming ? () => sse(delta('实际核心正常回答'), '[DONE]') : success]);
        const sseSource = await readFile(new URL('sse-stream.js', `file://${process.env.AUTO_RETRY_CORE_SOURCE}`), 'utf8');
        const parserStart = sseSource.indexOf('class EventSourceStream {');
        const parserEnd = sseSource.indexOf('\n/**', parserStart);
        const makeParser = new Function(`${sseSource.slice(parserStart, parserEnd)}; return new EventSourceStream();`);
        const deps = {
            getChatCompletionModel: () => 'test', oai_settings: {},
            createGenerationParameters: async () => ({ generate_data: { type: 'normal', stream: streaming }, stream: streaming, canMultiSwipe: false }),
            eventSource: { emit: async () => {} }, event_types: { CHAT_COMPLETION_SETTINGS_READY: 'settings' },
            fetch: h.fetch, getRequestHeaders: () => ({}), getEventSourceStream: makeParser,
            tryParseStreamingError: () => {}, getStreamingReply: data => data.choices[0].delta.content,
            ToolManager: { parseToolCalls: () => {} }, parseChatCompletionLogprobs: () => null,
            checkQuotaError: () => {}, checkModerationError: () => {},
            getChatCompletionErrorMessage: () => 'error', toastr: { error: () => {} }, t: x => x[0],
            delay: async () => {}, saveLogprobsForActiveMessage: () => {},
        };
        const send = new Function(...Object.keys(deps), `${source.slice(start, end)}; return sendOpenAIRequest;`)(...Object.values(deps));
        const result = await send('normal', [], h.abort.signal);
        if (streaming) {
            let text = '';
            for await (const chunk of result()) text = chunk.text;
            assert.equal(text, '实际核心正常回答');
        } else assert.equal(result.choices[0].message.content, '正常回答');
        assert.equal(h.calls.length, 2);
    }
});
