import {afterAll,beforeAll,expect,test} from "bun:test";
import {existsSync} from "node:fs";
import {chromium,type Browser} from "playwright";
import {DASHBOARD_STYLE} from "../../dashboard/src/style.js";
import {SUBMISSION_SETTINGS_MARKUP} from "./submission-settings-markup.js";
let browser:Browser;
beforeAll(async()=>{const bundled=chromium.executablePath();browser=await chromium.launch({headless:true,executablePath:existsSync(bundled)?bundled:"/usr/bin/chromium",args:["--no-sandbox"]});});
afterAll(async()=>{await browser?.close();});
const css=await Bun.file(new URL("./submission-settings.css",import.meta.url)).text();
for(const dark of [false,true])test(`server error has readable text in ${dark?"dashboard":"options"} theme`,async()=>{
  const page=await browser.newPage();
  try {
    await page.setContent(`<html><head><style>${dark?DASHBOARD_STYLE:""}${css}</style></head><body class="${dark?"":"submission-options"}"><main><section class="card submission-settings">${SUBMISSION_SETTINGS_MARKUP}</section></main></body></html>`);
    await page.locator("#submission-status").evaluate(element=>{element.textContent="Submission server returned HTTP 400";});
    const contrast=await page.locator("#submission-status").evaluate(element=>{
      const style=getComputedStyle(element);
      const luminance=(color:string)=>{const channels=color.match(/\d+/g)!.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*channels[0]!+.7152*channels[1]!+.0722*channels[2]!;};
      const text=luminance(style.color),background=luminance(style.backgroundColor);
      return (Math.max(text,background)+.05)/(Math.min(text,background)+.05);
    });
    expect(contrast).toBeGreaterThan(4.5);
    if(dark)await page.screenshot({path:"/tmp/wat-submission-http400.png",fullPage:true});
  } finally{await page.close();}
});
