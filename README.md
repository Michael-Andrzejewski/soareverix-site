# soareverix.com

Personal website for Soareverix (Michael Andrzejewski).

The intro is a brief glimpse of a polygonal blue eye rendered in three.js: faceted iris split three blue, one amber, with rotating geometric line work. The camera dives into the pupil (about three seconds, click to skip) and the site fades in.

The main page is a set of hand-built SVG scenes: a kid watching fireworks frozen in the night (hero), Staravorix (fire caster), Vintage Story (snoozer by the gear tree), AI Alignment Research (workbench, spilled matrices, and a small mechanical octopus), Convergence (telescope and golden-ratio galaxy), and Romance and other Ramblings (a couple on a meadow path at dusk). Tabs across the top scroll to each section.

Typography is Fraunces (display serif), Inter (text), and JetBrains Mono (labels), from Google Fonts with system fallbacks. The palette is gold and blue on near-black. After the hero comes a short prelude ("All of life is practice.") with a chapter index. Each scene then sits under a numbered chapter header, with a serif lede and a detail column: the rune quote for Staravorix, the named mods and the Rustfall modpack for Vintage Story, PrefDecay-Eval results for Alignment, the seven steps of Convergence (Star to Cycle). A sixth chapter, Things I've Made, is a gold-to-blue timeline from the first bedtime stories through City Breaker, Hanger VR, FitFight, Civilization Sim, and the 2026 Vintage Story mods. The nav highlights the current chapter, and a thin gold-to-blue bar tracks reading progress.

## Run locally

Any static server works:

```
python -m http.server 5502
```

Then open http://localhost:5502.

## Testing hooks

Query params used for automated screenshots:

- `?ff=N` fast-forwards the intro timeline N seconds deterministically and forces all facet shards visible.
- `&compact=1` (with `ff`) shrinks the hero so all sections fit one viewport.
- `&fp=0.5` pins the scroll-driven fire cast to a fixed progress (0 to 1).
- `&go=projects` (with `ff`) or a `#projects` hash jumps to a section after the intro.

Every major shape in the scenes is generated at load by a small facet engine (seeded, deterministic): shapes are defined as polygon outlines and filled with a jittered triangular lattice snapped to the boundary, the same construction as the intro eye. Shards assemble with staggered delays when a section scrolls into view; the fireworks bloom on load; the Staravorix fire pours out shard by shard with scroll progress.

Click, Enter, or Space skips the intro. `prefers-reduced-motion` skips it automatically.

## Deploy (Cloudflare Pages)

1. Cloudflare dashboard: Workers and Pages, Create, Pages, Connect to Git, pick this repo.
2. Framework preset: None. Build command: empty. Output directory: `/`.
3. Add `soareverix.com` as a custom domain on the project once DNS is on Cloudflare.

Every push to main deploys automatically.

## Art

`art/ascension/` is an animated version of the glowing-triangle figure piece: the head rises as smoke and diamond fragments climb around the figure in a storm-force updraft, in a seamless 12 s loop (open `art/ascension/index.html`; hold the button or press O to compare with the original). It is built by `art/ascension/build_scene.py` with the reusable `animate-art` toolkit in `.claude/skills/animate-art/`; see its `SKILL.md` for the process. `.claude/skills/animate-art/scripts/pipeline.sh art/ascension` regenerates the MP4.

`art/maelstrom/` animates the vortex painting: the maelstrom swirls around the glowing figure while the camera dives in close and pulls back out, in a seamless 12 s loop (`SCALE=1.5 .claude/skills/animate-art/scripts/pipeline.sh art/maelstrom` for the MP4).
