import type { AiAccounts, BrainGroup, BrainGroupStrategy, MachineAccountKind } from "@agenteschat/client";
import {
  useAiAccounts,
  useBrainGroups,
  useBrainMachines,
  useCreateBrainGroup,
  useDeleteBrainGroup,
  useUpdateBrainGroup,
} from "@agenteschat/client";
import { groupCandidates, groupLine, groupProviderKey } from "@agenteschat/client/lib/brain-groups";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { joinNames } from "@agenteschat/client/lib/format";
import { planLabel, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { planMeterText } from "@agenteschat/client/lib/plan-usage";
import { brainModelChoices, planOf } from "@agenteschat/client/lib/plans";
import { AUTO } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  List,
  Meter,
  PLAN_ALMOST,
  ProviderLogo,
  planLevel,
  planLine,
  Segmented,
  Select,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { PickList, type PickOption } from "@/pages/agent/brain/pieces";
import "./brain-groups.css";

/*
 * Configurações › IA e uso, "Grupos" (ADR 0180): an agent thinks with a group of accounts of one computer, at most one
 * per provider, tried in order or by the most room left. The pickers offer only what the server takes
 * (`groupCandidates`); what it still refuses is the app's toast for a failed write, and the dialog stays as it was.
 */

type Account = AiAccounts["accounts"][number];
type Member = BrainGroup["members"][number];

/** A name the server takes: 1 to 40 characters once trimmed. */
const NAME_MAX = 40;

/** One slot of the group being edited: its provider and the account standing for it. */
interface Slot {
  provider: string;
  accountId: string;
  model: string | null;
  effort: string | null;
}

/** What a member shows: the account as the computer lists it now, else as the group last saw it. */
type Shown = Pick<Member, "accountId" | "label" | "kind" | "provider" | "usage">;
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

export function BrainGroupsCard() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const groups = useBrainGroups(org.id);
  const ai = useAiAccounts(org.id);
  const [open, setOpen] = useState<{ group: BrainGroup | null } | null>(null);
  const accounts = ai.data?.accounts ?? [];
  // The computers where the viewer has something to group.
  const computers = (ai.data?.computers ?? []).filter(
    (c) => groupCandidates(accounts, c.machineId, me.user.id).length > 0,
  );
  const list = groups.data ?? [];
  if (groups.isSuccess && ai.isSuccess && list.length === 0 && computers.length === 0) return null;
  const several = new Set([...list.map((g) => g.machineId), ...computers.map((c) => c.machineId)]).size > 1;
  const computerName = (machineId: string) => {
    const c = ai.data?.computers.find((x) => x.machineId === machineId);
    return c ? computerNameOf(t, org.name, c.name, isPersonal(org)) : null;
  };
  const create = computers.length > 0 && (
    <Button size="sm" icon="plus" onClick={() => setOpen({ group: null })}>
      {t("brainGroups.new")}
    </Button>
  );
  return (
    <Card aria-labelledby="sec-brain-groups">
      <CardHeader
        id="sec-brain-groups"
        icon="layers"
        title={t("brainGroups.title")}
        hint={{ name: t("common.about", { label: t("brainGroups.title") }), text: t("brainGroups.about") }}
        action={create}
      />
      {groups.isLoading && <LoadingList count={2} avatar={false} />}
      {groups.isError && !groups.data && <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />}
      {groups.isSuccess && list.length === 0 && <p className="bg-empty">{t("brainGroups.empty")}</p>}
      {list.length > 0 && (
        <List className="plan-rows">
          {list.map((g) => (
            <div key={g.id} className="plan-row">
              <button
                type="button"
                className="plan-row__head ac-foldrow__head bg-row"
                disabled={!g.canEdit}
                onClick={() => setOpen({ group: g })}
              >
                <span className="bg-row__marks" aria-hidden>
                  {g.members.map((m) => (
                    <ProviderLogo key={m.accountId} id={m.provider ?? m.kind} size="sm" />
                  ))}
                </span>
                <span className="bg-row__name">{g.name}</span>
                {/* A fact that moves to the next line takes its "·" with it (a no-break space joins them). */}
                <span className="plan-acct__sub bg-row__sub">
                  {[
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
                    .filter((f): f is string => Boolean(f))
                    .map((f, i) => (
                      <Fragment key={f}>
                        {i > 0 && " "}
                        <span className="bg-row__fact">{i > 0 ? `·\u00a0${f}` : f}</span>
                      </Fragment>
                    ))}
                </span>
                {g.canEdit && <Icon name="chevronRight" size={16} className="plan-row__chevron bg-row__chevron" />}
              </button>
            </div>
          ))}
        </List>
      )}
      {open && (
        <BrainGroupDialog
          group={open.group}
          accounts={accounts}
          machineIds={computers.map((c) => c.machineId)}
          computerName={computerName}
          onClose={() => setOpen(null)}
        />
      )}
    </Card>
  );
}

type Screen = { type: "form" } | { type: "model"; provider: string } | { type: "delete" };

/** Making a group, or changing one: its name, its computer (new only), how it picks, and its accounts in order. */
export function BrainGroupDialog({
  group,
  accounts,
  machineIds,
  computerName,
  onClose,
}: {
  group: BrainGroup | null;
  accounts: Account[];
  /** The computers a new group may be on. */
  machineIds: string[];
  computerName: (machineId: string) => string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const create = useCreateBrainGroup(org.id);
  const update = useUpdateBrainGroup(org.id);
  const remove = useDeleteBrainGroup(org.id);
  const brainMachines = useBrainMachines(org.id);
  const [machineId, setMachineId] = useState(group?.machineId ?? machineIds[0] ?? "");
  const candidates = groupCandidates(accounts, machineId, me.user.id);
  // A new group starts with every provider there, each by its first account: taking one out is one press.
  const start = (on: string): Slot[] =>
    groupCandidates(accounts, on, me.user.id).flatMap((c) =>
      c.accounts[0] ? [{ provider: c.provider, accountId: c.accounts[0].id, model: null, effort: null }] : [],
    );
  const [name, setName] = useState(group?.name ?? "");
  const [strategy, setStrategy] = useState<BrainGroupStrategy>(group?.strategy ?? "order");
  const [slots, setSlots] = useState<Slot[]>(() =>
    group
      ? group.members.map((m) => ({
          provider: groupProviderKey(m),
          accountId: m.accountId,
          model: m.model,
          effort: m.effort,
        }))
      : start(machineId),
  );
  const [screen, setScreen] = useState<Screen>({ type: "form" });
  const [touched, setTouched] = useState(false);
  const busy = create.isPending || update.isPending || remove.isPending;

  const shown = (accountId: string): Shown | undefined => {
    const a = accounts.find((x) => x.id === accountId);
    return a ? shownOf(a) : group?.members.find((m) => m.accountId === accountId);
  };
  const providerName = (provider: string) => {
    const slot = slots.find((s) => s.provider === provider);
    const a = slot ? shown(slot.accountId) : candidates.find((c) => c.provider === provider)?.accounts[0];
    return a ? providerOf(t, a) : provider;
  };
  // A provider's accounts there: the one a saved group holds stays a choice while the computer no longer lists it.
  const alternatives = (slot: Slot): Shown[] => {
    const list = (candidates.find((c) => c.provider === slot.provider)?.accounts ?? []).map(shownOf);
    const held = shown(slot.accountId);
    return list.some((a) => a.accountId === slot.accountId) || !held ? list : [held, ...list];
  };
  const missing = candidates.filter((c) => !slots.some((s) => s.provider === c.provider));

  const patch = (provider: string, next: Partial<Slot>) =>
    setSlots((list) => list.map((s) => (s.provider === provider ? { ...s, ...next } : s)));
  const move = (index: number, step: -1 | 1) =>
    setSlots((list) => {
      const next = [...list];
      const [s] = next.splice(index, 1);
      if (s) next.splice(index + step, 0, s);
      return next;
    });

  // ── the model of a member (ADR 0180 §10): models don't carry between providers ──
  const modelOptions = (slot: Slot): PickOption[] => {
    const a = shown(slot.accountId);
    const option = brainMachines.data?.find((m) => m.machineId === machineId)?.options.find((o) => o.kind === a?.kind);
    const choices = brainModelChoices(planOf(a?.provider), option?.models ?? [], a?.provider);
    return [
      { value: AUTO, label: t("brain.auto.label"), description: t("brain.auto.hint") },
      ...(slot.model && !choices.some((m) => m.value === slot.model) ? [{ value: slot.model, label: slot.model }] : []),
      ...choices.map((m) => ({ value: m.value, label: m.label })),
    ];
  };
  const modelName = (slot: Slot) =>
    slot.model ? (modelOptions(slot).find((o) => o.value === slot.model)?.label ?? slot.model) : t("brain.auto.label");

  const nameError =
    touched && (name.trim().length === 0 || name.trim().length > NAME_MAX) ? t("brainGroups.nameNeeded") : undefined;
  const membersError = touched && slots.length === 0 ? t("brainGroups.membersNeeded") : undefined;
  const save = () => {
    setTouched(true);
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > NAME_MAX || slots.length === 0) return;
    const members = slots.map((s) => ({ accountId: s.accountId, model: s.model, effort: s.effort }));
    const done = {
      onSuccess: () => {
        toast.show(t(group ? "brainGroups.saved" : "brainGroups.created", { name: trimmed }));
        onClose();
      },
    };
    if (group) update.mutate({ groupId: group.id, input: { name: trimmed, strategy, members } }, done);
    else create.mutate({ machineId, name: trimmed, strategy, members }, done);
  };
  const drop = () => {
    if (!group) return;
    remove.mutate(group.id, {
      onSuccess: () => {
        toast.show(t("brainGroups.deleted", { name: group.name }));
        onClose();
      },
    });
  };

  const modelSlot = screen.type === "model" ? slots.find((s) => s.provider === screen.provider) : undefined;
  const title =
    screen.type === "delete" && group
      ? t("brainGroups.deleteTitle", { name: group.name })
      : modelSlot
        ? t("brainGroups.modelOf", { name: providerName(modelSlot.provider) })
        : t(group ? "brainGroups.edit" : "brainGroups.new");

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={title}
      description={
        screen.type === "delete" && group
          ? group.usedBy.length > 0
            ? t("brainGroups.deleteAgents", {
                count: group.usedBy.length,
                agents: joinNames(
                  group.usedBy.map((a) => a.name),
                  t,
                ),
              })
            : t("brainGroups.deleteNone")
          : undefined
      }
      closeLabel={t("common.close")}
      width={520}
    >
      {screen.type === "delete" && (
        <>
          <DialogFooter>
            <Button disabled={busy} onClick={() => setScreen({ type: "form" })}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={drop}>
              {t("brainGroups.deleteConfirm")}
            </Button>
          </DialogFooter>
        </>
      )}
      {modelSlot && (
        <>
          <DialogBody>
            <PickList
              options={modelOptions(modelSlot)}
              value={modelSlot.model ?? AUTO}
              onChange={(v) => {
                patch(modelSlot.provider, { model: v === AUTO ? null : v });
                setScreen({ type: "form" });
              }}
              label={title}
              searchLabel={t("models.search")}
            />
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setScreen({ type: "form" })}>{t("common.back")}</Button>
          </DialogFooter>
        </>
      )}
      {screen.type === "form" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <DialogBody>
            <Field label={t("brainGroups.name")} id="brain-group-name" error={nameError}>
              <Input
                value={name}
                maxLength={NAME_MAX}
                placeholder={t("brainGroups.namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {!group && machineIds.length > 1 && (
              <Field label={t("brainGroups.computer")} id="brain-group-computer">
                <Select
                  value={machineId}
                  onValueChange={(v) => {
                    setMachineId(v);
                    setSlots(start(v));
                  }}
                  options={machineIds.map((id) => ({ value: id, label: computerName(id) ?? id }))}
                />
              </Field>
            )}
            <Field
              label={t("brainGroups.strategy")}
              group
              hint={{
                name: t("common.about", { label: t("brainGroups.strategy") }),
                text: t("brainGroups.strategyAbout"),
              }}
            >
              <Segmented
                label={t("brainGroups.strategy")}
                value={strategy}
                onValueChange={setStrategy}
                options={[
                  { value: "order", label: t("brainGroups.order") },
                  { value: "room", label: t("brainGroups.room") },
                ]}
              />
            </Field>
            <Field
              label={t("brainGroups.members")}
              group
              error={membersError}
              hint={{
                name: t("common.about", { label: t("brainGroups.members") }),
                text: t("brainGroups.membersAbout"),
              }}
            >
              <div className="bg-members">
                {slots.map((slot, i) => (
                  <MemberRow
                    key={slot.provider}
                    slot={slot}
                    shown={shown(slot.accountId)}
                    first={i === 0}
                    last={i === slots.length - 1}
                    alternatives={alternatives(slot)}
                    providerName={providerName(slot.provider)}
                    modelName={modelName(slot)}
                    onPick={(accountId) => patch(slot.provider, { accountId, model: null, effort: null })}
                    onMove={(step) => move(i, step)}
                    onRemove={() => setSlots((list) => list.filter((s) => s.provider !== slot.provider))}
                    onModel={() => setScreen({ type: "model", provider: slot.provider })}
                  />
                ))}
                {missing.length > 0 && (
                  <div className="ac-acts bg-members__add">
                    {missing.map((c) => {
                      const a = c.accounts[0];
                      if (!a) return null;
                      const label = providerOf(t, a);
                      return (
                        <Button
                          key={c.provider}
                          size="sm"
                          variant="ghost"
                          icon="plus"
                          onClick={() =>
                            setSlots((list) => [
                              ...list,
                              { provider: c.provider, accountId: a.id, model: null, effort: null },
                            ])
                          }
                        >
                          {t("brainGroups.add", { name: label })}
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>
            </Field>
          </DialogBody>
          <DialogFooter
            note={
              group?.canEdit && (
                <Button
                  variant="link"
                  className="ac-link--danger"
                  disabled={busy}
                  onClick={() => setScreen({ type: "delete" })}
                >
                  {t("brainGroups.delete")}
                </Button>
              )
            }
          >
            <Button disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending || update.isPending}>
              {group ? t("common.save") : t("brainGroups.create")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/** A member: its maker's mark, the account and its model, its fullest window, and its place in the order. */
function MemberRow({
  slot,
  shown,
  first,
  last,
  alternatives,
  providerName,
  modelName,
  onPick,
  onMove,
  onRemove,
  onModel,
}: {
  slot: Slot;
  shown: Shown | undefined;
  first: boolean;
  last: boolean;
  alternatives: Shown[];
  providerName: string;
  modelName: string;
  onPick: (accountId: string) => void;
  onMove: (step: -1 | 1) => void;
  onRemove: () => void;
  onModel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const label = shown?.label ?? providerName;
  const text = planMeterText(t, i18n.language);
  const line = shown?.usage ? planLine(shown.usage, text) : null;
  return (
    <div className="bg-member">
      <ProviderLogo id={shown?.provider ?? shown?.kind ?? slot.provider} size="sm" />
      <span className="bg-member__head">
        <span className="bg-member__name ac-captop">{label}</span>
        <button type="button" className="ac-link ac-link--muted small bg-member__model" onClick={onModel}>
          {t("brainGroups.modelLine", { model: modelName })}
        </button>
      </span>
      {line?.top && (
        <span
          className="ac-planmeter ac-planmeter--compact bg-member__meter"
          data-level={planLevel(line.top.used, line.state === "limited")}
        >
          <span className="ac-planmeter__line">{`${text.short(line.top)} ${line.top.used}%`}</span>
          <Meter value={line.top.used} max={100} label={text.window(line.top)} marks={[PLAN_ALMOST]} />
        </span>
      )}
      <span className="bg-member__acts">
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="chevronUp"
          aria-label={t("brainGroups.moveUp", { name: label })}
          disabled={first}
          onClick={() => onMove(-1)}
        />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="chevronDown"
          aria-label={t("brainGroups.moveDown", { name: label })}
          disabled={last}
          onClick={() => onMove(1)}
        />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("brainGroups.remove", { name: label })}
          onClick={onRemove}
        />
      </span>
      {alternatives.length > 1 && (
        <Select
          className="bg-member__pick"
          size="sm"
          aria-label={t("brainGroups.accountOf", { provider: providerName })}
          value={slot.accountId}
          onValueChange={onPick}
          options={alternatives.map((a) => ({ value: a.accountId, label: a.label }))}
        />
      )}
    </div>
  );
}
