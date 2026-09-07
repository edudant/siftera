import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./style.css";

if ("serviceWorker" in navigator) {
  // Na GitHub Pages běží aplikace v podcestě /siftera/; absolutní "/sw.js" tam neexistuje a registrace tiše padá.
  const base = import.meta.env.BASE_URL;
  window.addEventListener("load", () => void navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => { /* bez offline režimu se dá číst dál */ }));
}

createRoot(document.getElementById("root")!).render(<App />);
