// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { QuestionForm } from "./QuestionForm";
vi.mock("./TaskChatRichInput", () => ({ TaskChatRichInput: () => <textarea /> }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) =>
    <div data-markdown className={className}>{children}</div>,
}));

const help = "**Teamadvies: A.** De laatste vastlegging.\n\nKies Other en schrijf een toelichting.";
const prompt = "Waarom deze vraag:\n\n- eerste situatie\n- tweede situatie";

it("renders agent-authored help text as Markdown at the form's own text size", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<QuestionForm id="q" presentation="decision" questionSet={{ schema: "paperclip.question_set.v1", questions: [
      { id: "one", prompt, helpText: help, answerMode: "single_select", required: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "two", prompt: "Second?", answerMode: "single_select", required: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    ] }} onSubmit={vi.fn()} />));
    const blocks = [...host.querySelectorAll<HTMLElement>("[data-markdown]")];
    const helpBlock = blocks.find((node) => node.textContent === help);
    const promptBlock = blocks.find((node) => node.textContent === prompt);
    expect(helpBlock).toBeDefined();
    expect(promptBlock).toBeDefined();
    // The shared Markdown body sets its own 15px size; question text must follow the form instead.
    expect(helpBlock!.className).toContain("paperclip-markdown-inherit-size");
    expect(promptBlock!.className).toContain("paperclip-markdown-inherit-size");
    // A multi-paragraph prompt reads as body text, not as one bold heading.
    expect(promptBlock!.closest(".font-medium")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); }
});

it("keeps a one-line prompt in the question's medium weight", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<QuestionForm id="q" questionSet={{ schema: "paperclip.question_set.v1", questions: [
      { id: "one", prompt: "Which one?", answerMode: "single_select", required: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    ] }} onSubmit={vi.fn()} />));
    const promptBlock = [...host.querySelectorAll<HTMLElement>("[data-markdown]")].find((node) => node.textContent === "Which one?");
    expect(promptBlock?.closest(".font-medium")).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); }
});
