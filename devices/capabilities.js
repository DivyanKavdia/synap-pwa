(function (root) {
  'use strict';
  const profiles = root.SynapDeviceProfiles || require('./profiles.js');
  const { FLAGS, BY_MODULE } = profiles;
  function profile(info) {
    const known = info && Object.hasOwn(BY_MODULE, info.id) && BY_MODULE[info.id];
    return known && known.target === info.target ? known : null;
  }
  function supports(info, feature) {
    const known = profile(info),
      bit = FLAGS[feature];
    return Boolean(known && bit && known.features.includes(feature) && info.supported & bit);
  }
  const ready = (info, feature) =>
    supports(info, feature) && !info.legacy && Boolean(info.ready & FLAGS[feature]);
  const isChakshu = (info) => profile(info)?.adapter === 'xiao-sense' && !info.legacy;
  function cameraConnection(connection, client) {
    if (!connection) return { state: 'disconnected', message: 'Connect Chakshu for camera capture.' };
    if (!client || client.closed || client.context !== connection)
      return { state: 'detecting', message: 'Pendant connected. Reading its camera capabilities…' };
    const info = client.module;
    if (!info)
      return { state: client.error ? 'unavailable' : 'detecting', message: client.error
        ? 'Pendant connected, but camera capabilities could not be read. Refresh hardware status in Settings.'
        : 'Pendant connected. Reading its camera capabilities…' };
    if (!isChakshu(info))
      return { state: 'unsupported', message: (profile(info)?.name || 'This pendant') + ' is connected. Connect Chakshu for camera capture.' };
    if (!connection.deviceId)
      return { state: 'unavailable', message: 'Chakshu connected, but its device ID could not be read. Reconnect to identify it.' };
    return { state: 'connected', message: 'Chakshu connected.' };
  }
  function protocol(info, key) {
    const expected = isChakshu(info) ? profile(info).protocols[key] : 0;
    return Boolean(Number.isInteger(expected) && expected > 0 && info[key + 'Version'] === expected);
  }
  const hasMedia = (info) => protocol(info, 'media');
  const hasVoice = (info) => protocol(info, 'voice') && supports(info, 'audio');
  function canCapture(info, kind, offline = false) {
    return (
      hasMedia(info) &&
      ['photo', 'video'].includes(kind) &&
      ready(info, 'camera') &&
      ready(info, kind) &&
      (kind !== 'video' || ready(info, 'audio')) &&
      (!offline || (ready(info, 'sd') && (kind !== 'video' || ready(info, 'sdAudio'))))
    );
  }
  function hardwareCheck(info, operation, requireReady = false) {
    if (!isChakshu(info)) return false;
    const needs = {
      1: [],
      2: ['photo', 'camera', 'sd'],
      3: ['sdAudio', 'audio', 'sd'],
      4: ['video', 'camera', 'sd'],
    }[operation];
    return Boolean(
      needs && needs.every((feature) => (requireReady ? ready : supports)(info, feature)),
    );
  }
  const api = Object.freeze({
    profile,
    supports,
    ready,
    isChakshu,
    cameraConnection,
    hasMedia,
    hasVoice,
    canCapture,
    hardwareCheck,
  });
  root.SynapCapabilities = api;
  // Keep index.html stable: capability discovery owns the optional voice companion.
  // Guard Node/native tests where document does not exist.
  if (
    typeof root.document?.querySelector === 'function' &&
    typeof root.document?.createElement === 'function' &&
    root.document.head &&
    !root.document.querySelector('script[data-synap-chakshu-voice]')
  ) {
    const script = root.document.createElement('script');
    script.src = 'devices/chakshu/voice.js?v=1.0.0-chakshu-voice2';
    script.defer = true;
    script.dataset.synapChakshuVoice = '2';
    root.document.head.append(script);
  }
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);