/* Export installable PNGs from the code-native, self-contained icon.svg.
 * Requires sharp to be resolvable by Node. Run: node tools/rasterize-brand.cjs
 * logo.webp remains the original silhouette source, not a live UI asset.
 */
'use strict';
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
Promise.all([192,512].map(size => sharp(path.join(root,'icon.svg'),{density:192})
  .resize(size,size).png().toFile(path.join(root,`icon-${size}.png`))))
  .then(() => console.log('Exported 192px and 512px Synap app icons.'))
  .catch(error => { console.error(error); process.exitCode=1; });
