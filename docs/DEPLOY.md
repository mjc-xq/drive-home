# Deploy & Git Strategy (Da Hilg / drive-home)

How the site deploys, and how to push large assets over this flaky network without
fighting it for an hour. Read this before touching `public/` binaries.

## The two hard constraints

1. **Vercel cannot resolve Git LFS.** Its build checkout has no LFS remote
   (`git lfs pull` → "Not in a Git repository"), so any **LFS-tracked** file is served
   as a ~133-byte *pointer* and the asset 404s / fails to load at runtime
   (e.g. the R3F levels showed "3D unavailable", the Unity StreamingAssets streamed garbage).
   → **Every deploy-served asset MUST be a regular git blob, not LFS.** See `.gitattributes`:
   the level GLBs (`public/da-hilg/*.glb`), Unity `*.unityweb`, and Unity `StreamingAssets/*.glb`
   are all de-LFS'd on purpose.

2. **GitHub rejects single files > 100 MB.** So a deploy asset must be **both** regular-git
   **and** < 100 MB. Keep level GLBs well under that (see "Keep assets small" below).

## The flaky-network push playbook

Symptom: `git push` over SSH dies on larger files with
`send-pack: unexpected disconnect` / `Connection closed by remote host` / `broken pipe`.
Empirically this connection pushes ~24 MB fine, gets unreliable ~34 MB+, and fails ~37 MB+ over SSH.

In rough order of what to reach for:

1. **Push large files in separate commits.** One asset per commit, push after each, so each
   push transfers only that blob. Small pushes survive; a big multi-file pack does not.

2. **Push over HTTPS with HTTP/1.1 + a big buffer, and RETRY.** This beats the SSH broken-pipe
   and landed a 48.9 MB file where SSH failed 40+ times:
   ```bash
   gh auth setup-git   # once: gh becomes the git credential helper for HTTPS
   git -c http.version=HTTP/1.1 -c http.postBuffer=1572864000 \
       -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
       push https://github.com/mjc-xq/drive-home.git HEAD:main
   ```
   The **first attempt often fails** with `LibreSSL ... bad record mac` — just retry; attempt 2–3
   usually lands it. Forcing HTTP/1.1 (not HTTP/2) is the key part for large uploads.

3. **`git lfs push` resumes/chunks.** For genuinely large files that must live in LFS (non-deployed
   source/archive GLBs), `git lfs push origin main` retries object-by-object and survives drops
   (a 280 MB LFS push eventually completed in ~3 tries). **Do NOT** use LFS for anything Vercel must
   serve (constraint #1).

4. **Split into ~4 MB parts + reassemble client-side** — the proven pattern for the Unity engine
   data blob: `da-hilg.data.unityweb` is committed as `…part0`…`part6` (exactly 4 MB each) and the
   page reassembles them (`assembleUnityDataUrl` in `public/unity/da-hilg/index.html`). Use this only
   for files that genuinely can't be shrunk under the push ceiling, because it needs runtime
   reassembly support (the StreamingAssets GLB path does not have it today).

## Keep assets small (so you never hit the ceiling)

The cheapest fix is usually **not to make the file huge in the first place**:

- **Don't over-resolve baked texture atlases.** The dahill facade atlas shipped at 6144²/4096²
  pages (35.8 MB of JPEG) — 2–3× anything a street-level camera shows. Downscaling the atlas pages
  to ~2048 cut the level GLB 48.9 MB → 20.6 MB with no practical quality loss. Bake atlases at
  ~2048–3072, not 4096+.
- Meshopt-compress geometry (already done in `build_dahilg_assets` / `build_dahilg_unity_assets`).
- Verify a built GLB's texture budget with gltf-transform before committing
  (`textures: N images, X MB`); if textures dominate, downscale before pushing.

## Verifying a deploy actually landed

- Check the served byte size, not just that the push succeeded:
  `curl -sI https://home-alpha-ivory.vercel.app/unity/da-hilg/StreamingAssets/<level>.glb`
  — a `content-length: 133` means it's still an **LFS pointer** (broken); a real size means it's good.
- StreamingAssets are immutably cached (`Cache-Control: …immutable`); after a deploy, **hard-reload**
  (Cmd+Shift+R) or add a `?cb=<ts>` query to bypass the browser cache.
- The Unity level GLB is fetched at runtime from `StreamingAssets/<slug>.glb`, so a level-content
  change does **not** require rebuilding the wasm Build — just push the StreamingAsset and redeploy.
