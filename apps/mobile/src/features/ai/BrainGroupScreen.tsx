import type { AiAccounts, BrainGroup, BrainGroupStrategy, MachineAccountKind } from "@agenteschat/client";
import {
  useAiAccounts,
  useBrainGroups,
  useBrainMachines,
  useCreateBrainGroup,
  useDeleteBrainGroup,
  useUpdateBrainGroup,
} from "@agenteschat/client";
import { effortLevel } from "@agenteschat/client/lib/brain-advanced";
import { groupCandidates, groupLine } from "@agenteschat/client/lib/brain-groups";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { planLabel, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { brainModelChoices, planOf } from "@agenteschat/client/lib/plans";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { usePreventRemove } from "expo-router";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  ProviderLogo,
  useFieldText,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { chooseAction, Gap, SettingsPage } from "../settings/parts";
import { useColors, useMeId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { PlanMeter } from "../usage/parts";
import { EffortRamp } from "./EffortRamp";
import { GROUP_NAME_MAX, groupNameOk, membersInput, moveSlot, type Slot, slotsOf, startSlots } from "./groups";
import { Note } from "./parts";

/*
 * Brain groups on the phone (ADR 0180), as the web's "Grupos" in IA e uso (`BrainGroups.tsx`): an agent thinks with a
 * group of accounts of one computer, at most one per provider, tried in order or by the most room left. The section
 * lists them under the accounts; each opens a screen of its own to change or delete it, and "Novo grupo" one to make
 * it. The pickers offer only what the server takes (`groupCandidates`); what it still refuses is a toast in its words
 * (`brain_group.*`), and the screen stays as it was.
 */

type Account = AiAccounts["accounts"][number];
type Member = BrainGroup["members"][number];
/** What a member shows: the account as the computer lists it now, else as the group last saw it. */
type Shown = Pick<Member, "accountId" | "label" | "kind" | "provider" | "usage">;

/** Where "Novo grupo" goes: a new group's screen. */
const NEW = "new";

/** Opens a group to change it, or a new one. */
export const openBrainGroup = (id: string = NEW) => router.push(`/brain-group/${id}` as never);

/** "Claude", "ChatGPT", "GLM Coding"…: a member's provider as its accounts say it. */
const providerOf = (t: TFunction, a: Pick<Shown, "kind" | "provider">) =>
  planLabel(t, planOfAccount({ kind: a.kind as MachineAccountKind, provider: a.provider }));
const shownOf = (a: Account): Shown => ({
  accountId: a.id,
  label: a.label,
  kind: a.kind,
  provider: a.provider,
  usage: a.usage,
});

/** The computers where the viewer has something to group. */
const groupComputers = (ai: AiAccounts | undefined, meId: string | null) =>
  meId ? (ai?.computers ?? []).filter((c) => groupCandidates(ai?.accounts ?? [], c.machineId, meId).length > 0) : [];

/** "Grupos" in IA e uso: each group with its line, whom it thinks for and (on several computers) where; a new one. */
export function BrainGroupsSection() {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const c = useColors();
  const groups = useBrainGroups(orgId);
  const ai = useAiAccounts(orgId);
  const computers = groupComputers(ai.data, meId);
  const list = groups.data ?? [];
  if (groups.isSuccess && ai.isSuccess && list.length === 0 && computers.length === 0) return null;
  const several = new Set([...list.map((g) => g.machineId), ...computers.map((x) => x.machineId)]).size > 1;
  const computerName = (machineId: string) => {
    const x = ai.data?.computers.find((y) => y.machineId === machineId);
    return x ? computerNameOf(t, org?.name ?? "", x.name, isPersonal(org)) : null;
  };
  return (
    <>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("brainGroups.title") }), text: t("brainGroups.about") }}
      >
        {t("brainGroups.title")}
      </GroupedHeader>
      {groups.isLoading ? <ActivityIndicator color={c.muted} /> : null}
      {groups.isError && !groups.data ? <Note icon="x">{t("common.loadFailed")}</Note> : null}
      <GroupedList>
        {list.map((g) => {
          const lead = g.members[0];
          return (
            <GroupedRow
              key={g.id}
              {...(lead ? { leading: <ProviderLogo id={lead.provider ?? lead.kind} size="sm" /> } : { icon: "brain" })}
              label={g.name}
              sub={[
                groupLine(t, g),
                g.usedBy.length > 0
                  ? t("brainGroups.usedBy", {
                      names: joinNames(
                        g.usedBy.map((a) => a.name),
                        t,
                      ),
                    })
                  : t("brainGroups.unused"),
                several ? computerName(g.machineId) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              subLines={2}
              chevron={g.canEdit}
              disabled={!g.canEdit}
              onPress={() => openBrainGroup(g.id)}
            />
          );
        })}
        {computers.length > 0 ? (
          <GroupedRow icon="plus" label={t("brainGroups.new")} onPress={() => openBrainGroup()} />
        ) : null}
      </GroupedList>
      {groups.isSuccess && list.length === 0 ? <GroupedFooter>{t("brainGroups.empty")}</GroupedFooter> : null}
    </>
  );
}

