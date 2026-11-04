import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { LangProvider } from "./i18n.tsx";

document.documentElement.dataset.platform = /Windows/.test(navigator.userAgent) ? "win" : /Mac/.test(navigator.userAgent) ? "mac" : "other";
createRoot(document.getElementById("root")!).render(<LangProvider><App /></LangProvider>);
