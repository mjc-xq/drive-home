#!/usr/bin/env python3
"""Curvature-correct ECEF->ENU, identical to src/engine/coords.js makeGeoENU, so
the exported GLB shares the exact frame the app's Google photoreal tiles use
(ReorientationPlugin anchored at the house lat/lon, true ENU axes).

The old pipeline used a flat approximation with a 0.4%-low latitude constant
(110540 vs ~110990 m/deg here) -> grew to metres of drift vs Google. This fixes it.

World frame: x = East, z = -North, metres, origin at the house. Use to_world(lat,lon).
"""
import json
import math
import os

import numpy as np

D2R = math.pi / 180.0
WA = 6378137.0
WE2 = 0.00669437999014
# flat constants ONLY for inverting scene.json's existing flat-ENU + deriving the
# house lat/lon exactly as the app does (engine.js / build_scene.py).
LAT0, LON0 = 37.6835313, -122.0686199
COSLAT = math.cos(math.radians(LAT0))

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_C = json.load(open(os.path.join(_ROOT, "src", "assets", "scene.json")))["center"]
# house origin lat/lon = flat-inverse of the centroid (matches app's houseLat/Lon)
HOUSE_LAT = LAT0 + _C[1] / 110540.0
HOUSE_LON = LON0 + _C[0] / (COSLAT * 111320.0)


def _ecef(lat, lon):
    sla = np.sin(lat * D2R); cla = np.cos(lat * D2R)
    slo = np.sin(lon * D2R); clo = np.cos(lon * D2R)
    n = WA / np.sqrt(1 - WE2 * sla * sla)
    return n * cla * clo, n * cla * slo, n * (1 - WE2) * sla


_e0 = _ecef(HOUSE_LAT, HOUSE_LON)
_sla = math.sin(HOUSE_LAT * D2R); _cla = math.cos(HOUSE_LAT * D2R)
_slo = math.sin(HOUSE_LON * D2R); _clo = math.cos(HOUSE_LON * D2R)


def to_en(lat, lon):
    """lat/lon (deg) -> (East, North) metres from the house. Accepts scalars or arrays."""
    x, y, z = _ecef(np.asarray(lat, float), np.asarray(lon, float))
    dx, dy, dz = x - _e0[0], y - _e0[1], z - _e0[2]
    E = -_slo * dx + _clo * dy
    N = -_sla * _clo * dx - _sla * _slo * dy + _cla * dz
    return E, N


def to_world(lat, lon):
    """lat/lon (deg) -> (worldX=E, worldZ=-N) metres, house at origin."""
    E, N = to_en(lat, lon)
    return E, -N


def world_to_ll(x, z):
    """(worldX, worldZ) -> (lat, lon) deg. Inverse ENU->geodetic (Bowring)."""
    E = np.asarray(x, float); N = -np.asarray(z, float)
    X = _e0[0] + (-_slo) * E + (-_sla * _clo) * N
    Y = _e0[1] + _clo * E + (-_sla * _slo) * N
    Z = _e0[2] + _cla * N
    b = WA * math.sqrt(1 - WE2)
    ep2 = (WA * WA - b * b) / (b * b)
    pr = np.hypot(X, Y)
    th = np.arctan2(Z * WA, pr * b)
    lat = np.arctan2(Z + ep2 * b * np.sin(th) ** 3, pr - WE2 * WA * np.cos(th) ** 3)
    lon = np.arctan2(Y, X)
    return lat / D2R, lon / D2R


def flat_to_ll(e, n):
    """Invert scene.json/build_scene flat ENU (from the geocode origin) -> lat/lon."""
    return LAT0 + np.asarray(n, float) / 110540.0, LON0 + np.asarray(e, float) / (COSLAT * 111320.0)
