import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeCaseWindows, verifyNativeCase5} from './acceptance/native-case5.ts';

const start = () => ({
	A: {document:'A',windowNumber:101,body:'',dialogOpen:false,dialogWindowNumber:null},
	B: {document:'B',windowNumber:102,body:'',dialogOpen:false,dialogWindowNumber:null},
});
const bodies={A:'own document A',B:'own document B'};
const end = () => ({A:{...start().A,body:bodies.A},B:{...start().B,body:bodies.B}});
const events=()=>[
	{kind:'dialog-open',document:'A',windowNumber:103,parentWindowNumber:101,sequence:5},
	{kind:'dialog-cancel',document:'A',windowNumber:103,parentWindowNumber:101,sequence:8},
];

test('native formal targets require signed document and live panel identities',()=>{
	assert.deepEqual(nativeCaseWindows(start(),4),{A:'w:101'});
	assert.deepEqual(nativeCaseWindows(start(),5),{A:'w:101',B:'w:102'});
	const open=start();Object.assign(open.A,{dialogOpen:true,dialogWindowNumber:103});
	assert.deepEqual(nativeCaseWindows(open,5),{A:'w:101','dialog A':'w:103',B:'w:102'});
	for(const patch of [{dialogWindowNumber:101},{dialogWindowNumber:102},{dialogWindowNumber:0},{dialogWindowNumber:null}]){
		const bad=structuredClone(open);Object.assign(bad.A,patch);assert.throws(()=>nativeCaseWindows(bad,5));
	}
	const stale=start();Object.assign(stale.A,{dialogWindowNumber:103});assert.throws(()=>nativeCaseWindows(stale,5));
	const wrong=start();wrong.B.document='A';assert.throws(()=>nativeCaseWindows(wrong,5));
});

test('native case5 requires correct documents and one exact open/cancel pair',()=>{
	assert.doesNotThrow(()=>verifyNativeCase5(start(),end(),events(),bodies));
	for(const change of [
		(e:ReturnType<typeof end>)=>{e.B.body=bodies.A;},
		(e:ReturnType<typeof end>)=>{e.B.dialogOpen=true;},
		(e:ReturnType<typeof end>)=>{Object.assign(e.B,{dialogWindowNumber:104});},
		(e:ReturnType<typeof end>)=>{e.A.windowNumber=200;},
	]){const bad=end();change(bad);assert.throws(()=>verifyNativeCase5(start(),bad,events(),bodies));}
	for(const patch of [{document:'B'},{windowNumber:104},{parentWindowNumber:102},{sequence:4}]){
		const bad=events();Object.assign(bad[1]!,patch);assert.throws(()=>verifyNativeCase5(start(),end(),bad,bodies));
	}
	assert.throws(()=>verifyNativeCase5(start(),end(),events().slice(1),bodies));
	assert.throws(()=>verifyNativeCase5(start(),end(),[...events(),events()[0]!],bodies));
	assert.throws(()=>verifyNativeCase5(start(),end(),[...events(),{kind:'saved',document:'A',windowNumber:101,parentWindowNumber:101,sequence:10}],bodies));
});

test('native case5 cannot count an invalid Save attempt as a successful Cancel',()=>{
	// Old fixture Save called cancelDialog before save, so it emitted the same
	// cancel event and merely failed missing-name validation without any file.
	const saveInsteadOfCancel=[...events(),{kind:'invalid',document:'A',reason:'missing-name',sequence:9}];
	assert.throws(()=>verifyNativeCase5(start(),end(),saveInsteadOfCancel,bodies));
	const confirmed=events();Object.assign(confirmed[1]!,{kind:'dialog-confirm'});
	assert.throws(()=>verifyNativeCase5(start(),end(),confirmed,bodies));
	const sameNumber=events().map(event=>({...event,windowNumber:101}));
	assert.throws(()=>verifyNativeCase5(start(),end(),sameNumber,bodies));
});
