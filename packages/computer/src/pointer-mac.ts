import { HelperResponseError, JsonHelper } from "./helper.ts";
import { MacEventData } from "./event-data-mac.ts";
import { nativeCommandRoute, PointerInputError, type NativeCommandRoute } from "./native-route.ts";
import { randomUUID } from "node:crypto";
import { currentInput, InputTerminationUnverifiedError, type InputLease } from "./coordinator.ts";
import { PhasedPointerActor } from "./pointer-lifecycle.ts";

// Candidate startup proof only. Never imports AppKit/AX/CG, creates windows,
// touches the clipboard or enters the legacy helper's EOF restoration path.
const FOUNDATION_STARTUP = String.raw`function run(){
ObjC.import("Foundation");
const input=$.NSFileHandle.fileHandleWithStandardInput,out=$.NSFileHandle.fileHandleWithStandardOutput;
let bytes=$.NSMutableData.data;
for(;;){
 const byte=input.readDataOfLength(1);if(Number(byte.length)===0)return;
 bytes.appendData(byte);if(Number(bytes.length)>8192)throw new Error("startup command exceeded its bound");
 const text=$.NSString.alloc.initWithDataEncoding(byte,$.NSUTF8StringEncoding).js;if(text!=="\n")continue;
 const c=JSON.parse(String($.NSString.alloc.initWithDataEncoding(bytes,$.NSUTF8StringEncoding).js));bytes=$.NSMutableData.data;
 if(c.op!=="ping"||!Number.isSafeInteger(c.id)||c.id<=0)throw new Error("candidate startup helper accepts only an internal ping");
 out.writeData($(JSON.stringify({id:c.id,ok:true,componentOnly:true,startupOnly:true,inputSent:false,pid:Number($.NSProcessInfo.processInfo.processIdentifier)})+"\n").dataUsingEncoding($.NSUTF8StringEncoding));
}
}`;

/** Target-addressed input and a visual cursor by default. Real-pointer drag is explicit opt-in.
 * Pixel events are dispatch receipts, not evidence that the target accepted the action.
 * The window field and SkyLight focus route are platform-dependent and must be fixture-tested.
 */
