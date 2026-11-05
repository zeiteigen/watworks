import {test,expect} from 'bun:test';
import {readAccountEmail} from '../src/account-email.js';
test('follows only the literal My Account read navigation and reads its labelled email',async()=>{
  const bodies:string[]=[];
  const result=await readAccountEmail(async(input,init)=>{
    expect(String(input)).toBe('https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm');
    expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');
    bodies.push(String(init?.body));return new Response(bodies.length===1?`<a onclick="orbisAppSr.buildForm({'action':'account-read'}, '', '').submit();">My Account</a>`:'<table><tr><td>Email Address:</td><td>student@uwaterloo.ca</td></tr></table>');
  });
  expect(result).toBe('student@uwaterloo.ca');expect(bodies).toEqual(['','action=account-read']);
});
test('signed-out and missing navigation responses cannot become a student identity',async()=>{
  await expect(readAccountEmail(async()=>new Response('Sign in',{status:401}))).rejects.toThrow();
  await expect(readAccountEmail(async()=>new Response('<p>support@uwaterloo.ca</p>'))).rejects.toThrow();
});
