import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryNotifier } from '../notifications.js';
import { summarizeApiFailure } from '../error-display.js';

function harness() {
    const notices = [], cleared = [];
    const status = {textContent:''}, recent = {hidden:true}, detail = {textContent:''};
    const nodes = {'[data-status]':status,'[data-last-error]':recent,'[data-error-detail]':detail};
    const toast = kind => (...args) => { const token = {kind,args}; notices.push(token); return token; };
    const notify = createRetryNotifier({toastr:{info:toast('info'),warning:toast('warning'),error:toast('error'),clear:t=>cleared.push(t)},
        getPanel:()=>({querySelector:selector=>nodes[selector]})});
    return {notify,notices,cleared,status,recent,detail};
}
const diagnostic = () => summarizeApiFailure({error:{error:{code:502,message:'Upstream generation failed; no automatic retry'},g4keep:{version:1,outcome:'failed'}},
    status:502,model:'gemini-4-carbon-high',elapsedMs:45000});
const pending = () => ({kind:'pending',failure:{kind:'api',diagnostic:diagnostic()},attempts:1,maxRetries:20,delayMs:2000});

test('retry toast shows reason, real status, model, elapsed time and retry schedule', () => {
    const h=harness();h.notify(pending());
    const notice=h.notices[0];assert.equal(notice.kind,'info');assert.equal(notice.args[2].escapeHtml,true);
    assert.equal(notice.args[2].toastClass,'toast arr-retry-toast');
    assert(notice.args[2].timeOut>=6000);
    assert.match(notice.args[0],/上游生成失败/);assert.match(notice.args[0],/502/);assert.match(notice.args[0],/gemini-4-carbon-high/);
    assert.match(notice.args[0],/45 秒/);assert.match(notice.args[0],/2 秒后重试（1\/20）/);
    assert.equal(h.recent.hidden,false);assert.match(h.detail.textContent,/Upstream generation failed/);
    assert.doesNotMatch(h.detail.textContent,/no automatic retry/);
});
test('retrying and success do not erase the last reason; a new manual run clears it', () => {
    const h=harness();h.notify(pending());const detail=h.detail.textContent;
    h.notify({kind:'retrying',attempts:1});assert.match(h.status.textContent,/上次原因：.*上游生成失败/);
    h.notify({kind:'success',attempts:1});assert.match(h.status.textContent,/回复正常/);assert.equal(h.detail.textContent,detail);assert.equal(h.recent.hidden,false);
    h.notify({kind:'monitoring'});assert.equal(h.recent.hidden,true);assert.equal(h.detail.textContent,'');
});
test('repeated retries replace only this extension toast and limit retains the latest cause', () => {
    const h=harness();h.notify(pending());h.notify({...pending(),attempts:2});
    assert.deepEqual(h.cleared,[h.notices[0]]);
    h.notify({kind:'limit',attempts:2,failure:pending().failure});
    assert.equal(h.notices.at(-1).kind,'warning');assert.match(h.notices.at(-1).args[0],/达到上限.*已停止/);
    assert.match(h.notices.at(-1).args[0],/上游生成失败/);
});
test('manual stop clears pending notice without an error toast', () => {
    const h=harness();h.notify(pending());h.notify({kind:'cancelled',reason:'手动停止'});
    assert.equal(h.notices.length,1);assert.equal(h.status.textContent,'手动停止');assert.equal(h.cleared.length,1);
});
test('keywords and error text remain escaped text, not executable HTML', () => {
    const h=harness();h.notify({kind:'pending',failure:{kind:'apology',keyword:'<img src=x onerror=alert(1)>'},attempts:1,maxRetries:3,delayMs:2000});
    assert.equal(h.notices[0].args[2].escapeHtml,true);assert.match(h.status.textContent,/<img/);
    h.notify({kind:'delivery-error',reason:'取回失败 <synthetic>'});
    assert.equal(h.notices.at(-1).args[2].escapeHtml,true);assert.equal(h.status.textContent,'取回失败 <synthetic>');
});
test('retry-launch errors show sanitized detail rather than blaming API connection', () => {
    const h=harness();h.notify({kind:'error',error:new Error('synthetic failure Bearer private-token-value')});
    assert.equal(h.notices[0].kind,'error');assert.match(h.status.textContent,/synthetic failure/);
    assert.doesNotMatch(h.status.textContent,/private-token-value|请检查 API 连接/);
});
test('non-retryable API failure keeps its diagnostic after cancellation', () => {
    const h=harness();h.notify({kind:'cancelled',reason:'API 请求失败，本轮不再自动重试',diagnostic:summarizeApiFailure({error:{error:'insufficient_quota'},status:402})});
    assert.equal(h.notices.length,0);assert.match(h.status.textContent,/402/);assert.match(h.detail.textContent,/insufficient_quota/);assert.equal(h.recent.hidden,false);
});
test('a broken toast clear cannot prevent replacement, cancellation or panel updates', () => {
    let shown = 0;
    const status = {textContent:''};
    let clearOptions;
    const notify = createRetryNotifier({toastr:{info:()=>{shown++;return {};},clear:(_toast,options)=>{clearOptions=options;throw new Error('synthetic clear failure');}},
        getPanel:()=>({querySelector:selector=>selector === '[data-status]' ? status : null})});
    assert.doesNotThrow(()=>{notify(pending());notify({...pending(),attempts:2});});
    assert.equal(shown,2);assert.match(status.textContent,/2\/20/);assert.equal(clearOptions.force,true);
    assert.doesNotThrow(()=>notify({kind:'cancelled',reason:'手动停止'}));assert.equal(status.textContent,'手动停止');
});
