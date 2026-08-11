import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGateway } from "./auth/AuthGateway";
import { LivingAtlasApp } from "./journey/LivingAtlasApp";
import "./styles/tokens.css";
import "./app.css";
import "./styles/archive-shell.css";
import "./styles/artwork-browser.css";
import "./styles/personal-artifact.css";
import "./styles/personal-gallery.css";
import "./styles/auth-gate.css";
import "./styles/living-atlas.css";

const Experience = import.meta.env.DEV
  && new URLSearchParams(window.location.search).has("qaState")
  ? App
  : LivingAtlasApp;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGateway>
      <Experience />
    </AuthGateway>
  </StrictMode>,
);
