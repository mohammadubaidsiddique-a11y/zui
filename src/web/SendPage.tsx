import type { JSX } from "react";
import { ShareCard } from "./ShareCard";

export function SendPage(): JSX.Element {
  return (
    <section className="send">
      <h1>Send a file</h1>
      <p className="description">
        One job, three steps: <strong>compress</strong> the file → make it{" "}
        <strong>travel</strong> through the server → the receiver&apos;s page{" "}
        <strong>restores</strong> the exact original bytes. Pick a file below and
        you get a link to share.
      </p>

      <ShareCard />

      <p className="send-note">
        Need to package a file into an offline <code>.zui</code> container (or
        restore one you received out-of-band)? That lives in the{" "}
        <a href="#/zui-lab">Codec Lab</a> — this page only sends files over the
        internet.
      </p>
    </section>
  );
}