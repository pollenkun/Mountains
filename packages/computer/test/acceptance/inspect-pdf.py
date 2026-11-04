import json, os, subprocess, sys
from pathlib import Path
import pdfplumber
from PIL import Image

root=Path(sys.argv[1]).resolve()
manifest=json.loads((root/'manifest.json').read_text())
pdf=root/'workspace/case17.pdf'
expected=manifest['values']['table']
normalize=lambda value: ''.join((value or '').split())
with pdfplumber.open(pdf) as document:
    assert len(document.pages)==1, 'expected one page'
    page=document.pages[0]
    text=page.extract_text() or ''
    assert normalize(manifest['values']['richTitle']) in normalize(text), 'PDF title differs'
    candidates=page.find_tables()
    matching=[table for table in candidates if [[normalize(cell) for cell in row] for row in table.extract()]==[[normalize(cell) for cell in row] for row in expected]]
    assert len(matching)==1, 'PDF does not have exactly one expected 3x3 table'
    table=matching[0]
    page_width,page_height=page.width,page.height
    cells=list(table.cells)
render=root/'evidence/case17-render'
renderer=os.environ.get('MOUNTAINS_PDFTOPPM','/Users/beluga383/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm')
subprocess.run([renderer,'-png','-r','120','-singlefile',str(pdf),str(render)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
image=Image.open(str(render)+'.png').convert('RGB')
scale_x,scale_y=image.width/page_width,image.height/page_height
# Verify every table edge exists in the independently rendered raster, not just PDF metadata.
def dark(x,y):
    if not(0<=x<image.width and 0<=y<image.height): return False
    return max(image.getpixel((x,y)))<200
for x0,y0,x1,y1 in cells:
    for fixed,start,end,horizontal in [(y0,x0,x1,True),(y1,x0,x1,True),(x0,y0,y1,False),(x1,y0,y1,False)]:
        hits=0
        for step in range(5,96):
            moving=start+(end-start)*step/100
            x,y=(moving,fixed) if horizontal else (fixed,moving)
            ix,iy=round(x*scale_x),round(y*scale_y)
            hits+=any(dark(ix+dx,iy+dy) for dx in range(-2,3) for dy in range(-2,3))
        assert hits>=80, 'table edge is missing from rendered image'
result={'title':manifest['values']['richTitle'],'table':table.extract(),'render':str(render)+'.png',
        'renderedPixelsVerified':True,'method':'pdfplumber exact cell extraction plus Poppler raster edge checks',
        'width':image.width,'height':image.height}
print(json.dumps(result,ensure_ascii=False))
