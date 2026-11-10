// Registers HTML with the editor. The parser (lang.js, built from src/lang.js)
// is only fetched and evaluated the first time such a file is opened.
export async function activate(ctx) {
  const editor = await ctx.services.get("editor");
  const parser = () => import(ctx.assets.url("lang.js"));
  editor.registerLanguage({
    id: "html",
    name: "HTML",
    extensions: [".html",".htm",".xhtml"],
    aliases: [],
    load: async () => (await parser()).html(),
  });
}
