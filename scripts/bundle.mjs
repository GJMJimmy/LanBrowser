import { build } from "esbuild";
import "./generate-assets.mjs";

await build({
  entryPoints: ["src/server.js"],
  outfile: "dist/app.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});
