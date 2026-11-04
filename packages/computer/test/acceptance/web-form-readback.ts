import assert from 'node:assert/strict';

/** Every consumed checkpoint has its own page identity and capture interval.
 * A correct final page does not authenticate intermediate pagination/dialogs. */
export function verifyWebPageCheckpoint(record:Record<string,unknown>,expected:{caseId:number;phase:string;targetId:string;origin:string;after:number;before:number}):void{
	assert.equal(record.id,expected.caseId,'checkpoint belongs to another case');assert.equal(record.phase,expected.phase,'checkpoint belongs to another phase');
	assert.equal(record.webTarget,expected.targetId,'checkpoint target differs from the private parent binding');
	const page=record.page as Record<string,unknown>|undefined;
	assert.ok(page&&typeof page==='object'&&!Array.isArray(page),'missing independent page checkpoint');
	assert.equal(page.target,expected.targetId,'page target differs from the private parent binding');
	assert.equal(page.provider,'separate raw CDP read-only connection','page was not independently read');
	assert.ok(typeof page.url==='string');const url=new URL(page.url);
	assert.equal(url.origin,expected.origin,'page checkpoint belongs to another origin');assert.equal(url.username,'');assert.equal(url.password,'');
	assert.ok(Number.isFinite(expected.after)&&Number.isFinite(expected.before)&&expected.after<=expected.before);
	assert.ok(typeof record.at==='number'&&Number.isFinite(record.at)&&record.at>=expected.after&&record.at<=expected.before,'checkpoint starts outside this case');
	assert.ok(typeof record.capturedAt==='number'&&Number.isFinite(record.capturedAt)&&record.capturedAt>=record.at&&record.capturedAt<=expected.before,'checkpoint capture is outside this case');
	assert.ok(typeof page.at==='number'&&Number.isFinite(page.at)&&page.at>=record.at&&page.at<=record.capturedAt,'page was not read during its checkpoint');
}

/** Independent DOM evidence only. Request origin, server signatures, tool
 * causality, focus and speed must be verified separately by the controller. */
export function verifyWebFormReadback(page:Record<string,unknown>,expected:{targetId:string;url:string;name:string;color:string;agree:boolean;after:number;before:number}):void{
	assert.ok(typeof expected.targetId==='string'&&expected.targetId.length>0&&expected.targetId.length<=256,'missing controller-pinned page target');
	assert.equal(page.provider,'separate raw CDP read-only connection','page was not independently read');
	assert.equal(page.target,expected.targetId,'independent read observed a different tab');
	assert.equal(page.url,expected.url,'independent read observed a different URL');
	assert.ok(Number.isFinite(expected.after)&&Number.isFinite(expected.before)&&expected.after<=expected.before);
	assert.ok(typeof page.at==='number'&&Number.isFinite(page.at)&&page.at>=expected.after&&page.at<=expected.before,'independent page observation is outside the completed action interval');
	assert.equal(page.status,`Submitted ${expected.name} / ${expected.color} / agreed`,'page did not show the submitted result');
	assert.equal(expected.agree,true);
	assert.ok(Array.isArray(page.fields),'independent page fields are missing');
	const field=(label:string):Record<string,unknown>=>{
		const matches=(page.fields as unknown[]).filter(value=>value&&typeof value==='object'&&!Array.isArray(value)&&(value as Record<string,unknown>).label===label);
		assert.equal(matches.length,1,'page field is missing or ambiguous: '+label);return matches[0] as Record<string,unknown>;
	};
	const name=field('Name'),color=field('Color'),agree=field('I agree');
	assert.equal(name.type,'text');assert.equal(name.value,expected.name);
	assert.equal(color.type,'select-one');assert.equal(color.value,expected.color);
	assert.equal(agree.type,'checkbox');assert.equal(agree.checked,expected.agree);
}
