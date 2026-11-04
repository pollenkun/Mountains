import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {accessSync,constants,lstatSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Cold-build only, with the installed toolchain already selected for Swift.
 * Never invoke /usr/bin/clang's installer shim or install system-wide helpers. */
export function officeSignalsLinkFlags(compiler:string,sdk:string,output:string):string[]{
	const directory=realpathSync(dirname(compiler)),clang=join(dirname(compiler),'clang'),actual=realpathSync(clang);
	const inside=relative(directory,actual);assert.ok(inside!==''&&inside!=='..'&&!inside.startsWith('..'+sep)&&!isAbsolute(inside));
	assert.notEqual(actual,'/usr/bin/clang');assert.ok(lstatSync(actual).isFile());accessSync(actual,constants.X_OK);
	const header=fileURLToPath(new URL('./native/OfficeSignals.h',import.meta.url)),source=fileURLToPath(new URL('./native/OfficeSignals.c',import.meta.url));
	const object=join(output,'OfficeSignals.o'),build=spawnSync(clang,['-isysroot',sdk,'-std=c11','-Wall','-Wextra','-Werror','-c',source,'-o',object],{encoding:'utf8',timeout:5000,killSignal:'SIGKILL'});
	writeFileSync(join(output,'OfficeSignals.c.build.log'),(build.stdout??'')+(build.stderr??''),{flag:'wx',mode:0o600});
	assert.equal(build.status,0,'installed C compiler failed: '+build.stderr);return['-import-objc-header',header,object];
}
