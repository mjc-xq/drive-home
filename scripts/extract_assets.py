#!/usr/bin/env python3
"""Recover the ORIGINAL assets from the shipped single-file claude.ai artifact
(1840-dahill-3d.html) and drop them into src/assets/ for exact visual parity
with the artifact built in claude.ai chat.

Usage: python3 scripts/extract_assets.py path/to/1840-dahill-3d.html

Overwrites src/assets/{scene.json, aerial_opt.jpg, ferrari.glb}. Rerun
`npm run build` afterwards."""
import base64
import os
import re
import sys

src = open(sys.argv[1]).read()
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'assets')
os.makedirs(out, exist_ok=True)

# scene.json: the JS object literal assigned to S (brace-depth scan; regex-proof)
i = src.index('const S = {') + len('const S = ')
depth = 0
j = i
while True:
    c = src[j]
    if c == '{':
        depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0:
            j += 1
            break
    j += 1
open(os.path.join(out, 'scene.json'), 'w').write(src[i:j])

m = re.search(r'data:image/jpeg;base64,([A-Za-z0-9+/=]+)', src)
open(os.path.join(out, 'aerial_opt.jpg'), 'wb').write(base64.b64decode(m.group(1)))

m = re.search(r'data:application/octet-stream;base64,([A-Za-z0-9+/=]+)', src)
open(os.path.join(out, 'ferrari.glb'), 'wb').write(base64.b64decode(m.group(1)))

print('extracted scene.json, aerial_opt.jpg, ferrari.glb into src/assets/')
