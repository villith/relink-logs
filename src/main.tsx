import "@fontsource-variable/noto-sans";
import "@mantine/charts/styles.layer.css";
import { createTheme, MantineProvider, rem } from "@mantine/core";
import "@mantine/core/styles.layer.css";
import ReactDOM from "react-dom/client";
// Pulls in Tailwind's theme and utilities layers and, through them, the app's
// design tokens in `components/ui/theme.css`. Imported ONLY here: importing
// theme.css directly as well bypasses Tailwind's processing, which lands a
// second, inert copy of its `@theme` blocks in every bundle.
import "./styles.css";

// Populates the skill-name bridge map before the first render. The module's
// top-level await blocks until the asset is read.
import "@/assets/skill-name-sources";

import { ModalsProvider } from "@mantine/modals";

import { bootstrapDurableSettings } from "@/stores/durableStorage";

import { App } from "./App";

const theme = createTheme({
  fontFamily: '"Noto Sans Variable", Inter, Avenir, Helvetica, Arial, sans-serif',
  fontSizes: {
    xs: rem(14),
    sm: "12",
    md: "14",
    lg: "16",
    xl: "18",
  },
});

// Reconcile settings.db with the localStorage cache before anything renders.
// Every store module evaluated by this point has registered its key and is
// hydrated here — which is why the stores use `skipHydration`; one that
// registers later (a code-split route) hydrates itself on registration.
// Awaiting before the first paint is what keeps the transparent overlay from
// showing default columns for a frame.
await bootstrapDurableSettings();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    <ModalsProvider>
      <App />
    </ModalsProvider>
  </MantineProvider>
);
