import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ToastProvider } from "./components/Toast";
import { DialogProvider } from "./components/Dialog";
import { Splash } from "./components/Splash";
import "./styles.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

function Root() {
  const [splashDone, setSplashDone] = useState(() =>
    sessionStorage.getItem("hd:splashShown") === "1",
  );

  return (
    <BrowserRouter>
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <ToastProvider>
            <DialogProvider>
              {!splashDone && (
                <Splash
                  onDone={() => {
                    sessionStorage.setItem("hd:splashShown", "1");
                    setSplashDone(true);
                  }}
                />
              )}
              <App />
            </DialogProvider>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
