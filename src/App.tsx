import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Meter } from "./pages/Meter";

import Logs from "./pages/Logs";
import SettingsPage from "./pages/Settings";
import ToolboxPage from "./pages/Toolbox";
import { ConfluxIndexPage } from "./pages/logs/ConfluxIndex";
import { IndexPage as LogIndexPage } from "./pages/logs/Index";
import { ViewPage as LogViewPage } from "./pages/logs/View";
import SynthesisHelper from "./pages/toolbox/SynthesisHelper";

import "./App.css";

export const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Meter />} />
        <Route path="/logs" element={<Logs />}>
          <Route index element={<LogIndexPage />} />
          <Route path="conflux" element={<ConfluxIndexPage />} />
          <Route path="toolbox" element={<ToolboxPage />}>
            <Route index element={<Navigate to="synthesis" replace />} />
            <Route path="synthesis" element={<SynthesisHelper />} />
          </Route>
          <Route path=":id" element={<LogViewPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
};
