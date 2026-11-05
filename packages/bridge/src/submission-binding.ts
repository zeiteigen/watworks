import { AsyncLocalStorage } from "node:async_hooks";
/** Scoped to one human-approved dashboard execution, across every workflow phase. */
export const submissionBindingScope=new AsyncLocalStorage<string>();
export function withSubmissionBinding<T>(binding:string|undefined,run:()=>Promise<T>):Promise<T>{
  return binding?submissionBindingScope.run(binding,run):run();
}
