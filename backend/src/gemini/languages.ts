// Provider-supported hints, not arbitrary browser preference strings.
// https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe
// Regional variants stay explicit; a bare language uses the first entry below.
const supported = `
af-ZA am-ET ar-EG hy-AM as-IN az-AZ be-BY bn-BD bn-IN bs-BA bg-BG rup-BG
my-MM yue-Hant-HK ca-ES ceb km-KH hr-HR cs-CZ da-DK nl-NL en-IN en-GB en-US
et-EE fa-IR fil-PH fi-FI fr-FR gl-ES ka-GE de-DE el-GR gu-IN ha-NG he-IL
hi-IN hu-HU is-IS id-ID it-IT ja-JP jv-ID kea-CV kn-IN kk-KZ ko-KR ky-KG
lv-LV ln-CD lt-LT mk-MK ms-MY ml-IN mt-MT cmn-Hans-CN mr-IN
mn-MN ne-NP nb-NO or-IN pl-PL pt-BR pt-PT pa-IN pa-Guru-IN ro-RO
ru-RU sr-RS sd-Arab-IN sk-SK sl-SI es-419 es-US sw-KE sv-SE tg-TJ
te-IN th-TH tr-TR uk-UA uz-UZ vi-VN
`.trim().split(/\s+/);

const hints = new Map<string, string>();
for (const code of supported) {
  hints.set(code.toLowerCase(), code);
  const language = code.split('-')[0]!;
  if (!hints.has(language)) hints.set(language, code);
}

/** Invalid, mixed, and unknown preferences use multilingual auto-detection. */
export function transcriptionLanguageCodes(preference: string): string[] | undefined {
  const code = hints.get(preference.trim().replaceAll('_', '-').toLowerCase());
  return code ? [code] : undefined;
}
