import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('delivery-error is a visible escaped toast as well as panel status; normal cancel is not an error toast', () => {
    const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = source.indexOf('function notify(event) {');
    const end = source.indexOf('\nconst controller =', start);
    assert(start >= 0 && end > start);
    const notices = [], status = { textContent: '' };
    const notify = new Function('toastr', 'panel', source.slice(start, end) + '\nreturn notify;')(
        { error: (...args) => notices.push(args) }, { querySelector: () => status });
    notify({ kind: 'delivery-error', reason: '取回失败 <synthetic>' });
    assert.equal(notices.length, 1); assert.equal(notices[0][0], '取回失败 <synthetic>');
    assert.equal(notices[0][2].escapeHtml, true); assert.equal(status.textContent, '取回失败 <synthetic>');
    notify({ kind: 'cancelled', reason: '手动停止' });
    assert.equal(notices.length, 1); assert.equal(status.textContent, '手动停止');
});
