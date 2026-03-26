import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://hiruzen.github.io",
  base: "/Portfolio/",
  output: "static",
  vite: {
    plugins: [tailwindcss()]
  }
});
