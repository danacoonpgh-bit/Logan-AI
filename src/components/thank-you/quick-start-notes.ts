/**
 * Written notes shown under the Quick Start Guide video, one set per language.
 * Chapter times match that language's video, so update both together.
 * Text in `backticks` renders as inline code.
 */

export type QuickStartLang = "en" | "es";

/** A line of text, or a set of commands that each get their own Copy button. */
export type NoteBlock = { text: string } | { code: string[] };

export interface QuickStartNotes {
  button: string;
  copy: string;
  copied: string;
  intro: string[];
  chaptersTitle: string;
  chapters: { time: string; label: string }[];
  commandsTitle: string;
  commands: NoteBlock[];
  stuckTitle: string;
  stuck: string[];
}

export const QUICK_START_NOTES: Record<QuickStartLang, QuickStartNotes> = {
  en: {
    button: "Description & Code Snippets",
    copy: "Copy",
    copied: "Copied",
    intro: [
      "Get your own copy of LeadStack onto your computer and get Claude ready to set up the rest with you. No coding needed. Every step ends with a quick check, so you'll always know it worked.",
      "You'll need: a Windows or Mac computer, a free GitHub account, a paid Claude plan (Pro or Max) and about 15 minutes.",
      "Already sent us your GitHub username after buying LeadStack? You should already have access to the code, so skip to Step 2.",
    ],
    chaptersTitle: "Chapters",
    chapters: [
      { time: "0:00", label: "What you'll have and what you need" },
      { time: "0:44", label: "Step 1 · Get access to the code" },
      { time: "1:43", label: "Step 2 · Install VS Code" },
      { time: "2:12", label: "Step 3 · Add Claude Code and sign in" },
      { time: "3:08", label: "Step 4 · Install Git and the GitHub tool" },
      { time: "4:36", label: "Step 5 · Sign in to GitHub from the terminal" },
      { time: "5:25", label: "Step 6 · Make your own copy of LeadStack" },
      { time: "6:32", label: "Step 7 · Hand over to Claude" },
    ],
    commandsTitle: "Commands to copy",
    commands: [
      { text: "Step 4 (Windows), one at a time:" },
      {
        code: [
          "winget install --id Git.Git -e",
          "winget install --id GitHub.cli -e",
        ],
      },
      { text: "Step 4 (Mac):" },
      { code: ["brew install git gh"] },
      { text: "Then close VS Code completely, open it again, and check:" },
      { code: ["git --version", "gh --version"] },
      { text: "Step 5:" },
      { code: ["gh auth login"] },
      { text: "Step 6 (open your Documents folder in VS Code first):" },
      {
        code: [
          "gh repo create my-lead-app --template Claude-Code-Pro-Camp/leadstack-agency --private --clone",
        ],
      },
      { text: "Then File → Open Folder → my-lead-app." },
      { text: "Step 7, in the Claude panel:" },
      { code: ["Help me set up my CRM"] },
    ],
    stuckTitle: "Stuck?",
    stuck: [
      "\"not recognized\" → close VS Code completely and open it again.",
      "\"Repository not found\" → accept the GitHub invite email first (Step 1), then try again.",
      "\"Name already exists\" → you already made a copy; use another name, e.g. `my-lead-app-2`.",
      "Asked to upgrade in the Claude panel → Claude Code needs a paid Claude plan (Pro or Max).",
      "Anything else → use the chat on the leadstack.dev website. Support is available Monday – Friday, 10am – 4pm AEST / AEDT.",
    ],
  },
  es: {
    button: "Descripción y fragmentos de código",
    copy: "Copiar",
    copied: "Copiado",
    intro: [
      "Pon tu propia copia de LeadStack en tu computadora y deja a Claude listo para configurar el resto contigo. No necesitas saber programar. Cada paso termina con una comprobación rápida, para que siempre sepas que funcionó.",
      "Necesitas: una computadora con Windows o Mac, una cuenta gratuita de GitHub, un plan de pago de Claude (Pro o Max) y unos 15 minutos.",
      "¿Ya nos enviaste tu usuario de GitHub después de comprar LeadStack? Ya deberías tener acceso al código, así que salta al paso 2.",
    ],
    chaptersTitle: "Capítulos",
    chapters: [
      { time: "0:00", label: "Lo que vas a tener y lo que necesitas" },
      { time: "0:49", label: "Paso 1 · Obtén acceso al código" },
      { time: "1:52", label: "Paso 2 · Instala VS Code" },
      { time: "2:25", label: "Paso 3 · Agrega Claude Code e inicia sesión" },
      { time: "3:23", label: "Paso 4 · Instala Git y la herramienta de GitHub" },
      { time: "4:52", label: "Paso 5 · Inicia sesión en GitHub desde la terminal" },
      { time: "5:45", label: "Paso 6 · Crea tu propia copia de LeadStack" },
      { time: "6:55", label: "Paso 7 · Pásale el control a Claude" },
    ],
    commandsTitle: "Comandos para copiar",
    commands: [
      { text: "Paso 4 (Windows), uno a la vez:" },
      {
        code: [
          "winget install --id Git.Git -e",
          "winget install --id GitHub.cli -e",
        ],
      },
      { text: "Paso 4 (Mac):" },
      { code: ["brew install git gh"] },
      { text: "Luego cierra VS Code por completo, vuelve a abrirlo y comprueba:" },
      { code: ["git --version", "gh --version"] },
      { text: "Paso 5:" },
      { code: ["gh auth login"] },
      { text: "Paso 6 (primero abre tu carpeta Documents en VS Code):" },
      {
        code: [
          "gh repo create my-lead-app --template Claude-Code-Pro-Camp/leadstack-agency --private --clone",
        ],
      },
      { text: "Luego File → Open Folder → my-lead-app." },
      { text: "Paso 7, en el panel de Claude:" },
      { code: ["Ayúdame a configurar mi CRM"] },
    ],
    stuckTitle: "¿Te atascaste?",
    stuck: [
      "\"not recognized\" → cierra VS Code por completo y vuelve a abrirlo.",
      "\"Repository not found\" → primero acepta el correo de invitación de GitHub (paso 1) y vuelve a intentarlo.",
      "\"Name already exists\" → ya creaste una copia; usa otro nombre, por ejemplo `my-lead-app-2`.",
      "El panel de Claude te pide mejorar tu plan → Claude Code necesita un plan de pago de Claude (Pro o Max).",
      "Cualquier otra cosa → usa el chat en el sitio web leadstack.dev. El soporte está disponible de lunes a viernes, de 10 am a 4 pm (hora del este de Australia, AEST / AEDT) y responde en inglés.",
    ],
  },
};
