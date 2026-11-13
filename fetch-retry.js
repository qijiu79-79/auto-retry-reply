// SPDX-License-Identifier: AGPL-3.0-only
// Browser-only adapter. No SillyTavern source files or event definitions change.
import { routedOptions } from './routing.js';
import { deliveryFetch, isRecordedApiFailure } from './delivery.js';
const ENDPOINT = '/api/backends/chat-completions/generate';
const TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);

function errorPayload(data) {
    return Boolean(data && (data.error || data.detail || data.quota_error || typeof data.message === 'string'));
}

function parseFailure(text, status) {
    try { return JSON.parse(text); }
    catch { return new Error(`Got response status ${status}`); }
}

function frameData(frame) {
    return frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
}

export function createRetryFetch({ fetch: originalFetch, controller, baseUrl }) {
    return async function retryFetch(input, options) {
        // SillyTavern uses a string URL and a reusable JSON string body. Leave
        // Request/stream bodies and every unrelated request completely alone.
        let payload;
        try {
            const url = new URL(input instanceof URL ? input.href : input, baseUrl);
            if (typeof input !== 'string' && !(input instanceof URL)
                || url.origin !== new URL(baseUrl).origin || url.pathname !== ENDPOINT
                || String(options?.method).toUpperCase() !== 'POST' || typeof options?.body !== 'string') {
                return originalFetch(input, options);
            }
            payload = JSON.parse(options.body);
        } catch { return originalFetch(input, options); }
        if (!TYPES.has(payload?.type)) return originalFetch(input, options);

        const signal = options.signal;
        const request = { type: payload.type, signal };
        const bridgeTarget = payload.chat_completion_source === 'makersuite'
            && ['gemini-4-carbon', 'gemini-4-argon'].includes(payload.model)
            && /^https:\/\/api\.doggego\.online\/?$/.test(payload.reverse_proxy);
        let deliveryBlocked = false;
        if (!controller.onRequestStarted(request)) return originalFetch(input, options);

        async function shouldRetry(error, response) {
            if (deliveryBlocked || signal?.aborted || error?.name === 'AbortError') return false;
            if (String(error?.code ?? error?.error?.code ?? '').startsWith('G4_DELIVERY_')) return false;
            const event = { request, error, status: bridgeTarget && isRecordedApiFailure(error) ? error.error.code : response?.status,
                retryAfter: response?.headers.get('Retry-After'), retry: false };
            await controller.onRequestFailed(event);
            return event.retry === true && !signal?.aborted;
        }

        async function fetchResponse(retried = false) {
            while (true) {
                let response;
                try {
                    signal?.throwIfAborted();
                    const routing = controller.getRoutingContext(request);
                    if (retried && !routing) throw new DOMException('Retry cancelled', 'AbortError');
                    response = await deliveryFetch({ fetch: originalFetch, input,
                        options: routedOptions(payload, options, routing), payload, baseUrl, context: routing,
                        valid: () => Boolean(controller.getRoutingContext(request)) && !signal?.aborted,
                        blockRetry: reason => { deliveryBlocked = true; controller.cancelRequest(request, reason); },
                    });
                } catch (error) {
                    if (await shouldRetry(error)) { retried = true; continue; }
                    throw error;
                }
                // Inspect a clone, leaving the original body available for
                // SillyTavern's normal error reporting.
                if (!response.ok) {
                    let error;
                    try { error = parseFailure(await response.clone().text(), response.status); }
                    catch (failure) { error = failure; }
                    if (await shouldRetry(error, response)) {
                        await response.body?.cancel().catch(() => {});
                        retried = true;
                        continue;
                    }
                    return response;
                }
                if (!payload.stream || response.headers.get('Content-Type')?.includes('application/json')) {
                    let failure;
                    try {
                        const data = await response.clone().json();
                        if (errorPayload(data)) failure = data;
                    } catch (error) { failure = error; }
                    if (failure && await shouldRetry(failure, response)) {
                        await response.body?.cancel().catch(() => {});
                        retried = true;
                        continue;
                    }
                }
                return response;
            }
        }

        const initial = await fetchResponse();
        if (!payload.stream || !initial.ok || !initial.body) return initial;
        let reader;
        let cancelled = false;
        const encoder = new TextEncoder();

        async function* chunks() {
            let response = initial;
            let delivered = false;
            while (!cancelled) {
                const decoder = new TextDecoder();
                let buffer = '';
                let failure;
                reader = response.body.getReader();
                try {
                    while (!cancelled) {
                        signal?.throwIfAborted();
                        const { done, value } = await reader.read();
                        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                        let match;
                        while ((match = /\r\n\r\n|\r\r|\n\n/.exec(buffer))) {
                            const end = match.index + match[0].length;
                            const frame = buffer.slice(0, match.index);
                            const raw = buffer.slice(0, end);
                            buffer = buffer.slice(end);
                            const data = frameData(frame);
                            if (data === '[DONE]') { yield encoder.encode(raw); return; }
                            if (data) {
                                const parsed = JSON.parse(data);
                                if (errorPayload(parsed)) throw parsed;
                                // Never replay into private core accumulation
                                // state after it has received any valid event.
                                delivered = true;
                            }
                            yield encoder.encode(raw);
                        }
                        if (done) {
                            if (buffer.trim() && !buffer.trim().startsWith(':')) throw new Error('Truncated SSE response');
                            return;
                        }
                    }
                    return;
                } catch (error) { failure = error; }
                finally {
                    await reader.cancel().catch(() => {});
                    reader.releaseLock();
                    reader = null;
                }
                if (cancelled) return;
                if (delivered) {
                    controller.cancelRequest(request, '流式回复已开始后出错：已保留片段，请手动重新生成（纯扩展版不拼接重试）');
                    throw failure;
                }
                if (!(await shouldRetry(failure, response))) {
                    if (cancelled) return;
                    throw failure;
                }
                if (cancelled) return;
                response = await fetchResponse(true);
                if (!response.ok) throw new Error(`Got response status ${response.status}`);
            }
        }

        const iterator = chunks();
        const body = new ReadableStream({
            async pull(stream) {
                try {
                    const result = await iterator.next();
                    if (cancelled) return;
                    if (result.done) stream.close();
                    else stream.enqueue(result.value);
                } catch (error) { if (!cancelled) stream.error(error); }
            },
            async cancel() {
                cancelled = true;
                controller.cancelRequest(request, '流式回复已取消，本轮不再自动重试');
                await reader?.cancel().catch(() => {});
                await iterator.return();
            },
        }, { highWaterMark: 0 });
        const headers = new Headers(initial.headers);
        headers.delete('Content-Length');
        headers.delete('Content-Encoding');
        return new Response(body, { status: initial.status, statusText: initial.statusText, headers });
    };
}
