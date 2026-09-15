'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function generate(catalog) {
  if (catalog.schema !== 1) throw Error('Unsupported device catalog');
  const devices = catalog.devices.map((d) => ({
    id: d.moduleId,
    target: d.id,
    name: d.name,
    board: d.board,
    adapter: d.adapter,
    chip: d.chip,
    flashBytes: d.flashBytes,
    psramBytes: d.psramBytes,
    partition: d.partition,
    maxSize: d.slotSize,
    marker: d.productMarker,
    manifestPath: d.manifestPath,
    releasePrefix: d.releasePrefix,
    features: d.features,
    protocols: d.protocols || {},
  }));
  return `// Generated from devices/catalog.json by tools/device-catalog.cjs.\n(function(root) {\n  'use strict';\n  const catalog = ${JSON.stringify({ primaryTarget: catalog.primaryTarget, flags: catalog.flags, devices }, null, 2)};\n  function freeze(value) {\n    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }\n    return value;\n  }\n  const api = freeze({\n    PRIMARY_TARGET: catalog.primaryTarget, FLAGS: catalog.flags,\n    BY_TARGET: Object.fromEntries(catalog.devices.map(d => [d.target, d])),\n    BY_MODULE: Object.fromEntries(catalog.devices.map(d => [d.id, d]))\n  });\n  root.SynapDeviceProfiles = api;\n  if (typeof module !== 'undefined') module.exports = api;\n})(globalThis);\n`;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--from') {
    const source = fs.readFileSync(path.resolve(args[1], 'devices/catalog.json'));
    generate(JSON.parse(source));
    fs.writeFileSync(path.join(root, 'devices/catalog.json'), source);
  }
  const expected = generate(
    JSON.parse(fs.readFileSync(path.join(root, 'devices/catalog.json'), 'utf8')),
  );
  const output = path.join(root, 'devices/profiles.js');
  if (args.includes('--check')) {
    if (fs.readFileSync(output, 'utf8') !== expected)
      throw Error('Regenerate device profiles: node tools/device-catalog.cjs');
  } else fs.writeFileSync(output, expected);
}
module.exports = { generate };
