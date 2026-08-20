"use client";

import { useRef, useState, type DragEvent } from "react";

/**
 * Cuadro de carga de archivo reutilizable -- arrastrar y soltar, o hacer
 * clic para elegir. Envuelve un <input type="file"> nativo (accesible,
 * funciona con formularios normales/Server Actions) con una zona
 * arrastrable y un botón de acción visible.
 */
export function FileUploadBox({
  name,
  accept,
  ariaLabel,
  pending,
  pendingLabel,
  idleLabel = "Subir archivo",
}: {
  name: string;
  accept: string;
  ariaLabel: string;
  pending: boolean;
  pendingLabel: string;
  idleLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  function openPicker() {
    inputRef.current?.click();
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file && inputRef.current) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      inputRef.current.files = transfer.files;
      setFileName(file.name);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openPicker}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openPicker()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
      className={`flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
        dragActive ? "border-arcotex-copper bg-arcotex-copper-light" : "border-arcotex-copper-border bg-arcotex-copper-light/50 hover:border-arcotex-copper hover:bg-arcotex-copper-light"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        name={name}
        accept={accept}
        required
        aria-label={ariaLabel}
        className="hidden"
        onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
      />

      <p className="text-sm text-slate-500">
        {fileName ? (
          <span className="font-medium text-slate-700">{fileName}</span>
        ) : (
          <>Arrastra tu archivo aquí o haz clic para seleccionarlo</>
        )}
      </p>

      <button
        type="submit"
        disabled={pending}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-2 rounded-md bg-arcotex-copper px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-arcotex-copper-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-copper disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
          <path d="M12 12v9" />
          <path d="m16 16-4-4-4 4" />
        </svg>
        {pending ? pendingLabel : idleLabel}
      </button>
    </div>
  );
}
