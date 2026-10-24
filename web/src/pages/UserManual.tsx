import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { Download, Printer } from "lucide-react";
import { Button } from "../components/common";
import manualHtml from "../content/user-manual.html?raw";
import "./UserManual.css";

// This bundled document is authored locally. Never render API or user HTML here.
const manualDocument = new DOMParser().parseFromString(manualHtml, "text/html");
const content = manualDocument.querySelector("main")!.innerHTML;
const styles = manualDocument.getElementById("manual-styles")!.textContent!;

export function UserManual() {
  const { hash } = useLocation();
  useEffect(() => {
    const previous = window.document.title;
    window.document.title = "Manual de uso · DataQore";
    return () => { window.document.title = previous; };
  }, []);
  useEffect(() => {
    if (hash) window.document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  function download() {
    const url = URL.createObjectURL(new Blob([manualHtml], { type: "text/html;charset=utf-8" }));
    const link = window.document.createElement("a");
    link.href = url;
    link.download = "dataqore-manual-de-uso.html";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    <div className="manual-tools" lang="pt-BR" role="group" aria-label="Opções do manual">
      <Button variant="outline" onClick={download}><Download size={16} aria-hidden="true" />Baixar HTML</Button>
      <Button variant="outline" onClick={() => window.print()}><Printer size={16} aria-hidden="true" />Imprimir / salvar PDF</Button>
    </div>
    <style>{styles}</style>
    <article className="user-manual" lang="pt-BR" aria-label="Manual de uso do DataQore" dangerouslySetInnerHTML={{ __html: content }} />
  </>;
}
