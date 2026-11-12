import {afterEach, expect, test} from 'bun:test';
import {handlePageMessage} from './page-messages.js';
import {WATERLOOWORKS_ORIGIN} from '../../shared/src/protocol.js';
const original = globalThis.chrome;
afterEach(() => {globalThis.chrome = original;});
function fixture() {
  const opened: unknown[] = [];
  globalThis.chrome = {
    runtime:{id:'watworks',getURL:(path:string)=>`chrome-extension://watworks/${path}`},
    storage:{session:{get:async()=>({'signin:tab':42})}},
    tabs:{create:async(value:unknown)=>{opened.push(value);}},
  } as unknown as typeof chrome;
  const sender = {id:'watworks',url:`${WATERLOOWORKS_ORIGIN}/myAccount/dashboard.htm`,tab:{id:42},frameId:0} as chrome.runtime.MessageSender;
  return {sender,opened};
}
test('page capability opens only the extension dashboard with no page-supplied URL', async()=>{
  const {sender,opened}=fixture();
  await handlePageMessage({type:'pageOpenDashboard',url:'https://evil.test'},sender);
  expect(opened).toEqual([{url:'chrome-extension://watworks/hosted.html'}]);
});
test('content scripts cannot reach privileged messages or cross-origin/frame capabilities',()=>{
  const {sender,opened}=fixture();
  for(const type of ['prepareSubmissionSession','startService','signIn','discoveryPolicySave','openApplicationForm']) {
    expect(handlePageMessage({type},sender)).toBeUndefined();
  }
  for(const override of [{id:'foreign'},{frameId:1},{url:'https://evil.test/'},{url:'https://waterlooworks.uwaterloo.ca.evil.test/'}]) {
    expect(handlePageMessage({type:'pageOpenDashboard'},{...sender,...override})).toBeUndefined();
  }
  expect(handlePageMessage({type:'pageOpenDashboard'},{...sender,url:'https://login.microsoftonline.com/'})).toBeUndefined();
  expect(opened).toHaveLength(0);
});
test('SSO context exposes only whether the sending tab is tracked',async()=>{
  const {sender}=fixture();
  expect(handlePageMessage({type:'pageSignInContext'},{...sender,url:'https://login.microsoftonline.com/'})).toBeUndefined();
  expect(await handlePageMessage({type:'pageSignInContext'},{...sender,url:'https://adfs.uwaterloo.ca/'})).toEqual({signingIn:true});
  expect(await handlePageMessage({type:'pageSignInContext'},{...sender,tab:{id:43} as chrome.tabs.Tab})).toEqual({signingIn:false});
});
