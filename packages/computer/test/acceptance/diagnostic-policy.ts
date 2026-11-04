import {realpathSync, statSync} from 'node:fs';
import {isAbsolute, relative, sep} from 'node:path';

/** Harness boundary only. Account-backed office apps remain disabled until
 * local isolation, exact object IDs, independent inventory and cleanup exist. */
export function assertDiagnosticRequest(tool:string,args:Record<string,unknown>,owned:{nativePid:number;webURL:string;workspace:string}):void {
 const steps=[args,...(Array.isArray(args.steps)?args.steps as Record<string,unknown>[]:[])];
 if(steps.some(step=>step.action==='bring_to_front'||step.allow_real_pointer||step.action==='handoff'))throw new Error('This diagnostic forbids foreground, global-pointer and handoff actions');
 if(['screen_read','screen_act','screen_look'].includes(tool)){
  if(tool==='screen_read'&&args.app===undefined&&Object.keys(args).length===0)return;
  if(args.app!==String(owned.nativePid))throw new Error('Only the exact newly created native fixture PID is permitted; account-backed apps are disabled');
  if(args.open)throw new Error('Launching other apps is disabled in this diagnostic');
  return;
 }
 if(!['web_read','web_act','web_look'].includes(tool))throw new Error('Unknown diagnostic tool');
 if(args.url!==undefined){
  const actual=new URL(String(args.url)),expected=new URL(owned.webURL);
  if(actual.origin!==expected.origin||actual.username||actual.password)throw new Error('Only this run\'s loopback website is permitted');
 }
 for(const step of steps){
  if(step.action!=='upload')continue;
  const files=step.files;
  if(!Array.isArray(files)||!files.length)throw new Error('Upload needs this run\'s freshly created files');
  const workspace=realpathSync(owned.workspace);
  for(const file of files){
   if(typeof file!=='string'||!isAbsolute(file))throw new Error('Upload needs an absolute fixture path');
   const actual=realpathSync(file),inside=relative(workspace,actual);
   if(!inside||inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside)||!statSync(actual).isFile())throw new Error('Diagnostic upload is outside this run\'s workspace');
  }
 }
}

export function diagnosticApproval(request:{command:string;explanation?:string}):'allow'|'deny'{
 const value=request.command+' '+(request.explanation??'');
 if(['Use the web browser in this conversation','Use computer use in this conversation'].includes(request.command))return 'allow';
 if(/foreground|bring.to.front|real.pointer|global.pointer|activate|hand.?off/i.test(value))return 'deny';
 return /clipboard/i.test(value)?'allow':'deny';
}
