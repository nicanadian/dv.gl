import { defineConfig } from "tsup";

// Bundle the façade into ONE self-contained artifact: inline the first-party
// @dvgl/* workspace packages (so the published package carries no `workspace:*`
// deps a git-SHA install can't resolve) while keeping satellite.js external (a
// real dependency) and @webgpu/types external (a types-only peer). No sourcemaps
// -- they would point into src/, which `files` excludes.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // a non-composite, maps-off tsconfig for emit: the composite project config trips
  // the dts bundler (TS6307), and declaration/source maps would point into src/.
  tsconfig: "tsconfig.build.json",
  // resolve + inline transitive types into ONE self-contained .d.ts (the @dvgl/*
  // re-exports otherwise leave unresolvable specifiers); @webgpu/types stays an
  // ambient global via the peer dep, satellite.js types aren't in the public API.
  dts: { resolve: true },
  sourcemap: false,
  clean: true,
  treeshake: true,
  external: ["satellite.js", "@webgpu/types"],
  noExternal: [/^@dvgl\//],
});
