import { Anchor, TypographyStylesProvider } from "@mantine/core";
import { open } from "@tauri-apps/api/shell";
import Markdown from "react-markdown";

/**
 * Release notes rendered from markdown (react-markdown; raw HTML stays
 * inert by default). Links are rerouted to the system browser — a plain
 * anchor would navigate the Tauri webview itself.
 */
const UpdateNotes = ({ markdown }: { markdown: string }) => (
  <TypographyStylesProvider fz="sm" pl={0}>
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
  </TypographyStylesProvider>
);

export default UpdateNotes;
