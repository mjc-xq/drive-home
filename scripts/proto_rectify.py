#!/usr/bin/env python3
"""Vision-located street-view facade extractor — STEP 3 (perspective rectify).

Given a raw SV frame + the 4 wall corners [TL,TR,BR,BL] the vision step returned, +
wallW,wallH, perspective-warp that quad to a head-on rectangle at the wall aspect, honoring
the drop-in pixel-orientation contract (output left=A=TL/BL, right=B=TR/BR, top=eave=TL/TR,
bottom=BL/BR; no flips/rotation/mirroring).

PIL Image.transform(size, Image.QUAD, data) maps the OUTPUT rectangle's corners — in the
order upper-left, lower-left, lower-right, upper-right — to SOURCE (input-image) coords. So
to land TL->output top-left, TR->top-right, BR->bottom-right, BL->bottom-left:
    data = (TLx,TLy,  BLx,BLy,  BRx,BRy,  TRx,TRy)

Usage (positional, as specified):
  proto_rectify.py input_image TLx TLy TRx TRy BRx BRy BLx BLy wallW wallH output_path
Output size = (round(wallW*40), round(wallH*40)); saved JPEG quality 92.
"""
import sys

from PIL import Image

PX_PER_M = 40


def rectify(input_image, TL, TR, BR, BL, wallW, wallH, output_path):
    img = Image.open(input_image).convert("RGB")
    out_w = max(8, round(wallW * PX_PER_M))
    out_h = max(8, round(wallH * PX_PER_M))
    # PIL QUAD data = source coords for output corners in order: UL, LL, LR, UR.
    # UL<-TL, LL<-BL, LR<-BR, UR<-TR  => left=A(TL/BL), right=B(TR/BR), top=eave(TL/TR).
    data = (
        TL[0], TL[1],
        BL[0], BL[1],
        BR[0], BR[1],
        TR[0], TR[1],
    )
    out = img.transform((out_w, out_h), Image.QUAD, data, resample=Image.BICUBIC)
    out.save(output_path, format="JPEG", quality=92)
    return out_w, out_h


def main():
    args = sys.argv[1:]
    if len(args) != 12:
        sys.exit(
            "usage: proto_rectify.py input_image TLx TLy TRx TRy BRx BRy BLx BLy wallW wallH output_path"
        )
    input_image = args[0]
    nums = [float(x) for x in args[1:11]]
    output_path = args[11]
    TL = (nums[0], nums[1])
    TR = (nums[2], nums[3])
    BR = (nums[4], nums[5])
    BL = (nums[6], nums[7])
    wallW = nums[8]
    wallH = nums[9]
    out_w, out_h = rectify(input_image, TL, TR, BR, BL, wallW, wallH, output_path)
    print(f"wrote {output_path} ({out_w}x{out_h})")


if __name__ == "__main__":
    main()
