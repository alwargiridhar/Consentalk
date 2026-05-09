// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en" style={{ height: "100%" }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        <title>Consentalk — Private by Presence</title>
        <link
          rel="icon"
          type="image/png"
          href="https://customer-assets.emergentagent.com/job_intent-space-1/artifacts/1l50hp1h_18042944-d84f-4288-ad95-dc48f147d6ae.png"
        />
        <link
          rel="apple-touch-icon"
          href="https://customer-assets.emergentagent.com/job_intent-space-1/artifacts/1l50hp1h_18042944-d84f-4288-ad95-dc48f147d6ae.png"
        />
        <meta name="theme-color" content="#0EA5E9" />
        <meta
          name="description"
          content="Consentalk — A privacy-first, consent-based ephemeral communication platform. Private by Presence."
        />
        {/*
          Disable body scrolling on web to make ScrollView components work correctly.
          If you want to enable scrolling, remove `ScrollViewStyleReset` and
          set `overflow: auto` on the body style below.
        */}
        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              body > div:first-child { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; }
              [role="tablist"] [role="tab"] * { overflow: visible !important; }
              [role="heading"], [role="heading"] * { overflow: visible !important; }
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </body>
    </html>
  );
}
