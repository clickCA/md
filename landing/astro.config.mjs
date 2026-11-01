import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Static marketing site: zero framework JS ships to the browser — the only
// script on the page is the inline theme toggle. Tokens come from the app
// (md-app/theme.css) so the landing can't drift from the product's palette.
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
