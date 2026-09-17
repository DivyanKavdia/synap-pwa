// Generated from devices/catalog.json by tools/device-catalog.cjs.
(function(root) {
  'use strict';
  const catalog = {
  "primaryTarget": "esp32s3-fh4r2-qspi-4m",
  "flags": {
    "audio": 1,
    "camera": 2,
    "sd": 4,
    "settings": 8,
    "touch": 16,
    "battery": 32,
    "standby": 64,
    "video": 128,
    "sdAudio": 256,
    "photo": 512
  },
  "devices": [
    {
      "id": 1,
      "target": "esp32s3-fh4r2-qspi-4m",
      "name": "synap S3",
      "board": "ESP32-S3 SuperMini",
      "adapter": "esp32s3",
      "chip": 9,
      "flashBytes": 4194304,
      "psramBytes": 2097152,
      "partition": "default",
      "maxSize": 1310720,
      "marker": "SYNAP-ESP32S3-OTA-ID-V3",
      "manifestPath": "latest.json",
      "releasePrefix": "",
      "features": ["audio","settings","touch","battery","standby"],
      "protocols": {}
    },
    {
      "id": 2,
      "target": "esp32c3-supermini-4m",
      "name": "synap C3",
      "board": "ESP32-C3 SuperMini",
      "adapter": "esp32c3",
      "chip": 5,
      "flashBytes": 4194304,
      "psramBytes": 0,
      "partition": "default",
      "maxSize": 1310720,
      "marker": "SYNAP-ESP32C3-OTA-ID-V3",
      "manifestPath": "targets/esp32c3-supermini-4m/latest.json",
      "releasePrefix": "targets/esp32c3-supermini-4m/",
      "features": ["audio","settings","touch","battery","standby"],
      "protocols": {}
    },
    {
      "id": 3,
      "target": "xiao-esp32s3-sense-8m",
      "name": "Chakshu",
      "board": "Chakshu (XIAO ESP32S3 Sense)",
      "adapter": "xiao-sense",
      "chip": 9,
      "flashBytes": 8388608,
      "psramBytes": 8388608,
      "partition": "default_8MB",
      "maxSize": 3342336,
      "marker": "SYNAP-CHAKSHU-OTA-ID-V3",
      "manifestPath": "targets/xiao-esp32s3-sense-8m/latest.json",
      "releasePrefix": "targets/xiao-esp32s3-sense-8m/",
      "features": ["audio","camera","sd","settings","video","sdAudio","photo"],
      "protocols": {"media":1,"voice":2}
    }
  ]
};
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const api = freeze({
    PRIMARY_TARGET: catalog.primaryTarget, FLAGS: catalog.flags,
    BY_TARGET: Object.fromEntries(catalog.devices.map(d => [d.target, d])),
    BY_MODULE: Object.fromEntries(catalog.devices.map(d => [d.id, d]))
  });
  root.SynapDeviceProfiles = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
