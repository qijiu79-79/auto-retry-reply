import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeApiFailure } from '../error-display.js';
import { DeliveryHttpError } from '../delivery.js';

const summarize = input => {
    const result = summarizeApiFailure(input);
    assert.equal(typeof result.summary, 'string');
    assert.equal(typeof result.detail, 'string');
    assert.doesNotThrow(() => JSON.stringify(result));
    return result;
};
const text = result => `${result.summary}\n${result.detail}`;

test('generic HTTP 500 reports status without inventing model or network cause', () => {
    const result = summarize({ error: { error: true }, status: 500 });
    assert.match(result.summary, /500/);
    assert.doesNotMatch(text(result), /模型(?:出错|故障|崩溃)|上游(?:模型)?(?:出错|故障|生成失败)|(?:本地|用户).{0,8}网络.{0,8}(?:故障|错误|断开)/);
});

test('recorded SSE error shows actual failure status, message, model and elapsed time', () => {
    const result = summarize({ error: { error: { code: 502, message: 'upstream overloaded' },
        g4keep: { version: 1, outcome: 'failed' } }, status: 502, model: 'gemini-4-carbon-high', elapsedMs: 12345 });
    assert.match(result.summary, /502/);
    assert.match(text(result), /upstream overloaded/i);
    assert.match(result.detail, /gemini-4-carbon-high/);
    assert.match(result.detail, /12(?:\.3|\.34|\.35|345)?\s*秒|12345\s*ms|12(?:\.3|\.34|\.35|345)?\s*s/i);
});

test('legacy bridge message is described as upstream failure without obsolete retry instruction', () => {
    const result = summarize({ error: { error: { code: 'G4_DELIVERY_FAILED',
        message: 'Upstream generation failed; no automatic retry' },
        g4keep: { version: 1, outcome: 'failed' } }, status: 502 });
    assert.match(text(result), /上游.{0,8}生成失败/);
    assert.doesNotMatch(text(result), /no automatic retry|不(?:会|再)?自动重试/i);
});

test('recorded upstream failure nested in an actual DeliveryHttpError keeps its cause', () => {
    const cause = { error: { code: 502, message: 'Upstream generation failed; no automatic retry' },
        g4keep: { version: 1, outcome: 'failed' } };
    const error = new DeliveryHttpError(new Response('{}', { status: 502 }), cause);
    const output = text(summarize({ error, status: 502 }));
    assert.match(output, /上游.{0,8}生成失败/);
    assert.doesNotMatch(output, /no automatic retry|不(?:会|再)?自动重试/i);
});

test('network, parsing and result recovery failures remain distinguishable', () => {
    const network = summarize({ error: new TypeError('Failed to fetch') });
    const parse = summarize({ error: new SyntaxError('Unexpected end of JSON input') });
    const recover = summarize({ error: { code: 'G4_DELIVERY_MISSING', message: 'result recovery failed' }, status: 410 });
    assert.match(text(network), /连接|传输|网络|fetch/i);
    assert.doesNotMatch(text(network), /(?:你的|用户|本地).{0,8}网络.{0,8}(?:故障|错误|断开)/);
    assert.match(text(parse), /解析|格式|JSON|parse/i);
    assert.match(text(recover), /取回|恢复|recover|G4_DELIVERY_MISSING/i);
    assert.notEqual(network.summary, parse.summary);
    assert.notEqual(recover.summary, network.summary);
});

test('extracts nested whitelisted descriptors but never request fields or stack', () => {
    const error = { message: 'request failed', error: { detail: { cause: { code: 'rate_limit_exceeded',
        type: 'rate_limit_error', message: 'server capacity busy' } } },
        stack: 'PRIVATE-STACK-DATA', prompt: 'PRIVATE-PROMPT-DATA', messages: [{ content: 'PRIVATE-MESSAGE-DATA' }],
        headers: { authorization: 'PRIVATE-HEADER-DATA' }, config: { text: 'PRIVATE-CONFIG-DATA' } };
    Object.defineProperty(error, 'payload', { enumerable: true, get() { throw new Error('unexpected traversal'); } });
    const output = text(summarize({ error, status: 429 }));
    assert.match(output, /server capacity busy/);
    assert.match(output, /rate_limit_(?:exceeded|error)/);
    for (const secret of ['PRIVATE-STACK-DATA', 'PRIVATE-PROMPT-DATA', 'PRIVATE-MESSAGE-DATA', 'PRIVATE-HEADER-DATA', 'PRIVATE-CONFIG-DATA']) {
        assert(!output.includes(secret));
    }
});

