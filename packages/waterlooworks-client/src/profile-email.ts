import { pageDocument } from './application-fields.js';
/** Fail closed if the authenticated profile does not expose one unambiguous email field. */
export function verifiedProfileEmail(html:string):string {
  const values=new Set<string>();
  for(const input of pageDocument(html).querySelectorAll('input[name="email"], input[name="emailAddress"], input[name="studentEmail"]')){
    const value=input.getAttribute('value')?.trim().toLowerCase();
    if(value&&/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@uwaterloo\.ca$/.test(value))values.add(value);
  }
  // Live My Account view uses a read-only two-cell row, not an editable input.
  for(const row of pageDocument(html).querySelectorAll('tr')){
    const cells=[...row.children].filter(cell=>cell.tagName==='TD'||cell.tagName==='TH');
    if(cells.length!==2||cells[0]!.textContent?.replace(/\s+/g,' ').trim()!=='Email Address:')continue;
    const value=cells[1]!.textContent?.trim().toLowerCase();
    if(value&&/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@uwaterloo\.ca$/.test(value))values.add(value);
  }
  if(values.size!==1)throw new Error('Verified WaterlooWorks profile email unavailable');
  return [...values][0]!;
}
