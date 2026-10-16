---
name: animate-art
description: Turn a still artwork (illustration, digital painting, poster) into a faithful, seamlessly looping animation, gentle or dramatic (gusting wind, smoke rising, fragments tearing loose), delivered as a self-contained web page and an MP4 and verified against the original with screenshots and metrics. Use when asked to animate a picture, bring an image to life, make a cinemagraph or living version of art, or make "an animated version of this".
---

# animate-art

Make a still picture move without losing it. The original pixels stay the base
layer (the "plate"). Only what must move is cut out and rebuilt as particles,
and every effect is an overlay. The composition stays the artist's in every
frame, and frame 0 can be made nearly identical to the source.

Worked example: `art/ascension/` (a figure dissolving into diamonds under a
glowing triangle, in a gusting wind). Read its `build_scene.py` before starting
a new piece; it uses every technique below.

## Calibrate the intensity first

"Animated" can mean a gentle cinemagraph or a storm. The first version of
ascension (slow drift, soft glow pulses) was rejected as "far too mild: only
little squares disappearing into the background". What was wanted was gusting
wind, the subject's own material rising into the air, and fragments everywhere.
Unless the request says gentle, aim for clearly visible motion:
- moving elements travel 30 to 120 px/s, not 3 to 9
- the subject itself moves (it smokes, burns, sways, dissolves), not only
  particles around it
- there are thousands of fragments, at several depths (far, faint and slow;
  near, dark and fast)
- events have rhythm: calm, then gusts of different strengths, then calm
- light sources respond to the events (glow surges with each gust)

## What you get

- `art/<name>/index.html`: viewer page (WebGL2 canvas with Canvas2D fallback,
  play/pause, hold-to-compare with the original, per-layer toggles). Works from `file://`.
- `art/<name>/out/<name>.mp4`: H.264, 60 fps, seamless loop, BT.709-correct colours.
- `art/<name>/out/<name>.html`: the same page as one self-contained file.
- `art/<name>/out/review/`: metrics, side-by-side and contact sheets.

## Requirements

`pip install -r .claude/skills/animate-art/requirements.txt` (numpy, pillow,
opencv-python-headless, scikit-image), plus node with Playwright + Chromium and
ffmpeg. Claude Code cloud containers already have node, Playwright, Chromium and
ffmpeg; only the pip install is needed.

## Quick start

```bash
mkdir -p art/<name> && cp picture.webp art/<name>/source.webp
cp .claude/skills/animate-art/templates/build_scene_starter.py art/<name>/build_scene.py
.claude/skills/animate-art/scripts/pipeline.sh art/<name>      # build, capture, score, seam check, encode, bundle
```

The starter runs with no edits. Repeated small shapes (`KIND`) are cut loose and
carried by a gusting wind; gusts tear fragments off the dark mass's edges; light
sources surge; the mass twinkles; the field shimmers. Set `GUSTS = []` for a calm
version. Then make it the piece's own (steps 2 to 4). The unedited starter's
plate shows exactly what the custom steps fix: a stroke that should stay gets
cut up (needs a keep mask), and smudges appear where shapes sat on a glowing
edge (needs a profile guide).

## Workflow

### 1. Study the picture
Look before measuring. Make 3-4x crops of every distinct region and read them:
```bash
convert source.webp -crop 300x260+260+60 -scale 300% crop.png    # then Read crop.png
```
Identify the layers the artist painted: background field, light sources and
their halos, the subject, loose particles, ground or edges, and what sits in
front of what. Sample colours and the luminance histogram. Look for exact
geometry: vector shapes (here an equilateral triangle) can be fitted to sub-pixel
accuracy and rebuilt perfectly.

### 2. Decide what moves, and how hard
Animate what the picture implies:
- a subject breaking apart keeps breaking apart; its own body becomes the
  effect (here the head is a plume of diamonds rising and bending in the wind)
- loose particles get carried the way they are scattered (here up and right)
- light sources surge with events (`alpha: {wave: 'wind'}`) or beat (`'beat'`)
- textured masses twinkle; trails carry flow (`path` layers)
- the field shimmers faintly
Keep strokes that define the composition still (keep masks).

### 3. Decompose
Explore with the CLI, then tune thresholds until the debug view is right:
```bash
python3 .claude/skills/animate-art/scripts/extract_shapes.py --src source.webp --out /tmp/look --kind diamond
```
- **Ink mask**: absolute dark (`L < ink_lum`) OR relatively dark against a
  grey-closing background (`L < rel * close(L)`). The relative test catches
  translucent shapes over bright areas.
