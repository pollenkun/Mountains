import assert from 'node:assert/strict';

type State = Record<string, unknown>;
const number = (value: unknown): number => {
	assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'missing exact owned window number');
	return value;
};

/** Only the controller's verified signed receiver state can supply these IDs. */
export function nativeCaseWindows(states: Record<string, State>, selectedCase: number): Record<string, string> {
	const result: Record<string, string> = {};
	for (const document of selectedCase === 5 ? ['A', 'B'] : ['A']) {
		const state = states[document];
		assert.equal(state?.document, document, 'document identity mismatch');
		result[document] = 'w:' + number(state.windowNumber);
		if (selectedCase === 5) {
			assert.equal(typeof state.dialogOpen, 'boolean');
			if (state.dialogOpen) result['dialog ' + document] = 'w:' + number(state.dialogWindowNumber);
			else assert.equal(state.dialogWindowNumber, null, 'closed panel retained a live window number');
		}
	}
	assert.equal(new Set(Object.values(result)).size, Object.values(result).length, 'owned windows must have distinct identities');
	return result;
}

/** Data-only checks; focus/speed and the journal's HMAC are checked separately. */
export function verifyNativeCase5(start: Record<string, State>, end: Record<string, State>, events: State[], bodies: Record<string, unknown>): void {
	for (const document of ['A', 'B']) {
		const before = start[document], after = end[document];
		assert.ok(before && after, 'missing document state');
		assert.equal(after.document, document);
		assert.equal(after.windowNumber, before.windowNumber, 'document window changed');
		assert.equal(after.body, bodies[document], 'content belongs to the other document');
		assert.equal(before.dialogOpen, false);
		assert.equal(after.dialogOpen, false, 'a document still owns an open panel');
		assert.equal(after.dialogWindowNumber, null, 'closed panel number remains');
	}
	const opened = events.filter(event => event.kind === 'dialog-open');
	const cancelled = events.filter(event => event.kind === 'dialog-cancel');
	assert.equal(opened.length, 1, 'exactly one panel must actually open');
	assert.equal(cancelled.length, 1, 'exactly one panel must actually cancel');
	const open = opened[0]!, cancel = cancelled[0]!;
	assert.ok(open.document === 'A' || open.document === 'B');
	assert.equal(cancel.document, open.document, 'cancel belongs to a different document');
	assert.equal(number(cancel.windowNumber), number(open.windowNumber), 'cancel belongs to a different panel');
	assert.ok(!['A','B'].some(document=>start[document]?.windowNumber===open.windowNumber), 'panel reused a document identity');
	const parent = start[open.document]; assert.ok(parent, 'missing panel parent');
	assert.equal(number(open.parentWindowNumber), number(parent.windowNumber));
	assert.equal(cancel.parentWindowNumber, open.parentWindowNumber);
	assert.ok(typeof open.sequence === 'number' && typeof cancel.sequence === 'number' && cancel.sequence > open.sequence, 'panel cancellation predates opening');
	assert.equal(events.filter(event => event.kind === 'saved').length, 0, 'cancelled panel saved a document');
	assert.equal(events.filter(event => event.kind === 'dialog-confirm' || event.kind === 'invalid').length, 0, 'Save was attempted instead of Cancel');
}