const HELPER = String.raw`ObjC.import("Cocoa"); ObjC.import("QuartzCore"); ObjC.import("CoreGraphics"); ObjC.import("CoreText"); ObjC.import("stdlib"); ObjC.import("ApplicationServices");
const phaseNonce=ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("MOUNTAINS_POINTER_PHASED"))||"";
const phasedInput=phaseNonce!=="";
let globalFinishAllowed=false;
const workspace = $.NSWorkspace.sharedWorkspace;
const out = $.NSFileHandle.fileHandleWithStandardOutput;
let helperClosing = false, activeCommand = null;
const reply = o => {
	try { out.writeData($(JSON.stringify(o) + "\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
	catch (e) { helperClosing = true; }
};
const primaryHeight = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
// CGColorCreateSRGB returns a retained colour; NSColor.CGColor can be freed under the bridge and crash.
const color = (r, g, b, a) => $.CGColorCreateSRGB(r, g, b, a);
const overlays = [], screens = $.NSScreen.screens,arrows=[],cursors=[],stretchers=[];
let cursorInitialized=false;
function initializeCursor(){
if(cursorInitialized)return;cursorInitialized=true;
const app=$.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
for (let i = 0; i < screens.count; i++) {
	const f = screens.objectAtIndex(i).frame;
	const w = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(f, 0, $.NSBackingStoreBuffered, false);
	w.opaque = false; w.backgroundColor = $.NSColor.clearColor; w.ignoresMouseEvents = true; w.hasShadow = false;
	w.collectionBehavior = 1 | 16 | 64 | 256; w.releasedWhenClosed = false;
	const v = w.contentView; v.wantsLayer = true;
	overlays.push({ win: w, x: f.origin.x, top: primaryHeight - (f.origin.y + f.size.height), width: f.size.width, height: f.size.height, layer: v.layer });
}
// The cursor's colour: the app's theme colour when it passes one (Codex passes its accent colour the same way),
// else the desktop picture's most colourful part, made clear enough to stand out on any app. A grey picture
// gives the system's accent colour.
function cursorRGB() {
	const given = /^#([0-9a-f]{6})$/i.exec(ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("MOUNTAINS_CURSOR_COLOR")) || "");
	if (given) return [0, 2, 4].map(k => parseInt(given[1].slice(k, k + 2), 16) / 255);
	try {
		const img = $.NSImage.alloc.initWithContentsOfURL(workspace.desktopImageURLForScreen($.NSScreen.mainScreen));
		const n = 8, rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, n, n, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
		$.NSGraphicsContext.saveGraphicsState;
		$.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
		img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, n, n), $.NSZeroRect, 1, 1);
		$.NSGraphicsContext.restoreGraphicsState;
		let best = null;
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
			const c = rep.colorAtXY(x, y), score = c.saturationComponent * c.brightnessComponent;
			if (!best || score > best.score) best = { score, h: c.hueComponent, s: c.saturationComponent, b: c.brightnessComponent };
		}
		if (best && best.s >= 0.12) {
			const c = $.NSColor.colorWithDeviceHueSaturationBrightnessAlpha(best.h, Math.max(best.s, 0.6), Math.min(Math.max(best.b, 0.7), 0.92), 1);
			return [c.redComponent, c.greenComponent, c.blueComponent];
		}
	} catch (e) { /* no picture: the accent colour */ }
	const a = $.NSColor.controlAccentColor.colorUsingColorSpace($.NSColorSpace.deviceRGBColorSpace);
	return [a.redComponent, a.greenComponent, a.blueComponent];
}
const tint = cursorRGB();
// One colour for the arrow and its name tag, as Codex has it. The white text needs the fill dark enough for
// 3:1; a light desktop colour is darkened only as far as that takes.
const fill = (() => {
	const lum = c => c.map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)).reduce((a, v, k) => a + v * [0.2126, 0.7152, 0.0722][k], 0);
	let c = tint.slice();
	for (let k = 0; k < 12 && 1.05 / (lum(c) + 0.05) < 3; k++) c = c.map(v => v * 0.92);
	return c;
})();
// The agent's name in a tag beside its cursor, as Codex shows it: "Mountains", or each agent's own name
// when several work at once. An empty value hides the tag.
const label = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("MOUNTAINS_CURSOR_LABEL")) || "";
// Settle after each synthetic focus record before keys follow. open-computer-use measured 10 ms as enough on
// Chrome and AppKit (0 ms failed on macOS 26); 30 ms keeps a margin. Was 120 ms each, up to three times a key.
const FOCUS_SETTLE = (() => { const v = Number(ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("MOUNTAINS_FOCUS_SETTLE_MS"))); return Number.isFinite(v) && v >= 0 && v <= 500 ? v / 1000 : 0.03; })();
// Layers count y upwards from the bottom of the screen; the arrow's tip is at (0, 0) and it points up-left.
// Codex's cursor, traced from its 2x screenshot and drawn 1.3 times its size: tip at (0, 0), a straight top
// edge to a short right wing, a curved notch down to a long narrow tail, a straight left edge back. The colour
// is also stroked in its own colour, which rounds its corners without cutting the narrow tip short, and sits
// on a white ring about 1.4 points wide.
const ARROW = { right: [13.6, -5.2], notch: [4.9, -7], tail: [3.9, -14.6] };
cursors.push(...overlays.map((o, i) => {
	const group = $.CALayer.layer;
	group.anchorPoint = $.CGPointMake(0, 0); group.bounds = $.CGRectMake(0, 0, 1, 1); group.opacity = 0;
	const p = $.CGPathCreateMutable(), { right, notch, tail } = ARROW;
	$.CGPathMoveToPoint(p, null, 0, 0);
	$.CGPathAddLineToPoint(p, null, right[0], right[1]);
	$.CGPathAddQuadCurveToPoint(p, null, notch[0], notch[1], tail[0], tail[1]);
	$.CGPathCloseSubpath(p);
	const ring = $.CAShapeLayer.layer;
	ring.path = p; ring.fillColor = color(1, 1, 1, 1); ring.strokeColor = color(1, 1, 1, 1); ring.lineWidth = 4; ring.lineJoin = $.kCALineJoinRound;
	ring.shadowColor = color(0, 0, 0, 1); ring.shadowOpacity = 0.22; ring.shadowRadius = 2.5; ring.shadowOffset = $.CGSizeMake(0, -1);
	const arrow = $.CAShapeLayer.layer;
	arrow.path = p; arrow.fillColor = color(fill[0], fill[1], fill[2], 1); arrow.strokeColor = color(fill[0], fill[1], fill[2], 1); arrow.lineWidth = 1.2; arrow.lineJoin = $.kCALineJoinRound;
	// head leans, dips and wiggles about the tip; inside it a scoot stretches the arrow along its direction of
	// travel: rotate into that direction, scale, rotate back (three layers, as one layer applies scale first).
	const layer = () => { const l = $.CALayer.layer; l.anchorPoint = $.CGPointMake(0, 0); l.bounds = $.CGRectMake(0, 0, 0, 0); return l; };
	const head = layer(), dirOut = layer(), squash = layer(), dirIn = layer();
	dirIn.addSublayer(ring); dirIn.addSublayer(arrow); squash.addSublayer(dirIn); dirOut.addSublayer(squash); head.addSublayer(dirOut);
	group.addSublayer(head);
	arrows.push(head); stretchers.push({ dirOut, squash, dirIn });
	if (label) {
		// A pill in the arrow's colour, in the screenshot's proportions at the arrow's size: 20 points high, 7 points
		// either side of 12-point regular text, its left edge 12 points right of the tip, its top just below the tail. The layer gets a CoreText UI font: given an NSFont or a font name, CATextLayer draws black
		// Helvetica whatever the colour (checked offscreen).
		const font = $.NSFont.systemFontOfSize(12), size = $(label).sizeWithAttributes($.NSDictionary.dictionaryWithObjectForKey(font, $.NSFontAttributeName));
		const textHeight = Math.ceil(size.height), height = 20, width = Math.ceil(size.width) + 14;
		const pill = $.CALayer.layer;
		pill.backgroundColor = color(fill[0], fill[1], fill[2], 1); pill.cornerRadius = height / 2;
		pill.frame = $.CGRectMake(12, -17 - height, width, height);
		const t = $.CATextLayer.layer;
		t.string = $(label); t.font = $.CTFontCreateUIFontForLanguage($.kCTFontUIFontSystem, 12, null); t.fontSize = 12;
		t.foregroundColor = color(1, 1, 1, 1); t.alignmentMode = $.kCAAlignmentCenter; t.contentsScale = screens.objectAtIndex(i).backingScaleFactor;
		t.frame = $.CGRectMake(0, (height - textHeight) / 2, width, textHeight);
		pill.addSublayer(t);
		group.addSublayer(pill);
	}
	o.layer.addSublayer(group);
	return group;
}));
app.finishLaunching;
}
let at = null, shownOn = -1;
const pos = (o, x, y) => $.CGPointMake(x - o.x, o.height - (y - o.top));
const screenOf = (x, y) => Math.max(0, overlays.findIndex(o => x >= o.x && x < o.x + o.width && y >= o.top && y < o.top + o.height));
const tx = (fn, seconds) => {
	$.CATransaction.begin; $.CATransaction.setAnimationDuration(seconds);
	$.CATransaction.setAnimationTimingFunction($.CAMediaTimingFunction.functionWithName($.kCAMediaTimingFunctionEaseInEaseOut));
	fn(); $.CATransaction.commit; $.CATransaction.flush;
};
function place(win) { initializeCursor();for (const o of overlays) o.win.orderWindowRelativeTo($.NSWindowAbove, win); }
// Keep observing activation and deadlines during animation; never restore foreground secretly.
const wait = seconds => $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
const ease = () => $.CAMediaTimingFunction.functionWithName($.kCAMediaTimingFunctionEaseInEaseOut);
function still() { if (shownOn >= 0) arrows[shownOn].removeAnimationForKey("think"); }
// While the model works out its next step, the cursor wiggles about its tip, as Codex's does.
function think() {
	if (shownOn < 0) return;
	const a = $.CABasicAnimation.animationWithKeyPath("transform.rotation.z");
	a.fromValue = $(-0.09); a.toValue = $(0.09); a.duration = 0.5; a.autoreverses = true; a.repeatCount = 1e9; a.timingFunction = ease();
	arrows[shownOn].addAnimationForKey(a, "think");
}
function hideCursor() {
	still();
	if (shownOn >= 0) tx(() => { cursors[shownOn].opacity = 0; }, 0.25);
	shownOn = -1;
}
// The cursor's motion, after the structure of Codex's (arc paths, distance-scaled springs, short "scoots"
// with squash and stretch); the values are ours. A long move bows to whichever side keeps the arc on screen
// and comes into the target from the lower right, as a hand brings a pointer up to a button. A spring drives
// progress along the path: the cursor eases out of rest, overshoots a little and settles. A short move is a
// straight scoot that stretches along its way; a long one stretches slightly at speed. The arrow leans with its speed, smoothed; the name tag stays
// level. The whole path is worked out first and handed to Core Animation as 120-per-second keyframes, so the
// display draws every frame instead of this script nudging the layer; the click goes once within 3 points.
// --- cursor path: pure, so tests and the preview renderer run this same text ---
const MOTION = { straightBelow: 36, arc: 0.18, startHandle: 0.3, endHandle: 0.32, approach: Math.PI * 0.75, margin: 40,
	response: [0.36, 0.6], responsePerPoint: 0.0003, damping: 0.86, scootResponse: 0.22, scootDamping: 0.8,
	lean: 0.12, leanPerSpeed: 0.00008, leanSmoothing: 0.3, stretch: 0.18, squash: 0.08, stretchPerSpeed: 0.00015,
	// Long moves stretch a little at speed too, standing in for motion blur so fast frames read as one movement.
	glideStretch: 0.1, glideStretchPerSpeed: 0.000018, closeEnough: 3, rate: 120 };
const lerp = (a, b, t) => a + (b - a) * t;
function bezier(p0, p1, p2, p3, t) {
	const u = 1 - t;
	return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
}
// Positions (layer points, y up) at MOTION.rate per second from a to b, with the arrow's lean and a scoot's stretch,
// and the time at which the cursor is close enough to click.
function cursorPath(a, b, width, height, random) {
	const dist = Math.hypot(b[0] - a[0], b[1] - a[1]), scoot = dist < MOTION.straightBelow;
	// A straight scoot uses third points, so its speed along the line is even and its end tangent is real.
	let c1 = [lerp(a[0], b[0], 1 / 3), lerp(a[1], b[1], 1 / 3)], c2 = [lerp(a[0], b[0], 2 / 3), lerp(a[1], b[1], 2 / 3)];
	if (!scoot) {
		// Two candidate bows; keep the one whose handles stay inside the screen margin.
		const nx = -(b[1] - a[1]) / dist, ny = (b[0] - a[0]) / dist, inside = q => q[0] > MOTION.margin && q[0] < width - MOTION.margin && q[1] > MOTION.margin && q[1] < height - MOTION.margin;
		const candidates = [1, -1].map(side => {
			const s1 = [lerp(a[0], b[0], MOTION.startHandle) + nx * side * MOTION.arc * dist, lerp(a[1], b[1], MOTION.startHandle) + ny * side * MOTION.arc * dist];
			// The end handle sits below and right of the target in screen terms (layer y points up).
			const e = Math.min(dist * MOTION.endHandle, 140), s2 = [b[0] - Math.cos(MOTION.approach) * e, b[1] - Math.sin(MOTION.approach) * e];
			return { s1, s2, score: (inside(s1) ? 2 : 0) + (inside(s2) ? 1 : 0) + random() * 0.5 };
		}).sort((p, q) => q.score - p.score);
		c1 = candidates[0].s1; c2 = candidates[0].s2;
	}
	const response = scoot ? MOTION.scootResponse : Math.min(MOTION.response[1], Math.max(MOTION.response[0], MOTION.response[0] + dist * MOTION.responsePerPoint));
	const zeta = scoot ? MOTION.scootDamping : MOTION.damping, w = 2 * Math.PI / response, steps = 2, dt = 1 / (MOTION.rate * steps);
	// The first keyframe is where the cursor already is, so the move starts without a jump.
	const points = [a], angles = [0], sx = [1], sy = [1];
	let p = 0, v = 0, t = 0, last = a, angle = 0, arrive = -1;
	for (let n = 0; t < 1.6; n++) {
		for (let k = 0; k < steps; k++) { v += (-w * w * (p - 1) - 2 * zeta * w * v) * dt; p += v * dt; t += dt; }
		// Past the end the cursor runs on along the final tangent, so an overshoot does not fold back on the curve.
		const q = p <= 1 ? bezier(a, c1, c2, b, p) : [b[0] + (b[0] - c2[0]) * 3 * (p - 1), b[1] + (b[1] - c2[1]) * 3 * (p - 1)];
		const vx = (q[0] - last[0]) * MOTION.rate, speed = Math.hypot(q[0] - last[0], q[1] - last[1]) * MOTION.rate;
		angle += (Math.max(-MOTION.lean, Math.min(MOTION.lean, -vx * MOTION.leanPerSpeed)) - angle) * MOTION.leanSmoothing;
		const stretch = scoot ? Math.min(MOTION.stretch, speed * MOTION.stretchPerSpeed) : Math.min(MOTION.glideStretch, speed * MOTION.glideStretchPerSpeed);
		points.push(q); angles.push(angle); sx.push(1 + stretch); sy.push(1 - stretch * (MOTION.squash / MOTION.stretch));
		last = q;
		if (arrive < 0 && p > 0.9 && Math.hypot(q[0] - b[0], q[1] - b[1]) < MOTION.closeEnough) arrive = (n + 1) / MOTION.rate;
		if (Math.abs(1 - p) < 0.0008 && Math.abs(v) < 0.01) break;
	}
	points.push(b); angles.push(0); sx.push(1); sy.push(1);
	return { points, angles, sx, sy, arrive, scoot, dir: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
// --- end cursor path ---
const reduceMotion = () => { try { return !!workspace.accessibilityDisplayShouldReduceMotion; } catch (e) { return false; } };
function moveTo(x, y) {
	initializeCursor();
	const s = screenOf(x, y), o = overlays[s], cur = cursors[s], head = arrows[s], st = stretchers[s];
	still();
	const from = at && screenOf(at[0], at[1]) === s && s === shownOn ? at : null;
	if (s !== shownOn) {
		if (shownOn >= 0) tx(() => { cursors[shownOn].opacity = 0; }, 0.1);
		tx(() => { cur.position = pos(o, x, y); }, 0);
		tx(() => { cur.opacity = 1; }, 0.2);
		shownOn = s;
	}
	const dist = from ? Math.hypot(x - from[0], y - from[1]) : 0;
	if (dist > 2 && reduceMotion()) { tx(() => { cur.position = pos(o, x, y); }, 0.15); wait(0.15); }
	else if (dist > 2) {
		const A = pos(o, from[0], from[1]), B = pos(o, x, y), path = cursorPath([A.x, A.y], [B.x, B.y], o.width, o.height, Math.random);
		const duration = path.points.length / MOTION.rate, points = path.points.map(q => $.NSValue.valueWithPoint($.NSMakePoint(q[0], q[1])));
		const keys = (keyPath, values) => { const k = $.CAKeyframeAnimation.animationWithKeyPath(keyPath); k.values = $(values); k.duration = duration; k.calculationMode = $.kCAAnimationLinear; return k; };
		$.CATransaction.begin; $.CATransaction.setDisableActions(true);
		st.dirOut.transform = $.CATransform3DMakeRotation(path.dir, 0, 0, 1); st.dirIn.transform = $.CATransform3DMakeRotation(-path.dir, 0, 0, 1);
		cur.position = B; cur.addAnimationForKey(keys("position", points), "move");
		head.addAnimationForKey(keys("transform.rotation.z", path.angles), "lean");
		st.squash.addAnimationForKey(keys("transform.scale.x", path.sx), "sx"); st.squash.addAnimationForKey(keys("transform.scale.y", path.sy), "sy");
		$.CATransaction.commit; $.CATransaction.flush;
		wait(path.arrive > 0 ? path.arrive : duration);
	}
	at = [x, y];
}
// A press: the arrow dips toward its tip and springs back, with no ripple; the name tag stays as it is.
function press(hold) {
	if (shownOn < 0) return;
	const head = arrows[shownOn];
	tx(() => { head.transform = $.CATransform3DMakeScale(0.84, 0.84, 1); }, 0.06);
	wait(0.06);
	if (!hold) release();
}
function release() {
	if (shownOn < 0) return;
	const back = $.CASpringAnimation.animationWithKeyPath("transform.scale");
	back.fromValue = $(0.84); back.toValue = $(1); back.damping = 14; back.stiffness = 420; back.mass = 1; back.duration = back.settlingDuration;
	$.CATransaction.begin; $.CATransaction.setDisableActions(true);
	arrows[shownOn].transform = $.CATransform3DIdentity; arrows[shownOn].addAnimationForKey(back, "release");
	$.CATransaction.commit;
}
// Window-local coordinates are distinct from the event's desktop position.
// Without them AppKit can interpret a click as title-bar input.
let localLocation = false;
try { ObjC.bindFunction("CGEventSetWindowLocation", ["void", ["void *", "double", "double"]]); localLocation = true; } catch (e) {}
function verifyProcess(c) {
 const running=$.NSRunningApplication.runningApplicationWithProcessIdentifier(c.pid);
 if(!running || running.isNil() || (running.launchDate && !running.launchDate.isNil() ? String(Number(running.launchDate.timeIntervalSince1970)) : "since-login")!==c.instance)throw new Error("target process generation changed before event dispatch");
}
function windowRecord(c) {
 if(c.hostTarget){
  windowRecord(c.hostTarget);
  let anchor=exactAXWindow(c.hostTarget);const proof=c.hostTarget.inputAnchor;
  if(!proof||!anchor)throw new Error("host remote input receiver changed; read the window again before input");
  for(const index of proof.path){const children=axAttribute(anchor,"AXChildren");if(!children||index>=children.count)throw new Error("host remote input receiver changed; read the window again before input");anchor=children.objectAtIndex(index);}
  const number=Ref();
  if(!$.CFEqual(anchor,proof.element)||$._AXUIElementGetWindow(anchor,number)!==0||Number(number[0])!==c.window)throw new Error("host remote input receiver changed; read the window again before input");
 }
 verifyProcess(c);
 const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(c.hostTarget ? 0 : 8, c.hostTarget ? 0 : c.window));
 for (let i=0;i<list.count;i++) {
  const w=ObjC.deepUnwrap(list.objectAtIndex(i));
  if (w.kCGWindowNumber !== c.window || w.kCGWindowOwnerPID !== c.pid) continue;
  const b=w.kCGWindowBounds, expected=c.bounds;
  if (!expected || Math.abs(b.X-expected.x)>1 || Math.abs(b.Y-expected.y)>1 || Math.abs(b.Width-expected.width)>1 || Math.abs(b.Height-expected.height)>1) throw new Error("window geometry changed before event dispatch");
  return b;
 }
 throw new Error("exact target window disappeared before event dispatch");
}
function normalizeActionName(name) {
 const plain=name.startsWith("AX")?name.slice(2):name;let value="";
 for(let i=0;i<plain.length;i++){const ch=plain[i];value+=/[A-Z]/.test(ch)?(i?"_":"")+ch.toLowerCase():ch;}
 return value;
}
// A remote view can be mirrored into its host app as a second CG window.
// Follow only window numbers reported by this exact AX subtree, never an
// arbitrary process with the same name or a window found by geometry alone.
function resolveInputTarget(c) {
 if(c.foregroundAuthorized || c.hostTarget)return c;
 const root=exactAXWindow(c);if(!root)return c;
 const pending=[{el:root,depth:0,path:[]}],ids=new Map();
 for(let i=0;i<pending.length&&i<128;i++){
  const {el,depth,path}=pending[i],number=Ref();
  if($._AXUIElementGetWindow(el,number)===0&&Number(number[0])!==c.window)ids.set(Number(number[0]),{element:el,path});
  if(depth>=2)continue;
  const children=axAttribute(el,"AXChildren");
  for(let j=0;children&&j<children.count&&pending.length<128;j++){
   const child=children.objectAtIndex(j);if(elementRole(child)!=="AXSheet")pending.push({el:child,depth:depth+1,path:path.concat(j)});
  }
 }
 if(!ids.size)return c;
 const list=ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0)),matches=[];
 for(let i=0;i<list.count;i++){
  const w=ObjC.deepUnwrap(list.objectAtIndex(i)),b=w.kCGWindowBounds;
  if(!ids.has(w.kCGWindowNumber)||w.kCGWindowOwnerPID===c.pid||w.kCGWindowLayer!==0)continue;
  if(Math.abs(b.X-c.bounds.x)>1||Math.abs(b.Y-c.bounds.y)>1||Math.abs(b.Width-c.bounds.width)>1||Math.abs(b.Height-c.bounds.height)>1)continue;
  matches.push(w);
 }
 if(!matches.length)return c;
 if(matches.length!==1)throw new Error("remote input window identity is ambiguous; no input was sent");
 const w=matches[0],running=$.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID);
 if(!running||running.isNil())throw new Error("remote input process disappeared");
 const instance=running.launchDate&&!running.launchDate.isNil()?String(Number(running.launchDate.timeIntervalSince1970)):"since-login";
 return {...c,hostTarget:{pid:c.pid,instance:c.instance,window:c.window,bounds:c.bounds,inputAnchor:ids.get(w.kCGWindowNumber)},pid:w.kCGWindowOwnerPID,instance,window:w.kCGWindowNumber};
}
function stamp(e, c, x, y) {
 const b=windowRecord(c);
 $.CGEventSetIntegerValueField(e, 51, c.window);
 // NSEvent supplies its own private fields. In particular field 55 carries
 // event-type data on this OS; overwriting it with a window ID drops events.
 $.CGEventSetIntegerValueField(e, 91, c.window);
 $.CGEventSetIntegerValueField(e, 92, c.window);
 $.CGEventSetIntegerValueField(e, $.kCGEventTargetUnixProcessID, c.pid);
 if (x !== undefined) {
  if (!localLocation) throw new Error("window-local event coordinates unavailable; no fallback was sent");
  $.CGEventSetWindowLocation(e, x-b.X, y-b.Y);
 }
}
let inputSent = false;
let skylight = null;
function focus(c, keyboard) {
    const pid=c.pid, win=c.window;
	const owner=c.hostTarget||c, destination=exactAXWindow(owner);
	if(!destination)throw new Error("cannot verify the exact native input window; no input was sent");
	const role=elementRole(destination), subrole=axAttribute(destination,"AXSubrole"), kind=subrole?String(subrole.js):"";
	const dialog=["AXSheet","AXDialog"].includes(role)||role==="AXWindow"&&/Dialog|FloatingWindow/.test(kind);
    // Native dialogs, panels and custom windows keep their own responder.
    // Only a standard document needs the legacy synthetic key-window preparation.
    // Send addressed events to other window kinds and report actual guard failures.
    if(dialog||role!=="AXWindow"||kind!=="AXStandardWindow"||c.hostTarget)return true;

	const previousFocus = keyboard ? axAttribute($.AXUIElementCreateApplication(pid),"AXFocusedUIElement") : null;
	const keepReceiver = previousFocus && !["AXWindow","AXSheet","AXDialog"].includes(elementRole(previousFocus)) && insideWindow(previousFocus,win);

	// Key and main are separate AppKit window roles. A background document can
	// receive text while its menu commands still have no main document to act on.
	// Set the target's main window without activating its application or raising it.
	if (keyboard) {
		const targetWindow = exactAXWindow(c);
		if (targetWindow && elementRole(targetWindow) === "AXWindow") {
			$.AXUIElementSetAttributeValue(targetWindow, $("AXMain"), $.NSNumber.numberWithBool(true));
		}
	}
	if (skylight === null) {
		try {
			$.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/SkyLight.framework").load;
			ObjC.bindFunction("SLPSPostEventRecordTo", ["int", ["void *", "void *"]]);
			ObjC.bindFunction("GetProcessForPID", ["int", ["int", "void *"]]);
			skylight = true;
		} catch (e) { skylight = false; }
	}
	if (!skylight || !win) return false;
	const psn = $.NSMutableData.dataWithLength(8);
	if ($.GetProcessForPID(pid, psn.mutableBytes) !== 0) return false;
	const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const post = bytes => {
        checkGuard(); windowRecord(c);
		let s = "";
		for (let i = 0; i < bytes.length; i += 3) {
			const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
			s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
		}
		const d = $.NSData.alloc.initWithBase64EncodedStringOptions($(s), 0);
		return $.SLPSPostEventRecordTo(psn.mutableBytes, d.bytes);
	};
	const record = (type, fill, target = win) => {
		const r = new Array(0xf8).fill(0);
		r[0x04] = 0xf8; r[0x08] = type;
		for (let i = 0; i < 4; i++) r[0x3c + i] = (target >>> (8 * i)) & 0xff;
		fill(r);
		return r;
	};
	// Changing key windows inside one process requires retiring its previous key window first.
    // All records go only to that process; the user's front application receives none.
    if (keyboard) {
        const previous=axAttribute($.AXUIElementCreateApplication(pid),"AXFocusedWindow"), id=Ref();
        if(previous && $._AXUIElementGetWindow(previous,id)===0 && Number(id[0])!==win){
            checkGuard(); if(post(record(0x0d,r=>{r[0x8a]=0x02;},Number(id[0])))!==0)return false;
            wait(FOCUS_SETTLE);
        }
    }
    checkGuard();
	const ok = post(record(0x0d, r => { r[0x8a] = 0x01; })) === 0;
	if (ok && guard && pid === guard.target && guard.front !== pid) guard.syntheticTarget = { pid, instance:c.instance };
    if(keyboard)wait(FOCUS_SETTLE);
	for (const type of [1, 2]) {checkGuard();post(record(type, r => { r[0x3a] = 0x10; for (let i = 0x20; i < 0x30; i++) r[i] = 0xff; }));}
	wait(keyboard?FOCUS_SETTLE:0.03);
	if (keepReceiver) {
		const current=axAttribute($.AXUIElementCreateApplication(pid),"AXFocusedUIElement"),settable=Ref();
		if ((!current || !$.CFEqual(previousFocus,current)) && $.AXUIElementIsAttributeSettable(previousFocus,$("AXFocused"),settable)===0 && settable[0]) {
			checkGuard();windowRecord(c);
			$.AXUIElementSetAttributeValue(previousFocus,$("AXFocused"),$.NSNumber.numberWithBool(true));
		}
	}
	return ok;
}
const TYPES = { down: 1, up: 2, rdown: 3, rup: 4, move: 5, drag: 6 };
// Background drags stay inside the addressed process. Do not synthesize a
// session-wide button hold or cover the user's windows to make a drag work.
// Modifier keys held during a pointer action: shift-click, cmd-click, option-drag, cmd-scroll.
const held = c => (c.held || []).reduce((f, h) => f | (FLAGS[h] || 0), 0);
// A press is checked before it goes out; its release always follows, to the same app, whatever changed in between.
// An app left with a button or key held stays in that state (剪映 kept its editor dimmed).
function deliverRelease(e, c, x, y) {
	verifyProcess(c);
	try { stamp(e, c, x, y); } catch (err) {
		// Only a vanished/moved window can use a process-addressed release.
		// A replaced process, remote host or renderer must never be swallowed.
		if(!err||!["exact target window disappeared before event dispatch","window geometry changed before event dispatch"].includes(String(err.message)))throw err;
		for(const field of [51,91,92])$.CGEventSetIntegerValueField(e,field,c.window);
		$.CGEventSetIntegerValueField(e,$.kCGEventTargetUnixProcessID,c.pid);
	}
	verifyProcess(c);
	inputSent = true; $.CGEventPostToPid(c.pid, e);
}
function releaseKey(e, c) {
	verifyProcess(c);
	if (c.foregroundAuthorized && Number(workspace.frontmostApplication.processIdentifier) === c.pid) { inputSent = true; $.CGEventPost($.kCGHIDEventTap, e); }
	else deliverRelease(e, c);
}
let mouseEventNumber = 0, inputPointer = null;
function mouse(c, kind, x, y, clicks, cleanup) {
	if (!cleanup) checkGuard();
	const flags = held(c);
	// Decode native NSEvent data through a C API: JXA's NSEvent.CGEvent
	// accessor yields an opaque reference that Quartz silently treats as nil.
	const data = c.nativeEvents && c.nativeEvents[kind];
	const bytes = data && $.NSData.alloc.initWithBase64EncodedStringOptions($(data),0);
	const e = bytes ? $.CGEventCreateFromData(null,bytes) : cleanup ? $.CGEventCreateMouseEvent(null,TYPES[kind],{x,y},kind[0]==="r"?1:0) : null;
	if (!e || Number($.CGEventGetType(e)) !== TYPES[kind]) throw new Error("native mouse event data is missing or invalid; no event posted");
	$.CGEventSetIntegerValueField(e, 0, ++mouseEventNumber);
	$.CGEventSetTimestamp(e, Number($.NSProcessInfo.processInfo.systemUptime)*1e9);
	$.CGEventSetLocation(e, { x, y });
	$.CGEventSetFlags(e, flags);
	$.CGEventSetIntegerValueField(e, 3, kind[0] === "r" ? 1 : 0);
	$.CGEventSetIntegerValueField(e, 7, 3);
	if (kind !== "move") $.CGEventSetIntegerValueField(e, 1, clicks || 1);
	if (cleanup) deliverRelease(e, c, x, y);
	else {
		stamp(e, c, x, y);
		// Register after validation, immediately before posting. A bridge can
		// apply the down and then throw, so the caller cannot set this later.
		if(kind==="down"||kind==="rdown")beginPointer(c,kind,x,y,clicks,"pid");
		const record=kind==="drag"?pendingPointer(c):null;
		if(record)pointerMoveStarting(record,x,y);
		inputSent = true; $.CGEventPostToPid(c.pid, e);
		if(record)pointerMoveFinished(record,x,y);
	}
	if(kind!=="move")inputPointer={x,y,button:kind[0]==="r"?"right":"left",released:kind==="up"||kind==="rup"};
}
function realPointerLocation() { return $.CGEventGetLocation($.CGEventCreate(null)); }
let realPointerSource=null;
function realPointerEvent(kind,x,y) {
 if(!realPointerSource)realPointerSource=$.CGEventSourceCreate(-1);
 if(!realPointerSource)throw new Error("cannot create private real-pointer event source");
 const event=$.CGEventCreateMouseEvent(realPointerSource,TYPES[kind],{x,y},0);
 if(!event)throw new Error("cannot create real-pointer event");return event;
}
const REAL_MOUSE_HARDWARE_TYPES=[1,2,3,4,5,6,7,22,25,26,27];
function realMouseHardwareSequence() {
 const values=REAL_MOUSE_HARDWARE_TYPES.map(type=>Number($.CGEventSourceCounterForEventType(1,type)));
 if(values.some(value=>!Number.isSafeInteger(value)||value<0||value>4294967295))throw new Error("hardware mouse sequence is unavailable; ownership is unverified");
 return values;
}
function verifyRealMouseHardware(sequence) {
 const now=realMouseHardwareSequence();
 if(!sequence||sequence.length!==now.length||now.some((value,index)=>value!==sequence[index]))throw new Error("hardware mouse input changed; real-pointer ownership is unverified");
}
function realPointerRelease(record) {
 const c=record.target;
 if(!record.positionKnown)throw new Error("real pointer location is unknown; no global release was sent");
 const e=realPointerEvent("up",record.x,record.y);
 $.CGEventSetFlags(e,0);
 // Never send a global up into a new app, process, window, button state or
 // independently moved pointer observed before dispatch. Prepare the event
 // first; slow bridge/AX calls must not follow the last quick checks. Reads
 // and global posting are not atomic: this explicit opt-in route cannot
 // guarantee ownership across an arbitrary OS scheduling interruption.
 verifyRealPointerTarget(c,record.x,record.y,true);
 verifyProcess(c);
 verifyRealMouseHardware(record.hardwareSequence);
 const p=realPointerLocation();
 if(Math.hypot(p.x-record.x,p.y-record.y)>2)throw new Error("real pointer location changed; no global release was sent");
 if(Number($.NSEvent.pressedMouseButtons)!==1)throw new Error("real mouse button state changed; release remains unverified");
 if(Number(workspace.frontmostApplication.processIdentifier)!==c.pid)throw new Error("real-pointer target is no longer in front; no global release was sent");
 inputSent=true;$.CGEventPost($.kCGHIDEventTap,e);
 inputPointer={x:record.x,y:record.y,button:"left",released:true};
}
function verifyRealPointerTarget(c,x,y,cleanup) {
 if(!cleanup)checkGuard();windowRecord(c);verifyKeyWindow(c);
 if(!c.foregroundAuthorized || Number(workspace.frontmostApplication.processIdentifier)!==c.pid)throw new Error("authorized real-pointer window is no longer in front");
 // Window-list rectangles include click-through system overlays (such as Dock's
 // full-screen window). Ask the system which AX element actually occupies the point.
 const hit=Ref(),pid=Ref(),number=Ref();
 if($.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(),x,y,hit)!==0)throw new Error("cannot identify the real-pointer destination");
 const el=ObjC.castRefToObject(hit[0]),window=axAttribute(el,"AXWindow")||el;
 if($.AXUIElementGetPid(el,pid)!==0||Number(pid[0])!==c.pid||$._AXUIElementGetWindow(window,number)!==0||Number(number[0])!==c.window)throw new Error("real-pointer destination is covered or belongs to another window; no input sent there");
}
function realPointerDrag(c) {
 verifyRealPointerTarget(c,c.x,c.y);verifyRealPointerTarget(c,c.x2,c.y2);
 if(Number($.NSEvent.pressedMouseButtons)!==0)throw new Error("a real mouse button is already held; drag was not started");
 const hardwareSequence=Object.freeze(realMouseHardwareSequence());
 let last=null;
 const post=(kind,x,y)=>{
  const e=realPointerEvent(kind,x,y);$.CGEventSetFlags(e,held(c));$.CGEventSetIntegerValueField(e,1,1);
  verifyRealPointerTarget(c,x,y);
  verifyProcess(c);verifyRealMouseHardware(hardwareSequence);
  if(last){const p=realPointerLocation();if(Math.hypot(p.x-last.x,p.y-last.y)>2)throw new Error("real mouse moved independently; drag stopped");}
  if(Number($.NSEvent.pressedMouseButtons)!==(kind==="down"?0:1))throw new Error("real mouse button state changed; drag stopped");
  if(Number(workspace.frontmostApplication.processIdentifier)!==c.pid)throw new Error("real-pointer target is no longer in front; no global event was sent");
  const record=kind==="down"?beginPointer(c,kind,x,y,1,"real"):pendingPointer(c);
  if(kind==="down")record.hardwareSequence=hardwareSequence;
  if(kind!=="down")pointerMoveStarting(record,x,y);
  inputSent=true;$.CGEventPost($.kCGHIDEventTap,e);
  if(kind!=="down")pointerMoveFinished(record,x,y);
  last={x,y};
 };
 pointerPair(()=>{
  post("down",c.x,c.y);wait(0.05);
  const steps=Math.min(96,Math.max(8,Math.round(Math.hypot(c.x2-c.x,c.y2-c.y)/12)));
  for(let i=1;i<=steps;i++){post("drag",c.x+(c.x2-c.x)*i/steps,c.y+(c.y2-c.y)*i/steps);wait(0.016);}
 });
 return {dispatched:true,verified:false,pointerMode:"real_pointer"};
}
// Keyboard text is admitted only for the observed receiver in the exact window.
ObjC.bindFunction("_AXUIElementGetWindow", ["int", ["id", "unsigned int *"]]);
ObjC.bindFunction("AXUIElementGetPid", ["int", ["id", "int *"]]);
ObjC.bindFunction("AXValueGetValue", ["bool", ["id", "int", "void *"]]);
ObjC.bindFunction("CGEventKeyboardSetUnicodeString", ["void", ["void *", "unsigned long", "void *"]]);
function axAttribute(el, name) { const value=Ref(); return $.AXUIElementCopyAttributeValue(el,$(name),value)===0 ? ObjC.castRefToObject(value[0]) : null; }
function axNumbers(value, type) {
 const data=$.NSMutableData.dataWithLength(16);
 if (!value || !$.AXValueGetValue(value,type,data.mutableBytes)) throw new Error("cannot verify keyboard receiver geometry or selection");
 const encoded=String(data.base64EncodedStringWithOptions(0).js), alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", bytes=[];
 let bits=0, count=0;
 for(const ch of encoded){const n=alphabet.indexOf(ch);if(n<0)break;bits=(bits<<6)|n;count+=6;if(count>=8){count-=8;bytes.push((bits>>count)&255);}}
 return new DataView(new Uint8Array(bytes).buffer);
}
// A sheet on a sheet (Go to Folder in an open panel) reports the outer window: an element is in a window when
// it or any element it sits in belongs to that window.
function insideWindow(el, window) {
 for(let i=0;el&&i<64;i++){const n=Ref();if($._AXUIElementGetWindow(el,n)===0&&Number(n[0])===window)return true;el=axAttribute(el,"AXParent");}
 return false;
}
function verifyKeyWindow(c) {
 const owner=c.hostTarget||c, app=$.AXUIElementCreateApplication(owner.pid), id=Ref();
 const window=axAttribute(app,"AXFocusedWindow")||axAttribute(app,"AXMainWindow");
 const known=window&&$._AXUIElementGetWindow(window,id)===0;
 if(known&&Number(id[0])===owner.window)return;
 const receiver=axAttribute(app,"AXFocusedUIElement");
 if(receiver&&insideWindow(receiver,owner.window))return;
 // A positively reported different window is unsafe; missing AX focus is not.
 let otherReceiver=false;
 for(let el=receiver,i=0;el&&i<64;i++,el=axAttribute(el,"AXParent")){const n=Ref();if($._AXUIElementGetWindow(el,n)===0)otherReceiver=true;}
 if(known||otherReceiver)throw new Error("app keyboard focus is not in the exact requested window");
}
// Missing AX focus is common in Qt/canvas apps. Only positively identified
// payment receivers are refused; exact process/window routing is checked separately.
function rejectKnownPaymentReceiver(c) {
 const owner=c.hostTarget||c, receiver=axAttribute($.AXUIElementCreateApplication(owner.pid),"AXFocusedUIElement");
 if(!receiver)return;
 const metadata=["AXIdentifier","AXAutocomplete","AXTitle","AXDescription","AXHelp"].map(name=>axAttribute(receiver,name)).filter(Boolean).map(value=>String(value.js)).join(" ");
 if(/cc-(?:number|csc|exp)|credit[-_ ]?card|卡号|信用卡|安全码|有效期|到期日|card[ _-]*(?:number|no\b|expiry|expiration)|\b(?:cvv2?|cvc2?|expiry|expiration date)\b/i.test(metadata))throw new Error("payment fields cannot receive keyboard input");
}
const retainedReceivers=new Map();
function exactAXWindow(c) {
 const roots=[],windows=axAttribute($.AXUIElementCreateApplication(c.pid),"AXWindows");
 for(let i=0;windows&&i<windows.count;i++)roots.push(windows.objectAtIndex(i));
 let root=null;
 for(let i=0;i<roots.length;i++){
  if(i>=128)throw new Error("too many window sheets while retaining text receivers");
  const w=roots[i],number=Ref();if($._AXUIElementGetWindow(w,number)===0&&Number(number[0])===c.window){if(root)throw new Error("text window identity is ambiguous");root=w;}
  const children=axAttribute(w,"AXChildren");for(let j=0;children&&j<children.count;j++){const child=children.objectAtIndex(j),role=axAttribute(child,"AXRole");if(role&&String(role.js)==="AXSheet")roots.push(child);}
 }
 return root;
}
function retainReceivers(c) {
 windowRecord(c);
 // A focused receiver is unique by the application's own AX focus, so bind it
 // directly when all observed identity facts agree. No file-list traversal.
 if(c.receivers.length===1){
  const wanted=c.receivers[0],el=axAttribute($.AXUIElementCreateApplication(c.pid),"AXFocusedUIElement");
  if(el&&insideWindow(el,c.window))try{
   const role=axAttribute(el,"AXRole"),identifier=axAttribute(el,"AXIdentifier"),value=axAttribute(el,"AXValue");
   const p=axNumbers(axAttribute(el,"AXPosition"),1),z=axNumbers(axAttribute(el,"AXSize"),2),b=wanted.bounds;
   if(role&&String(role.js)===wanted.axRole&&(!wanted.stableId||String(identifier?identifier.js:"")===wanted.stableId)&&(wanted.value===null||String(value?value.js:"")===wanted.value)&&Math.abs(p.getFloat64(0,true)-b.x)<=1&&Math.abs(p.getFloat64(8,true)-b.y)<=1&&Math.abs(z.getFloat64(0,true)-b.width)<=1&&Math.abs(z.getFloat64(8,true)-b.height)<=1){
    retainedReceivers.set(wanted.token,{el,pid:c.pid,instance:c.instance,window:c.window});
    while(retainedReceivers.size>1024)retainedReceivers.delete(retainedReceivers.keys().next().value);
    return {retained:[wanted.token]};
   }
  }catch(e){/* fall back to exact-window matching */}
 }
 const root=exactAXWindow(c);if(!root)return {retained:[]};
 const pending=[root],matches=new Map(c.receivers.map(r=>[r.token,[]])),roles=new Set(c.receivers.map(r=>r.axRole));
 for(let i=0;i<pending.length;i++){
  // Receiver binding must not break paginated reading of a large window. When
  // uniqueness cannot be established, leave typing unbound and refuse it later.
  if(i>=2000||deadline&&Date.now()>=deadline)return {retained:[],incomplete:true};
  const el=pending[i],role=axAttribute(el,"AXRole");
  if(role&&roles.has(String(role.js))){
   try{
    const p=axNumbers(axAttribute(el,"AXPosition"),1),z=axNumbers(axAttribute(el,"AXSize"),2),identifier=axAttribute(el,"AXIdentifier"),value=axAttribute(el,"AXValue");
    for(const wanted of c.receivers){
     const b=wanted.bounds;
     if(wanted.axRole!==String(role.js)||wanted.stableId&&String(identifier?identifier.js:"")!==wanted.stableId||wanted.value!==null&&String(value?value.js:"")!==wanted.value)continue;
     if(Math.abs(p.getFloat64(0,true)-b.x)>1||Math.abs(p.getFloat64(8,true)-b.y)>1||Math.abs(z.getFloat64(0,true)-b.width)>1||Math.abs(z.getFloat64(8,true)-b.height)>1)continue;
     matches.get(wanted.token).push(el);
    }
   }catch(e){/* a disappearing node cannot be retained */}
  }
  const children=axAttribute(el,"AXChildren");for(let j=0;children&&j<children.count;j++)pending.push(children.objectAtIndex(j));
 }
 windowRecord(c);
 const retained=[];
 for(const wanted of c.receivers){const found=matches.get(wanted.token);if(found.length===1){retainedReceivers.set(wanted.token,{el:found[0],pid:c.pid,instance:c.instance,window:c.window});retained.push(wanted.token);}}
 while(retainedReceivers.size>1024)retainedReceivers.delete(retainedReceivers.keys().next().value);
 return {retained};
}
function focusedReceiver(c) {
 c=c.hostTarget?{...c.hostTarget,receiver:c.receiver}:c;
 const app=$.AXUIElementCreateApplication(c.pid),direct=axAttribute(app,"AXFocusedUIElement");
 if(direct)return direct;
 // WKWebView can expose focused fields in AXChildren while omitting the
 // application's AXFocusedUIElement. Search only the exact window, never
 // choose an unfocused field or guess among several focused receivers.
 if(!c.receiver || !c.receiver.axRole) return null;
 const windows=axAttribute(app,"AXWindows"),roots=[];
 for(let i=0;windows&&i<windows.count;i++)roots.push(windows.objectAtIndex(i));
 let root=null;
 for(let i=0;i<roots.length;i++){
  if(i>=128)throw new Error("too many window sheets while checking text focus");
  const w=roots[i],number=Ref();if($._AXUIElementGetWindow(w,number)===0&&Number(number[0])===c.window){if(root)throw new Error("text window identity is ambiguous");root=w;}
  const children=axAttribute(w,"AXChildren");for(let j=0;children&&j<children.count;j++){const child=children.objectAtIndex(j),role=axAttribute(child,"AXRole");if(role&&String(role.js)==="AXSheet")roots.push(child);}
 }
 if(!root)return null;
 const pending=[root],matches=[];
 for(let i=0;i<pending.length;i++){
  if(i>=2000)throw new Error("focused receiver search is incomplete; no input was sent");
  if(i%32===0)checkGuard();
  const el=pending[i],role=axAttribute(el,"AXRole"),focused=axAttribute(el,"AXFocused");
  if(role&&String(role.js)===c.receiver.axRole&&focused&&Boolean(focused.js))matches.push(el);
  const children=axAttribute(el,"AXChildren");for(let j=0;children&&j<children.count;j++)pending.push(children.objectAtIndex(j));
 }
 if(matches.length>1)throw new Error("several focused text receivers; no input was sent");
 return matches[0]||null;
}
function verifyReceiver(c, checkText = true) {
 const el=focusedReceiver(c), wanted=c.receiver;
 const owner=c.hostTarget||c;
 if(!wanted)throw new Error("no explicitly observed keyboard receiver");
 if(!el)throw new Error("app does not expose its current keyboard receiver");
 const retained=retainedReceivers.get(wanted.token);
 if(!retained||retained.pid!==owner.pid||retained.instance!==owner.instance||retained.window!==owner.window||!$.CFEqual(retained.el,el))throw new Error("observed text receiver was replaced or expired; read again before typing");
 if(!insideWindow(el,owner.window))throw new Error("keyboard receiver belongs to another window");
 const p=axNumbers(axAttribute(el,"AXPosition"),1), z=axNumbers(axAttribute(el,"AXSize"),2), b=wanted.bounds;
 if(Math.abs(p.getFloat64(0,true)-b.x)>1 || Math.abs(p.getFloat64(8,true)-b.y)>1 || Math.abs(z.getFloat64(0,true)-b.width)>1 || Math.abs(z.getFloat64(8,true)-b.height)>1)throw new Error("keyboard receiver moved or changed");
 const identifier=axAttribute(el,"AXIdentifier"), value=axAttribute(el,"AXValue");
 if(wanted.stableId && String(identifier ? identifier.js : "")!==wanted.stableId)throw new Error("keyboard receiver identity changed");
 if(checkText && wanted.value!==null && String(value ? value.js : "")!==wanted.value)throw new Error("keyboard receiver text changed before typing");
 if(checkText && wanted.range){const r=axNumbers(axAttribute(el,"AXSelectedTextRange"),4);const start=r.getUint32(0,true)+r.getUint32(4,true)*4294967296,length=r.getUint32(8,true)+r.getUint32(12,true)*4294967296;if(start!==wanted.range[0] || length!==wanted.range[1]-wanted.range[0])throw new Error("text selection was not applied; no replacement was typed");}
 return el;
}
const KEYS = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46, ".": 47, "\x60": 50,
	Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
	F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111 };
const FLAGS = { Meta: 0x100000, Shift: 0x20000, Ctrl: 0x40000, Alt: 0x80000 };
// Prefer the app's enabled menu equivalent. Other shortcuts go to its process
// serial number, with explicit modifier transitions. Never post background keys
// into the system's HID queue or temporarily make the target the front process.
let menuShortcutReady = null;
function shortcutMenu(c, code, flags) {
	if (!(flags & (FLAGS.Meta | FLAGS.Ctrl | FLAGS.Alt))) return false;
	// Dialogs handle accelerators before the application's menu bar. For example,
	// a save panel's Go to Folder can share a key with a disabled editor command.
	const root = exactAXWindow(c.hostTarget||c), subrole = root && axAttribute(root, "AXSubrole");
	if (root && (["AXSheet", "AXDialog"].includes(elementRole(root)) || subrole && /Dialog|FloatingWindow/.test(String(subrole.js)))) return false;
	const bar = axAttribute($.AXUIElementCreateApplication(c.pid), "AXMenuBar");
	if (!bar) return false;
	const pending = [bar];
	// Reading AXChildren can open and validate a menu. Finish one menu before
	// inspecting the next, so an early match never opens unrelated menus.
	for (let visited = 0; pending.length && visited < 2000; visited++) {
		const el = pending.pop(), role = elementRole(el);
		if (role === "AXMenuItem") {
			const v = axAttribute(el, "AXMenuItemCmdVirtualKey"), ch = axAttribute(el, "AXMenuItemCmdChar");
			const key = v ? Number(v.js) : ch && KEYS[String(ch.js).toLowerCase()];
			const m = axAttribute(el, "AXMenuItemCmdModifiers"), mods = m ? Number(m.js) : 0;
			const mask = (mods & 8 ? 0 : FLAGS.Meta) | (mods & 1 ? FLAGS.Shift : 0) | (mods & 2 ? FLAGS.Alt : 0) | (mods & 4 ? FLAGS.Ctrl : 0);
			if (key === code && mask === flags && (v || ch && String(ch.js))) {
				const enabled = axAttribute(el, "AXEnabled");
				if (enabled && !enabled.js) throw new Error("menu shortcut is disabled; no key was sent");
				checkGuard(); windowRecord(c); verifyKeyWindow(c);rejectKnownPaymentReceiver(c);
				inputSent = true;
				const error = $.AXUIElementPerformAction(el, $("AXPress"));
				if (error !== 0) throw new Error("menu shortcut was not accepted (accessibility error " + error + ")");
				return true;
			}
		}
		const children = axAttribute(el, "AXChildren");
		for (let j = children ? children.count - 1 : -1; j >= 0; j--) pending.push(children.objectAtIndex(j));
	}
	return false;
}
function postMenuShortcut(c, code, flags) {
	if (shortcutMenu(c, code, flags)) return true;
	// Return is a keyboard event. AXConfirm only ends a field's editing in
	// some native panels; treating it as Return can silently leave the panel open.

	if (menuShortcutReady === null) {
		try {
			ObjC.bindFunction("GetProcessForPID", ["int", ["int", "void *"]]);
			ObjC.bindFunction("CGEventPostToPSN", ["void", ["void *", "void *"]]);
			menuShortcutReady = true;
		} catch (e) { menuShortcutReady = false; }
	}
	if (!menuShortcutReady) throw new Error("menu shortcut support did not load");
	if (!c.window) throw new Error("menu shortcut has no window");
	const target = $.NSMutableData.dataWithLength(8);
	if ($.GetProcessForPID(c.pid, target.mutableBytes) !== 0) throw new Error("cannot address the target process");
	const modifiers = [[FLAGS.Meta, 55], [FLAGS.Shift, 56], [FLAGS.Ctrl, 59], [FLAGS.Alt, 58]].filter(pair => flags & pair[0]);
	const introduced = [];
	const post = (key, down, mask, modifier, cleanup, beforePost, original) => {
		if (!cleanup) { checkGuard(); windowRecord(c); verifyKeyWindow(c);rejectKnownPaymentReceiver(c); }
		const native=!modifier&&c.nativeKeys&&c.nativeKeys[down?"down":"up"];
		const e = native?$.CGEventCreateFromData(null,$.NSData.alloc.initWithBase64EncodedStringOptions($(native),0)):$.CGEventCreateKeyboardEvent(null, key, down);
		if (modifier) $.CGEventSetType(e, 12);
		$.CGEventSetFlags(e, mask);
		// A key can close its dialog. Its release must still reach the same process.
		if (!cleanup) stamp(e, c);
		verifyProcess(original||c);
		if(beforePost)beforePost();
		inputSent = true; $.CGEventPostToPSN(target.mutableBytes, e);
	};
	let mask = 0, primary = null;
	try {
		for (const pair of modifiers) {
			const next=mask|pair[0];
			post(pair[1],true,next,true,false,()=>{introduced.push({record:beginKey(c,pair[1],true),key:pair[1],flag:pair[0],modifier:true});});
			mask=next;
		}
		post(code,true,flags,false,false,()=>{introduced.push({record:beginKey(c,code,false),key:code,flag:0,modifier:false});});
		wait(0.02);
	} catch(error){primary=error;throw error;
	} finally {
		let pendingMask=introduced.reduce((value,item)=>value|item.flag,0);const errors=[];
		for(const item of introduced.slice().reverse()){
			pendingMask&=~item.flag;
			try{post(item.key,false,pendingMask,item.modifier,true,null,item.record.target);finishKey(item.record);}
			catch(error){inputKeyReleaseFailed=true;errors.push(error);}
		}
		if(errors.length)throw cleanupError(primary,errors);
	}
	return true;
}
// Paste: the user's clipboard is saved whole (every item, every type) and put back after the paste.
const pasteboard = $.NSPasteboard.generalPasteboard;
let saved = null, savedCount = null, savedToken = null, clipRestoreFailure = null, partialSetCount = null;
function clipSave() {
	const items = [], list = pasteboard.pasteboardItems;
	for (let i = 0; list && i < list.count; i++) {
		const item = list.objectAtIndex(i), types = item.types, kept = [];
		for (let j = 0; j < types.count; j++) {
			const type = types.objectAtIndex(j), data = item.dataForType(type);
			if(!data||data.isNil())throw new Error("original clipboard representation is unavailable; clipboard left untouched");
			kept.push([type, data]);
		}
		// UTF-16 text is derived by the system from UTF-8 text; saving it would add a wrong copy on restore.
		const utf8 = kept.some(([t]) => t.js === "public.utf8-plain-text");
		items.push(utf8 ? kept.filter(([t]) => !/^public\.utf16(-external)?-plain-text$/.test(t.js)) : kept);
	}
	return items;
}
function clipSet(c) {
 if(clipRestoreFailure)throw clipRestoreFailure;
 if(saved)throw new Error("a paste is already in progress");
 if(Number(pasteboard.changeCount)!==c.changeCount)throw new Error("clipboard changed before paste; left untouched");
 // Prepare the representations before taking ownership. A refused text/HTML
 // representation must not clear the user's original clipboard.
 const item=$.NSPasteboardItem.alloc.init;
 if(c.html&&item.setStringForType($('<meta charset="utf-8">'+c.html),"public.html")!==true)throw new Error("temporary HTML clipboard representation was refused");
 if(item.setStringForType($(c.text),"public.utf8-plain-text")!==true)throw new Error("temporary text clipboard representation was refused");
 const originals=clipSave();
 if(Number(pasteboard.changeCount)!==c.changeCount)throw new Error("clipboard changed while preparing paste; left untouched");
 saved=originals;savedToken=c.token;savedCount=null;partialSetCount=null;
 try {
  // Use the clear operation's own returned generation. Reading changeCount
  // afterwards could accidentally adopt a copy made by the user in between.
  const cleared=Number(pasteboard.clearContents);
  if(!Number.isSafeInteger(cleared)||cleared<0)throw new Error("clipboard clear ownership could not be verified");
  savedCount=cleared;partialSetCount=cleared;
 }catch(error){clipRestoreFailure=error;throw error;}
 if(Number(pasteboard.changeCount)!==savedCount){saved=null;savedCount=null;savedToken=null;partialSetCount=null;throw new Error("clipboard changed after clear; new clipboard left untouched");}
 // A missing marker after our own failed setup is recoverable only by this
 // still-live sender, with its saved originals and exact clear generation.
 if(item.setStringForType($(JSON.stringify({token:savedToken,changeCount:savedCount})),"org.mountains.clipboard-transaction")!==true)throw new Error("temporary clipboard ownership marker was refused");
 const objects=$.NSMutableArray.array;objects.addObject(item);
 if(Number(pasteboard.changeCount)!==savedCount){saved=null;savedCount=null;savedToken=null;partialSetCount=null;throw new Error("clipboard changed before temporary write; new clipboard left untouched");}
 let written;
 try{written=pasteboard.writeObjects(objects);}
 catch(error){
  // A throwing write may already have published. If ownership changed inside
  // it, we cannot attribute that change to the user or recover over it.
  try{if(Number(pasteboard.changeCount)!==savedCount)clipRestoreFailure=new Error(String(error.message||error)+"; clipboard ownership changed inside the write; restoration remains unverified");}
  catch(observation){clipRestoreFailure=new Error(String(error.message||error)+"; clipboard ownership after the write is unreadable; restoration remains unverified");}
  throw clipRestoreFailure||error;
 }
 let observed;
 try{observed=Number(pasteboard.changeCount);}catch(error){clipRestoreFailure=error;throw error;}
 if(observed!==savedCount){clipRestoreFailure=new Error("clipboard ownership changed inside the temporary write; restoration remains unverified");throw clipRestoreFailure;}
 if(written!==true)throw new Error("temporary clipboard write was refused; original backup retained");
 partialSetCount=null;
 return {changeCount:savedCount};
}
function clipRestore(c) {
 // A failed write may already have cleared our marker. Never reinterpret
 // that self-caused change on a later EOF as a new user clipboard.
 if(clipRestoreFailure)throw clipRestoreFailure;
 const local=saved!==null,localPartial=local&&partialSetCount!==null&&partialSetCount===savedCount;
 if(local&&c&&c.token&&c.token!==savedToken)throw new Error("clipboard restoration transaction changed; original backup retained");
 if(!local&&c&&c.items&&(typeof c.token!=="string"||!c.token))throw new Error("external clipboard recovery requires its original transaction marker");
 // Private originals and clear count are authoritative for our live backup.
 // Caller-provided items/count must never create or replace that authority.
 const items = local?saved:c && c.items ? c.items.map(item => item.map(pair => [$(pair[0]), $.NSData.alloc.initWithBase64EncodedStringOptions($(pair[1]), 0)])) : null;
 let count = local?savedCount:c && typeof c.changeCount === "number" ? c.changeCount : null;
 const token=local?savedToken:c&&c.token;
 if(!items)return {restored:false,userChanged:false};
 if(token&&!localPartial) {
  const marker=pasteboard.stringForType("org.mountains.clipboard-transaction");let receipt=null;
  try{receipt=marker&&!marker.isNil()?JSON.parse(marker.js):null;}catch(e){}
  if(!receipt || receipt.token!==token || !Number.isSafeInteger(receipt.changeCount)){
   if(local){
    let current;try{current=Number(pasteboard.changeCount);}catch(error){clipRestoreFailure=error;throw error;}
    if(current===savedCount){clipRestoreFailure=new Error("clipboard marker is invalid at our own generation; restoration remains unverified");throw clipRestoreFailure;}
   }
   saved=null;savedCount=null;savedToken=null;partialSetCount=null;return {restored:false,userChanged:true};
  }
  if(typeof count==="number"&&count!==receipt.changeCount){
   const error=new Error("clipboard recovery generation differs from its original marker; clipboard left untouched");if(local)clipRestoreFailure=error;throw error;
  }
  count=receipt.changeCount;
 }
 if (!items || count === null) return { restored: false, userChanged: false };
 if (Number(pasteboard.changeCount) !== count) { saved = null; savedCount = null;savedToken=null;partialSetCount=null; return { restored: false, userChanged: true }; }
 try {
  // Prepare the original representations before clearing anything. Both
  // AppKit methods return BOOL; a refusal is not a successful restoration.
  const objects = $.NSMutableArray.array;
  for (const kept of items) {
   const item = $.NSPasteboardItem.alloc.init;
   for (const [type, data] of kept) if(item.setDataForType(data, type)!==true)throw new Error("original clipboard representation could not be prepared; restoration remains unverified");
   objects.addObject(item);
  }
  if(Number(pasteboard.changeCount)!==count){saved=null;savedCount=null;savedToken=null;partialSetCount=null;return {restored:false,userChanged:true};}
  const restoredClear=Number(pasteboard.clearContents);
  if(!Number.isSafeInteger(restoredClear)||restoredClear<0||Number(pasteboard.changeCount)!==restoredClear)throw new Error("clipboard ownership changed while restoring; restoration remains unverified");
  if(objects.count&&pasteboard.writeObjects(objects)!==true)throw new Error("clipboard write-back was refused; restoration remains unverified");
  if(Number(pasteboard.changeCount)!==restoredClear)throw new Error("clipboard ownership changed inside the restore write; restoration remains unverified");
 }catch(error){clipRestoreFailure=error;throw error;}
 saved = null; savedCount = null;savedToken=null;partialSetCount=null;
 return { restored: true, userChanged: false };
}
// Observe activation. A dialog or the target app taking the keyboard is not the user.
// Restore an unsolicited activation, but retain it as a failed background constraint.
// The user's own hardware input, while the target is front,
// does not cut this action short and does not end the turn. The result tells the model
// they changed the app, and to read the window again.
let guard = null, deadline = 0;
let monitorTimer = null, monitorFocus = null;
function targetInScope(pid){return !!guard&&(pid===guard.target||typeof scopeTargets!=="undefined"&&scopeTargets.has(pid));}
function monitorState() {
	if (!guard) return;
	const focused = focusedElement();
	if (Boolean(monitorFocus) !== Boolean(focused) || monitorFocus && focused && !$.CFEqual(monitorFocus, focused)) {
		if(guard && !guard.byUser && (Boolean(focused)!==Boolean(guard.typing) || focused && guard.typing && !$.CFEqual(focused,guard.typing))) {
			const front=Number(workspace.frontmostApplication.processIdentifier);
			const inTarget=focused&&(targetInScope(elementPid(focused))||focusInTargetSheet(focused));
			if(focused&&!inTarget&&front!==guard.target&&(front===guard.front||userInputSince(guard.observedAt))){
				// The user's own app may change fields, Tab, open its own panel,
				// or switch applications. Follow that destination without restoring it.
				guard.front=front;guard.typing=focused;guard.observedAt=Date.now();
			}else{
				guard.focusChanged=true;
			}
		}
	}
	monitorFocus = focused;
}
// Seconds since the user's own last input: the HID state counts the hardware only, not events Mountains sends to an app.
const USER_INPUT = [1, 3, 10, 12, 22, 25];
function userInputSince(t) { return Math.min(...USER_INPUT.map(type => $.CGEventSourceSecondsSinceLastEventType(1, type))) * 1000 < Date.now() - t; }
// Hardware mouse-down plus an unchanged pointer position over this app's
// actual topmost window is positive click evidence. Unrelated typing is not.
function userClickedTargetSince(t){
 if(!guard||!guard.target)return false;
 const age=Math.min(...[1,3,25].map(type=>$.CGEventSourceSecondsSinceLastEventType(1,type)))*1000;
 if(age>100||age>=Date.now()-t||$.CGEventSourceSecondsSinceLastEventType(1,5)*1000<age)return false;
 const point=$.CGEventGetLocation($.CGEventCreate(null)),windows=ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0));
 for(let i=0;i<windows.count;i++){const w=ObjC.deepUnwrap(windows.objectAtIndex(i)),b=w.kCGWindowBounds;if(w.kCGWindowLayer!==0||w.kCGWindowOwnerPID===Number($.NSProcessInfo.processInfo.processIdentifier))continue;if(point.x>=b.X&&point.x<b.X+b.Width&&point.y>=b.Y&&point.y<b.Y+b.Height)return targetInScope(w.kCGWindowOwnerPID);}
 return false;
}
function targetName() {
	try {
		const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(guard.target);
		if (!app || app.isNil()) return "this app";
		const name = app.localizedName;
		const text = name && !name.isNil() ? String(name.js || "") : "";
		return text || "this app";
	} catch (e) { return "this app"; }
}
function focusedElement() {
	try {
		const focused = Ref();
		if ($.AXUIElementCopyAttributeValue($.AXUIElementCreateSystemWide(), $("AXFocusedUIElement"), focused) !== 0) return null;
		return ObjC.castRefToObject(focused[0]);
	} catch (e) { return null; }
}
function elementPid(el) {
	try { const pid = Ref(); return el && $.AXUIElementGetPid(el, pid) === 0 ? Number(pid[0]) : 0; } catch (e) { return 0; }
}
function elementRole(el) {
	const role = axAttribute(el, "AXRole");
	return role ? String(role.js) : "";
}
// A sheet of the app we are driving (Save, Go to Folder) is the dialog this action opened.
function focusInTargetSheet(el) {
	if (!el || !guard || !guard.target) return false;
	let current = el;
	for (let i = 0; current && i < 32; i++) {
		const role = elementRole(current);
		if (role === "AXSheet" || role === "AXDialog") {
			if (elementPid(current) === guard.target) return true;
			const parent = axAttribute(current, "AXParent");
			if (parent && elementPid(parent) === guard.target) return true;
			return false;
		}
		if (role === "AXWindow" || role === "AXApplication") break;
		current = axAttribute(current, "AXParent");
	}
	const windows = axAttribute($.AXUIElementCreateApplication(guard.target), "AXWindows"), pending = [];
	for (let i = 0; windows && i < windows.count; i++) pending.push(windows.objectAtIndex(i));
	for (let i = 0; i < pending.length && i < 128; i++) {
		const w = pending[i], role = elementRole(w);
		if (role === "AXSheet" || role === "AXDialog") {
			const n = Ref();
			if ($._AXUIElementGetWindow(w, n) === 0 && insideWindow(el, Number(n[0]))) return true;
		}
		const children = axAttribute(w, "AXChildren");
		for (let j = 0; children && j < children.count; j++) {
			const child = children.objectAtIndex(j), childRole = elementRole(child);
			if (childRole === "AXSheet" || childRole === "AXDialog") pending.push(child);
		}
	}
	return false;
}
function foregroundTypingFocus() {
	return axAttribute($.AXUIElementCreateApplication(Number(workspace.frontmostApplication.processIdentifier)), "AXFocusedUIElement");
}
function retireSyntheticFocus(pid) {
	$.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/SkyLight.framework").load;
	ObjC.bindFunction("GetProcessForPID", ["int", ["int", "void *"]]);
	ObjC.bindFunction("SLPSPostEventRecordTo", ["int", ["void *", "void *"]]);
	const psn = $.NSMutableData.dataWithLength(8);
	if ($.GetProcessForPID(pid, psn.mutableBytes) !== 0) return;
	const application = $.AXUIElementCreateApplication(pid);
	const window = axAttribute(application, "AXFocusedWindow") || axAttribute(application, "AXMainWindow"), number = Ref();
	let id = 0;
	if (window && $._AXUIElementGetWindow(window, number) === 0) id = Number(number[0]);
	const data = new Array(0xf8).fill(0); data[4] = 0xf8; data[8] = 0x0d; data[0x8a] = 2;
	for (let i = 0; i < 4; i++) data[0x3c+i] = (id >>> (8*i)) & 0xff;
	const encoded = $(data.map(n => String.fromCharCode(n)).join("")).dataUsingEncoding($.NSISOLatin1StringEncoding);
	$.SLPSPostEventRecordTo(psn.mutableBytes, encoded.bytes);
	wait(0.06);
}
// A background dialog may own its app's responder, but must not own the user's global keyboard focus.
function restoreTypingFocus() {
	if(typeof phasedInput!=="undefined"&&phasedInput&&!globalFinishAllowed)return;
	if (!guard || guard.byUser || guard.attributionUnknown) return;
	const now = focusedElement();
	if (!now && !guard.typing || now && guard.typing && $.CFEqual(guard.typing, now)) return;
	guard.focusChanged = true;
	if (elementPid(now) === guard.target && guard.front !== guard.target) retireSyntheticFocus(guard.target);
	if (guard.typing) try { $.AXUIElementSetAttributeValue(guard.typing, $("AXFocused"), $.NSNumber.numberWithBool(true)); } catch (e) {}

}
// The user working in some other app is fine: events are posted to the target process, as Codex does.
// Being "in" the target means that app is frontmost. A background action focuses one of its elements,
// so the focused element's process is not evidence that the user took over.
function inTarget() {
	if (!guard || !guard.target) return false;
	return targetInScope(Number(workspace.frontmostApplication.processIdentifier));
}
// The app we are driving may activate itself or move the keyboard into a sheet it opened.
// That is not the user. Put their previous app back, at most a few times a second, and keep going.
function restoreFront() {
	if (!guard || !guard.front || guard.holdFront || guard.byUser || guard.attributionUnknown) return;
	const current = Number(workspace.frontmostApplication.processIdentifier);
	if (current === guard.front) return;
	const now = Date.now();
	// Follow a human switch to another app. Returning to the action's initial app
	// would steal the foreground from the user we are meant to leave alone.
	if (!targetInScope(current) && userInputSince(guard.observedAt)) {
		guard.front = current;
		guard.typing = focusedElement();
		guard.observedAt = now;
		return;
	}
	guard.frontChanged = true;
	if(typeof phasedInput!=="undefined"&&phasedInput&&!globalFinishAllowed)return;
	if (guard.restoredAt && now - guard.restoredAt < 300) return;
	guard.restoredAt = now;
	const previous = $.NSRunningApplication.runningApplicationWithProcessIdentifier(guard.front);
	if (!previous || previous.isNil()) return;
	previous.activateWithOptions(1 << 1);
}
function observeActivation() {
	if (!guard || guard.holdFront || guard.byUser || guard.attributionUnknown) return;
	const current = Number(workspace.frontmostApplication.processIdentifier);
	if (current === guard.front) return;
	if(!targetInScope(current)&&userInputSince(guard.observedAt)){
		guard.front=current;guard.typing=focusedElement();guard.observedAt=Date.now();return;
	}
	// Do not reset the input clock before checking it: that hid an intentional
	// user switch into the target app and immediately pulled them back out.
	if (targetInScope(current)) {
		guard.frontChanged = true;
		if (!guard.jumpedAt) guard.jumpedAt = Date.now();
		if (userClickedTargetSince(guard.observedAt)) {guard.byUser=true;return;}
	}
	restoreFront();
}
function finishGuard() {
	if(!guard)return {unchanged:false,byUser:false,frontChanged:false,focusChanged:false,restored:false,attributionUnknown:true,
		reason:"original input guard is unavailable after helper shutdown; foreground and keyboard focus could not be verified"};
	monitorState();
	observeActivation();
	const byUser = !!(guard && (userTookTarget() || guard.byUser));
	const app = byUser && guard ? targetName() : "";
	const observeOnly=typeof phasedInput!=="undefined"&&phasedInput&&!globalFinishAllowed;
	if (guard && !byUser && !guard.attributionUnknown&&!observeOnly) {
		for (let i = 0; i < 3 && Number(workspace.frontmostApplication.processIdentifier) !== guard.front; i++) {
			guard.restoredAt = 0;
			restoreFront();
			wait(0.06);
		}
		restoreTypingFocus();
	}
	const frontRestored = !!(guard && Number(workspace.frontmostApplication.processIdentifier) === guard.front);
	const focused = focusedElement();
	const focusRestored = !!(guard && (!guard.typing && !focused || guard.typing && focused && $.CFEqual(guard.typing, focused)));
	const restored = !!(guard && !guard.attributionUnknown && frontRestored && focusRestored);
	const unchanged = !!(guard && !byUser && restored && !guard.frontChanged && !guard.focusChanged && !guard.attributionUnknown);
	const notice = { unchanged, byUser, frontChanged: !!(guard && guard.frontChanged),
		focusChanged: !!(guard && guard.focusChanged), restored, attributionUnknown:!!(guard && guard.attributionUnknown),
		reason: !unchanged && !byUser ? guard.attributionUnknown ? "foreground or keyboard focus changed during hardware input; cause is unverified; no further input was sent" : !frontRestored ? "could not restore the user's foreground application" : !focusRestored ? "could not restore the user's keyboard focus" : "background input briefly changed the user's foreground or keyboard focus; restoration does not satisfy background mode" : "", ...(byUser ? { app } : {}) };
	if(!observeOnly){guard = null;
	if(monitorTimer){monitorTimer.invalidate;monitorTimer=null;}}
	return notice;
}
// Hardware input counts as the user taking over only while the target app is the one in front.
// Input in some other app does not. If the target jumped forward, only input after that jump counts;
// earlier input belonged to the app the user was already in.
function userTookTarget() {
	if (!guard || !inTarget()) return false;
	return guard.jumpedAt ? userClickedTargetSince(guard.jumpedAt) : userInputSince(guard.started);
}
function checkGuard() {
	if (helperClosing) throw new Error("input controller closed; remaining events were not sent");
	if (deadline && Date.now() >= deadline) throw new Error("input deadline expired; remaining events were not sent");
	if (!guard) return;
	monitorState();
	observeActivation();
	if(typeof phasedInput!=="undefined"&&phasedInput&&!globalFinishAllowed&&guard&&!guard.byUser&&(guard.frontChanged||guard.focusChanged))throw new Error("background foreground or keyboard focus changed; remaining input was stopped before global cleanup");
	if (guard.attributionUnknown) throw new Error("foreground or keyboard focus changed; cause is unverified; read again before more input");
	if (userTookTarget()) {
		guard.changed = true;
		guard.byUser = true;
		// Keep sending. When this action finishes, the result says the user changed the app.
		return;
	}
}
// Sending a key-up is sender-side cleanup, not proof that the app received it.
// Keep failures sticky: another command cannot erase an uncertain earlier key.
const inputKeys = [];
let inputKeyReleaseFailed = false;
function beginKey(c, code, modifier) {
	const target={pid:c.pid,instance:c.instance,window:c.window,bounds:c.bounds,foregroundAuthorized:c.foregroundAuthorized,hostTarget:c.hostTarget};
	const record={target,code,modifier:!!modifier};inputKeys.push(record);return record;
}
function finishKey(record) { const index=inputKeys.indexOf(record);if(index>=0)inputKeys.splice(index,1); }
function keyboardCleanup(id) {
	return {schema:"mac-keyboard-cleanup-v1",commandId:id,pendingKeys:inputKeys.length,failed:inputKeyReleaseFailed,complete:inputKeys.length===0&&!inputKeyReleaseFailed};
}
function cleanupError(primary, errors) {
	return new Error((primary?String(primary.message||primary)+"; ":"")+"key release failed: "+errors.map(error=>String(error.message||error)).join("; "));
}
function keyPair(c, code, create, postDown, pause) {
	let record=null,primary=null;
	try {
		postDown(create(true),()=>{record=beginKey(c,code,false);});
		wait(pause);
	} catch(error) { primary=error;throw error; }
	finally {
		if(record)try { releaseKey(create(false),record.target);finishKey(record); }
		catch(error){inputKeyReleaseFailed=true;throw cleanupError(primary,[error]);}
	}
	wait(pause);
}
// Sender-side mouse ledger, not receiver or global-focus proof. Only validated
// downs create records; successful ups retire them. Failed cleanup is sticky.
const inputButtons=[];
let inputButtonReleaseFailed=false;
let mouseCounterId=null,mouseRegisteredDowns=0;
function pointerTarget(c) {
	const target={pid:c.pid,instance:c.instance,window:c.window,bounds:c.bounds?Object.freeze(Object.assign({},c.bounds)):c.bounds,foregroundAuthorized:!!c.foregroundAuthorized,held:Object.freeze((c.held||[]).slice())};
	// AX elements are opaque identity references. Copy the path, retain that
	// exact element, and never resolve a replacement renderer during cleanup.
	if(c.inputAnchor)target.inputAnchor=Object.freeze({element:c.inputAnchor.element,path:Object.freeze(c.inputAnchor.path.slice())});
	if(c.hostTarget)target.hostTarget=pointerTarget(c.hostTarget);
	if(c.nativeEvents)target.nativeEvents=Object.freeze({up:c.nativeEvents.up,rup:c.nativeEvents.rup});
	return Object.freeze(target);
}
function beginPointer(c,kind,x,y,clicks,mode) {
	if(inputButtons.length||inputButtonReleaseFailed)throw new Error("earlier mouse release remains unverified; no new down was sent");
	const record={target:pointerTarget(c),x,y,button:kind==="rdown"?"right":"left",clicks:clicks||1,mode,positionKnown:true};
	if(mouseCounterId!==c.id){mouseCounterId=c.id;mouseRegisteredDowns=0;}mouseRegisteredDowns++;
	inputButtons.push(record);inputPointer={x,y,button:record.button,released:false};return record;
}
function pendingPointer(c) {
	const record=inputButtons[0];
	if(!record||record.target.pid!==c.pid||record.target.instance!==c.instance||record.target.window!==c.window)throw new Error("mouse command does not own the original down");
	return record;
}
function pointerMoveStarting(record,x,y) {
	// If a move applies then throws, its receiver position is unknown. Do not
	// turn the previous successful point into a guessed drop location.
	record.positionKnown=record.positionKnown&&record.x===x&&record.y===y;
	inputPointer={x:record.x,y:record.y,button:record.button,released:false,positionVerified:record.positionKnown};
}
function pointerMoveFinished(record,x,y) {
	record.x=x;record.y=y;record.positionKnown=true;
	inputPointer={x,y,button:record.button,released:false};
}
function mouseCleanup(id) {
	return {schema:"mac-mouse-cleanup-v1",commandId:id,registeredDowns:mouseCounterId===id?mouseRegisteredDowns:0,pendingButtons:inputButtons.length,failed:inputButtonReleaseFailed,complete:inputButtons.length===0&&!inputButtonReleaseFailed};
}
function releasePointerRecord(record) {
	try {
		if(!record.positionKnown)throw new Error("last mouse position is unverified; no drop position was guessed");
		if(record.mode==="real")realPointerRelease(record);
		else mouse(record.target,record.button==="right"?"rup":"up",record.x,record.y,record.clicks,true);
		const index=inputButtons.indexOf(record);if(index>=0)inputButtons.splice(index,1);
	} catch(error) {inputButtonReleaseFailed=true;throw error;}
}
function pointerPair(action) {
	const before=inputButtons.length;let primary=null;
	try {return action();}catch(error){primary=error;throw error;}
	finally {
		const errors=[];
		for(const record of inputButtons.slice(before).reverse())try{releasePointerRecord(record);}catch(error){errors.push(error);}
		if(errors.length)throw new Error((primary?String(primary.message||primary)+"; ":"")+"mouse release failed: "+errors.map(error=>String(error.message||error)).join("; "));
	}
}
const ROUTED_OPS=["click","hover","drag","scroll","key","text","type_focus","prepare_key","release_pointer","release_key"];
function prepareCommandRoute(c) {
	if(typeof c.routeToken!=="string"||c.routeToken.length<16||c.routeToken.length>128)throw new Error("missing native command target acknowledgement token");
	const owner={pid:c.pid,instance:c.instance,window:c.window,bounds:c.bounds};
	if(["click","hover","drag","scroll","key","prepare_key"].includes(c.op)){windowRecord(c);c=resolveInputTarget(c);}
	const route={schema:"mac-command-target-v1",op:c.op,owner,target:{pid:c.pid,instance:c.instance,window:c.window,bounds:c.bounds}};
	return {command:c,route};
}
function perform(c) {
 if(helperClosing)throw new Error("input controller closed; remaining events were not sent");
 if(c.op==="click"&&c.count!==undefined&&(!Number.isSafeInteger(c.count)||c.count<1||c.count>3))throw new Error("click count must be 1, 2 or 3; no mouse input was sent");
 if((inputKeys.length||inputKeyReleaseFailed)&&ROUTED_OPS.includes(c.op)&&!c.op.startsWith("release_"))throw new Error("earlier key release remains unverified; no new input was sent");
 if((inputButtons.length||inputButtonReleaseFailed)&&ROUTED_OPS.includes(c.op)&&!c.op.startsWith("release_"))throw new Error("earlier mouse release remains unverified; no new input was sent");
 deadline = c.deadline || 0;
	// The explicit phased experiment has no overlay timers or windows yet.
	const show = c.cursor !== false&&!(typeof phasedInput!=="undefined"&&phasedInput);
	if (c.deadline && Date.now() >= c.deadline) throw new Error("input deadline expired before dispatch");
 if (["click", "hover", "drag", "scroll", "key", "text", "prepare_key"].includes(c.op)) checkGuard();
	if(["key","text","type_focus"].includes(c.op))rejectKnownPaymentReceiver(c);
	if (c.window && show && ["click", "hover", "drag", "scroll", "cursor"].includes(c.op)) place(c.window);
	if (c.pid && c.window && ["key", "text", "prepare_key"].includes(c.op)) { windowRecord(c); if (!c.foregroundAuthorized) focus(c, true); checkGuard(); }
	switch (c.op) {
		case "ping": return { pid: $.NSProcessInfo.processInfo.processIdentifier };
        case "app_instance": {const target=$.NSRunningApplication.runningApplicationWithProcessIdentifier(c.pid);if(!target||target.isNil())throw new Error("browser disappeared");return {instance:target.launchDate&&!target.launchDate.isNil()?String(Number(target.launchDate.timeIntervalSince1970)):"since-login"};}
        case "reveal_app": {verifyProcess(c);const target=$.NSRunningApplication.runningApplicationWithProcessIdentifier(c.pid);checkGuard();target.unhideWithoutActivation;return {};}


        case "retain_receivers": return retainReceivers(c);
		case "canonical_action": {
			windowRecord(c);const root=exactAXWindow(c),pending=root?[root]:[],found=new Set(),wanted=c.control,b=wanted.bounds;
			for(let i=0;i<pending.length&&i<2000;i++){
				if(deadline&&Date.now()>=deadline)return {};
				const el=pending[i];
				if(elementRole(el)===wanted.role)try{
					const p=axNumbers(axAttribute(el,"AXPosition"),1),z=axNumbers(axAttribute(el,"AXSize"),2),identifier=axAttribute(el,"AXIdentifier");
					if((!wanted.identifier||String(identifier?identifier.js:"")===wanted.identifier)&&Math.abs(p.getFloat64(0,true)-b.x)<=1&&Math.abs(p.getFloat64(8,true)-b.y)<=1&&Math.abs(z.getFloat64(0,true)-b.width)<=1&&Math.abs(z.getFloat64(8,true)-b.height)<=1){
						const actions=Ref();if($.AXUIElementCopyActionNames(el,actions)===0){const names=ObjC.castRefToObject(actions[0]);for(let j=0;j<names.count;j++){const name=String(names.objectAtIndex(j).js);if(name===c.action||normalizeActionName(name)===c.action)found.add(name);}}
					}
				}catch(e){}
				const children=axAttribute(el,"AXChildren");for(let j=0;children&&j<children.count;j++)pending.push(children.objectAtIndex(j));
			}
			windowRecord(c);return pending.length<=2000&&found.size===1?{action:Array.from(found)[0]}:{};
		}
		case "date_values": {
			windowRecord(c);const root=exactAXWindow(c),pending=root?[root]:[],matches=c.controls.map(()=>[]);
			for(let i=0;i<pending.length&&i<2000;i++){
				if(deadline&&Date.now()>=deadline)return {values:c.controls.map(()=>null)};
				const el=pending[i];
				if(elementRole(el)==="AXDateTimeArea")try{
					const p=axNumbers(axAttribute(el,"AXPosition"),1),z=axNumbers(axAttribute(el,"AXSize"),2),identifier=axAttribute(el,"AXIdentifier");
					for(let j=0;j<c.controls.length;j++){const wanted=c.controls[j],b=wanted.bounds;if(wanted.identifier&&String(identifier?identifier.js:"")!==wanted.identifier)continue;
						if(Math.abs(p.getFloat64(0,true)-b.x)<=1&&Math.abs(p.getFloat64(8,true)-b.y)<=1&&Math.abs(z.getFloat64(0,true)-b.width)<=1&&Math.abs(z.getFloat64(8,true)-b.height)<=1)matches[j].push(el);
					}
				}catch(e){}
				const children=axAttribute(el,"AXChildren");for(let j=0;children&&j<children.count;j++)pending.push(children.objectAtIndex(j));
			}
			windowRecord(c);
			if(pending.length>2000)return {values:c.controls.map(()=>null)};
			return {values:matches.map(found=>{if(found.length!==1)return null;const value=axAttribute(found[0],"AXValue");try{const time=Number(value.timeIntervalSince1970);return Number.isFinite(time)?new Date(time*1000).toISOString():null;}catch(e){return null;}})};
		}
        case "selection": {
            windowRecord(c);
            const el=verifyReceiver(c),range=axNumbers(axAttribute(el,"AXSelectedTextRange"),4);
            const start=range.getUint32(0,true)+range.getUint32(4,true)*4294967296;
            const length=range.getUint32(8,true)+range.getUint32(12,true)*4294967296;
            return {range:[start,start+length]};
        }
		case "guard_start": {
			if(typeof phasedInput!=="undefined"&&phasedInput&&guard){scopeTargets.add(c.pid);guard.target=c.pid||0;guard.started=Date.now();return {};}
			guard = { front: Number(workspace.frontmostApplication.processIdentifier), typing: focusedElement(), changed: false, byUser: false, stolen: "", frontChanged: false, focusChanged: false, restoredAt: 0, started: Date.now(), observedAt: Date.now(), jumpedAt: 0, target: c.pid || 0 };
			monitorFocus=guard.typing;
			if(!monitorTimer)monitorTimer=$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.05,handler,"onMonitor:",$(),true);
			return {};
		}
        case "guard_end": {
            return finishGuard();
        }
		case "cursor": if (show) moveTo(c.x, c.y); return {};
		case "hide": hideCursor(); return {};
		case "click": {
			const right = c.button === "right", count = c.count===undefined?1:c.count;
			if (show) moveTo(c.x, c.y);
			for (let n = 1; n <= count; n++) {
				if (show) press();
				pointerPair(()=>{mouse(c,right?"rdown":"down",c.x,c.y,n);wait(0.03);});
				wait(n < count ? 0.08 : 0.01);
			}
			return {};
		}
        case "release_pointer": {
            try{
            if(inputButtons.length){
                const record=pendingPointer(c);
                if(record.button!==(c.button==="right"?"right":"left")||record.x!==c.x||record.y!==c.y)throw new Error("cleanup does not match the original mouse position or button");
                releasePointerRecord(record);
            }else mouse(c,c.button==="right"?"rup":"up",c.x,c.y,1,true);
            }catch(error){inputButtonReleaseFailed=true;throw error;}
            return {};
        }
        case "release_key": {
            const code=KEYS[c.key];if(code===undefined)throw new Error("unknown release key");
            const e=$.CGEventCreateKeyboardEvent(null,code,false);$.CGEventSetFlags(e,0);
            releaseKey(e,c);return {};
        }
		case "hover": if (show) moveTo(c.x, c.y); mouse(c, "move", c.x, c.y); return {};
		case "drag": {
			if(c.foregroundAuthorized)return realPointerDrag(c);
			if (show) { moveTo(c.x, c.y); press(true); }
			try {pointerPair(()=>{
				mouse(c, "down", c.x, c.y, 1); wait(0.05);
				const steps = Math.min(96, Math.max(8, Math.round(Math.hypot(c.x2 - c.x, c.y2 - c.y) / 12)));
				for (let i = 1; i <= steps; i++) {
					const x = c.x + (c.x2 - c.x) * i / steps, y = c.y + (c.y2 - c.y) * i / steps;
					if (show && shownOn >= 0) tx(() => { cursors[shownOn].position = pos(overlays[shownOn], x, y); }, 0.016);
					mouse(c, "drag", x, y); wait(0.016);
				}
				at = [c.x2, c.y2];
			});}finally {if(show)release();}
			return { dispatched: true, verified: false };
		}
		case "scroll": {
			if (show) moveTo(c.x, c.y);
			const dx = c.dx || 0, dy = c.dy || 0, steps = Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/80));
			for (let i = 0; i < steps; i++) {
				// The fixed-argument form: variadic C functions do not take their arguments reliably through the bridge.
				const part = value => Math.round(value*(i+1)/steps)-Math.round(value*i/steps);
				const e = $.CGEventCreateScrollWheelEvent2(null, 0, 2, -part(dy), -part(dx), 0);
				$.CGEventSetLocation(e, { x: c.x, y: c.y });
				stamp(e, c, c.x, c.y);
				$.CGEventSetFlags(e, held(c));
				checkGuard();
				inputSent = true; $.CGEventPostToPid(c.pid, e);
				wait(0.012);
			}
			return {};
		}
        case "text": {
            const receiver = verifyReceiver(c);
            // Each event contains whole Unicode code points, including surrogate pairs.
            const chunks=[];let chunk="";
            for(const ch of c.text){if(chunk.length+ch.length>32){chunks.push(chunk);chunk="";}chunk+=ch;}if(chunk)chunks.push(chunk);
            for(const part of chunks){
                checkGuard();windowRecord(c);
                const bytes=$(part).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
                const create=down=>{
                    const e=$.CGEventCreateKeyboardEvent(null,0,down);
                    $.CGEventSetFlags(e,0);$.CGEventKeyboardSetUnicodeString(e,part.length,bytes.bytes);
                    return e;
                };
                keyPair(c,0,create,(e,beforePost)=>{
                    checkGuard(); windowRecord(c); verifyKeyWindow(c); rejectKnownPaymentReceiver(c);
                    if(!$.CFEqual(receiver,verifyReceiver(c,false)))throw new Error("keyboard receiver was replaced during typing");
                    if(c.foregroundAuthorized){
                        if(Number(workspace.frontmostApplication.processIdentifier)!==c.pid)throw new Error("authorized foreground window is no longer in front; no background fallback was sent");
                        beforePost();
                        inputSent=true;$.CGEventPost($.kCGHIDEventTap,e);
                    }else{stamp(e,c);beforePost();inputSent=true;$.CGEventPostToPid(c.pid,e);}
                },0.01);
            }
            return {};
        }
        case "type_focus": {
            // In an app brought to the front with approval, text goes where its keyboard is, as typing by hand
            // would: for boxes (Qt, CEF) that never report which element has focus.
            if(!c.foregroundAuthorized)throw new Error("typing at the keyboard focus needs an app brought to the front");
            windowRecord(c);
            const chunks=[];let chunk="";
            for(const ch of c.text){if(chunk.length+ch.length>32){chunks.push(chunk);chunk="";}chunk+=ch;}if(chunk)chunks.push(chunk);
            for(const part of chunks){
                const bytes=$(part).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
                const create=down=>{
                    const e=$.CGEventCreateKeyboardEvent(null,0,down);
                    $.CGEventSetFlags(e,0);$.CGEventKeyboardSetUnicodeString(e,part.length,bytes.bytes);
                    return e;
                };
                keyPair(c,0,create,(e,beforePost)=>{
                    checkGuard();
                    if(deadline&&Date.now()>=deadline)throw new Error("input deadline expired; remaining text was not typed");
                    if(Number(workspace.frontmostApplication.processIdentifier)!==c.pid)throw new Error("the app is no longer in front; the rest was not typed");
                    verifyKeyWindow(c);rejectKnownPaymentReceiver(c);
                    beforePost();
                    inputSent=true;$.CGEventPost($.kCGHIDEventTap,e);
                },0.01);
            }
            return {};
        }
		case "wake": {
			if (!c.pid) return {};
			const application = $.AXUIElementCreateApplication(c.pid);
			const main = axAttribute(application, "AXMainWindow") || axAttribute(application, "AXFocusedWindow");
			if (main) $.AXUIElementSetAttributeValue(main, $("AXMain"), $.NSNumber.numberWithBool(true));
			return {};
		}
		case "prepare_key": verifyKeyWindow(c); return {};
		case "key": {
			verifyKeyWindow(c);
			rejectKnownPaymentReceiver(c);
			const receiver=c.receiver?verifyReceiver(c):null;
			const code = KEYS[c.key];
			if (code === undefined) throw new Error("unknown key " + c.key);
			const flags = (c.held || []).reduce((f, h) => f | (FLAGS[h] || 0), 0);
			if(!c.foregroundAuthorized&&((c.held&&c.held.length)||["Enter","Escape","Tab"].includes(c.key))){
				checkGuard();windowRecord(c);verifyKeyWindow(c);rejectKnownPaymentReceiver(c);
				if(receiver&&!$.CFEqual(receiver,verifyReceiver(c,true)))throw new Error("keyboard receiver changed during shortcut");
				if(postMenuShortcut(c,code,flags))return {};
			}
			const create=down=>{
				const native=c.nativeKeys&&c.nativeKeys[down?"down":"up"];
				const e = native?$.CGEventCreateFromData(null,$.NSData.alloc.initWithBase64EncodedStringOptions($(native),0)):$.CGEventCreateKeyboardEvent(null, code, down);
				$.CGEventSetFlags(e, flags);
				return e;
			};
			keyPair(c,code,create,(e,beforePost)=>{
				checkGuard();
				windowRecord(c); verifyKeyWindow(c);
				rejectKnownPaymentReceiver(c);
				if(receiver&&!$.CFEqual(receiver,verifyReceiver(c,true)))throw new Error("keyboard receiver changed during shortcut");
				if (c.foregroundAuthorized) {
                    if (Number(workspace.frontmostApplication.processIdentifier) !== c.pid) throw new Error("authorized foreground window is no longer in front; no background fallback was sent");
                    beforePost();
                    inputSent = true; $.CGEventPost($.kCGHIDEventTap, e);
                }else{stamp(e,c);beforePost();inputSent=true;$.CGEventPostToPid(c.pid,e);}
			},0.02);
			return {};
		}
		case "clip_read": return { items: clipSave().map(item => item.map(pair => [String(pair[0].js), String(pair[1].base64EncodedStringWithOptions(0).js)])), changeCount: Number(pasteboard.changeCount) };
        case "clip_set": {
			return clipSet(c);
		}
		case "clip_restore": return clipRestore(c);
		default: throw new Error("unknown command " + c.op);
	}
}
let buffer = "", idle = null, pendingCommand = null;
// The explicit phased runtime is the same perform()/finally implementation.
// Its private control pipe never executes a business command or re-enters it.
const scopeTargets=new Set(),lifetimePending=[];
const lifetimeReadOnly=new Set(["ping","app_instance","retain_receivers","selection","date_values","canonical_action"]);
let lifetimePhase="idle",lifetimeScope=null,lifetimeOriginal=null,lifetimeControl=null,lifetimeBuffer="",lifetimeLastID=0,lifetimeEOF=false,lifetimeControlGone=false;
function lifetimeReply(c,value){lifetimeControl.writeData($(JSON.stringify(Object.assign({kind:"pointer-lifecycle",id:c.id,nonce:phaseNonce,scope:c.scope,pid:Number($.NSProcessInfo.processInfo.processIdentifier)},value))+"\n").dataUsingEncoding($.NSUTF8StringEncoding));}
function validateLifetimeCommand(c){
 if(lifetimePhase==="finishing")throw new Error("readonly calls cannot re-enter global restoration");
 if(lifetimeReadOnly.has(c.op)){
  if(c.lifecycleScope==null)return;
  if(lifetimePhase==="active"&&c.lifecycleScope===lifetimeScope&&!helperClosing)return;
  throw new Error("readonly command belongs to an ended input scope");
 }
 if(lifetimePhase!=="active"||helperClosing||c.lifecycleScope!==lifetimeScope)throw new Error("business command has no current input scope; no input was sent");
 if(Number.isSafeInteger(c.pid)&&c.pid>0)scopeTargets.add(c.pid);
}
function lifetimeBusinessEOF(){
 lifetimeEOF=true;helperClosing=true;pendingCommand=null;
 if(activeCommand)return;
 if(lifetimePhase==="idle"&&!guard&&!saved&&!inputKeys.length&&!inputButtons.length&&!inputKeyReleaseFailed&&!inputButtonReleaseFailed)$.exit(0);
 if(lifetimePhase==="active")lifetimePhase="draining";
 // No original global restoration is authorized by EOF or a dead controller.
 if(lifetimeControlGone)$.exit(1);
 drainLifetimeControl();
}
function lifetimeControlData(n){
 const data=n.userInfo.objectForKey("NSFileHandleNotificationDataItem");
 if(!data||Number(data.length)===0){lifetimeControlGone=true;lifetimeBusinessEOF();return;}
 lifetimeControl.readInBackgroundAndNotify;
 lifetimeBuffer+=String($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding).js);
 if(lifetimeBuffer.length>8192){lifetimeControlGone=true;lifetimeBusinessEOF();return;}
 for(;;){const nl=lifetimeBuffer.indexOf("\n");if(nl<0)break;const line=lifetimeBuffer.slice(0,nl);lifetimeBuffer=lifetimeBuffer.slice(nl+1);let c;
  try{c=JSON.parse(line);if(!c||c.nonce!==phaseNonce||!Number.isSafeInteger(c.id)||c.id!==lifetimeLastID+1||typeof c.scope!=="string"||!/^[0-9a-f-]{36}$/.test(c.scope)||!["begin_scope","cancel_local","finish_scope"].includes(c.op))throw new Error("invalid private pointer control frame");lifetimeLastID=c.id;}
  catch(error){lifetimeControlGone=true;lifetimeBusinessEOF();return;}
  if(c.op==="cancel_local"&&c.scope===lifetimeScope&&["active","draining"].includes(lifetimePhase)){helperClosing=true;lifetimePhase="draining";}
  if(lifetimePending.length>=8){lifetimeControlGone=true;lifetimeBusinessEOF();return;}
  lifetimePending.push(c);
 }
 drainLifetimeControl();
}
function drainLifetimeControl(){
 if(activeCommand||lifetimePhase==="finishing")return;
 while(lifetimePending.length){const c=lifetimePending.shift();
  try{
   if(c.op==="begin_scope"){
    if(lifetimePhase!=="idle"||guard||saved||pendingCommand||inputKeys.length||inputButtons.length||inputKeyReleaseFailed||inputButtonReleaseFailed||lifetimeEOF||c.scope===lifetimeScope)throw new Error("pointer is not clean readonly idle");
    const front=Number(workspace.frontmostApplication.processIdentifier),typing=focusedElement(),now=Date.now();
    if(!front)throw new Error("original frontmost application unavailable");
    lifetimeScope=c.scope;lifetimeOriginal=Object.freeze({front,typing});scopeTargets.clear();helperClosing=false;globalFinishAllowed=false;lifetimePhase="active";
    guard={front,typing,changed:false,byUser:false,stolen:"",frontChanged:false,focusChanged:false,restoredAt:0,started:now,observedAt:now,jumpedAt:0,target:0};
    monitorFocus=typing;
    if(!monitorTimer)monitorTimer=$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.05,handler,"onMonitor:",$(),true);
    lifetimeReply(c,{ok:true,active:true});
   }else if(c.op==="cancel_local"){
    if(c.scope!==lifetimeScope||lifetimePhase!=="draining")throw new Error("local cancel belongs to another scope");
    const failed=inputKeyReleaseFailed||inputButtonReleaseFailed;
    const pending=pendingCommand;pendingCommand=null;
    lifetimeReply(c,{ok:true,pendingKeys:inputKeys.length,pendingButtons:inputButtons.length,failed,complete:!inputKeys.length&&!inputButtons.length&&!failed});
    if(pending){const command=pending.command;reply({id:command.id,ok:false,error:"input cancelled before target acknowledgement; no input was sent",inputSent:false,inputPointer:null,inputCleanup:keyboardCleanup(command.id),inputMouseCleanup:mouseCleanup(command.id),cancelledBeforePermit:{schema:"mac-pointer-cancel-before-permit-v1",scope:lifetimeScope,commandId:command.id,routeToken:command.routeToken}});}
   }else{
    if(c.scope!==lifetimeScope||lifetimePhase!=="draining"||!helperClosing||pendingCommand||inputKeys.length||inputButtons.length||inputKeyReleaseFailed||inputButtonReleaseFailed)throw new Error("global finish requested before local release");
    // No run-loop callbacks may begin business while global writes run.
    lifetimePhase="finishing";globalFinishAllowed=true;
    let clipboardError=null,foreground=null;
    try{clipRestore();}catch(error){clipboardError=error;}
    try{foreground=finishGuard();}finally{globalFinishAllowed=false;}
    if(clipboardError)throw clipboardError;
    if(!foreground||foreground.attributionUnknown!==false||foreground.restored!==true&&foreground.byUser!==true||saved||clipRestoreFailure||guard||monitorTimer||pendingCommand||inputKeys.length||inputButtons.length)throw new Error("global pointer resource cleanup remains unverified");
    if(idle){idle.invalidate;idle=null;}deadline=0;inputSent=false;inputPointer=null;monitorFocus=null;lifetimeOriginal=null;scopeTargets.clear();
    lifetimePhase="idle";helperClosing=false;
    lifetimeReply(c,{ok:true,idle:true,resourcesClean:true,foreground});
   }
  }catch(error){lifetimePhase="failed";helperClosing=true;lifetimeReply(c,{ok:false,error:String(error.message||error)});$.exit(1);}
 }
}
function startLifetimeControl(){
 lifetimeControl=$.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3,false);
 $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(handler,"onControl:","NSFileHandleReadCompletionNotification",lifetimeControl);
 lifetimeControl.readInBackgroundAndNotify;
}
function finishHelper() {
	if(typeof phasedInput!=="undefined"&&phasedInput){if(lifetimeControlGone)lifetimeBusinessEOF();else drainLifetimeControl();return;}
	pendingCommand = null;
	let status = 0;
	// Each global responsibility still gets its own cleanup attempt. A failed
	// clipboard write must not prevent restoring the user's foreground/focus.
	try { clipRestore(); } catch (e) { status = 1; }
	if(guard)try {
		const focus=finishGuard();
		// A verified human takeover deliberately keeps their new destination.
		// Restored=true is resource cleanup only: transient theft still fails
		// the action through the guard notice, independently of this exit code.
		if(!focus||focus.attributionUnknown!==false||focus.restored!==true&&focus.byUser!==true)status=1;
	} catch (e) { status = 1; }
	if(inputKeys.length||inputKeyReleaseFailed||inputButtons.length||inputButtonReleaseFailed)status=1;
	$.exit(status);
}
ObjC.registerSubclass({ name: "MountainsPointerInput", methods: { "onMonitor:": { types: ["void", ["id"]], implementation: () => {if(!(phasedInput&&lifetimePhase==="finishing"))monitorState();} }, "onIdle:": { types: ["void", ["id"]], implementation: () => { idle = null;if(!phasedInput)hideCursor(); } }, "onActivate:": { types: ["void", ["id"]], implementation: n => {
	if(phasedInput&&lifetimePhase==="finishing")return;
	const activated = n.userInfo.objectForKey("NSWorkspaceApplicationKey");
	if (!guard || guard.holdFront || guard.byUser || !activated || activated.isNil() || Number(activated.processIdentifier) === guard.front) return;
	observeActivation();
} }, "onControl:": {types:["void",["id"]],implementation:n=>lifetimeControlData(n)}, "onData:": { types: ["void", ["id"]], implementation: n => {
	if (idle) { idle.invalidate; idle = null; }
	const data = n.userInfo.objectForKey("NSFileHandleNotificationDataItem");
	// NSData.length comes back wrapped; compare it as a number, or end of input is never seen.
	// The user's clipboard is put back before leaving, even when Mountains stopped mid-paste.
	if (!data || Number(data.length) === 0) { if(typeof phasedInput!=="undefined"&&phasedInput){lifetimeBusinessEOF();return;}helperClosing=true;pendingCommand=null;if(!activeCommand)finishHelper();return; }
	// Arm the next one-shot read before entering a gesture's run loop. EOF can
	// mark cancellation there, but must not exit across that gesture's finally.
	input.readInBackgroundAndNotify;
	if(activeCommand){helperClosing=true;return;}
	buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
	let nl;
	while ((nl = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
		if (!line.trim()) continue;
		let c = {};
		try {
			c = JSON.parse(line);
			activeCommand=c;
			if(c.op!=="route_ack"){inputSent=false;inputPointer=null;}
			if(typeof phasedInput!=="undefined"&&phasedInput)validateLifetimeCommand(c);
			if(c.op==="route_ack"){
				const pending=pendingCommand;
				pendingCommand=null;
				if(!pending||c.id!==pending.command.id||c.routeToken!==pending.command.routeToken||JSON.stringify(c.route)!==JSON.stringify(pending.route))throw new Error("native command target acknowledgement changed");
				c=pending.command;
				// The acknowledged renderer is also a recipient of this scope.
				// Otherwise its stolen global focus looks like unrelated human work.
				if(typeof phasedInput!=="undefined"&&phasedInput)validateLifetimeCommand(c);
				// Keep the retained host/remote binding. Never choose another renderer.
				if(!c.op.startsWith("release_"))windowRecord(c);
			}else{
				if(pendingCommand)throw new Error("native command is awaiting target acknowledgement");
				inputSent=false;inputPointer=null;
				if(c.pid&&c.window&&ROUTED_OPS.includes(c.op)){
					pendingCommand=prepareCommandRoute(c);
					reply({id:c.id,kind:"input-route",routeToken:c.routeToken,route:pendingCommand.route});
					continue;
				}
			}
			const result=perform(c);
			if(helperClosing)throw new Error("input controller closed; remaining events were not sent");
			reply(Object.assign({id:c.id,ok:true,inputSent,inputPointer,inputCleanup:keyboardCleanup(c.id),inputMouseCleanup:mouseCleanup(c.id)},result));
		}catch(e){reply({id:c.id,ok:false,error:String(e.message||e),inputSent,inputPointer,inputCleanup:keyboardCleanup(c.id),inputMouseCleanup:mouseCleanup(c.id)});}
		finally{activeCommand=null;if(typeof phasedInput!=="undefined"&&phasedInput)drainLifetimeControl();if(helperClosing)finishHelper();}
	}
	if(typeof phasedInput!=="undefined"&&phasedInput)return;
	think();
	// Gone when the model has not acted for a while.
	if (idle) idle.invalidate;
	idle = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(30, handler, "onIdle:", $(), false);
} } } });
const handler = $.MountainsPointerInput.alloc.init;
const input = $.NSFileHandle.fileHandleWithStandardInput;
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(handler, "onData:", "NSFileHandleReadCompletionNotification", input);
workspace.notificationCenter.addObserverSelectorNameObject(handler, "onActivate:", $.NSWorkspaceDidActivateApplicationNotification, $()); // $(), not null: from any sender
input.readInBackgroundAndNotify;
if(phasedInput)startLifetimeControl();
$.NSRunLoop.currentRunLoop.run;`;

