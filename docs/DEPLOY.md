# Deploy & Git Strategy (Da Hilg / drive-home)

How the site deploys, and how to push large assets over this flaky network without
fighting it for an hour. Read this before touching `public/` binaries.

## The two constraints (one now relaxed)

1. **Vercel Git LFS support is ENABLED** (2026-06-23 — https://vercel.com/changelog/git-lfs-support).
   Vercel now resolves LFS pointers at build time and serves the real binaries, so LFS-tracked assets
   deploy correctly. This **removes the old hard rule** that every deploy-served asset had to be a
   regular git blob. (History: before this, Vercel served LFS files as ~133-byte pointers → 404s /
   "3D unavailable" / garbage StreamingAssets, which is why the level GLBs, `*.unityweb`, and
   `StreamingAssets/*.glb` were de-LFS'd in `.gitattributes`.)
   - Existing deploy assets can stay regular blobs — they work, and regular blobs sidestep the
     flaky-network LFS *upload* problem (below). No migration is required.
   - LFS is now a valid choice for deploy assets, and is the **only** option for anything > 100 MB
     (constraint #2): e.g. `public/da-hilg/level.glb` (~172 MB) can deploy as LFS once its object is
     uploaded to the remote.
   - Still verify: a served `content-length: 133` means a **stale pointer** (the LFS object never
     reached the remote) — push the object (playbook #3) and redeploy.

2. **GitHub rejects single *regular* files > 100 MB.** LFS files have no such limit. So: a regular
   blob must be < 100 MB; anything larger must be LFS (now that Vercel serves LFS). Keep regular level
   GLBs well under 100 MB (see "Keep assets small" below).

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

3. **`git lfs push` survives drops — object-by-object retry.** `git lfs push origin main` (or
   `git lfs push --object-id origin <oid>` to target one object) retries per object and **banks each
   completed one**, so a multi-object push finishes across several tries (a 280 MB LFS push landed in
   ~3 tries; a 31 MB object lands in 1). Now that Vercel resolves LFS (constraint #1) this works for
   **deploy assets too**, not just archive GLBs. Harden it for the flaky link first:
   ```bash
   git config lfs.concurrenttransfers 1     # single stream = fewer connections to drop
   git config lfs.transfer.maxretries 10    # retry each object many times
   git config lfs.activitytimeout 120
   for i in $(seq 1 20); do git lfs push --object-id origin <oid> && break || sleep 8; done
   ```
   **Caveat — a single object is NOT byte-resumable:** each retry re-sends the whole object, so a file
   too big to upload within one stable window (this link drops ~30 s / ~170 MB in) may never complete.
   Empirically ≤~50 MB lands reliably; ~172 MB needs a lucky window or a trim. For oversized single
   files, shrink them (compress the facade atlas, playbook below) or push from a stable connection.

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
