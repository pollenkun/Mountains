import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {stopFocusMonitor} from './acceptance/stop-monitor.ts';

test('monitor shutdown waits for EOF, final output and the exact own child close',async()=>{
	const child=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('final-sample\\nstopped\\n');process.exitCode=0});process.stdout.write('ready\\n')"],{stdio:['pipe','pipe','pipe']});
	let out='';child.stdout.on('data',part=>{out+=part;});await once(child.stdout,'data');
	await stopFocusMonitor(child);assert.equal(out,'ready\nfinal-sample\nstopped\n');assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);
});
test('a monitor ignoring EOF is killed and never counts as normally stopped',async()=>{
	const child=spawn(process.execPath,['-e',"process.stdin.resume();setInterval(()=>{},1000);process.stdout.write('ready\\n')"],{stdio:['pipe','pipe','pipe']});
	await once(child.stdout,'data');await assert.rejects(stopFocusMonitor(child,50),/did not flush/);assert.equal(child.signalCode,'SIGKILL');
});