interface PointerReceiver { token: string; bounds: { x: number; y: number; width: number; height: number }; stableId: string | null; value: string | null; axRole?: string; range?: [number, number] }
export type PointerCommand =
	| { op: "ping" | "hide" | "guard_end" }
    | {op:"app_instance";pid:number}
    | {op:"reveal_app";pid:number;instance:string}
	| { op: "retain_receivers"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number }; receivers: PointerReceiver[] }
	| { op: "guard_start"; pid: number }
	| { op: "wake"; pid: number }
	| { op: "cursor"; window: number; x: number; y: number }
	| { op: "click" | "release_pointer"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number }; x: number; y: number; button?: "left" | "right"; count?: number; held?: string[]; cursor?: boolean }
	| { op: "hover"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number }; x: number; y: number; held?: string[]; cursor?: boolean }
	| { op: "drag"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number }; x: number; y: number; x2: number; y2: number; held?: string[]; cursor?: boolean; foregroundAuthorized?: boolean }
	| { op: "scroll"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number }; x: number; y: number; dx: number; dy: number; held?: string[]; cursor?: boolean }
	| { op: "prepare_key"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number } }
	| { op: "selection"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number }; receiver: PointerReceiver }
	| { op: "date_values"; pid: number; instance: string; window: number; bounds: {x:number;y:number;width:number;height:number};controls:{identifier:string;bounds:{x:number;y:number;width:number;height:number}}[] }
	| { op: "canonical_action"; pid:number;instance:string;window:number;bounds:{x:number;y:number;width:number;height:number};action:string;control:{role:string;identifier:string;bounds:{x:number;y:number;width:number;height:number}} }
	| { op: "key" | "release_key"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number }; key: string; held: string[]; foregroundAuthorized?: boolean; receiver?: PointerReceiver }
	| { op: "text"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number }; text: string; foregroundAuthorized?: boolean; receiver: PointerReceiver }
	| { op: "type_focus"; pid: number; instance: string; window: number; bounds: { x: number; y: number; width: number; height: number }; text: string; foregroundAuthorized: true }
	| { op: "clip_read" }
	| { op: "clip_set"; text: string; html?: string; changeCount: number; token:string }
	| { op: "clip_restore"; items?: string[][][]; changeCount?: number; token?:string };

