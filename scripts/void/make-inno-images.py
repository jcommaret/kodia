#!/usr/bin/env python3
# Regenerates the Windows installer's wizard images (resources/win32/inno-{small,big}-*.bmp) from Kodia's icon:
# the cube centered on white, at each size Inno Setup expects. Needs Pillow.
#   python3 scripts/void/make-inno-images.py resources/linux/code.png resources/win32

import sys, os
from PIL import Image
src, outdir = sys.argv[1], sys.argv[2]
logo = Image.open(src).convert('RGBA')
# keep just the cube and its shadow: crop away the transparent corners and the white circle around the icon
mask = Image.eval(logo.convert('L'), lambda v: 255 if v < 235 else 0)
mask = Image.composite(mask, Image.new('L', logo.size, 0), logo.getchannel('A'))
logo = logo.crop(mask.getbbox())

# the sizes VS Code ships, one per display scale (%)
sizes = {
    'small': {100: (55, 55), 125: (64, 68), 150: (83, 80), 175: (92, 97), 200: (110, 106), 225: (119, 123), 250: (138, 140)},
    'big': {100: (164, 314), 125: (192, 386), 150: (246, 459), 175: (273, 556), 200: (328, 604), 225: (355, 700), 250: (410, 797)},
}
for kind, scales in sizes.items():
    for scale, (w, h) in scales.items():
        # the cube fits in 85% of the small image, and takes 72% of the big image's width (like the old glyph)
        side = min(int(w * 0.85), int(h * 0.85 * logo.width / logo.height)) if kind == 'small' else int(w * 0.72)
        cube = logo.resize((side, round(side * logo.height / logo.width)), Image.LANCZOS)
        canvas = Image.new('RGBA', (w, h), (255, 255, 255, 255))
        canvas.alpha_composite(cube, ((w - cube.width) // 2, (h - cube.height) // 2))
        canvas.convert('RGB').save(os.path.join(outdir, f'inno-{kind}-{scale}.bmp'), 'BMP')
print('done')
