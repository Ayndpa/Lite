import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
/** codeLanguages: LanguageDescriptions for fenced code blocks (from the editor's registry). */
export const load = (codeLanguages) => markdown({ base: markdownLanguage, codeLanguages });
