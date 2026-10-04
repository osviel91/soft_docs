import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import WorkspaceInvitationPage from "./features/server/WorkspaceInvitationPage";
import PublicProjectReader from "./features/project/PublicProjectReader";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/^\/invite\//.test(window.location.pathname) ? <WorkspaceInvitationPage /> : /^\/share\//.test(window.location.pathname) ? <PublicProjectReader token={window.location.pathname.slice("/share/".length)} /> : <App />}
  </React.StrictMode>,
);
