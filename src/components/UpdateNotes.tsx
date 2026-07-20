import { Anchor, TypographyStylesProvider } from "@mantine/core";
import { open } from "@tauri-apps/api/shell";
import { Suspense, lazy } from "react";

// Loaded on demand: react-markdown pulls in the whole unified/remark/micromark
// stack, and both Tauri windows share one bundle — the always-on-top Meter
// overlay would otherwise parse it at startup to render a prompt it can never
// show.
const Markdown = lazy(() => import("react-markdown"));

/**
 * Release notes rendered from markdown (react-markdown; raw HTML stays
 * inert by default). Links are rerouted to the system browser — a plain
 * anchor would navigate the Tauri webview itself.
 */
const UpdateNotes = ({ markdown }: { markdown: string }) => (
  <TypographyStylesProvider fz="sm" pl={0}>
    <Suspense fallback={null}>
      <Markdown
        components={{
          a: ({ href, children }) => (
            <Anchor
              size="sm"
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) open(href);
              }}
            >
              {children}
            </Anchor>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </Suspense>
  </TypographyStylesProvider>
);

export default UpdateNotes;
