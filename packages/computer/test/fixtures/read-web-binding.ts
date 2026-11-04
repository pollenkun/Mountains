import {readPrivateWebTarget} from '../acceptance/web-verifier-channel.ts';

try{
	const result=await readPrivateWebTarget({root:process.argv[2]!,caseId:Number(process.argv[3])});
	process.stdout.write(JSON.stringify(result)+'\n');
}catch{
	process.stderr.write('private target rejected\n');
	process.exitCode=1;
}