/** One input owner per agent; cooperative EOF lets it release before exiting. */
/** The theme colour for the cursor, passed on only when it is a plain #RRGGBB. */
function cursorColorEnv(color?: string): Record<string, string> { return color && /^#[0-9a-f]{6}$/i.test(color) ? { MOUNTAINS_CURSOR_COLOR: color } : {}; }
export class MacPointer {
 private readonly helper: JsonHelper;
 private readonly phased:PhasedPointerActor|undefined;
 private readonly startupHelpers=new Set<JsonHelper>();
 private mode:"legacy"|"candidate"|undefined;
 private closed=false;
 private eventData: Promise<MacEventData> | undefined;
 private routes: NativeCommandRoute[] = [];
 private routesComplete = true;
 constructor(label?: string,options?:{phasedInput?:boolean;color?:string}) {
  // This process alone ignores SIGPIPE. A lost reply reader must not kill the
  // input owner before its gesture's finally sends the original-target release.
  this.helper = new JsonHelper("/bin/sh", ["-c", "trap '' PIPE; exec /usr/bin/osascript \"$@\"", "mountains-pointer", "-l", "JavaScript", "-e", HELPER], { ...process.env, MOUNTAINS_CURSOR_LABEL: label ?? "", ...cursorColorEnv(options?.color) }, "eof");
  if(options?.phasedInput)this.phased=new PhasedPointerActor("/bin/sh",["-c","trap '' PIPE; exec /usr/bin/osascript \"$@\"","mountains-phased-pointer","-l","JavaScript","-e",HELPER],{...process.env,MOUNTAINS_CURSOR_LABEL:label??"",...cursorColorEnv(options?.color)});
 }
 get pid(): number | null { return this.phased?.pid??this.helper.pid; }
 private candidateStartup(lease:InputLease,timeoutMs:number):Promise<Record<string,unknown>>{
  lease.check();
  if(this.mode==="legacy"||this.helper.pid!==null||this.eventData)throw new Error("candidate startup requires a fresh pointer; an existing desktop helper was not stopped or reused");
  this.mode="candidate";
  const helper=new JsonHelper("/bin/sh",["-c","trap '' PIPE; exec /usr/bin/osascript \"$@\"","mountains-pointer-startup","-l","JavaScript","-e",FOUNDATION_STARTUP],process.env,"eof");
  this.startupHelpers.add(helper);
  const pending=(async()=>{
   let failed=false,primary:unknown,result:Record<string,unknown>|undefined;
   try{result=await helper.send({op:"ping"},timeoutMs,true,undefined,undefined,undefined,{expiresAt:performance.now()+timeoutMs,beforeDispatch:lease.signal},context=>lease.registerReadOnlyHelper(context.child,context.signal));}
   catch(error){failed=true;primary=error;}
   try{await helper.dispose();}
   catch(error){throw new InputTerminationUnverifiedError("candidate startup helper exit could not be verified; input claim retained",{cause:failed?new AggregateError([primary,error],"startup and helper exit failed"):error});}
   finally{this.startupHelpers.delete(helper);}
   if(failed)throw primary;
   return result!;
  })();
  // Includes spawn registration and actual EOF/close, even if send's caller
  // forgets to await. A ping reply alone must never release the input claim.
  lease.track(pending);return pending;
 }
 async send(command: PointerCommand, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  if(this.closed)throw new Error("desktop pointer helper was closed");
  if(command.op==="click"&&command.count!==undefined&&(!Number.isSafeInteger(command.count)||command.count<1||command.count>3))throw new Error("click count must be 1, 2 or 3; no helper was started");
  const lease=currentInput();
  if(lease?.hasPersistentClaims){
   // Registration is not a sender begin. Keep every ordinary UI/clipboard
   // command shut before event-data creation or any legacy helper startup.
   if(command.op!=="ping")throw new Error("candidate JXA input is not connected to its sender begin and cleanup receipts; no command was sent");
   return await this.candidateStartup(lease,timeoutMs);
  }
  if(this.mode==="candidate")throw new Error("candidate startup pointer cannot switch to legacy input; use a new pointer");
  this.mode="legacy";
  const phasedCommand=this.phased?.command(command.op),sender=this.phased?.helper??this.helper;
  if(command.op==="guard_start"){this.routes=[];this.routesComplete=true;}
  const recordsRoute="pid" in command && "instance" in command && "bounds" in command && "window" in command && ["click","hover","drag","scroll","key","text","type_focus","prepare_key","release_pointer","release_key"].includes(command.op);
  let route: NativeCommandRoute | null = null, permissionMayHaveBeenSent = false;
  const routeToken=recordsRoute?randomUUID():undefined;
  try {
  let nativeEvents: Record<string,string> | undefined;
  let nativeKeys:Record<string,string>|undefined;
  if (["click","hover","drag","release_pointer"].includes(command.op) && "window" in command) {
   const creation = this.eventData ??= MacEventData.open();
   try { nativeEvents = await (await creation).mouse(command.window, "held" in command ? command.held : undefined, command.op !== "release_pointer"); }
   catch (error) { if (this.eventData === creation) this.eventData = undefined; await creation.then(helper=>helper.close()).catch(()=>{}); if (command.op !== "release_pointer") throw error; }
  }
  if(command.op==="key"){
   const special:Record<string,[number,string]>={Enter:[36,"\r"],Tab:[48,"\t"],Escape:[53,"\x1b"]},value=special[command.key];
   if(value)nativeKeys=await(await(this.eventData??=MacEventData.open())).key(command.window,value[0],value[1],command.held);
  }
  const result = await sender.send({ ...command, ...(routeToken?{routeToken}:{}), ...(nativeEvents ? {nativeEvents} : {}),...(nativeKeys?{nativeKeys}:{}),...(phasedCommand?{lifecycleScope:phasedCommand.scope}:{}) }, timeoutMs, !phasedCommand&&!command.op.startsWith("clip_") && command.op !== "guard_end" && command.op !== "retain_receivers" && command.op !== "selection" && command.op !== "date_values" && command.op !== "canonical_action" && !command.op.startsWith("release_"), recordsRoute ? record => {
   if(route)throw new Error("duplicate native command target record");
   const selected=nativeCommandRoute(record.route,command as Parameters<typeof nativeCommandRoute>[1]);
   if(this.routes.length>=4096)throw new Error("native command target record limit exceeded");
   route=selected;this.routes.push(selected);
  } : undefined,()=>{permissionMayHaveBeenSent=true;},phasedCommand?()=>phasedCommand.assertValid():undefined,phasedCommand?{expiresAt:performance.now()+timeoutMs,...(lease?{beforeDispatch:lease.signal}:{})}:undefined,phasedCommand?.beforeCommand);
  if(recordsRoute&&!route)throw new Error("native helper completed without a command target record");
  return command.op==="guard_end"?{...result,inputRoutes:[...this.routes],inputTargetPids:[...new Set(this.routes.map(record=>record.target.pid))],inputRoutesComplete:this.routesComplete}:result;
  } catch(error) {
   if(!recordsRoute)throw error;
   const mayHaveSent=permissionMayHaveBeenSent&&!(error instanceof HelperResponseError&&error.reply.inputSent===false);
   if(mayHaveSent)this.routesComplete=false;
   throw new PointerInputError(error,route,mayHaveSent,error instanceof HelperResponseError?error.reply.inputPointer:undefined);
  }
 }
 assertClosable():void{currentInput()?.assertOpen();this.phased?.assertDisposable();}
 async close(): Promise<void> { this.assertClosable();this.closed=true;await Promise.all([this.helper.dispose(),this.phased?.dispose(), ...[...this.startupHelpers].map(helper=>helper.dispose()), this.eventData?.then(helper=>helper.close())]); }
}
