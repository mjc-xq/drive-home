#!/usr/bin/env python3
"""FFT phase-correlation of two top-down ground images that cover the IDENTICAL
±HALF m world window (North-up, East-right) — used by verify_texture_alignment.mjs
to read the horizontal shift of the Mapbox aerial vs the Google photoreal ground.

  python _measure_xcorr_fft.py <aerial.png> <photoreal.png> <half_m> [search_m]

High-passes (removes the Mapbox-vs-Google exposure/colour difference), Hann-windows,
then phase-correlates. Reports the shift to register the AERIAL onto the photoreal:
  +dEast => aerial must move East;  +dNorth => aerial must move North.
Prints a single parseable line: "... dEast=.. dNorth=.. |..| peak=..".
"""
import sys
import numpy as np
from PIL import Image

AER, PHO = sys.argv[1], sys.argv[2]
HALF = float(sys.argv[3])
SEARCH_M = float(sys.argv[4]) if len(sys.argv) > 4 else 20.0

N = 512
mpp = 2.0 * HALF / N


def boxblur(g, r):
    def b1(x):
        c = np.cumsum(np.pad(x, ((r + 1, r), (0, 0)), mode="edge"), axis=0)
        return (c[2 * r + 1:, :] - c[:-2 * r - 1, :]) / (2 * r + 1)
    return b1(b1(g.T).T)


def prep(p, boost=1.0):
    g = np.asarray(Image.open(p).convert("L").resize((N, N), Image.BILINEAR), float) * boost
    g = np.clip(g, 0, 255)
    g = g - boxblur(g, 10)                 # high-pass: kill exposure/colour bias
    g = (g - g.mean()) / (g.std() + 1e-6)
    return g * np.outer(np.hanning(N), np.hanning(N))


a = prep(AER)
b = prep(PHO)
Fa = np.fft.fft2(a)
Fb = np.fft.fft2(b)
R = Fa * np.conj(Fb)
R /= np.abs(R) + 1e-9
c = np.fft.fftshift(np.fft.ifft2(R).real)

S = int(round(SEARCH_M / mpp))
sub = c[N // 2 - S:N // 2 + S + 1, N // 2 - S:N // 2 + S + 1]
pk = np.unravel_index(np.argmax(sub), sub.shape)
di = pk[0] - S
dj = pk[1] - S
peak = float(sub.max())

# aerial shifted by (di rows, dj cols) lands on photoreal. image +col=+East, +row=South.
# so aerial sits (dj east, -di north) from truth; to register it must move (-dj east? ) —
# the shift to APPLY to the aerial to match the photoreal is exactly (di,dj):
dEast = dj * mpp
dNorth = -di * mpp
mag = (dEast ** 2 + dNorth ** 2) ** 0.5
print(f"texture-vs-photoreal: dEast={dEast:+.2f} dNorth={dNorth:+.2f} |{mag:.2f}| peak={peak:.3f}")
