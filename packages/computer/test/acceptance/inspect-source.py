import hashlib, json, subprocess, sys
from html.parser import HTMLParser
from pathlib import Path

root=Path(sys.argv[1]).resolve()
values=json.loads((root/'manifest.json').read_text())['values']
source=next((root/'workspace'/name for name in ['case17.rtf','case17.rtfd'] if (root/'workspace'/name).exists()),None)
assert source is not None, 'source document missing'
converted=subprocess.run(['/usr/bin/textutil','-convert','html','-stdout',str(source)],check=True,capture_output=True).stdout.decode('utf-8')
class Tables(HTMLParser):
    def __init__(self):
        super().__init__(); self.tables=[]; self.table=None; self.row=None; self.cell=None; self.text=[]
    def handle_starttag(self,tag,attrs):
        if tag=='table': self.table=[]
        elif tag=='tr' and self.table is not None: self.row=[]
        elif tag in ['td','th'] and self.row is not None: self.cell=[]
    def handle_data(self,data):
        self.text.append(data)
        if self.cell is not None: self.cell.append(data)
    def handle_endtag(self,tag):
        if tag in ['td','th'] and self.cell is not None:
            self.row.append(''.join(self.cell).strip()); self.cell=None
        elif tag=='tr' and self.row is not None:
            self.table.append(self.row); self.row=None
        elif tag=='table' and self.table is not None:
            self.tables.append(self.table); self.table=None
parsed=Tables();parsed.feed(converted)
norm=lambda value: ''.join(value.split())
assert norm(values['richTitle']) in norm(''.join(parsed.text)), 'saved source title differs'
expected=[[norm(cell) for cell in row] for row in values['table']]
matching=[table for table in parsed.tables if [[norm(cell) for cell in row] for row in table]==expected]
assert len(matching)==1, 'saved source must contain final exact 3x3 table'
paths=sorted(source.rglob('*')) if source.is_dir() else [source]
hashes={str(path.relative_to(root)):hashlib.sha256(path.read_bytes()).hexdigest() for path in paths if path.is_file()}
print(json.dumps({'source':str(source),'title':values['richTitle'],'table':matching[0],'hashes':hashes,'method':'independent textutil HTML conversion and HTMLParser table cells'},ensure_ascii=False))
