# soareverix.com

Personal website for Soareverix (Michael Andrzejewski).

## The intro

A polygonal eye rendered in three.js: a faceted iris split into sea blue, ocean teal, deep blue, and one lobe of golden-hour amber, with a ring of warm light around the pupil and rotating geometric line work. It assembles out of a misty dusk sky while warm lantern motes drift upward, breathes for a moment, then the camera dives through the pupil into warm light (about four seconds; click, Enter, or Space skips ahead). When the dive ends, the WebGL context is released.

## The site

There is no body text. Each section is one full-screen painting with a single header, and every painting moves softly. The paintings are made at load time on a canvas: static layers (sky, hills, trees, figures) are painted once per screen size from seeded noise, and a light layer of moving things is drawn over them every frame. One fixed canvas shows the current painting and dissolves into the next as you scroll, with gentle parallax that follows the pointer (or drifts on its own on touch screens).

| Section | Painting |
| --- | --- |
| Soareverix | A hilltop road under a swaying tree, looking down on a sunlit bay: sea glitter, waves on the sand, dappled shade, drifting pollen, a soft lens flare |
| Staravorix | A golden forest with layered trunks fading into the light, god rays, ember-coloured leaves fluttering down, and a wanderer in a red cloak |
| Vintage Story | Rolling green coastal hills with hedgerows and Norfolk pines, swells breaking along a crescent beach, cloud shadows crossing the fields, gulls, rooftops out of focus |
| AI Alignment Research | A lighthouse at blue hour, its beam sweeping and flaring as it turns toward you, a small boat with a lantern, mist on the water |
| Convergence | Stars wheeling slowly around a pole, a golden-angle spiral whose light travels inward, falling stars, fireflies, a watcher with a telescope |
| Romance and other Ramblings | Two figures on a hill at sunset, hair and scarf in the wind, sunset clouds, blossom petals blowing off a lone tree |
| Things I've Made | A misty terraced hillside covered in flickering lanterns, sky lanterns rising into the fog, a walker looking out |

The dots on the right edge jump between sections. Headers fade in out of a blur as their painting arrives.

Inspired by golden-hour coastlines, Yorsh-style glowing forests, and hillsides of lanterns in fog.

## Run locally

Any static server works:

```
python -m http.server 5502
```

Then open http://localhost:5502.

## Testing hooks

- `?ff=N` fast-forwards the intro timeline N seconds deterministically (`?ff=8` lands straight on the site).
- `?go=convergence` (or a `#convergence` hash) jumps to a section once the site opens.

`prefers-reduced-motion` skips the intro and holds every painting still. If three.js cannot load, the site opens on its own after a few seconds.

## Deploy (Cloudflare Pages)

1. Cloudflare dashboard: Workers and Pages, Create, Pages, Connect to Git, pick this repo.
2. Framework preset: None. Build command: empty. Output directory: `/`.
3. Add `soareverix.com` as a custom domain on the project once DNS is on Cloudflare.

Every push to main deploys automatically.
