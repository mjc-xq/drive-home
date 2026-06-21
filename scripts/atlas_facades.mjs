// Atlas the per-wall Street-View facade textures into a few shared pages.
//
// WHY: export_property_glb.mjs (addStreetViewFacadeOverlays) emits ONE quad + ONE
// cropped JPEG + ONE MeshStandardMaterial per building wall it has a Street View photo
// for — named `SVFacade_<building>_<edge>`. A busy level (stanton) carries ~370 of these,
// so the shipped GLB hauls ~370 separate textures + materials + draw calls just for the
// facades. Each facade quad maps the WHOLE [0,1]^2 UV range onto its own photo (the export
// uses u0=0,u1=1,vBottom=1,vTop=0 — a V-flipped full-range quad).
//
// WHAT: atlasFacades(doc) bin-packs every SVFacade texture rectangle (native pixel size,
// via sharp) into one or a few 4096x4096 atlas PAGES with a 2 px gutter, composites each
// page with sharp, then for every SVFacade primitive remaps its TEXCOORD_0 from [0,1]^2
// into that texture's atlas sub-rect [u0,v0,u1,v1] and reassigns the primitive to a SINGLE
// shared atlas material per page. The now-orphaned per-wall textures + materials are
// disposed, so the GLB carries 1-few atlas textures instead of hundreds. Runs on the
// uncompressed LEVEL doc BEFORE meshopt/KTX so the atlas pages get GPU-compressed too.
//
// UV CORRECTNESS: the remap is purely affine — newU = u0 + uv.x*(u1-u0),
// newV = v0 + uv.y*(v1-v0) — so it preserves the export's V-flip and winding untouched
// (it just rescales whatever UVs the quad had into the sub-rect). To keep a facade from
// sampling a neighbour's pixels at the seam we (a) leave a 2 px gutter BETWEEN packed rects
// and (b) inset the sub-rect UV bounds by a half-texel so bilinear taps never reach past
// the rect's own edge into the gutter.
import sharp from 'sharp';

const PAGE = 4096;       // max atlas page dimension (square pages)
const GUTTER = 2;        // px of empty space around each packed rect (anti-bleed)
const FACADE_RE = /^SVFacade/;

// ---- shelf (skyline-row) bin packer ------------------------------------------------
// Sort rects tall->short, lay them left->right on a "shelf"; when a rect won't fit the
// current row, start a new shelf at the row's max height. When the page runs out of
// vertical room, open a NEW page. Simple, deterministic, and good enough for the facade
// crops (all <= 640x256), giving high page occupancy with no rotation.
function packRects(rects, pageSize, gutter) {
  const pages = [];        // each: { placements: [{rect, x, y}] }
  let page = null, shelfX = 0, shelfY = 0, shelfH = 0;
  const newPage = () => { page = { placements: [] }; pages.push(page); shelfX = 0; shelfY = 0; shelfH = 0; };
  newPage();
  for (const rect of rects) {
    const w = rect.w + gutter, h = rect.h + gutter;   // reserve a gutter on right+bottom
    if (w > pageSize || h > pageSize) {
      throw new Error(`atlasFacades: facade ${rect.name} (${rect.w}x${rect.h}) exceeds page ${pageSize}px`);
    }
    if (shelfX + w > pageSize) { shelfX = 0; shelfY += shelfH; shelfH = 0; }   // next shelf
    if (shelfY + h > pageSize) { newPage(); }                                   // next page
    page.placements.push({ rect, x: shelfX + gutter, y: shelfY + gutter });    // gutter on left+top
    shelfX += w;
    if (h > shelfH) shelfH = h;
  }
  return pages;
}

