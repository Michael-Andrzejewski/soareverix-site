// Adds a content hash to the asset URLs in public/index.html.
//
// soareverix.com serves JS and CSS with a 4-hour browser cache but never caches
// the HTML, so without this a visitor can get new HTML running yesterday's code.
// Runs on every Cloudflare build through "postinstall", since the build command
// is `npm ci`. Run it by hand with `npm run stamp`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const PAGE = 'public/index.html';
let html = fs.readFileSync(PAGE, 'utf8');
for (const name of ['karyon.css', 'ascii.js', 'app.js']) {
  const hash = createHash('sha256').update(fs.readFileSync(`public/assets/${name}`)).digest('hex').slice(0, 10);
  const url = new RegExp(`assets/${name.replace('.', '\\.')}(\\?v=[0-9a-f]+)?"`, 'g');
  if (!url.test(html)) throw new Error(`${PAGE} does not reference ${name}`);
  html = html.replace(url, `assets/${name}?v=${hash}"`);
  console.log(`${name}?v=${hash}`);
}
fs.writeFileSync(PAGE, html);
