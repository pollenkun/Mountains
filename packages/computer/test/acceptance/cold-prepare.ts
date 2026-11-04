import assert from 'node:assert/strict';
import {accessSync,constants,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';

/** Cold preparation never launches the generated apps or visits an account.
 * Keep this separate from permission to execute real desktop input. */
export function createFreshRunDirectory(requested:string,allowedBase:string):string{
	assert.ok(requested&&isAbsolute(requested),'pass an absolute NEW run directory');
	const base=realpathSync(allowedBase);
	assert.ok(lstatSync(base).isDirectory(),'test-material base is not a directory');
	const root=resolve(requested),parent=realpathSync(resolve(root,'..'));
	const inside=relative(base,parent);
	assert.ok(inside===''||inside!=='..'&&!inside.startsWith('..'+sep)&&!isAbsolute(inside),'run directory is outside the test-material base');
	// Do not accept a path whose apparent location differs through a parent link.
	assert.equal(parent,resolve(root,'..'),'run parent must be canonical, without symlink redirection');
	mkdirSync(root,{recursive:false,mode:0o700});
	assert.equal(realpathSync(root),root,'new run directory was redirected');
	return root;
}

/** Use the installed compiler itself, never the /usr/bin/swiftc install shim. */
export function installedSwiftCompiler(developerDirectory:string):string{
	assert.ok(isAbsolute(developerDirectory),'selected developer directory must be absolute');
	const developer=realpathSync(developerDirectory);
	for(const suffix of ['Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc','usr/bin/swiftc']){
		try{
			const entry=join(developer,suffix),compiler=realpathSync(entry);
			const inside=relative(developer,compiler);
			assert.ok(inside!==''&&inside!=='..'&&!inside.startsWith('..'+sep)&&!isAbsolute(inside),'installed compiler escaped the selected developer directory');
			assert.ok(!['/usr/bin/swiftc','/usr/bin/swift'].includes(compiler),'system compiler install shims are not installed toolchains');
			assert.ok(lstatSync(compiler).isFile());accessSync(compiler,constants.X_OK);
			// swiftc may be a multicall alias to swift-frontend. Its absolute
			// installed entry name selects compiler-driver mode via argv[0].
			return entry;
		}catch{/* A missing installed toolchain must not trigger an install prompt. */}
	}
	throw new Error('No installed Swift compiler in the selected developer directory; nothing was launched');
}

export function installedMacSDK(developerDirectory:string):string{
	assert.ok(isAbsolute(developerDirectory),'selected developer directory must be absolute');
	const developer=realpathSync(developerDirectory);
	for(const suffix of ['Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk','SDKs/MacOSX.sdk']){
		try{
			const sdk=realpathSync(join(developer,suffix)),inside=relative(developer,sdk);
			assert.ok(inside!==''&&inside!=='..'&&!inside.startsWith('..'+sep)&&!isAbsolute(inside));
			assert.ok(lstatSync(sdk).isDirectory()&&lstatSync(join(sdk,'SDKSettings.json')).isFile());return sdk;
		}catch{/* Discovery only; never ask Xcode to install anything. */}
	}
	throw new Error('No installed macOS SDK in the selected developer directory; nothing was launched');
}