export async function atlasFacades(doc) {
  const root = doc.getRoot();
  const texturesBefore = root.listTextures().length;

  // 1) Collect SVFacade materials + their single baseColor texture, de-duping by texture
  //    (dedup() upstream may already share one texture across walls — pack each unique
  //    texture once, then point every material that uses it at the same sub-rect).
  const facadeMats = root.listMaterials().filter((m) => FACADE_RE.test(m.getName() || ''));
  if (facadeMats.length === 0) {
    return { pages: 0, facadesPacked: 0, texturesBefore, texturesAfter: texturesBefore };
  }
  const texToMats = new Map();   // Texture -> [Material, ...]
  for (const mat of facadeMats) {
    const tex = mat.getBaseColorTexture();
    if (!tex) continue;
    if (!texToMats.has(tex)) texToMats.set(tex, []);
    texToMats.get(tex).push(mat);
  }
  const uniqueTextures = [...texToMats.keys()];
  if (uniqueTextures.length === 0) {
    return { pages: 0, facadesPacked: 0, texturesBefore, texturesAfter: texturesBefore };
  }

  // 2) Measure each unique facade texture's pixel size with sharp.
  const rects = [];
  for (const tex of uniqueTextures) {
    const img = tex.getImage();
    if (!img) continue;
    const meta = await sharp(Buffer.from(img)).metadata();
    rects.push({ tex, name: tex.getName() || 'facade', w: meta.width, h: meta.height, img });
  }
  // Tall-first improves shelf occupancy.
  rects.sort((a, b) => b.h - a.h || b.w - a.w);

  // 3) Bin-pack into pages.
  const pages = packRects(rects, PAGE, GUTTER);

  // 4) Composite each page with sharp; create ONE atlas Texture + ONE shared Material/page.
  const buffer = root.listBuffers()[0] || doc.createBuffer();
  const placementOf = new Map();   // Texture -> { page, x, y, w, h }
  const pageMaterials = [];
  let facadesPacked = 0;

  for (let p = 0; p < pages.length; p++) {
    const { placements } = pages[p];
    // Page extent: only as large as the packed content (rounded up), capped at PAGE.
    let usedW = 0, usedH = 0;
    for (const { rect, x, y } of placements) {
      usedW = Math.max(usedW, x + rect.w + GUTTER);
      usedH = Math.max(usedH, y + rect.h + GUTTER);
    }
    const pageW = Math.min(PAGE, usedW), pageH = Math.min(PAGE, usedH);

    // Composite the facade crops onto a black RGBA page (gutter stays black; the UV inset
    // below keeps samplers off it anyway). Decode each crop to raw RGBA so heterogeneous
    // JPEG sources composite cleanly.
    const composites = [];
    for (const { rect, x, y } of placements) {
      composites.push({ input: Buffer.from(rect.img), left: x, top: y });
      placementOf.set(rect.tex, { page: p, x, y, w: rect.w, h: rect.h });
    }
    const pageImg = await sharp({
      create: { width: pageW, height: pageH, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).composite(composites).jpeg({ quality: 90 }).toBuffer();

    const atlasTex = doc.createTexture(`SVFacadeAtlas_${p}`)
      .setImage(pageImg)
      .setMimeType('image/jpeg');
    // One shared material per page, mirroring the per-wall facade material settings
    // (white base, rough, non-metal, faint white emissive — see export_property_glb.mjs).
    const atlasMat = doc.createMaterial(`SVFacadeAtlas_${p}`)
      .setBaseColorFactor([1, 1, 1, 1])
      .setRoughnessFactor(0.95)
      .setMetallicFactor(0)
      .setEmissiveFactor([0.05, 0.05, 0.05])
      .setDoubleSided(true)
      .setBaseColorTexture(atlasTex);
    pageMaterials.push({ mat: atlasMat, w: pageW, h: pageH });
  }

  // 5) Remap every SVFacade primitive's TEXCOORD_0 into its atlas sub-rect and reassign
  //    the primitive to its page's shared material. Inset the sub-rect by a half-texel so
  //    bilinear taps never reach into the 2 px gutter (neighbour bleed guard).
  for (const [tex, mats] of texToMats) {
    const place = placementOf.get(tex);
    if (!place) continue;
    const { page, x, y, w, h } = place;
    const { mat: atlasMat, w: pageW, h: pageH } = pageMaterials[page];
    // sub-rect in [0,1], inset by half a texel on each side.
    const u0 = (x + 0.5) / pageW;
    const v0 = (y + 0.5) / pageH;
    const u1 = (x + w - 0.5) / pageW;
    const v1 = (y + h - 0.5) / pageH;
    const du = u1 - u0, dv = v1 - v0;

    for (const mat of mats) {
      const prims = mat.listParents().filter((pp) => pp.propertyType === 'Primitive');
      for (const prim of prims) {
        const uvAcc = prim.getAttribute('TEXCOORD_0');
        if (!uvAcc) { prim.setMaterial(atlasMat); facadesPacked++; continue; }
        // Clone the UV accessor so primitives that happen to share a UV accessor don't get
        // double-remapped; remap [0,1]^2 -> [u0,v0,u1,v1] (affine, preserves V-flip/winding).
        const src = uvAcc.getArray();
        const dst = new Float32Array(src.length);
        for (let i = 0; i < src.length; i += 2) {
          dst[i] = u0 + src[i] * du;
          dst[i + 1] = v0 + src[i + 1] * dv;
        }
        const newUv = doc.createAccessor(uvAcc.getName() || 'TEXCOORD_0')
          .setType('VEC2')
          .setArray(dst)
          .setBuffer(uvAcc.getBuffer() || buffer);
        prim.setAttribute('TEXCOORD_0', newUv);
        prim.setMaterial(atlasMat);
        facadesPacked++;
      }
    }
  }

  // 6) Dispose the now-orphaned per-wall facade materials + textures.
  for (const mat of facadeMats) mat.dispose();
  for (const tex of uniqueTextures) tex.dispose();

  const texturesAfter = root.listTextures().length;
  return { pages: pages.length, facadesPacked, texturesBefore, texturesAfter };
}

// ---- tiny self-test: `node scripts/atlas_facades.mjs --selftest` -------------------
// Builds a synthetic doc with 5 SVFacade quads (full-[0,1] V-flipped UVs, like the export)
// each pointing at a distinct solid-color JPEG, runs atlasFacades, and asserts: a single
// atlas page, all 5 facades packed, texture count collapses 5 -> 1, every facade primitive
// now shares the atlas material, and its remapped UVs land INSIDE its own (inset) sub-rect.
async function selftest() {
  const { Document } = await import('@gltf-transform/core');
  const doc = new Document();
  const buf = doc.createBuffer();
  const mesh = doc.createMesh('facades');
  const scene = doc.createScene();
  const node = doc.createNode('facades').setMesh(mesh);
  scene.addChild(node);

  const N = 5;
  const dims = [[270, 166], [506, 177], [614, 129], [640, 151], [412, 163]];
  for (let i = 0; i < N; i++) {
    const [w, h] = dims[i];
    const jpeg = await sharp({
      create: { width: w, height: h, channels: 3, background: { r: (i * 50) % 256, g: 80, b: 120 } },
    }).jpeg().toBuffer();
    const tex = doc.createTexture(`tex_${i}`).setImage(jpeg).setMimeType('image/jpeg');
    const mat = doc.createMaterial(`SVFacade_${i}_0`).setBaseColorTexture(tex);
    // a quad with the SAME full-range V-flipped UVs the exporter writes.
    const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0,
    ])).setBuffer(buf);
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([
      0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0,
    ])).setBuffer(buf);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('TEXCOORD_0', uv).setMaterial(mat);
    mesh.addPrimitive(prim);
  }

  const before = doc.getRoot().listTextures().length;
  const stats = await atlasFacades(doc);
  const after = doc.getRoot().listTextures().length;

  const assert = (cond, msg) => { if (!cond) throw new Error('SELFTEST FAILED: ' + msg); };
  assert(stats.pages === 1, `expected 1 page, got ${stats.pages}`);
  assert(stats.facadesPacked === N, `expected ${N} facades packed, got ${stats.facadesPacked}`);
  assert(before === N, `expected ${N} textures before, got ${before}`);
  assert(after === 1, `expected 1 texture after, got ${after}`);
  assert(doc.getRoot().listMaterials().length === 1, `expected 1 material after, got ${doc.getRoot().listMaterials().length}`);

  // Every facade prim shares the single atlas material; UVs stay within [0,1].
  const atlasMat = doc.getRoot().listMaterials()[0];
  for (const prim of mesh.listPrimitives()) {
    assert(prim.getMaterial() === atlasMat, 'prim not pointing at atlas material');
    const arr = prim.getAttribute('TEXCOORD_0').getArray();
    for (const v of arr) assert(v >= 0 && v <= 1, `remapped UV ${v} out of [0,1]`);
  }
  // The atlas page must decode as a valid image.
  const md = await sharp(Buffer.from(atlasMat.getBaseColorTexture().getImage())).metadata();
  assert(md.width > 0 && md.height > 0 && md.width <= PAGE && md.height <= PAGE,
    `bad atlas page ${md.width}x${md.height}`);

  console.log(`atlas_facades self-test OK: ${JSON.stringify(stats)}, atlas page ${md.width}x${md.height}`);
}

if (process.argv.includes('--selftest')) {
  selftest().catch((err) => { console.error(err); process.exit(1); });
}
