import { NuqsAdapter } from "nuqs/adapters/react-router/v6";
import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Meter } from "./pages/Meter";

import DebugPage from "./pages/Debug";
import Logs from "./pages/Logs";
import SettingsPage from "./pages/Settings";
import ToolboxPage from "./pages/Toolbox";
import { ConfluxIndexPage } from "./pages/logs/ConfluxIndex";
import { IndexPage as LogIndexPage } from "./pages/logs/Index";
import { ViewPage as LogViewPage } from "./pages/logs/View";
import ChecklistSettings from "./pages/settings/ChecklistSettings";
import GeneralSettings from "./pages/settings/GeneralSettings";
import MeterSettings from "./pages/settings/meters/MeterSettings";
import BuildAudit from "./pages/toolbox/BuildAudit";
import OvermasteryPredictor from "./pages/toolbox/OvermasteryPredictor";
import SynthesisHelper from "./pages/toolbox/SynthesisHelper";
import TransmarvelSearcher from "./pages/toolbox/TransmarvelSearcher";
import { registerShortcutBlocker } from "./utils";

import "./App.css";

export const App = () => {
  useEffect(() => {
    return registerShortcutBlocker();
  }, []);

  return (
    <BrowserRouter>
      {/* Backs the `?tab=` query state that keeps each page's in-page tabs in
          the route, so the header's per-tab memory restores them too. */}
      <NuqsAdapter>
        <Routes>
          <Route path="/" element={<Meter />} />
          <Route path="/logs" element={<Logs />}>
            <Route index element={<LogIndexPage />} />
            <Route path="conflux" element={<ConfluxIndexPage />} />
            <Route path="toolbox" element={<ToolboxPage />}>
              <Route index element={<Navigate to="synthesis" replace />} />
              <Route path="synthesis" element={<SynthesisHelper />} />
              <Route path="overmastery" element={<OvermasteryPredictor />} />
              <Route path="transmarvel" element={<TransmarvelSearcher />} />
              <Route path="audit" element={<BuildAudit />} />
            </Route>
            <Route path=":id" element={<LogViewPage />} />
            <Route path="settings" element={<SettingsPage />}>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<GeneralSettings />} />
              <Route path="meters" element={<MeterSettings />} />
              <Route path="checklist" element={<ChecklistSettings />} />
            </Route>
            {import.meta.env.DEV && <Route path="debug" element={<DebugPage />} />}
          </Route>
        </Routes>
      </NuqsAdapter>
    </BrowserRouter>
  );
};
