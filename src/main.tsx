import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import WorkspaceInvitationPage from "./features/server/WorkspaceInvitationPage";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/^\/invite\//.test(window.location.pathname) ? <WorkspaceInvitationPage /> : <App />}
  </React.StrictMode>,
);
