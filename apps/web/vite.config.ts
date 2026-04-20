/**
 * Vite configuration for the React frontend.
 *
 * Vite serves the development site at http://localhost:5173 and builds the
 * static frontend files into apps/web/dist for deployment.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  }
});