/** A group's screen (`id`, or `new`): its name, its computer (new only, with several), how it picks, its accounts. */
export function BrainGroupScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const c = useColors();
  const groups = useBrainGroups(orgId);
  const ai = useAiAccounts(orgId);
  if (groups.isPending || ai.isPending) {
    return (
      <SettingsPage title={t(id === NEW ? "brainGroups.new" : "brainGroups.edit")}>
        <ActivityIndicator color={c.muted} style={styles.loading} />
      </SettingsPage>
    );
  }
  const group = id === NEW ? null : (groups.data?.find((g) => g.id === id) ?? null);
  if ((id !== NEW && !group) || !meId) {
    return (
      <SettingsPage title={t("brainGroups.edit")}>
        <Note icon="x">{t("common.loadFailed")}</Note>
      </SettingsPage>
    );
  }
  const computers = groupComputers(ai.data, meId);
  const computerName = (machineId: string) => {
    const x = ai.data?.computers.find((y) => y.machineId === machineId);
    return x ? computerNameOf(t, org?.name ?? "", x.name, isPersonal(org)) : null;
  };
  return (
    <GroupForm
      key={id}
      group={group}
      accounts={ai.data?.accounts ?? []}
      machineIds={computers.map((x) => x.machineId)}
      meId={meId}
      computerName={computerName}
    />
  );
}

/** One member's model and effort being picked, kept into the member with "Usar". */
interface Picking {
  provider: string;
  model: string | null;
  effort: string | null;
}

