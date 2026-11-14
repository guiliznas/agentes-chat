import { afterEach, describe, expect, test } from "bun:test";
import type { AiAccounts, AiComputer, BrainGroup } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * IA e uso › Grupos (ADR 0180): a group holds at most one account per provider on one computer, tried in order or by
 * the most room left.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};
type Account = AiAccounts["accounts"][number];
const account = (id: string, over: Partial<Account> = {}): Account => ({
  id,
  kind: "claude_code",
  label: id,
  email: null,
  plan: null,
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  shared: true,
  serves: "everyone",
  machineId: MAC.machineId,
  computer: MAC.name,
  ...over,
});
const CLAUDE = account("acct_claude", {
  label: "Claude Max",
  plan: "max",
  usage: {
    windows: [{ kind: "five_hour", usedPercent: 62, resetsAt: "2099-01-01T15:40:00.000Z" }],
    source: "probe",
    at: new Date().toISOString(),
  },
});
const CLAUDE_2 = account("acct_claude_2", { label: "Claude Pro", plan: "pro" });
const CHATGPT = account("acct_gpt", { kind: "codex", label: "ChatGPT Plus", plan: "plus" });

async function page(groups: BrainGroup[] = [], accounts = [CLAUDE, CLAUDE_2, CHATGPT]) {
  const api = createFakeApi(seedState());
  const fake = fakeMachinesOf.get(api);
  if (!fake) throw new Error("no machines fake");
  fake.setAiAccounts({ accounts, computers: [MAC] });
  fake.setBrainGroups(groups);
  await renderApp(`/org/${ORG_ID}/settings/usage`, { api });
  await settle(6);
  return { api, fake };
}

const card = () => screen().getByRole("region", { name: "Grupos" });
const dialog = () => screen().getByRole("dialog");
const members = () =>
  [...dialog().querySelectorAll(".bg-member")].map((m) => m.querySelector(".bg-member__name")?.textContent);

const SAVED: BrainGroup = {
  id: "bg_saved",
  machineId: MAC.machineId,
  name: "Dia a dia",
  strategy: "order",
  members: [
    {
      accountId: CLAUDE.id,
      label: CLAUDE.label,
      kind: "claude_code",
      provider: null,
      model: null,
      effort: null,
      status: "active",
      usage: CLAUDE.usage,
    },
    {
      accountId: CHATGPT.id,
      label: CHATGPT.label,
      kind: "codex",
      provider: null,
      model: null,
      effort: null,
      status: "active",
      usage: null,
    },
  ],
  usedBy: [{ id: "agent-ada", name: "Ada" }],
  canEdit: true,
};

