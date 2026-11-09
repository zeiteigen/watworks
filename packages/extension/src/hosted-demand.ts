import { hostedRequest } from './hosted-client.js';
import { prepareHostedSubmissionSession } from './hosted-session.js';
/** Credentials move directly to the submission endpoint, never through the workspace API. */
export async function refreshHostedDemand():Promise<void>{
  const demand=await hostedRequest<{due:boolean}>('/demand');
  if(demand.due)await prepareHostedSubmissionSession();
}
