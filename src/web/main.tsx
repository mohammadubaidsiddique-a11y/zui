import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerWebPayloadStore } from "./opfs";
import "./styles.css";

// Disk-backed (OPFS) encode spool so multi-GB wraps stay memory-flat in this
// browser instead of buffering the whole container in RAM.
if (typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function") {
  try {
    registerWebPayloadStore();
  } catch {
    /* fall back to the in-memory store */
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);