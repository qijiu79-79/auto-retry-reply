import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRetryFetch } from '../fetch-retry.js';
import { createRetryController, DEFAULT_SETTINGS } from '../controller.js';
import { createRetryNotifier } from '../notifications.js';

// Exercise the real adapter/controller/notifier with in-memory responses only.
globalThis.crypto ??= webcrypto;
const endpoint = '/api/backends/chat-completions/generate';
const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: {'Content-Type':'application/json'},
});
const sse = (...frames) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: {'Content-Type':'text/event-stream'},
});
const success = () => json({choices:[{message:{content:'synthetic success'}}]});
const completed = {candidates:[{content:{parts:[{text:'synthetic success'}]},finishReason:'STOP'}]};
const recorded = {error:{code:502,message:'Upstream generation failed; no automatic retry'},g4keep:{version:1,outcome:'failed'}};
const bridgePayload = {stream:true,chat_completion_source:'makersuite',reverse_proxy:'https://api.doggego.online',
    tools:[{type:'function',function:{name:'dispatch_stream_payload_0123456789abcdef',
        parameters:{properties:{display_stream:{type:'string'}}}}}]};

function harness(responses, {brokenToast = false, brokenPanel = false} = {}) {
    const notices = [], calls = [], delays = [], events = [];
    const status = {textContent:''}, detail = {textContent:''}, recent = {hidden:true};
    const nodes = {'[data-status]':status,'[data-error-detail]':detail,'[data-last-error]':recent};
    const crash = () => { throw new Error('synthetic display failure'); };
    const toast = (message, title, options) => {
        if (brokenToast) crash();
        const token = {message,title,options}; notices.push(token); return token;
    };
    const notifier = createRetryNotifier({
        toastr:{info:toast,error:toast,warning:toast,clear:brokenToast ? crash : () => {}},
        getPanel:brokenPanel ? crash : () => ({querySelector:selector=>nodes[selector]}),
    });
    const state = {key:'synthetic-chat',groupId:null,chat:[{mes:'synthetic user input',is_user:true}],busy:true,blocked:''};
    const settings = {...DEFAULT_SETTINGS,maxRetries:2};
    const controller = createRetryController({getState:()=>state,getSettings:()=>settings,
        notify:event=>{events.push(event);notifier(event);},
        retry:()=>assert.fail('API retry must not swipe or append a user message'),
        setTimer:(callback,delay)=>{delays.push(delay);return setTimeout(callback,0);},
    });
    let clock = 0;
    const adapter = createRetryFetch({controller,baseUrl:'http://localhost:8000/',now:()=>clock,
        fetch:async (input,options)=>{
            calls.push({input,options});
            clock += calls.length === 1 ? 45000 : 7000;
            return responses[Math.min(calls.length - 1,responses.length - 1)]();
        },
    });
    controller.onStart('normal');
    return {notices,calls,delays,events,status,detail,recent,state,controller,
        send:(payload={})=>adapter(endpoint,{method:'POST',body:JSON.stringify({
            type:'normal',stream:false,model:'synthetic-model',messages:['private synthetic input'],...payload,
        })}),
    };
}

test('plain HTTP error reaches UI, but its text cannot change the original retry decision', async () => {
    const h = harness([()=>new Response('upstream connection reset; invalid_request; key PRIVATECREDENTIAL123456', {status:502}),success]);
    const chat = structuredClone(h.state.chat);
    assert.match(await (await h.send()).text(),/synthetic success/);
    assert.equal(h.calls.length,2);assert.deepEqual(h.delays,[2000]);assert.deepEqual(h.state.chat,chat);
    assert.equal(h.calls[0].options,h.calls[1].options);
    const notice = h.notices[0].message;
    assert.match(notice,/HTTP 502/);assert.match(notice,/upstream connection reset/);
    assert.match(notice,/synthetic-model/);assert.match(notice,/45 秒/);assert.match(notice,/2 秒后重试（1\/2）/);
    assert.doesNotMatch(notice + h.detail.textContent,/PRIVATECREDENTIAL/);
    assert.equal(h.events.find(x=>x.kind==='pending').failure.diagnostic.detail,h.detail.textContent);
    h.state.chat.push({mes:'synthetic success',is_user:false});
    h.controller.onReceived(1,'normal');h.controller.onEnded();
    assert.match(h.status.textContent,/本轮重试 1 次/);assert.match(h.detail.textContent,/HTTP 502/);
});

for (const model of ['gemini-4-carbon','gemini-4-carbon-low','gemini-4-carbon-high','gemini-4-neon']) {
    test(`${model} recorded SSE failure shows real 502, not the outer HTTP 200`, async () => {
        const h = harness([()=>sse(recorded),()=>sse(completed)]);
        assert.match(await (await h.send({...bridgePayload,model})).text(),/synthetic success/);
        assert.equal(h.calls.length,2);assert.deepEqual(h.delays,[2000]);
        assert.match(h.notices[0].message,/上游生成失败 · HTTP 502/);
        assert.match(h.notices[0].message,/45 秒/);assert(h.notices[0].message.includes(model));
        assert.doesNotMatch(h.notices[0].message,/HTTP 200|no automatic retry/);
        const paths = h.calls.map(x=>new URL(JSON.parse(x.options.body).reverse_proxy).pathname.split('/'));
        assert.deepEqual(paths.map(x=>x[3]),['start','start']);assert.notEqual(paths[0][2],paths[1][2]);
    });
}

for (const options of [{brokenToast:true},{brokenPanel:true},{brokenToast:true,brokenPanel:true}]) {
    test(`display failure never interrupts the original retry: ${JSON.stringify(options)}`, async () => {
        const h = harness([()=>json({error:{message:'synthetic upstream failure'}},502),success],options);
        assert.match(await (await h.send()).text(),/synthetic success/);
        assert.equal(h.calls.length,2);assert.deepEqual(h.delays,[2000]);
        assert.equal(h.events.find(x=>x.kind==='retrying').attempts,1);
        if (!options.brokenPanel) assert.match(h.detail.textContent,/synthetic upstream failure/);
        if (!options.brokenToast) assert.match(h.notices[0].message,/synthetic upstream failure/);
    });
}

test('elapsed time resets per attempt, and old request errors cannot overwrite a new run', async () => {
    const h = harness([()=>json({error:{message:'synthetic upstream failure'}},502),
        ()=>json({error:{message:'second failure'}},502),success]);
    assert.match(await (await h.send()).text(),/synthetic success/);
    assert.match(h.notices[0].message,/45 秒/);assert.match(h.notices[1].message,/7 秒/);
    assert.deepEqual(h.delays,[2000,2000]);
    const old = {type:'normal'};
    h.controller.onRequestStarted(old);
    h.controller.onStart('normal');
    await h.controller.onRequestFailed({request:old,status:502,error:{message:'stale'},
        diagnostic:{summary:'stale failure',detail:'stale failure'}});
    assert.equal(h.detail.textContent,'');assert.equal(h.recent.hidden,true);assert.equal(h.notices.length,2);
});
