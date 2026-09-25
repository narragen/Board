import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installBoardChartTheme } from "./chart-theme.ts";
import { App } from "./components/App.tsx";
import "./fonts.css";
import "./styles.css";

// Board scripts run in this document (D18), so a global the app defines is
// reachable from them. Installed before render so it exists no matter when a
// board mounts.
installBoardChartTheme();

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("missing #root element");
}
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
