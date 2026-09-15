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
  const protocol = (info, key) =>
    Boolean(isChakshu(info) && profile(info).protocols[key] === 1 && info[key + 'Version'] === 1);
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
    hasMedia,
    hasVoice,
    canCapture,
    hardwareCheck,
  });
  root.SynapCapabilities = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
