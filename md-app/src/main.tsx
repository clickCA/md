import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTypography, loadTypography } from "./lib/typography";
import "./index.css";

// Apply persisted editor typography before the first paint to avoid a
// visible font/size flash when a note opens.
applyTypography(loadTypography());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
