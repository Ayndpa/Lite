// Registers Python with the editor. The parser (lang.js, built from src/lang.js)
// is only fetched and evaluated the first time such a file is opened.
export async function activate(ctx) {
  const editor = await ctx.services.get("editor");
  const parser = () => import(ctx.assets.url("lang.js"));
  editor.registerLanguage({
    id: "python",
    name: "Python",
    extensions: [".py",".pyw",".pyi"],
    aliases: ["py"],
    load: async () => (await parser()).python(),
  });
}