test('nested status, type and message are available without an explicit HTTP status', () => {
    const result = summarize({ error: { detail: { error: { status: 429, type: 'rate_limit',
        message: 'server requests a slower rate' } } } });
    assert.match(text(result), /429/);
    assert.match(text(result), /rate_limit/);
    assert.match(text(result), /server requests a slower rate/);
});

test('redacts explicit secrets, authorization schemes, key formats and credential assignments', () => {
    const secrets = ['example-secret-value-7493', 'explicit-model-secret'];
    const forbidden = [secrets[0], secrets[1], 'BearerValue1234567890', 'BasicValue1234567890',
        'sk-abcdefghijklmno123456789', 'AIzaAbcdefghijklmno1234567890', 'query-secret-9876',
        'assignment-secret-9876', 'pass-secret-9876', 'token-secret-9876'];
    const message = `failure: ${secrets[0]} Bearer ${forbidden[2]} Basic ${forbidden[3]} ${forbidden[4]} ${forbidden[5]} `
        + `https://example.invalid/x?api_key=${forbidden[6]}&mode=safe `
        + `api_key=${forbidden[7]} password: ${forbidden[8]} token=${forbidden[9]}`;
    const output = text(summarize({ error: { message }, model: secrets[1], secrets }));
    for (const secret of forbidden) assert(!output.includes(secret), `leaked credential: ${secret}`);
});

test('structured request data embedded in an error message is not displayed', () => {
    for (const message of [
        'upstream failed: {"messages":[{"role":"user","content":"PRIVATE-MESSAGE-IN-JSON"}],"model":"example"}',
        'payload: {"prompt":"PRIVATE-PROMPT-IN-JSON","messages":[]}',
    ]) {
        const output = text(summarize({ error: { message }, status: 500 }));
        assert.doesNotMatch(output, /PRIVATE-MESSAGE-IN-JSON|PRIVATE-PROMPT-IN-JSON/);
    }
});

for (const [label, body] of [
    ['role and content', '{"role":"user","content":"PRIVATE-ROLE-CONTENT"}'],
    ['parts', '{"parts":[{"text":"PRIVATE-PART-TEXT"}]}'],
    ['unknown key', '{"unexpected_key":"PRIVATE-UNKNOWN-DATA"}'],
    ['array', '[{"role":"user","content":"PRIVATE-ARRAY-CONTENT"}]'],
    ['multiline', '{\n  "custom": [\n    "PRIVATE-MULTILINE-DATA"\n  ]\n}'],
]) {
    test(`structured ${label} is hidden while retaining the reason`, () => {
        const output = text(summarize({ error: { message: `upstream overloaded: ${body}` }, status: 500 }));
        assert.match(output, /upstream overloaded/);
        assert.doesNotMatch(output, /PRIVATE-(?:ROLE-CONTENT|PART-TEXT|UNKNOWN-DATA|ARRAY-CONTENT|MULTILINE-DATA)/);
    });
}

for (const format of ['invalid key', 'authorization failed']) {
    test(`unlisted key values in ${format} errors are redacted`, () => {
        const secret = 'PRIVATECREDENTIAL123456';
        const message = format === 'invalid key' ? `Invalid key: ${secret}` : `Authorization failed for key ${secret}`;
        const output = text(summarize({ error: { message }, status: 401 }));
        assert(!output.includes(secret));
        assert.match(output, /Invalid key|Authorization failed|认证|密钥|授权/i);
    });
}

test('cyclic, deep, non-string and oversized errors are bounded and serializable', () => {
    const cycle = { message: 'bounded error' }; cycle.cause = cycle;
    let deep = cycle;
    for (let i = 0; i < 200; i++) deep = { detail: deep };
    for (const error of [cycle, deep, { message: { private: 'PRIVATE-OBJECT' } },
        { message: 'x'.repeat(100000), stack: 'PRIVATE-STACK-DATA' }, null, false, 123]) {
        const output = text(summarize({ error }));
        assert(output.length < 10000);
        assert.doesNotMatch(output, /PRIVATE-OBJECT|PRIVATE-STACK-DATA/);
    }
});
