import "@fontsource-variable/noto-sans";
import "@mantine/charts/styles.css";
import { createTheme, MantineProvider, rem } from "@mantine/core";
import "@mantine/core/styles.css";
import ReactDOM from "react-dom/client";
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
// Every store module has already been evaluated by this point (ESM imports run
// first), so each has registered its key and can be hydrated here — which is
// why the stores use `skipHydration`. Awaiting before the first paint is what
// keeps the transparent overlay from showing default columns for a frame.
await bootstrapDurableSettings();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    <ModalsProvider>
      <App />
    </ModalsProvider>
  </MantineProvider>
);
