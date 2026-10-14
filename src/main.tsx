import React from "react";
import ReactDOM from "react-dom/client";
import { AuthGate } from "./Auth";
import "./styles.css";
import { applySavedTheme } from "./theme";

applySavedTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>,
);
