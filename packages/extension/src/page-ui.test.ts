import {expect, test} from 'bun:test';
import {parseHTML} from 'linkedom';
import {mountDashboardButton, mountSignInNotice} from './page-ui.js';
function fixture() {
  const {document}=parseHTML('<html><body><div id="myAccountNav"><div class="user-box"><span>Student Name</span></div></div></body></html>');
  // Keep test access to the otherwise closed shadow roots.
  const roots: ShadowRoot[]=[];
  const create=document.createElement.bind(document);
  document.createElement=((name:string)=>{
    const element=create(name),attach=element.attachShadow.bind(element);
    element.attachShadow=((options:ShadowRootInit)=>{const root=attach(options);roots.push(root as unknown as ShadowRoot);return root;}) as typeof element.attachShadow;
    return element;
  }) as typeof document.createElement;
  return {document:document as unknown as Document,roots};
}
test('dashboard control sits beside the name, survives remounts, and opens only on click',async()=>{
  const {document,roots}=fixture();let opens=0;
  const open=async()=>{opens++;};
  mountDashboardButton(document,open);mountDashboardButton(document,open);
  expect(document.querySelectorAll('[data-watworks-dashboard]').length).toBe(1);
  expect(document.querySelector('[data-watworks-dashboard]')?.parentElement?.textContent).toBe('Student Name');
  expect(opens).toBe(0);
  const button=roots[0]!.querySelector('button')!;
  expect(button.getAttribute('aria-label')).toBe('Open WatWorks dashboard');
  button.click();expect(opens).toBe(1);
});
test('notice explains sign-in and supports dismissal and authentication cleanup',()=>{
  const {document,roots}=fixture();
  const remove=mountSignInNotice(document);
  expect(roots[0]!.querySelector('p')!.textContent).toContain('WatWorks opened this tab');
  expect(document.querySelector('[data-watworks-signin]')).not.toBeNull();
  roots[0]!.querySelector('button')!.click();
  expect(document.querySelector('[data-watworks-signin]')).toBeNull();
  remove();
  const cleanup=mountSignInNotice(document);cleanup();
  expect(document.querySelector('[data-watworks-signin]')).toBeNull();
});
