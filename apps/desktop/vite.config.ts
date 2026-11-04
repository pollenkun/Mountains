import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page loads from file://, so asset paths stay relative and nothing is inlined into the HTML (CSP is default-src 'self').
export default defineConfig({
	root: fileURLToPath(new URL("src/renderer", import.meta.url)),
	base: "./",
	plugins: [react()],
	build: {
		outDir: fileURLToPath(new URL("dist/renderer", import.meta.url)),
		emptyOutDir: true,
		modulePreload: false,
		assetsInlineLimit: 0,
		target: "chrome140",
	},
	logLevel: "warn",
});