- **Static mass**: ink closed with a small kernel (9 px); big components stay in
  the plate. Holes are filled, so a bright emblem inside a dark body is not
  mistaken for free shapes.
- **Shape extraction**: each free component is covered greedily by metric balls
  from a distance transform: L1 gives diamonds, L2 circles, L-inf squares. A
  component is extracted only if its balls explain at least 72% of it. Each
  shape gets its median core colour; its footprint plus a 3.5 px rim is erased.
- **Keep masks**: `ak.poly_mask(polylines=[(points, width)])` for strokes that
  must not move (here the zigzag trail).
- **Cutting out a whole subject** that will move (a head, smoke, a flame):
  `ak.row_span(mask)` fills each row between its extremes, so the ragged edges
  go too.
- **Plate fill**: `ak.guided_fill` picks, per pixel, the direction along which
  the surroundings are most uniform (two-sided support, multi-scale lines), then
  inpaints the residual. Near a known geometric light source, pass a **profile
  guide**: fit the geometry, compute a 1-D coordinate across it
  (`ak.ring_coordinate` for a stroked polygon), and take the median colour per
  0.25 px bin (`ak.profile_guide`). Extend the guide's range over the whole area
  the subject covered. Check the plate at 3x against the source around every big hole.
- **Unmixing**: `ak.unmix(color, plate_color)` splits a cut-out pixel into ink and
  alpha over the refilled plate, so moved material composites correctly.

### 4. Build the scene (`build_scene.py`)
Layers draw back to front. Types:
- `image`: plate or overlays; `blend: 'lighter'` for glows. Glows come from
  `ak.glow_rgba(mask, color, sigmas, weights)`. Multiply glow alpha by
  `1 - blur(front_mask)` so anything in front of the light stays unlit.
- `particles`: records from `ak.particle(...)`. Placement:
  - `at_phase=p`: the particle is exactly at (x, y) at t = 0, with motion,
    sway, wind and spin undone. Use it for the artist's own shapes.
  - `born_at=t`: born at (x, y) at time t. With `wind.gust_times(rng, n)` this
    makes emission burst during gusts.
  - `phase=p`: steady state.
  Set `grow: true` on a layer of crisp shapes so they grow in and shrink away;
  alpha fades turn them grey on bright grounds. Set `bend: {amp, yBot, H, cup}`
  to sway a whole layer like a plume rooted at yBot.
- `path`: particles running along a polyline (`k` laps per loop).
- **Wind**: `wind = ak.Wind(LOOP, gusts=[(strength, peak_s, width_s), ...])`,
  then `scene["wind"] = wind.to_scene()`. A particle with `wd` (px per unit
  gust-second) is pushed by the integral of the gust since its birth. Gusts sweep
  left to right at `front` px/s. Python and JS share the same tables, so
  placement at t = 0 is exact. Keep about 2 s of calm around t = 0.

**Turning a textured mass into rising smoke** (the ascension head): cut the mass
out (`row_span`), unmix it, and rebuild it as a steady-state cloud of thousands
of short-lived shapes. Births are sampled from its alpha map
(`weight = alpha ** 1.6`), colours come from the source pixels, each shape rises
and accelerates for 2-3 s, and the layer bends with the gusts. Add a few soft
dark glow puffs under it to keep the core smooth. Calibrate the count: render
only plate + cloud (`capture.mjs --off ...`) and match the region's mean
luminance to the source (here 34 vs 35).

Seamless loop rules: every `life` and every wave `k` must divide `loop` (12 s
works well: lives of 2, 3, 4, 6 and 12 s). Sample colours from the source;
never invent a palette. Seed every RNG. `ak.install_page(dir, title)` copies the
engine and the titled viewer page.

### 5. Verify (always, with pictures)
- `capture.mjs page.html outdir --times 0,3,6,9` for stills. Read them next to
  the source, and crop at 2-3x around faces, edges, refilled holes and the
  moving subject. Look for smears, streaks and seams.
- `capture.mjs ... --off layerA,layerB` isolates layers for calibration.
- `compare.py --src source --frames dir` gives the metrics. A gentle loop holds
  SSIM above 0.92 every frame. A dramatic one sits around 0.80 (ascension v2:
  0.79 to 0.84), and it should still read as the same picture.
