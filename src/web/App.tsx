import type { JSX } from "react";
import { useEffect, useState } from "react";
import { LabPage } from "./LabPage";
import { SendPage } from "./SendPage";
import { ReceivePage } from "./ReceivePage";

interface RouteInfo {
  mode: "send" | "lab" | "receive";
  share: string | null;
}

function resolveRoute(): RouteInfo {
  const path = window.location.pathname;
  const search = window.location.search;
  const hash = window.location.hash;
  if (path.startsWith("/receiver") || path.startsWith("/receive")) {
    let zui = new URLSearchParams(search).get("zui");
    if (!zui) {
      const q = hash.split("?")[1];
      if (q?.includes("zui")) zui = new URLSearchParams(q).get("zui");
    }
    return zui ? { mode: "receive", share: zui } : { mode: "receive", share: null };
  }
  if (hash.startsWith("#/zui-lab") || hash.startsWith("#zui-lab")) return { mode: "lab", share: null };
  return { mode: "send", share: null };
}

function useRoute(): RouteInfo {
  const [route, setRoute] = useState<RouteInfo>(() => resolveRoute());
  useEffect(() => {
    const onNav = (): void => setRoute(resolveRoute());
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    return () => {
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
    };
  }, []);
  return route;
}

export function App(): JSX.Element {
  const route = useRoute();
  const isLab = route.mode === "lab";
  const isReceive = route.mode === "receive";
  const page =
    isLab ? <LabPage />
    : isReceive ? <ReceivePage share={route.share ?? ""} key={route.share ?? "none"} />
    : <SendPage />;
  return (
    <div className={isLab ? "app" : "app app-send"}>
      <header className="topbar">
        <div className="logo-container">
          <div className="logo-icon">Z</div>
          <span className="logo-text">ZUI</span>
        </div>
        <nav className="nav-links">
          <button className="btn-send" onClick={() => { window.location.hash = "/"; }}>
            Send
          </button>
          <a className={isLab ? "nav-link active" : "nav-link"} href="#/zui-lab">
            Codec Lab
          </a>
        </nav>
      </header>
      <main className={isLab ? "main lab" : "main"}>{page}</main>
      {isLab && (
        <footer className="footer">
          <span>ZUI · integrity-checked, resumable transfers.</span>
          <span className="footer-note">Every chunk is SHA-256 verified before a file is ever declared ready.</span>
        </footer>
      )}
    </div>
  );
}