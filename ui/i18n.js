// Localization primitives shared by the kernel and plugins.
// Messages are flat JSON maps per locale; English is the fallback for every key.

export const DEFAULT_LOCALE = "en";
/** Supported locales with their native names (always shown in their own language). */
export const LOCALES = [
  { id: "en", name: "English" },
  { id: "zh-CN", name: "简体中文" },
];

export function systemLocale() {
  return /^zh/i.test(navigator.language) ? "zh-CN" : "en";
}

/** preference: a locale id, or null/"auto" to follow the system. */
export function resolveLocale(preference) {
  return LOCALES.some((l) => l.id === preference) ? preference : systemLocale();
}

export const localeName = (id) => LOCALES.find((l) => l.id === id)?.name ?? id;

/**
 * Load English plus the target locale through `read(locale)` (returns JSON text or throws).
 * Returns { messages, english }.
 */
export async function loadMessages(locale, read) {
  const parse = async (loc) => {
    try {
      return JSON.parse(await read(loc));
    } catch {
      return {};
    }
  };
  const english = await parse(DEFAULT_LOCALE);
  const messages = locale === DEFAULT_LOCALE ? english : { ...english, ...(await parse(locale)) };
  return { messages, english };
}

/** t("key", { n: 3 }) -> message with {n} replaced; unknown keys come back as-is. */
export function translator(messages) {
  return (key, params = {}) =>
    (messages[key] ?? key).replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** "%name%" -> translated; anything else unchanged. */
export function resolvePlaceholder(value, t) {
  const m = typeof value === "string" && value.match(/^%([\w.-]+)%$/);
  return m ? t(m[1]) : value;
}
