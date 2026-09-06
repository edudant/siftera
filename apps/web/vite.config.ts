import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_PATH nastavuje build pro GitHub Pages (podcesta repozitáře); lokálně a v hosted Workeru zůstává "/".
export default defineConfig({ base: process.env.BASE_PATH ?? "/", plugins: [react()] });
