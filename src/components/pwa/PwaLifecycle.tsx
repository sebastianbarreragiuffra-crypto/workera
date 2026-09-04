"use client";

import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISSED_KEY = "gestora:pwa-install-dismissed";

function runsStandalone(): boolean {
  const safariNavigator = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || safariNavigator.standalone === true;
}

function isIosSafari(): boolean {
  const ipadDesktopMode = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const ios = /iPad|iPhone|iPod/i.test(navigator.userAgent) || ipadDesktopMode;
  const safari = /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent);
  return ios && safari;
}

export function PwaLifecycle() {
  const [online, setOnline] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      if (process.env.NODE_ENV === "production") {
        navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        }).catch(() => undefined);
      } else {
        // Un worker de una compilación anterior puede sobrevivir al volver a
        // `next dev` y servir chunks incompatibles con HMR. Limpia solo los
        // recursos de GESTORA en este origen, nunca caches ajenos.
        navigator.serviceWorker.getRegistrations()
          .then((registrations) => Promise.all(registrations.filter((registration) => {
            const workers = [registration.active, registration.waiting, registration.installing];
            return workers.some((worker) => worker && new URL(worker.scriptURL).pathname === "/sw.js");
          }).map((registration) => registration.unregister())))
          .catch(() => undefined);
        if ("caches" in window) {
          caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key.startsWith("gestora-shell-")).map((key) => caches.delete(key))))
            .catch(() => undefined);
        }
      }
    }

    const updateOnline = () => setOnline(navigator.onLine);
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      if (!runsStandalone() && localStorage.getItem(DISMISSED_KEY) !== "1") {
        setInstallPrompt(event as InstallPromptEvent);
      }
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setShowIosHelp(false);
    };

    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    queueMicrotask(() => {
      setOnline(navigator.onLine);
      if (!runsStandalone() && isIosSafari() && localStorage.getItem(DISMISSED_KEY) !== "1") {
        setShowIosHelp(true);
      }
    });

    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismissInstall = () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    setInstallPrompt(null);
    setShowIosHelp(false);
  };

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  if (online && !installPrompt && !showIosHelp) return null;

  return (
    <div className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-lg flex-col gap-2" aria-live="polite">
      {!online && (
        <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-950">
          Estás sin conexión. No se enviarán ni guardarán datos hasta recuperar internet.
        </div>
      )}
      {online && installPrompt && (
        <div className="rounded-xl border border-blue-200 bg-white p-4 text-sm text-slate-700">
          <p className="font-semibold text-slate-950">Usar GESTORA como una app</p>
          <p className="mt-1">Se instala desde el navegador y no requiere App Store.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={install} className="min-h-11 rounded-lg bg-arcotex-blue px-4 py-2 font-semibold text-white">Instalar</button>
            <button type="button" onClick={dismissInstall} className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 font-medium">Ahora no</button>
          </div>
        </div>
      )}
      {online && showIosHelp && (
        <div className="rounded-xl border border-blue-200 bg-white p-4 text-sm text-slate-700">
          <p className="font-semibold text-slate-950">Agregar GESTORA en Safari</p>
          <p className="mt-1">Toca Compartir y luego “Agregar a pantalla de inicio”. No necesitas descargar una app.</p>
          <button type="button" onClick={dismissInstall} className="mt-3 min-h-11 rounded-lg border border-slate-300 px-4 py-2 font-medium">Entendido</button>
        </div>
      )}
    </div>
  );
}
