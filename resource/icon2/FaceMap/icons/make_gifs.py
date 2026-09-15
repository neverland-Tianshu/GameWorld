import os, glob, re
from PIL import Image, ImagePalette

SRC = r"D:\tsqt\Game\resource\AIR\out_all\resource\icon2\FaceMap\icons"
DURATION = 120  # ms per frame
LOOP = 0        # 0 = infinite

def natural_key(name):
    m = re.search(r'face_(\d+)_(\d+)\.png$', name)
    return (int(m.group(1)), int(m.group(2)))

def make_gif_for_face(base, files, duration):
    files = sorted(files, key=natural_key)
    rgba_frames = [Image.open(f).convert('RGBA') for f in files]
    w, h = rgba_frames[0].size

    # Build a global palette from all frames stacked (RGB only; transparency handled separately),
    # reserving index 255 for transparency.
    sheet = Image.new('RGB', (w, h * len(rgba_frames)), (0, 0, 0))
    for i, im in enumerate(rgba_frames):
        sheet.paste(im.convert('RGB'), (0, i * h))
    # quantize to 255 colors for visible content (RGB allows MEDIANCUT)
    q = sheet.quantize(colors=255, method=Image.MEDIANCUT)
    pal = (q.getpalette() + [0, 0, 0])[:768]
    # pad to a full 256-entry palette, last entry acts as transparent color
    pal = (pal + [0, 0, 0]) if len(pal) < 768 else pal[:768]
    pal[255 * 3:255 * 3 + 3] = [0, 0, 0]
    pal_img = Image.new('P', (1, 1))
    pal_img.putpalette(pal)

    gif_frames = []
    for im in rgba_frames:
        alpha = im.split()[3]
        rgb = im.convert('RGB')
        p = rgb.quantize(palette=pal_img, dither=Image.NONE)
        # transparent where alpha < 128
        mask = alpha.point(lambda a: 255 if a < 128 else 0)
        # set those pixels to transparent index 255
        p.paste(255, mask)
        gif_frames.append(p)

    out = os.path.join(SRC, base + '.gif')
    gif_frames[0].save(
        out,
        save_all=True,
        append_images=gif_frames[1:],
        duration=duration,
        loop=LOOP,
        disposal=2,
        transparency=255,
        optimize=False,
    )
    return out, len(gif_frames), w, h

def main():
    groups = {}
    for f in glob.glob(os.path.join(SRC, 'face_*_*.png')):
        base = os.path.basename(f).rsplit('_', 1)[0]
        groups.setdefault(base, []).append(f)
    total = 0
    ok = 0
    errors = []
    for base in sorted(groups, key=lambda b: natural_key(b + '_0.png')):
        try:
            out, n, w, h = make_gif_for_face(base, groups[base], DURATION)
            total += 1
            ok += 1
        except Exception as e:
            errors.append((base, str(e)))
    print(f"Processed faces: {total}, succeeded: {ok}, errors: {len(errors)}")
    for e in errors:
        print("ERR", e)

if __name__ == '__main__':
    main()
