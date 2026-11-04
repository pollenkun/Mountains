// Disposable WKWebView fixture. DOM state is saved independently of accessibility readback.
import AppKit
import WebKit
import Foundation
import Darwin

// This process belongs to one test controller. Its pipe closing (including
// controller SIGKILL) must not leave a disposable app/monitor running.
FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty { Darwin.exit(0) }
}
let output = CommandLine.arguments[1]
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 200, y: 160, width: 640, height: 580), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
window.title = "Mountains Web Verification"; window.isReleasedWhenClosed = false
let web = WKWebView(frame: window.contentView!.bounds)
web.autoresizingMask = [.width, .height]; window.contentView?.addSubview(web)
web.loadHTMLString("""
<!doctype html><html><head><meta charset="utf-8"><style>body{font:18px system-ui;padding:20px}input,button{font:inherit;margin:8px;padding:8px}#canvas{height:180px;background:#328a96;color:white;padding:20px;overflow:auto}#canvas div{height:650px}output{display:block;margin:10px}</style></head><body>
<label>Web text <input id="field" aria-label="Web text" value="Draft"></label>
<button id="button">Increment</button><output id="count" aria-label="Count">Count: 0</output>
<button id="replace">Replace input</button><button id="delayed">Delayed change</button>
<label>Read only <input id="readonly" aria-label="Read only" value="Fixed" readonly></label>
<div id="canvas" tabindex="0" role="group" aria-label="Event canvas"><div>Click, double click, right click, drag, scroll and key here</div></div>
<output id="events"></output>
<script>
window.state={clicks:0,doubleClicks:0,rightClicks:0,moves:0,drags:0,scrolls:0,keys:'',presses:0,inputs:0,replacements:0};
const canvas=document.querySelector('#canvas');
function report(){document.querySelector('#events').textContent=JSON.stringify(state)}
document.querySelector('#button').onclick=()=>{state.presses++;document.querySelector('#count').textContent='Count: '+state.presses;report()};
document.querySelector('#replace').onclick=()=>{const old=document.querySelector('#field'),next=old.cloneNode(true);old.replaceWith(next);state.replacements++;report()};
document.querySelector('#delayed').onclick=()=>setTimeout(()=>{document.querySelector('#field').value='Delayed';report()},350);
document.addEventListener('input',()=>{state.inputs++;report()});
canvas.addEventListener('click',()=>{state.clicks++;canvas.focus();report()});
canvas.addEventListener('dblclick',()=>{state.doubleClicks++;report()});
canvas.addEventListener('contextmenu',e=>{e.preventDefault();state.rightClicks++;report()});
canvas.addEventListener('pointermove',e=>{state.moves++;if(e.buttons)state.drags++;report()});
canvas.addEventListener('wheel',()=>{state.scrolls++;report()});
canvas.addEventListener('keydown',e=>{state.keys+=e.key;report()});
report();
</script></body></html>
""", baseURL: nil)
window.orderFront(nil)
var pendingCommand = ""
var dragCover: NSPanel?
let timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in
 if let data = try? Data(contentsOf: URL(fileURLWithPath: "\(output)/web-control.json")),
    let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    let nonce = command["nonce"] as? String, nonce != pendingCommand,
    let json = String(data: data, encoding: .utf8) {
  pendingCommand = nonce
  if command["op"] as? String == "move" { window.setFrameOrigin(NSPoint(x: window.frame.minX + 20, y: window.frame.minY + 20)) }
  if command["op"] as? String == "cover" {
    let panel = NSPanel(contentRect: window.frame.insetBy(dx: 20, dy: 50), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.title = "Drag cover"; panel.isReleasedWhenClosed = false; panel.level = .floating
    panel.orderFrontRegardless(); dragCover = panel
  }
  if command["op"] as? String == "uncover" { dragCover?.close(); dragCover = nil }
  web.evaluateJavaScript("((c)=>{if(c.op==='replace'){const old=document.querySelector('#field'),next=old.cloneNode(true);next.value=old.value;old.replaceWith(next);next.focus();state.replacements++;}if(c.op==='empty')document.querySelector('#field').value='';if(c.op==='focus')document.querySelector('#field').focus();if(c.op==='large'){const list=document.createElement('div');list.id='large-list';for(let i=0;i<=4200;i++){const b=document.createElement('button');b.textContent='Pagination marker '+i;list.append(b);}document.body.append(list);}if(c.op==='small')document.querySelector('#large-list')?.remove();state.lastCommand=c.nonce;report();})(\(json))")
 }
 web.evaluateJavaScript("JSON.stringify({...state,value:document.querySelector('#field').value,readonly:document.querySelector('#readonly').value,active:document.activeElement.id})") { value, error in
  guard let value = value as? String, let data = value.data(using: .utf8), var model = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
  let p = NSEvent.mouseLocation
  model["pid"] = ProcessInfo.processInfo.processIdentifier; model["window"] = window.windowNumber
  model["front"] = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0; model["mouse"] = [p.x,p.y]; model["buttons"] = NSEvent.pressedMouseButtons
  model["coverWindow"] = dragCover?.windowNumber ?? 0
  if let saved = try? JSONSerialization.data(withJSONObject: model, options: [.sortedKeys]) { try? saved.write(to: URL(fileURLWithPath: "\(output)/web.json"), options: .atomic) }
 }
}
application.run()
