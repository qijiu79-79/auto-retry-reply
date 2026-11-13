import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableApiError } from '../api-error.js';

test('generic openai_error works across HTTP and JSON/SSE errors', () => {
    for (const status of [undefined, 200, 400, 500, 502, 503]) {
        assert.equal(isRetryableApiError({ status, error: { error: { type: 'openai_error' } } }), true);
    }
    assert.equal(isRetryableApiError({ error: 'openai_error' }), true);
    assert.equal(isRetryableApiError({ error: Object.assign(new Error('upstream error'), { payload: { error: 'openai_error' } }) }), true);
});

test('temporary network, rate limiting and server errors are retryable', () => {
    for (const error of [new TypeError('Failed to fetch'), new Error('ECONNRESET'), new Error('NetworkError'), new SyntaxError('Unexpected end of JSON input')]) {
        assert.equal(isRetryableApiError({ error }), true);
    }
    for (const status of [408, 409, 425, 429, 500, 504]) assert.equal(isRetryableApiError({ status }), true);
    assert.equal(isRetryableApiError({ status: 429, error: { error: { code: 'rate_limit_exceeded' } } }), true);
});

test('manual aborts and permanent HTTP errors never retry', () => {
    assert.equal(isRetryableApiError({ error: new DOMException('cancelled', 'AbortError'), status: 500 }), false);
    assert.equal(isRetryableApiError({ error: 'Generation was aborted.' }), false);
    for (const status of [401, 402, 403, 404, 405, 413, 415, 422]) {
        assert.equal(isRetryableApiError({ status, error: 'openai_error' }), false);
    }
});

test('permanent payload errors override a retryable HTTP status', () => {
    for (const code of ['invalid_api_key', 'authentication_error', 'insufficient_quota', 'context_length_exceeded', 'invalid_request_error', 'content_filter', 'policy_violation']) {
        assert.equal(isRetryableApiError({ status: 500, error: { error: { code } } }), false, code);
    }
    for (const message of ['余额不足', '额度耗尽', 'Maximum context length exceeded', 'This model requires moderation']) {
        assert.equal(isRetryableApiError({ status: 429, error: { detail: { error: { message } } } }), false, message);
    }
    assert.equal(isRetryableApiError({ status: 429, error: { quota_error: true } }), false);
});

test('missing or cyclic error descriptors are handled without throwing', () => {
    assert.equal(isRetryableApiError(), false);
    const error = { message: 'temporary upstream error' };
    error.cause = error;
    assert.equal(isRetryableApiError({ error }), true);
});