describe("IA e uso › Grupos (ADR 0180)", () => {
  test("with none yet, the card says what a group is for and offers Novo grupo", async () => {
    await page();
    const groups = card();
    expect(within(groups).getByText("Nenhum grupo ainda.")).toBeTruthy();
    expect(within(groups).getByRole("button", { name: "Novo grupo" })).toBeTruthy();
  });

  test("a group shows its name, its accounts in order and who uses it", async () => {
    await page([SAVED]);
    const row = within(card()).getByRole("button", { name: /Dia a dia/ });
    expect(row.textContent).toContain("Claude → ChatGPT · em ordem");
    expect(row.textContent).toContain("Ada");
  });

  test("Novo grupo: one account per provider, put in order, then saved with the strategy", async () => {
    const { fake } = await page();
    await click(within(card()).getByRole("button", { name: "Novo grupo" }));
    const d = dialog();
    expect(within(d).getByRole("heading", { name: "Novo grupo" })).toBeTruthy();
    await act(async () => fireEvent.change(within(d).getByLabelText("Nome"), { target: { value: "Plantão" } }));
    // Every provider of the computer starts in, its first account standing for it.
    expect(members()).toEqual(["Claude Max", "ChatGPT Plus"]);
    // The Claude account's meter: the window closest to its limit.
    const claude = dialog().querySelector(".bg-member") as HTMLElement;
    expect(within(claude).getByRole("meter")).toBeTruthy();
    // ChatGPT goes first.
    await click(within(dialog()).getByRole("button", { name: "Subir ChatGPT Plus" }));
    expect(members()).toEqual(["ChatGPT Plus", "Claude Max"]);
    await click(within(dialog()).getByRole("radio", { name: "Mais folga" }));
    await click(within(dialog()).getByRole("button", { name: "Criar grupo" }));
    const [saved] = fake.groups();
    expect(saved?.name).toBe("Plantão");
    expect(saved?.strategy).toBe("room");
    expect(saved?.members.map((m) => m.accountId)).toEqual([CHATGPT.id, CLAUDE.id]);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(within(card()).getByRole("button", { name: /Plantão/ }).textContent).toContain(
      "ChatGPT → Claude · a que tem mais folga",
    );
  });

  test("two accounts of one provider are alternatives: the group takes the one picked", async () => {
    const { fake } = await page();
    await click(within(card()).getByRole("button", { name: "Novo grupo" }));
    await act(async () => fireEvent.change(within(dialog()).getByLabelText("Nome"), { target: { value: "Pro" } }));
    // Claude's slot offers its second account; ChatGPT has only one.
    const pick = within(dialog()).getByRole("combobox", { name: "Conta do Claude" });
    expect(within(dialog()).queryByRole("combobox", { name: "Conta do ChatGPT" })).toBeNull();
    await act(async () => {
      fireEvent.pointerDown(pick, { button: 0, pointerType: "mouse" });
      fireEvent.click(pick);
    });
    await settle(3);
    await click(screen().getByRole("option", { name: "Claude Pro" }));
    expect(members()).toEqual(["Claude Pro", "ChatGPT Plus"]);
    // Taking ChatGPT out leaves it under the list, to add back.
    await click(within(dialog()).getByRole("button", { name: "Tirar ChatGPT Plus" }));
    expect(members()).toEqual(["Claude Pro"]);
    expect(within(dialog()).getByRole("button", { name: "Adicionar ChatGPT" })).toBeTruthy();
    await click(within(dialog()).getByRole("button", { name: "Criar grupo" }));
    expect(fake.groups()[0]?.members.map((m) => m.accountId)).toEqual([CLAUDE_2.id]);
  });

  test("the server refusing a second account of one provider shows its words, and the dialog stays", async () => {
    const { fake } = await page([], [CLAUDE, CHATGPT]);
    await click(within(card()).getByRole("button", { name: "Novo grupo" }));
    await act(async () => fireEvent.change(within(dialog()).getByLabelText("Nome"), { target: { value: "Dois" } }));
    // Meanwhile the "ChatGPT" account turned out to be a second Claude one on the computer.
    fake.setAiAccounts({ accounts: [CLAUDE, { ...CHATGPT, kind: "claude_code" }], computers: [MAC] });
    await click(within(dialog()).getByRole("button", { name: "Criar grupo" }));
    // The app's toast for a failed write, in the server's words; what was typed stays.
    expect(screen().getByText("Um grupo leva uma conta de cada provedor.").closest(".ac-toasts")).not.toBeNull();
    expect((within(dialog()).getByLabelText("Nome") as HTMLInputElement).value).toBe("Dois");
    expect(fake.groups()).toHaveLength(0);
  });

  test("a group opens to edit: renamed, reordered and saved, or deleted", async () => {
    const { fake } = await page([SAVED]);
    await click(within(card()).getByRole("button", { name: /Dia a dia/ }));
    expect(within(dialog()).getByRole("heading", { name: "Editar grupo" })).toBeTruthy();
    expect(members()).toEqual(["Claude Max", "ChatGPT Plus"]);
    await click(within(dialog()).getByRole("button", { name: "Descer Claude Max" }));
    await act(async () => fireEvent.change(within(dialog()).getByLabelText("Nome"), { target: { value: "Noite" } }));
    await click(within(dialog()).getByRole("button", { name: "Salvar" }));
    expect(fake.groups()[0]?.name).toBe("Noite");
    expect(fake.groups()[0]?.members.map((m) => m.accountId)).toEqual([CHATGPT.id, CLAUDE.id]);

    await click(within(card()).getByRole("button", { name: /Noite/ }));
    await click(within(dialog()).getByRole("button", { name: "Apagar grupo" }));
    // Who uses it is told before it goes.
    expect(within(dialog()).getByText(/Ada volta a pensar com a própria conta/)).toBeTruthy();
    await click(within(dialog()).getByRole("button", { name: "Apagar" }));
    expect(fake.groups()).toHaveLength(0);
    expect(within(card()).getByText("Nenhum grupo ainda.")).toBeTruthy();
  });
});