function GroupForm({
  group,
  accounts,
  machineIds,
  meId,
  computerName,
}: {
  group: BrainGroup | null;
  accounts: Account[];
  /** The computers a new group may be on. */
  machineIds: string[];
  meId: string;
  computerName: (machineId: string) => string | null;
}) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const words = useFieldText("body");
  const toast = useToast();
  const create = useCreateBrainGroup(orgId);
  const update = useUpdateBrainGroup(orgId);
  const remove = useDeleteBrainGroup(orgId);
  const brainMachines = useBrainMachines(orgId);
  const [machineId, setMachineId] = useState(group?.machineId ?? machineIds[0] ?? "");
  const [name, setName] = useState(group?.name ?? "");
  const [strategy, setStrategy] = useState<BrainGroupStrategy>(group?.strategy ?? "order");
  const [slots, setSlots] = useState<Slot[]>(() => (group ? slotsOf(group) : startSlots(accounts, machineId, meId)));
  const [picking, setPicking] = useState<Picking | null>(null);
  // The model picker is a step of the form (as Conectar uma IA's pages): the native back (the button and the edge
  // swipe) closes it, the group not saved yet kept; only "Usar" keeps what it picked.
  usePreventRemove(picking !== null, () => setPicking(null));
  const busy = create.isPending || update.isPending || remove.isPending;
  const candidates = groupCandidates(accounts, machineId, meId);

  const shown = (accountId: string): Shown | undefined => {
    const a = accounts.find((x) => x.id === accountId);
    return a ? shownOf(a) : group?.members.find((m) => m.accountId === accountId);
  };
  const providerName = (provider: string) => {
    const slot = slots.find((s) => s.provider === provider);
    const a = slot ? shown(slot.accountId) : candidates.find((x) => x.provider === provider)?.accounts[0];
    return a ? providerOf(t, a) : provider;
  };
  // A provider's accounts there: the one a saved group holds stays a choice while the computer no longer lists it.
  const alternatives = (slot: Slot): Shown[] => {
    const list = (candidates.find((x) => x.provider === slot.provider)?.accounts ?? []).map(shownOf);
    const held = shown(slot.accountId);
    return list.some((a) => a.accountId === slot.accountId) || !held ? list : [held, ...list];
  };
  const missing = candidates.filter((x) => !slots.some((s) => s.provider === x.provider));
  const patch = (provider: string, next: Partial<Slot>) =>
    setSlots((list) => list.map((s) => (s.provider === provider ? { ...s, ...next } : s)));

  // ── a member's model (ADR 0180 §10): models don't carry between providers ──
  const modelOptions = (slot: Pick<Slot, "accountId" | "model">) => {
    const a = shown(slot.accountId);
    const option = brainMachines.data?.find((m) => m.machineId === machineId)?.options.find((o) => o.kind === a?.kind);
    const choices = brainModelChoices(planOf(a?.provider), option?.models ?? [], a?.provider);
    return [
      ...(slot.model && !choices.some((m) => m.value === slot.model) ? [{ value: slot.model, label: slot.model }] : []),
      ...choices.map((m) => ({ value: m.value, label: m.label })),
    ];
  };
  const modelName = (slot: Slot) =>
    slot.model ? (modelOptions(slot).find((o) => o.value === slot.model)?.label ?? slot.model) : t("brain.auto.label");
  // An automatic model picks the effort too (as on "Quem pensa"); a fixed one takes the ramp's level.
  const modelLine = (slot: Slot) =>
    slot.model && slot.effort
      ? t("brainGroups.modelEffortLine", {
          model: modelName(slot),
          effort: t(`agentPage.work.brain.effortsLower.${effortLevel(slot.effort)}`),
        })
      : t("brainGroups.modelLine", { model: modelName(slot) });

  const failed = (e: unknown) => toast({ title: errorText(t, e), icon: "x" });
  const save = () => {
    const trimmed = name.trim();
    if (!groupNameOk(name)) return toast({ title: t("brainGroups.nameNeeded"), icon: "x" });
    if (slots.length === 0) return toast({ title: t("brainGroups.membersNeeded"), icon: "x" });
    const members = membersInput(slots);
    const done = {
      onSuccess: () => {
        successHaptic();
        toast({ title: t(group ? "brainGroups.saved" : "brainGroups.created", { name: trimmed }), icon: "check" });
        router.back();
      },
      onError: failed,
    };
    if (group) update.mutate({ groupId: group.id, input: { name: trimmed, strategy, members } }, done);
    else create.mutate({ machineId, name: trimmed, strategy, members }, done);
  };
  const askDelete = () =>
    group &&
    Alert.alert(
      t("brainGroups.deleteTitle", { name: group.name }),
      group.usedBy.length > 0
        ? t("brainGroups.deleteAgents", {
            count: group.usedBy.length,
            agents: joinNames(
              group.usedBy.map((a) => a.name),
              t,
            ),
          })
        : t("brainGroups.deleteNone"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("brainGroups.deleteConfirm"),
          style: "destructive",
          onPress: () =>
            remove.mutate(group.id, {
              onSuccess: () => {
                toast({ title: t("brainGroups.deleted", { name: group.name }), icon: "check" });
                router.back();
              },
              onError: failed,
            }),
        },
      ],
    );
  // A member's own actions: its place in the order, another account of its provider, its model, out of the group.
  const memberActions = (slot: Slot, i: number) => {
    const label = shown(slot.accountId)?.label ?? providerName(slot.provider);
    const others = alternatives(slot).filter((a) => a.accountId !== slot.accountId);
    chooseAction(
      label,
      [
        { label: t("brainGroups.modelOf", { name: providerName(slot.provider) }), onPress: () => openModel(slot) },
        ...(i > 0
          ? [{ label: t("brainGroups.moveUp", { name: label }), onPress: () => setSlots((l) => moveSlot(l, i, -1)) }]
          : []),
        ...(i < slots.length - 1
          ? [{ label: t("brainGroups.moveDown", { name: label }), onPress: () => setSlots((l) => moveSlot(l, i, 1)) }]
          : []),
        ...others.map((a) => ({
          label: a.label,
          onPress: () => {
            // Models don't carry between accounts (ADR 0180 §10): back to Automático, and it says so.
            patch(slot.provider, { accountId: a.accountId, model: null, effort: null });
            if (slot.model !== null) toast({ title: t("brainGroups.accountChanged"), icon: "info" });
          },
        })),
        {
          label: t("brainGroups.remove", { name: label }),
          destructive: true,
          onPress: () => setSlots((l) => l.filter((s) => s.provider !== slot.provider)),
        },
      ],
      t("common.cancel"),
    );
  };
  const openModel = (slot: Slot) => setPicking({ provider: slot.provider, model: slot.model, effort: slot.effort });

  const modelSlot = picking ? slots.find((s) => s.provider === picking.provider) : undefined;
  if (picking && modelSlot) {
    const options = modelOptions({ accountId: modelSlot.accountId, model: picking.model });
    const mark = shown(modelSlot.accountId);
    return (
      <SettingsPage
        title={t("brainGroups.modelOf", { name: providerName(modelSlot.provider) })}
        action={{
          label: t("brainGroups.use"),
          onPress: () => {
            patch(modelSlot.provider, { model: picking.model, effort: picking.effort });
            setPicking(null);
          },
        }}
      >
        <Gap />
        <GroupedList>
          <GroupedRow
            icon="sparkle"
            label={t("brain.auto.label")}
            sub={t("brain.auto.hint")}
            checked={picking.model === null}
            onPress={() => setPicking({ ...picking, model: null, effort: null })}
          />
          {options.map((o) => (
            <GroupedRow
              key={o.value}
              leading={<ProviderLogo id={mark?.provider ?? mark?.kind ?? modelSlot.provider} size="sm" />}
              label={o.label}
              checked={picking.model === o.value}
              onPress={() => setPicking({ ...picking, model: o.value, effort: effortLevel(picking.effort) })}
            />
          ))}
        </GroupedList>
        <GroupedHeader>{t("agentPage.work.brain.effort")}</GroupedHeader>
        <GroupedList>
          {picking.model ? (
            <View style={styles.ramp}>
              <EffortRamp
                value={effortLevel(picking.effort)}
                onChange={(e) => setPicking({ ...picking, effort: e })}
                color={undefined}
              />
            </View>
          ) : (
            <GroupedRow label={t("agentPage.work.brain.effortText.auto")} labelLines={0} />
          )}
        </GroupedList>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title={t(group ? "brainGroups.edit" : "brainGroups.new")}
      action={{ label: group ? t("common.save") : t("brainGroups.create"), onPress: save, disabled: busy }}
      locked={busy}
    >
      <Gap />
      <GroupedList>
        <GroupedField label={t("brainGroups.name")}>
          <TextInput
            value={name}
            onChangeText={setName}
            maxLength={GROUP_NAME_MAX}
            placeholder={t("brainGroups.namePlaceholder")}
            placeholderTextColor={c.faint}
            returnKeyType="done"
            style={[styles.input, words, { color: c.ink }]}
          />
        </GroupedField>
      </GroupedList>
      {!group && machineIds.length > 1 ? (
        <>
          <GroupedHeader>{t("brainGroups.computer")}</GroupedHeader>
          <GroupedList>
            {machineIds.map((m) => (
              <GroupedRow
                key={m}
                icon="laptop"
                label={computerName(m) ?? t("brainGroups.computer")}
                checked={m === machineId}
                onPress={() => {
                  if (m === machineId) return;
                  setMachineId(m);
                  setSlots(startSlots(accounts, m, meId));
                }}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("brainGroups.strategy") }), text: t("brainGroups.strategyAbout") }}
      >
        {t("brainGroups.strategy")}
      </GroupedHeader>
      <GroupedList>
        {(["order", "room"] as const).map((s) => (
          <GroupedRow key={s} label={t(`brainGroups.${s}`)} checked={strategy === s} onPress={() => setStrategy(s)} />
        ))}
      </GroupedList>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("brainGroups.members") }), text: t("brainGroups.membersAbout") }}
      >
        {t("brainGroups.members")}
      </GroupedHeader>
      <GroupedList>
        {slots.map((slot, i) => {
          const a = shown(slot.accountId);
          return (
            <GroupedRow
              key={slot.provider}
              leading={<ProviderLogo id={a?.provider ?? a?.kind ?? slot.provider} size="sm" />}
              label={a?.label ?? providerName(slot.provider)}
              sub={modelLine(slot)}
              more
              onPress={() => memberActions(slot, i)}
              {...(a?.usage
                ? {
                    below: (
                      <View style={styles.below}>
                        <PlanMeter usage={a.usage} compact />
                      </View>
                    ),
                  }
                : {})}
            />
          );
        })}
        {missing.map((x) => {
          const first = x.accounts[0];
          return first ? (
            <GroupedRow
              key={x.provider}
              icon="plus"
              label={t("brainGroups.add", { name: providerOf(t, first) })}
              onPress={() =>
                setSlots((list) => [...list, { provider: x.provider, accountId: first.id, model: null, effort: null }])
              }
            />
          ) : null;
        })}
      </GroupedList>
      {slots.length === 0 ? (
        <GroupedFooter>{t("brainGroups.membersNeeded")}</GroupedFooter>
      ) : (
        <GroupedFooter>{t("brainGroups.membersAbout")}</GroupedFooter>
      )}
      {group?.canEdit ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow label={t("brainGroups.delete")} danger disabled={busy} onPress={askDelete} />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  loading: { marginTop: 16 },
  below: { gap: 8, marginTop: 6 },
  // On the rows' 14 pt edge.
  ramp: { paddingHorizontal: 14, paddingVertical: 12 },
});
