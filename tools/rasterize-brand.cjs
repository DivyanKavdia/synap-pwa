/* Export installable PNGs from the code-native, self-contained icon.svg.
 * Requires sharp to be resolvable by Node. Run: node tools/rasterize-brand.cjs
 * logo.webp remains the original silhouette source, not a live UI asset.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const wordmark = fs.readFileSync(path.join(root,'synap-logo.svg'),'utf8');
const palettes = {light:['#21654c','#75ad91','#183c34'],dark:['#9cdbb7','#75ad91','#edf5ef'],
  'blue-light':['#285e9b','#83a9d5','#1d3554'],'blue-dark':['#a4c9ff','#83a9d5','#eff5ff'],
  'pink-light':['#993d69','#ce8dad','#542c41'],'pink-dark':['#f5adce','#ce8dad','#fff0f7'],
  'lavender-light':['#65489b','#aa93cc','#3d315b'],'lavender-dark':['#c9b3f4','#aa93cc','#f5f0ff']};
Promise.all([
  ...[192,512].map(size => sharp(path.join(root,'icon.svg'),{density:192})
    .resize(size,size).png().toFile(path.join(root,`icon-${size}.png`))),
  ...Object.entries(palettes).map(([mode,colors]) => {
    // Explicit pixels avoid external SVG mask / embedded media-query differences
    // between Chromium and installed Safari PWAs. SVG remains the source asset.
    const svg = wordmark.replace(/var\(--(mark-start|mark-end|wordmark)\)/g,
      (_,token) => colors[['mark-start','mark-end','wordmark'].indexOf(token)]);
    return sharp(Buffer.from(svg)).resize(800,216).png({compressionLevel:9})
      .toFile(path.join(root,`synap-logo-${mode}.png`));
  })
])
  .then(() => console.log('Exported palette wordmarks and 192px/512px app icons.'))
  .catch(error => { console.error(error); process.exitCode=1; });
