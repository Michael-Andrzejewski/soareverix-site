---
name: animate-art
description: Turn a still artwork (illustration, digital painting, poster) into a faithful, seamlessly looping animation, gentle or dramatic (gusting wind, smoke rising, fragments tearing loose), delivered as a self-contained web page and an MP4 and verified against the original with screenshots and metrics. Use when asked to animate a picture, bring an image to life, make a cinemagraph or living version of art, or make "an animated version of this".
---

# animate-art

Make a still picture move without losing it. The original pixels stay the base
layer (the "plate"). Only what must move is cut out and rebuilt as particles,
and every effect is an overlay. The composition stays the artist's in every
frame, and every loop passes exactly through the original: frame 0 is the
source picture bit for bit (the `rest` layer, below).

Worked examples, read the nearest one's `build_scene.py` before starting:
- `art/ascension/`: a figure dissolving into diamonds under a glowing triangle,
  in a storm-force updraft (particles, plate refill, wind).
- `art/maelstrom/`: a figure at the eye of a painted vortex; the whole painting
  swirls while the camera dives in and pulls back out (camera moves, see
  "Camera moves: swirl and zoom").
- `art/constellation/`: a figure on a platform under a web of golden lines and
  stars. The web draws itself out of the planet's horizon, line by line, while the
  camera pulls back from the figure, then withdraws the same way (see "Growing a
  structure: reveal by activation").

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
- events have rhythm: surges of different strengths (calm-then-gust if asked
  for gusts; a storm that never drops if asked for a seamless storm)
- light sources respond to the events (glow surges with each gust)
- measure it: `scripts/motion.py framesdir` reports optical-flow speed (frame
  heights per second) and the share of the frame in motion. Ascension's rising
  storm (accepted as intense) averages 0.078 H/s with 54% of the frame moving;
  Maelstrom's swirl and zoom average 0.53 H/s with 95% moving. A piece meant to be
  intense should land near or above Ascension, and report the numbers.
- get the direction right. Ascension went through "blowing sideways" before
  the wanted "storm-force wind rising upward around the figure, not diagonal".
  A rising storm is `Wind(..., dir=(0, -1), sweep="up", ground=H, base=0.75,
  steady_flutter=0.6)`: the floor never drops, surges rise from the ground up,
  and sideways motion is only turbulence (sway, waver)

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
  to sway a whole layer like a plume rooted at yBot in a sideways wind, or
  `waver: {amp, k, wl, yBot, H}` for ripples rising up a smoke column in an
  updraft. `stretch: 16` with `shape: 'square'` makes thin motion streaks (faint,
  additive, fast) that show the wind itself.
- `path`: particles running along a polyline (`k` laps per loop).
- **Wind**: `wind = ak.Wind(LOOP, gusts=[(strength, peak_s, width_s), ...])`,
  then `scene["wind"] = wind.to_scene()`. A particle with `wd` (px per unit
  gust-second) is pushed by the integral of the gust since its birth. Gust fronts
  sweep left to right (`sweep="right"`) or rise from the ground (`sweep="up"`) at
  `front` px/s. Python and JS share the same tables, so placement at t = 0 is
  exact. With the rest layer, keep about 2 s of calm around t = 0.

**Turning a textured mass into rising smoke** (the ascension head): cut the mass
out (`row_span`), unmix it, and rebuild it as a steady-state cloud of thousands
of short-lived shapes. Births are sampled from its alpha map
(`weight = alpha ** 1.6`), colours come from the source pixels, each shape rises
and accelerates for 2-3 s, and the layer bends with the gusts. Add a few soft
dark glow puffs under it to keep the core smooth. Calibrate the count: render
only plate + cloud (`capture.mjs --off ...`) and match the region's mean
luminance to the source (here 34 vs 35).

**Exact match at the loop point** (optional): put `ak.rest_layer(ak.file_data_uri(source))`
on top. It shows the untouched source (the file's own bytes, never re-encoded)
within `hold` s of the loop point and eases out over `fade` s. Schedule the
calm there (no gusts within ~2 s), so the picture wakes up, storms, and settles
back into the exact original. Verify with a max-abs-diff of frame 0 against the
decoded source: it must be 0. An MP4 cannot be bit-exact (4:2:0 compression);
expect about 44 dB PSNR there at CRF 18. The cost: the motion dies down and
dissolves into the still every loop, which reads as a reset. For a continuous
storm leave it off (ascension does, `REST = False`); the loop is still seamless.

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
  SSIM above 0.92 every frame. A dramatic one sits around 0.80 mid-storm
  (ascension v2: 0.79 to 0.84) and must still read as the same picture; with
  the rest layer, SSIM is 1.0 at the loop point and frame 0 differs from the
  source in 0 pixels.
- Check every consecutive frame step: the maximum should be near the median (no
  pops), and the seam step (last frame to first) should be typical. `pipeline.sh`
  prints the seam check.
- Check the direction of motion with a long exposure: average 0.5 s of frames
  (`capture.mjs --fps 60 --seconds 0.5 --start 4`, then mean them). Every moving
  thing leaves a trail; in an updraft they must all be vertical.
- `screenshot.mjs page.html out.png --w 1440 --h 900 --dpr 2` and
  `--w 390 --h 844 --dpr 2` check the viewer page and horizontal overflow.
- Render one frame with `?renderer=canvas2d` and compare it with WebGL2 (mean
  difference should be under 1/255).
- Decode the MP4 (`ffmpeg ... scale=in_color_matrix=bt709 ...`) and compare
  with the PNG frames: mean RGB shift under 0.5.

### 6. Deliver
- MP4: `encode.sh frames out.mp4 60 20`. Busy scenes are large at CRF 15
  (ascension v3: 26 MB; 14.5 MB at CRF 20).
- For players that do not loop, chain the loop:
  `ffmpeg -stream_loop 2 -i out.mp4 -c copy -movflags +faststart out-36s.mp4`.
  The decoded step at the join should equal the step at an internal keyframe
  (ascension: 5.87 vs 5.88), so the join is invisible.
- Web: `bundle.py index.html page.html --fragment`, then publish with the
  Artifact tool (republish the same file path to keep the URL). Send the MP4
  and a labelled comparison sheet with SendUserFile.

## Camera moves: swirl and zoom

For pictures with a centre of attention (a vortex, tunnel, eye, flower, galaxy),
move the camera instead of only the parts:
- `scene.camera = {cx, cy, zmax, revs, omega0, twist, r0, roll, shutter}`. Zoom
  goes 1 -> zmax -> 1 once per loop. The swirl turns exactly `revs` times per loop
  (speed omega0 at the loop point, fastest at full zoom), and inner rings run up to
  `twist` rad ahead (exp(-r / r0)), tightening on the way in and relaxing on the way
  out. Everything lines up again at the loop point, so the loop is exact.
- A `vortex` layer draws the whole frame with a shader: polar swirl, zoom, roll,
  rotational and zoom motion blur (`shutter` s), a chromatic fringe and a vignette;
  `gain` lifts exposure at full zoom so a dark centre still reads.
- Rotating a rectangle exposes its corners. `ak.polar_outpaint(img, centre, R)`
  continues every ring around the full circle (ping-pong reflection of the
  covered arcs), keeping the original pixels exact inside the frame.
- Zooming magnifies: build from `ak.upscale(src, 2)` and render the video at
  `SCALE=1.5`.
- Cut anything that must not spin (the figure) out of the master with
  `guided_fill` + `unmix`, and draw it as an `image` layer with `camera: true`, so
  it only zooms.
- Particles: `orbit` layers spiral around the centre with the swirl (`m` times its
  speed, inward at rate `k`) and draw as streaks along their motion. `parallax > 1`
  makes a layer feel closer to the lens. Keep streaks short (`st` 0.3 to 1) and
  flecks faint, or the painting turns into a sci-fi starfield.
- Too much `shutter` turns brushwork into smooth rings. About 0.025 s keeps the
  strokes readable at the loop point and still smears at full spin.

## Growing a structure: reveal by activation

For pictures with a drawn structure (a network, vines, cracks, lightning, a
circuit, a mandala), build it up instead of moving it:
- **Split** the structure off the plate. A white top-hat (17 px ellipse at 2x)
  finds thin bright lines and dots; the web is the one huge connected component,
  and off-line dots join it by colour (warm added light, top-hat R over B > 1.1)
  while white ones stay as background stars. Faint and out-of-focus lines need a
  ridge filter (`skimage.filters.sato`) with hysteresis, run again with wider
  sigmas on the cleaned plate, keeping only straight pieces (PCA width < 2.2 px).
  Saturated star cores are flat, so the top-hat skips their centres: fill small
  holes in the mask (< 3000 px). Glow halos around bright nodes need their own
  mask (`t41 > 30` near the cores).
- **Fill** the plate with `ak.smooth_fill` (push-pull membrane), not
  `guided_fill`: under soft sky, directional fills paint blotches into large halo
  holes. Network RGBA = `ak.unmix(master, plate)` inside the mask, so the
  full reveal composes back to the original (41 dB here).
- **Activation**: geodesic distance from the seeds (`skimage.graph.MCP_Geometric`,
  cost 1 on the structure, 5 across empty sky, high through the subject),
  normalised by the main web only (a stray far piece otherwise compresses
  everything), mapped into 0.03 to 0.9 so every flash finishes before G = 1.
  Stored at 1x as 16 bits in R (high) and G (low) of a PNG, sampled NEAREST.
- **Engine**: `scene.grow = {hold, ease}` sweeps G 0 -> 1 -> 0 once per loop. A
  `reveal` layer shows each pixel once G passes its level and glows the front
  (gated to near-opaque cores: the fringe alpha of an unmixed line is noisy and a
  glow amplifies it into speckle). `nodes` layers flash sprites as G passes their
  level: node flares (gaussian pulse), and comets of sparks spaced 3.5 px along
  the line skeleton (`decay: 'exp'`, tight pulse).
- **Pull-back camera**: `camera = {drive: 'grow', cx, cy, zmax, log: true, hold,
  ease, roll}` zooms about a fixed point near the subject, close at the loop point
  and at 1x when the structure is complete, so mid-loop is the original picture.
  Put the sky on `parallax` 0.85 and the subject on 1.0: the subject is cut out
  (dark mask, small holes filled, the bright gap between the legs kept) and only a
  thin band behind it is ever revealed.
- **Pacing**: `ease: 3` (smoothstep) spends more of the loop in motion than
  smootherstep. Use light holds (0.04 / 0.08 of a half loop); 30 s loops grow for
  about 10 s.
- **The start**: tie a horizon glow at the seeds to `wave: 'grow'` with a negative
  amp and rising motes to `growrate`, so light gathers at the source before the
  lines leave it.

## Engine reference

`engine/animator.js` is a pure function of time. `ArtAnimator.create(canvas,
scene, {scale, preserve, renderer})` returns `{render(t), renderer, wind, camera}`.
WebGL2 draws all particles of a layer in one instanced call, so about 10k
particles cost about 5 ms per frame even in software. Canvas2D is the fallback
(about 45 ms per frame for 10k). The scene format is documented at the top of
the file. `engine/template.html` adds the controls and these URL parameters:
`?capture`, `?t=3.5`, `?off=a,b`, `?scale=2`, `?renderer=canvas2d`.
Drivers: `scene.wind` (gusts), `scene.camera` (swirl + zoom, or `drive: 'grow'`
pull-back), `scene.grow` (structure growth G). Anim waves: `sin01`, `sin`, `beat`,
`wind`, `rest`, `zoom`, `grow`, `growrate`.

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
- `capture.mjs --times` used to name stills `t3.00.png`, `t10.50.png`, which sort
  by name as t10 before t3 and scrambled a contact sheet. Names are now zero-padded
  (`t003.00.png`); still label sheets from the times, not the file order.
- `guided_fill` used to fall back to Telea on the original image, so bright hole
  pixels leaked into unresolved fills. It now inpaints from the filled values.
- Glowing a revealed overlay by its alpha lights up its noisy fringe; gate glows to
  alpha > ~0.55.

## Files

```
scripts/artkit.py         library: masks, shape extraction, guided fill, smooth fill, profile guides, unmix,
                          row_span, upscale, polar_outpaint, glows, Wind, particles, export,
                          install_page
scripts/extract_shapes.py exploration CLI for a new picture
scripts/capture.mjs       deterministic frame capture (Playwright), --times / --off / --scale
scripts/compare.py        PSNR/SSIM/MAE + side-by-side and contact sheets
scripts/motion.py         optical-flow motion intensity, to compare pieces (frame heights/s)
scripts/screenshot.mjs    viewer page screenshot at any viewport
scripts/encode.sh         PNG frames -> MP4 (BT.709, even size, faststart)
scripts/bundle.py         inline scripts -> single HTML (--fragment for Artifact)
scripts/pipeline.sh       build -> capture -> compare -> seam check -> encode -> bundle (SCALE=1.5)
engine/animator.js        the renderer (WebGL2 + Canvas2D fallback)
engine/template.html      the viewer page ({{TITLE}} filled by install_page)
templates/build_scene_starter.py  zero-edit starting point for a new picture (wind on by default)
```

## Worked example numbers (art/ascension)

The source is 827x1026. 67 diamonds are set loose and 10 components stay in the
plate. The triangle was fitted to 0.06 px median residual and is equilateral.
The head plume is 6,000 diamonds plus 70 soft core puffs. In total there are 21
layers and about 9,800 particles on a 12 s loop in a never-calm updraft with
surges at 1.2, 4.3, 7.2 and 10.0 s.
SSIM against the source runs 0.76 to 0.78 (busy storm). The seam step is 4.39
against a 4.49 median and the largest step is 5.53, so there are no pops. The MP4
is 14.5 MB at CRF 20, 60 fps. With the rest layer on (v2), frame 0 was identical
to the source (0 of 848,502 pixels differ).

## Worked example numbers (art/maelstrom)

The source is 600x771, upscaled 2x and outpainted to a 2190 px canvas. The swirl
and zoom centre on the figure at (312, 372). The camera zooms 1x -> 2.8x -> 1x
while the vortex turns 3 times per 12 s loop (0.8 to 2.3 rad/s), with 1.6 rad of
inner twist. There are 9 layers and about 1,950 particles, rendered at 900x1158 and
60 fps. Frame steps run around a 7.7 median with a max of 8.7, and the seam step is
8.1, so the loop is seamless with no pops. SSIM against the still is 0.66 at the loop
point and about 0.28 at full zoom, as expected for a camera move. The MP4 is 11.3 MB
at CRF 20.
