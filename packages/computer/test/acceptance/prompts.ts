import {join} from 'node:path';
interface Cases{cases:{id:number;title:string;task:string;deadlineMs:number;maxToolCalls:number}[];boundaries:string[]}
interface Manifest{root:string;prefix:string;values:Record<string,unknown>}

/** Freeze the exact text the controller must send, including expected values
 * and save tags. The controller must record delivery byte-for-byte. */
export function taskPrompts(cases:Cases,manifest:Manifest,webURL:string):{id:number;text:string}[]{
 const site=new URL(webURL);if(site.hostname!=='127.0.0.1'||site.protocol!=='http:')throw new Error('frozen prompts need this run\'s loopback website');
 const v=manifest.values,workspace=join(manifest.root,'workspace');
 const details:Record<number,unknown>={
  1:{saveTag:'case01',fields:v.native01},
  2:{saveTags:['case02-min','case02-max'],fields:v.native02,validQuantities:[1,9],invalidQuantities:[0,10]},
  3:{saveTags:['case03-single','case03-batch'],fields:v.native03,comparison:'分别只计相同编辑与保存区间；两次都用同样起始内容'},
  4:{order:['Alpha receipt','Beta receipt'],leaveUnchecked:'Gamma receipt'},
  5:{bodyByWindow:v.native05,dialog:'打开存储对话框后取消，不写入文件'},
  6:{url:new URL('/form',site).href,fields:v.web06},7:{url:new URL('/async',site).href},
  8:{url:new URL('/tasks',site).href,values:v.web08,edit:'将第一条改为edited',sort:'逆序，页面显示Descending',delete:'删除改过的第一条，保留second；ID从实际创建结果读取'},
  9:{url:new URL('/records',site).href,values:v.web09,find:'先翻页找到目标ID，读取它的实际名称；找到后请求paged只读检查点',filter:'用刚读到的完整名称筛选，应有两条同名记录；请求filtered只读检查点，再只修改指定ID的评论，另一条保持原样',finish:'保存后清除筛选，回到第一页、空筛选和13条总数；不要直接按目标ID筛选'},
  10:{startURL:new URL('/form',site).href,url:new URL('/detail',site).href,values:v.web10,enter:'从当前Form页实际读取并点击Detail链接',cancelled:'第一次取消JS确认后，请求cancelled只读检查点；这时HTML编辑框仍开着，尚未保存',returnAndRefresh:'保存并读出和关闭alert后，用浏览器back回Form，再forward回Detail并reload刷新，然后请求refreshed只读检查点',escaped:'重新打开编辑框后用Escape取消，再请求escaped只读检查点',navigation:'导航（back/forward/reload或页面链接、Refresh page）单独调用，可在同一次steps中合并纯导航，不与编辑或保存混合；检查点只读，不重置时间和调用上限',focus:'最后点击Test delayed focus；根据工具读取等待实际Delayed page focus attempted出现后完成'},
  11:{saveAs:join(workspace,'case11.txt'),initial:'Mountains daily 你好 alpha 🌍',final:v.text},
  12:{localFolder:v.notesFolder,title:v.noteTitle,first:v.noteFirst,second:v.noteSecond},
  13:{source:join(workspace,'move-me.txt'),destination:join(workspace,'已改名','move-me.txt')},
  14:{image:join(workspace,'rotate.png'),rotation:'向左90度，320x160变为160x320'},
  15:{calendar:v.calendar,event:v.event,initialStart:v.eventStart,editedStart:v.eventEditedStart,editedEnd:v.eventEditedEnd},
  16:{list:v.reminders,items:v.reminderItems,completedNames:(v.reminderItems as unknown[]).slice(0,2)},
  17:{title:v.richTitle,table:v.table,source:join(workspace,'case17.rtf'),pdf:join(workspace,'case17.pdf')},
  18:{page:'通用 > 关于本机',readOnly:true},
  19:{source:join(workspace,'case11.txt'),localFolder:v.notesFolder,noteTitle:v.transferTitle,receipt:'从本轮软件界面实际读取，不提供常量'},
  20:{saveTag:'case20-source',fields:v.native20,url:new URL('/reconcile',site).href,receipt:'保存后从本轮软件界面实际读取'},
 };
 return cases.cases.map(spec=>{
  if(!(spec.id in details))throw new Error('missing prompt details for case '+spec.id);
  return{id:spec.id,text:[spec.title,spec.task,'本轮具体内容：'+JSON.stringify(details[spec.id]),'测试目录：'+workspace,
   '只操作本轮新建对象。账户类办公项必须有控制器给出的本机账户及容器持久ID；没有就停止并记失败。不得使用默认或同步账户。',
   '每个删除和剪贴板动作单独提请确认；自动测试的回答来自测试脚本，不代表用户长期授权。',
   '从实际读取结果决定下一步，界面和独立文件都核对后停止。技术控制器负责陈旧快照等故意拒绝检查，不要求模型故意犯错。',
   '本项上限：'+spec.deadlineMs+'毫秒、'+spec.maxToolCalls+'次工具调用。',...cases.boundaries].join('\n')};
 });
}