- Check every consecutive frame step: the maximum should be near the median (no
  pops), and the seam step (last frame to first) should be typical. `pipeline.sh`
  prints the seam check.
- `screenshot.mjs page.html out.png --w 1440 --h 900 --dpr 2` and
  `--w 390 --h 844 --dpr 2` check the viewer page and horizontal overflow.
- Render one frame with `?renderer=canvas2d` and compare it with WebGL2 (mean
  difference should be under 1/255).
- Decode the MP4 (`ffmpeg ... scale=in_color_matrix=bt709 ...`) and compare
  with the PNG frames: mean RGB shift under 0.5.

### 6. Deliver
- MP4: `encode.sh frames out.mp4 60 18`. Busy scenes are large at CRF 15
  (ascension v2: 20 MB; 13.6 MB at CRF 18).
- Web: `bundle.py index.html page.html --fragment`, then publish with the
  Artifact tool (republish the same file path to keep the URL). Send the MP4
  and a labelled comparison sheet with SendUserFile.

## Engine reference

`engine/animator.js` is a pure function of time. `ArtAnimator.create(canvas,
scene, {scale, preserve, renderer})` returns `{render(t), renderer, wind}`.
WebGL2 draws all particles of a layer in one instanced call, so about 10k
particles cost about 5 ms per frame even in software. Canvas2D is the fallback
(about 45 ms per frame for 10k). The scene format is documented at the top of
the file. `engine/template.html` adds the controls and these URL parameters:
`?capture`, `?t=3.5`, `?off=a,b`, `?scale=2`, `?renderer=canvas2d`.

## Pitfalls already hit (do not repeat)

- Too mild. Calibrate intensity first (see above).
- A conveyor that scrolls the subject's pixel rows upward and rescales each row
  to the silhouette width smears fine grain into horizontal streaks. Rebuild a
  grainy subject as a steady-state particle cloud instead.
- A conveyor whose particles spend part of each cycle outside the visible
  region leaves an empty band that travels through it. Every phase slot needs a
  particle.
- Residual inpainting needs the guide on a ring around each hole, not only
  inside it; otherwise fills come out bright.
- A direction supported by only a few valid pixels has near-zero variance and
  wins wrongly; require support on both halves of the line.
- Directional fills cannot rebuild a glowing edge across a big hole; fit the
  geometry and use a profile guide.
- Fill holes in the static mass, or the sides of a bright emblem get extracted.
- ffmpeg converts PNG to YUV with BT.601 by default; with BT.709 tags, colours
  shift (green +5). `encode.sh` sets the matrix explicitly.
- An odd width cannot be 4:2:0; pad by smearing the edge column.
- Canvas `toDataURL` frames are exact (WebGL needs `preserveDrawingBuffer`,
  which `?capture` sets). Page screenshots are only for UI checks.

## Files

```
scripts/artkit.py         library: masks, shape extraction, guided fill, profile guides, unmix,
                          row_span, glows, Wind, particles, export, install_page
scripts/extract_shapes.py exploration CLI for a new picture
scripts/capture.mjs       deterministic frame capture (Playwright), --times / --off / --scale
scripts/compare.py        PSNR/SSIM/MAE + side-by-side and contact sheets
scripts/screenshot.mjs    viewer page screenshot at any viewport
scripts/encode.sh         PNG frames -> MP4 (BT.709, even size, faststart)
scripts/bundle.py         inline scripts -> single HTML (--fragment for Artifact)
scripts/pipeline.sh       build -> capture -> compare -> seam check -> encode -> bundle
engine/animator.js        the renderer (WebGL2 + Canvas2D fallback)
engine/template.html      the viewer page ({{TITLE}} filled by install_page)
templates/build_scene_starter.py  zero-edit starting point for a new picture (wind on by default)
```

## Worked example numbers (art/ascension)

The source is 827x1026. 67 diamonds are set loose and 10 components stay in the
plate. The triangle was fitted to 0.06 px median residual and is equilateral.
The head plume is 6,000 diamonds plus 70 soft core puffs. In total there are 20
layers and about 9,600 particles on a 12 s loop with gusts at 2.6, 5.4 and 7.8 s.
SSIM against the source runs 0.79 to 0.84, the largest frame step is 3.4
against a 2.6 median, and the seam step is 1.5. The MP4 is 13.6 MB at CRF 18, 60 fps.
