import {mkdirSync,writeFileSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {encodePng} from '../../src/image.ts';
import {createFreshRunDirectory,installedSwiftCompiler,installedMacSDK} from './cold-prepare.ts';
import {officeSignalsLinkFlags} from './office-signals-build.ts';

// This entry point ONLY builds fresh fixtures. It grants no desktop/account
// permission. Runtime operators retain their separate safety gates.
if(process.platform!=='darwin')throw new Error('cold preparation requires macOS');
const selected=spawnSync('/usr/bin/xcode-select',['-p'],{encoding:'utf8',timeout:3000});
if(selected.status!==0)throw new Error('No selected installed developer directory; nothing was launched');
const compiler=installedSwiftCompiler(selected.stdout.trim());
const sdk=installedMacSDK(selected.stdout.trim());
const here=dirname(fileURLToPath(import.meta.url)),root=createFreshRunDirectory(process.argv[2]||'',join(homedir(),'Movies','Mountains 测试素材'));
for(const dir of ['workspace','controller-private','native','web','evidence','build'])mkdirSync(join(root,dir),{mode:0o700});
writeFileSync(join(root,'evidence','preparation.json'),JSON.stringify({phase:'preparing_materials_only',root,compiler,sdk,at:Date.now(),casesExecuted:0,paidCalls:0,suitePassed:false}),{flag:'wx',mode:0o600});
const build=(source,binary,shared=[],flags=[])=>{
 const result=spawnSync(compiler,['-sdk',sdk,'-swift-version','6','-warnings-as-errors',...flags,...(shared.length?['-parse-as-library']:[]),...shared.map(path=>join(here,path)),join(here,source),'-o',binary],{encoding:'utf8',timeout:120000});
 writeFileSync(join(root,'build',source.replaceAll('/','-')+'.build.log'),result.stdout+result.stderr);
 if(result.status!==0)throw new Error('Swift compile failed: '+source);
};
const bundle=join(root,'build','Mountains QA.app');
mkdirSync(join(bundle,'Contents','MacOS'),{recursive:true});
writeFileSync(join(bundle,'Contents','Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.mountains.acceptance.qa</string>
<key>CFBundleName</key><string>Mountains QA</string>
<key>CFBundleExecutable</key><string>MountainsQA</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);
build('native/App.swift',join(bundle,'Contents','MacOS','MountainsQA'));
build('native/Monitor.swift',join(root,'build','FocusMonitor'),['native/ProcessIdentity.swift','native/FocusSubscriptions.swift']);
build('native/ReadAX.swift',join(root,'build','ReadAX'));
build('native/ReadOfficeWindows.swift',join(root,'build','ReadOfficeWindows'),['native/ProcessIdentity.swift','native/OfficeDocumentTree.swift']);
build('native/OfficeSessionMain.swift',join(root,'build','OfficeSession'),['native/ProcessIdentity.swift','native/OfficeDocumentTree.swift','native/ReadOfficeWindows.swift','native/OfficeSessionCore.swift'],['-D','OFFICE_SESSION',...officeSignalsLinkFlags(compiler,sdk,join(root,'build'))]);
build('native/ReadProcessIdentity.swift',join(root,'build','ReadProcessIdentity'),['native/ProcessIdentity.swift']);
build('native/ReadFixturePeer.swift',join(root,'build','ReadFixturePeer'),['native/ProcessIdentity.swift']);
for(const path of [bundle,join(root,'build','FocusMonitor')]){
 const signed=spawnSync('/usr/bin/codesign',['--force','--sign','-',path],{encoding:'utf8',timeout:10000});
 if(signed.status!==0)throw new Error('ad-hoc signing failed');
}
const sha=value=>createHash('sha256').update(value).digest('hex');
const hashes={};
const collect=directory=>{for(const name of readdirSync(directory)){if(name==='__pycache__'||name==='.DS_Store')continue;
 const path=join(directory,name);if(statSync(path).isDirectory())collect(path);else hashes[path]=sha(readFileSync(path));
}};
collect(here);collect(join(root,'build'));
const pixels=Buffer.alloc(320*160*4);
for(let y=0;y<160;y++)for(let x=0;x<320;x++){
 const offset=(y*320+x)*4;pixels[offset]=x%256;pixels[offset+1]=y;pixels[offset+2]=(x+3*y)%256;pixels[offset+3]=255;
}
const image=encodePng(320,160,pixels);writeFileSync(join(root,'workspace','rotate.png'),image);
const marker=randomUUID(),prefix='M20-'+marker.slice(0,8);
const move='Move only this fresh test file. '+marker+'\n';
writeFileSync(join(root,'workspace','move-me.txt'),move);
const date=new Date();date.setDate(date.getDate()+((8-date.getDay())%7||7));date.setHours(9,0,0,0);
const manifest={version:1,phase:'prepared_only',casesExecuted:0,paidCalls:0,suitePassed:false,createdAt:Date.now(),root,prefix,fixtureHashes:hashes,
 watchBundles:["org.mountains.acceptance.qa","com.google.Chrome","com.apple.TextEdit","com.apple.Notes","com.apple.finder","com.apple.Preview","com.apple.iCal","com.apple.reminders","com.apple.systempreferences"],
 macOS:spawnSync('/usr/bin/sw_vers',['-productVersion'],{encoding:'utf8',timeout:3000}).stdout.trim(),
 assets:{imageSha256:sha(image),moveSha256:sha(move)},
 values:{
 native01:{name:prefix+' 山川',quantity:3,body:'Hello 山川 🌍 alpha',option:'Reviewed',enabled:true},
 native02:{name:prefix+' bounds',body:'Valid boundaries',option:'Draft',enabled:false},
 native03:{name:prefix+' equal',quantity:4,body:'Equal beta 你好 🌍',option:'Ready',enabled:true},
 native05:{A:prefix+' document A',B:prefix+' document B'},
 web06:{name:prefix+' 网页 🌍',color:'Green',agree:true},
 web08:{first:prefix+' apple',second:prefix+' pear',edited:prefix+' apple reviewed'},
 web09:{id:'record-111',comment:prefix+' verified detail'},
 web10:{value:prefix+' persisted modal'},
 text:'Mountains daily 你好 beta 🌍',noteTitle:prefix+' Notes',
 notesFolder:prefix+' Notes folder',transferTitle:prefix+' Transfer',safeReminders:prefix+' Empty reserve',
 noteFirst:'First line 你好 🌍',noteSecond:'Updated second line',
 calendar:prefix+' Calendar',event:prefix+' Review',eventStart:date.toISOString(),
 eventEditedStart:new Date(date.getTime()+2*3600000).toISOString(),
 eventEditedEnd:new Date(date.getTime()+3*3600000).toISOString(),
 reminders:prefix+' Reminders',reminderItems:['买牛奶','交周报','留着'],
 richTitle:prefix+' 工作核对',table:[['项目','数量','状态'],['文档','1','已核对'],['表格','3行','已完成']],
 native20:{name:prefix+' reconciliation',quantity:7,body:prefix+' transfer 山川 🌍',option:'Reviewed',enabled:true}
 }};
writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
writeFileSync(join(root,'evidence','prepared.json'),JSON.stringify({phase:'prepared_only',root,compiler,sdk,at:Date.now(),casesExecuted:0,paidCalls:0,suitePassed:false}),{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({phase:'prepared_only',root,prefix,bundle,manifest:join(root,'manifest.json'),casesExecuted:0,suitePassed:false})+'\n');
