import assert from 'node:assert/strict';
import test from 'node:test';
import { APOLOGY_MAX_LENGTH, detectFailure } from '../detector.js';

test('leaves normal answers alone', () => {
    assert.equal(detectFailure('The answer is 42.'), null);
    assert.equal(detectFailure('Here is a <strong>normal</strong> answer.'), null);
});

test('detects common Chinese and English apology or refusal phrases', () => {
    assert.deepEqual(detectFailure('抱歉，我不能协助这个请求。'), { kind: 'apology', keyword: '抱歉' });
    assert.deepEqual(detectFailure('很遺憾，我無法繼續。'), { kind: 'apology', keyword: '很遺憾' });
    assert.deepEqual(detectFailure("I can't help with that request."), { kind: 'apology', keyword: "I can't" });
    assert.deepEqual(detectFailure('I will not provide that.'), { kind: 'apology', keyword: 'I will not provide' });
    assert.deepEqual(detectFailure('This is against my guidelines.'), { kind: 'apology', keyword: 'against my guidelines' });
});

test('normalizes curly apostrophes and repeated whitespace', () => {
    assert.deepEqual(detectFailure('I’m   unable\n to help with that.'), { kind: 'apology', keyword: "I'm unable" });
});

test('treats whitespace, zero-width text, think-only replies, and ellipses as empty', () => {
    assert.deepEqual(detectFailure(' \t\r\n\u3000\u200B\u200C\u200D\u2060\uFEFF'), { kind: 'empty' });
    assert.deepEqual(detectFailure('<think>Sorry, I cannot help with that.</think>'), { kind: 'empty' });
    assert.deepEqual(detectFailure('  .\u200B..  '), { kind: 'empty' });
    assert.equal(detectFailure('... and here is the answer'), null);
    assert.equal(detectFailure('...', { retryEmpty: false }), null);
});

test('ignores apology keywords inside think blocks and scans ordinary HTML/code content', () => {
    assert.equal(detectFailure('<think>I cannot help</think>The answer is 42.'), null);
    assert.deepEqual(
        detectFailure('<think>hidden reasoning</think><p>I apologize for that.</p>'),
        { kind: 'apology', keyword: 'apologize' },
    );
    assert.deepEqual(
        detectFailure('const reply = "<p>I cannot assist</p>";'),
        { kind: 'apology', keyword: 'I cannot' },
    );
});

test('uses literal, case-insensitive keyword lines with English word boundaries', () => {
    assert.deepEqual(
        detectFailure('I CANNOT ASSIST with that.', { keywords: 'I cannot assist' }),
        { kind: 'apology', keyword: 'I cannot assist' },
    );
    assert.equal(detectFailure('I cannot assistant the team.', { keywords: 'I cannot assist' }), null);
    assert.equal(detectFailure('The token is unsorryable.', { keywords: 'sorry' }), null);
    assert.deepEqual(
        detectFailure('The literal marker is a.*b.', { keywords: 'a.*b\nother marker' }),
        { kind: 'apology', keyword: 'a.*b' },
    );
    assert.equal(detectFailure('The literal marker is axxxb.', { keywords: 'a.*b' }), null);
});

test('honors retry options and allows apology matching to be disabled', () => {
    assert.equal(detectFailure('sorry', { retryApology: false }), null);
    assert.equal(detectFailure('sorry', { keywords: '' }), null);
    assert.equal(detectFailure('sorry', { keywords: ' \n\t ' }), null);
    assert.equal(detectFailure('... ', { retryEmpty: false, retryApology: false }), null);
});

test('only scans apology keywords below the visible full-reply length limit', () => {
    assert.equal(APOLOGY_MAX_LENGTH, 1000);

    const fullReplyOfLength = length => `${'x'.repeat(length - 5)}sorry`;
    assert.deepEqual(detectFailure('sorry', { totalText: fullReplyOfLength(999) }), { kind: 'apology', keyword: 'sorry' });
    assert.equal(detectFailure('sorry', { totalText: fullReplyOfLength(1000) }), null);
    assert.equal(detectFailure('sorry', { totalText: fullReplyOfLength(1001) }), null);

    const emojiReply = `${'x'.repeat(993)}😀sorry`;
    assert.equal(emojiReply.length, 1000, 'UTF-16 length includes two code units for the emoji');
    assert.equal(Array.from(emojiReply).length, 999, 'the detector counts Unicode code points');
    assert.deepEqual(detectFailure('sorry', { totalText: emojiReply }), { kind: 'apology', keyword: 'sorry' });
    assert.equal(detectFailure('sorry', { totalText: fullReplyOfLength(1000) }), null, 'long total text suppresses a short delta');
    assert.deepEqual(detectFailure('', { totalText: fullReplyOfLength(1000) }), { kind: 'empty' }, 'empty detection is unaffected');
});
