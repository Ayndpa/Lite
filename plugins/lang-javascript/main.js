// Registers JavaScript, JavaScript JSX, TypeScript, TypeScript JSX with the editor. The parser (lang.js, built from src/lang.js)
// is only fetched and evaluated the first time such a file is opened.
export async function activate(ctx) {
  const editor = await ctx.services.get("editor");
  const parser = () => import(ctx.assets.url("lang.js"));
  editor.registerLanguage({
    id: "javascript",
    name: "JavaScript",
    extensions: [".js",".mjs",".cjs"],
    aliases: ["js","node"],
    load: async () => (await parser()).javascript(),
  });
  editor.registerLanguage({
    id: "jsx",
    name: "JavaScript JSX",
    extensions: [".jsx"],
    aliases: [],
    load: async () => (await parser()).javascript({"jsx":true}),
  });
  editor.registerLanguage({
    id: "typescript",
    name: "TypeScript",
    extensions: [".ts",".mts",".cts"],
    aliases: ["ts"],
    load: async () => (await parser()).javascript({"typescript":true}),
  });
  editor.registerLanguage({
    id: "tsx",
    name: "TypeScript JSX",
    extensions: [".tsx"],
    aliases: [],
    load: async () => (await parser()).javascript({"jsx":true,"typescript":true}),
  });
}
