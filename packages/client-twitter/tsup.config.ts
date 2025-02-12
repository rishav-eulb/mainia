import { defineConfig } from "tsup";
import { builtinModules } from "module";
import pkg from "./package.json";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"], // Ensure you're targeting CommonJS
    dts: true,
    splitting: false,
    minify: false,
    platform: "node",
    target: "node23",

    // Bundle problematic packages
    noExternal: [
        "agent-twitter-client",
        "got",
        "form-data",
        "combined-stream",
        "delayed-stream",
        "mime-types",
        "mime-db",
        "asynckit",
        "url"
    ],

    external: [
        ...builtinModules.filter(mod => mod !== "url"),
        ...Object.keys(pkg.dependencies || {})
            .filter(dep => !["agent-twitter-client", "got", "form-data", "combined-stream", 
                           "delayed-stream", "mime-types", "mime-db", "asynckit"].includes(dep))
    ],

    esbuildOptions: (options) => {
        options.mainFields = ["module", "main"];
        options.banner = {
            js: `
                import { createRequire } from "module";
                import { fileURLToPath } from "url";
                import { dirname } from "path";
                const require = createRequire(import.meta.url);
                const __filename = fileURLToPath(import.meta.url);
                const __dirname = dirname(__filename);
            `
        };
        options.define = {
            "process.env.NODE_ENV": '"production"'
        };
    }
});
