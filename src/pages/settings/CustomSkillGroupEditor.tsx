import i18next from "i18next";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

import SkillGroupMapping from "@/assets/skill-groups";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { CharacterType, CustomSkillGroup, SkillState } from "@/types";
import { getSkillName } from "@/utils";
import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  Modal,
  MultiSelect,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { ArrowCounterClockwise, Check, Pencil, Plus, Trash } from "@phosphor-icons/react";

// ─── Helpers ────────────────────────────────────────────────────────

const useCharacterOptions = () => {
  const { t, i18n } = useTranslation();
  return useMemo(() => {
    return Object.keys(SkillGroupMapping)
      .sort()
      .map((key) => {
        const uiName = t(`skills.characters.${key}`, { defaultValue: "" });
        const uiCharName = t(`characters.${key}`, { defaultValue: "" });
        return { value: key, label: uiCharName || uiName || t(`characters:${key}`, { defaultValue: key }) };
      });
  }, [t, i18n.language]);
};

const useSkillLabelGetter = (characterType: CharacterType | null) => {
  const { t, i18n } = useTranslation();
  return useCallback(
    (skillId: number | string): string => {
      if (!characterType) return String(skillId);
      const numId = Number(skillId);
      const mockSkill: SkillState = {
        actionType: { Normal: numId },
        childCharacterType: characterType,
        hits: 0,
        minDamage: 0,
        maxDamage: 0,
        totalDamage: 0,
        totalStunValue: 0,
        maxStunValue: 0,
        cappedHits: 0,
        cappableHits: 0,
        overcapBaseSum: 0,
        overcapCapSum: 0,
      };
      const translated = getSkillName(characterType, mockSkill);
      if (translated && translated !== "ui.unknown" && translated !== `Skill ${numId}`) return translated;
      // Fallback: Pl1900 (Id) may have skills from Pl2000 (dragon form)
      if (characterType === "Pl1900") {
        const fallback = t(`skills.Pl2000.${numId}`, { defaultValue: "" });
        if (fallback) return fallback;
      }
      return String(skillId);
    },
    [characterType, t, i18n.language]
  );
};

const useAllSkillObjects = (characterType: CharacterType | null) => {
  const { i18n } = useTranslation();
  const getSkillLabel = useSkillLabelGetter(characterType);
  return useMemo(() => {
    if (!characterType) return [];
    const bundle = (i18next.getResourceBundle(i18n.language, "ui") ?? i18next.getResourceBundle("en", "ui") ?? {}) as {
      skills?: Record<string, Record<string, unknown>>;
    };
    const charStr = String(characterType);
    const skillMap = { ...(bundle.skills?.[charStr] ?? {}) };
    // Pl1900 (Id) also includes Pl2000 (dragon form) skills
    if (charStr === "Pl1900") {
      const dragonSkills = bundle.skills?.Pl2000 ?? {};
      for (const [k, v] of Object.entries(dragonSkills)) {
        if (!skillMap[k]) skillMap[k] = v;
      }
    }
    return Object.entries(skillMap)
      .filter(([k, v]) => /^\d+$/.test(k) && typeof v === "string")
      .map(([k]) => ({ id: Number(k), label: getSkillLabel(Number(k)) }))
      .sort((a, b) => a.id - b.id);
  }, [characterType, getSkillLabel, i18n.language]);
};

const useGroupLabelGetter = (characterType: string | null) => {
  const { t, i18n } = useTranslation();
  return useCallback(
    (groupKey: string): string => {
      if (!characterType) return groupKey;
      const bundle = (i18next.getResourceBundle(i18n.language, "ui") ??
        i18next.getResourceBundle("en", "ui") ??
        {}) as { skills?: Record<string, { "skill-groups"?: Record<string, string> }> };
      return bundle.skills?.[characterType]?.["skill-groups"]?.[groupKey] ?? groupKey;
    },
    [characterType, t, i18n.language]
  );
};

// ─── Group Row ──────────────────────────────────────────────────────

const GroupRow = ({
  name,
  skillLabels,
  onEdit,
  onDelete,
}: {
  name: string;
  skillLabels: string[];
  onEdit: () => void;
  onDelete?: () => void;
}) => {
  const { t } = useTranslation();

  return (
    <Box px="sm" py={3}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" fw={600} truncate style={{ flex: 1 }}>
          {name}
        </Text>
        <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
          <Tooltip label={t("ui.custom-skill-group-edit")}>
            <ActionIcon size="sm" variant="subtle" color="blue" onClick={onEdit}>
              <Pencil size={14} />
            </ActionIcon>
          </Tooltip>
          {onDelete && (
            <Tooltip label={t("ui.custom-skill-group-delete")}>
              <ActionIcon size="sm" variant="subtle" color="red" onClick={onDelete}>
                <Trash size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>
      {skillLabels.length > 0 && (
        <Box pl="xs" mt={2}>
          <Text size="xs" c="dimmed" style={{ lineHeight: 1.4 }}>
            {skillLabels.join("、")}
          </Text>
        </Box>
      )}
    </Box>
  );
};

// ─── Inline Edit Form ───────────────────────────────────────────────

const EditForm = ({
  name,
  skillIds,
  allSkills,
  occupiedSkillIds,
  onNameChange,
  onSkillsChange,
  onClose,
}: {
  name: string;
  skillIds: number[];
  allSkills: { id: number; label: string }[];
  /** Skills already in other groups (should be hidden from available options). */
  occupiedSkillIds: Set<number>;
  onNameChange: (v: string) => void;
  onSkillsChange: (v: number[]) => void;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const data = useMemo(
    () =>
      allSkills
        .filter((s) => !occupiedSkillIds.has(s.id) || skillIds.includes(s.id))
        .map((s) => ({ value: String(s.id), label: s.label })),
    [allSkills, occupiedSkillIds, skillIds]
  );

  return (
    <Box
      px="sm"
      py={3}
      mb={2}
      style={{
        borderLeft: "2px solid var(--mantine-color-blue-5)",
        paddingLeft: 12,
      }}
    >
      <Stack gap="xs">
        <Group gap="xs" align="flex-end">
          <TextInput
            size="xs"
            label={t("ui.custom-skill-group-name")}
            value={name}
            onChange={(e) => onNameChange(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Tooltip label={t("ui.custom-skill-group-done")}>
            <ActionIcon size="md" variant="light" color="blue" onClick={onClose} style={{ marginBottom: 1 }}>
              <Check size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <MultiSelect
          size="xs"
          label={t("ui.custom-skill-group-skills")}
          placeholder={t("ui.custom-skill-group-skills-placeholder")}
          data={data}
          value={skillIds.map(String)}
          onChange={(vals) => onSkillsChange(vals.map(Number))}
          searchable
          hidePickedOptions
        />
      </Stack>
    </Box>
  );
};

// ─── Main Component ─────────────────────────────────────────────────

export const CustomSkillGroupEditor = ({ opened, onClose }: { opened: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  const characterOptions = useCharacterOptions();
  const [selectedCharacter, setSelectedCharacter] = useState<string>("");

  useEffect(() => {
    if (selectedCharacter && characterOptions.every((o) => o.value !== selectedCharacter)) {
      setSelectedCharacter("");
    }
    if (!selectedCharacter && characterOptions.length > 0) {
      setSelectedCharacter(characterOptions[0].value);
    }
  }, [characterOptions, selectedCharacter]);

  const { customSkillGroups, disabledPresetGroups, setSettings } = useMeterSettingsStore(
    useShallow((state) => ({
      customSkillGroups: state.custom_skill_groups,
      disabledPresetGroups: state.disabled_preset_groups ?? [],
      setSettings: state.set,
    }))
  );

  const getSkillLabel = useSkillLabelGetter(selectedCharacter);
  const getGroupLabel = useGroupLabelGetter(selectedCharacter);
  const allSkills = useAllSkillObjects(selectedCharacter);

  const characterName = useMemo(
    () => characterOptions.find((o) => o.value === selectedCharacter)?.label ?? selectedCharacter,
    [characterOptions, selectedCharacter]
  );

  // ── Inline editing state ──────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSkills, setEditSkills] = useState<number[]>([]);

  // Cancel editing when switching characters (edits are saved by the
  // Select's onChange before setSelectedCharacter fires, so no save needed).
  useEffect(() => {
    setEditingId(null);
  }, [selectedCharacter]);

  // ── Computed data ─────────────────────────────────────────────
  const presetMapping = useMemo(() => SkillGroupMapping[selectedCharacter] ?? {}, [selectedCharacter]);
  const presetKeys = useMemo(() => Object.keys(presetMapping), [presetMapping]);

  const flatGroups = useMemo(() => {
    const groups: Array<{ id: string; name: string; skillIds: number[]; isPreset: boolean; presetKey?: string }> = [];
    for (const pKey of presetKeys) {
      if (disabledPresetGroups.includes(`${selectedCharacter}::${pKey}`)) continue;
      const override = customSkillGroups.find((r) => r.characterType === selectedCharacter && r.presetKey === pKey);
      groups.push({
        id: `preset::${pKey}`,
        name: override?.name ?? getGroupLabel(pKey),
        skillIds: override ? override.skillIds : presetMapping[pKey]?.skills ?? [],
        isPreset: true,
        presetKey: pKey,
      });
    }
    for (const rule of customSkillGroups) {
      if (rule.characterType !== selectedCharacter || rule.presetKey) continue;
      groups.push({ id: rule.id, name: rule.name, skillIds: rule.skillIds, isPreset: false });
    }
    return groups;
  }, [presetKeys, presetMapping, customSkillGroups, disabledPresetGroups, selectedCharacter, getGroupLabel]);

  // Skills already assigned to groups other than the one being edited
  const occupiedSkillIds = useMemo(() => {
    const s = new Set<number>();
    for (const g of flatGroups) {
      if (g.id !== editingId) g.skillIds.forEach((id) => s.add(id));
    }
    return s;
  }, [flatGroups, editingId]);

  // ── Handlers ──────────────────────────────────────────────────

  const handleDelete = (groupId: string, isPreset: boolean, presetKey?: string) => {
    if (isPreset && presetKey) {
      setSettings({
        custom_skill_groups: customSkillGroups.filter(
          (r) => !(r.characterType === selectedCharacter && r.presetKey === presetKey)
        ),
        disabled_preset_groups: [...disabledPresetGroups, `${selectedCharacter}::${presetKey}`],
      });
    } else {
      setSettings({ custom_skill_groups: customSkillGroups.filter((r) => r.id !== groupId) });
    }
  };

  const handleAdd = () => {
    const newGroup: CustomSkillGroup = {
      id: crypto.randomUUID(),
      characterType: selectedCharacter,
      name: `${t("ui.custom-skill-group-custom-badge")} ${flatGroups.filter((g) => !g.isPreset).length + 1}`,
      skillIds: [],
      enabled: true,
    };
    setSettings({ custom_skill_groups: [...customSkillGroups, newGroup] });
    setEditingId(newGroup.id);
    setEditName(newGroup.name);
    setEditSkills([]);
  };

  /** Save any pending name edits to the store before leaving edit mode. */
  const commitEdit = () => {
    if (editingId) {
      applyEdit(editName, editSkills);
    }
  };

  /** Toggle edit mode for a group. */
  const startEdit = (group: (typeof flatGroups)[number]) => {
    // Save pending edits before toggling off or switching to another group
    commitEdit();
    if (editingId === group.id) {
      setEditingId(null);
      return;
    }
    setEditingId(group.id);
    setEditName(group.name);
    setEditSkills([...group.skillIds]);
  };

  /** Save name + skills to store. Called on every skills change (for
   * live cross-group dedup) and on commitEdit (for name, which is deferred to
   * avoid writing to the persisted store on every keystroke). */
  const applyEdit = (newName: string, newSkills: number[]) => {
    const gId = editingId;
    if (!gId || !newName.trim()) return;
    const group = flatGroups.find((g) => g.id === gId);
    if (!group) return;

    const skillSet = new Set(newSkills);
    let updated = customSkillGroups
      .filter((r) => r.characterType === selectedCharacter)
      .map((r) => {
        if (r.id === gId) return r;
        if (group.isPreset && group.presetKey && r.presetKey === group.presetKey) return r;
        return { ...r, skillIds: r.skillIds.filter((id) => !skillSet.has(id)) };
      });

    if (group.isPreset && group.presetKey) {
      const existing = updated.find((r) => r.presetKey === group.presetKey);
      if (existing) {
        updated = updated.map((r) => (r.id === existing.id ? { ...r, name: newName.trim(), skillIds: newSkills } : r));
      } else {
        updated.push({
          id: crypto.randomUUID(),
          characterType: selectedCharacter,
          presetKey: group.presetKey,
          name: newName.trim(),
          skillIds: newSkills,
          enabled: true,
        } as CustomSkillGroup);
      }
    } else {
      updated = updated.map((r) => (r.id === gId ? { ...r, name: newName.trim(), skillIds: newSkills } : r));
    }
    updated.push(...customSkillGroups.filter((r) => r.characterType !== selectedCharacter));
    setSettings({ custom_skill_groups: updated });
  };

  const handleNameChange = (v: string) => {
    setEditName(v);
  };

  const handleSkillsChange = (v: number[]) => {
    setEditSkills(v);
    applyEdit(editName, v);
  };

  const handleResetAll = () => {
    modals.openConfirmModal({
      title: t("ui.custom-skill-group-reset-title"),
      children: <Text size="sm">{t("ui.custom-skill-group-reset-confirm", { character: characterName })}</Text>,
      labels: { confirm: t("ui.custom-skill-group-reset"), cancel: t("ui.cancel-btn") },
      confirmProps: { color: "red" },
      centered: true,
      onConfirm: () => {
        modals.openConfirmModal({
          title: t("ui.custom-skill-group-reset-title"),
          children: <Text size="sm">{t("ui.custom-skill-group-reset-confirm-2")}</Text>,
          labels: { confirm: t("ui.custom-skill-group-reset"), cancel: t("ui.cancel-btn") },
          confirmProps: { color: "red" },
          centered: true,
          onConfirm: () => {
            setSettings({
              custom_skill_groups: customSkillGroups.filter((r) => r.characterType !== selectedCharacter),
              disabled_preset_groups: disabledPresetGroups.filter((id) => !id.startsWith(`${selectedCharacter}::`)),
            });
          },
        });
      },
    });
  };

  // ── Render ────────────────────────────────────────────────────

  return (
    <Modal opened={opened} onClose={onClose} title={t("ui.custom-skill-groups")} size="lg" centered padding="sm">
      <Stack gap={6}>
        <Text size="xs" c="dimmed">
          {t("ui.custom-skill-groups-description")}
        </Text>

        <Select
          size="xs"
          label={t("ui.custom-skill-group-character")}
          data={characterOptions}
          value={selectedCharacter}
          onChange={(val) => {
            if (val) {
              commitEdit();
              setSelectedCharacter(val);
            }
          }}
          searchable
          clearable={false}
        />

        <Divider my={4} />

        <Group justify="space-between">
          <Button variant="subtle" size="xs" color="blue" leftSection={<Plus size={14} />} onClick={handleAdd}>
            {t("ui.custom-skill-group-new-group")}
          </Button>
          <Button
            variant="subtle"
            size="xs"
            color="gray"
            leftSection={<ArrowCounterClockwise size={14} />}
            onClick={handleResetAll}
          >
            {t("ui.custom-skill-group-reset")}
          </Button>
        </Group>

        <Stack gap={4}>
          {flatGroups.length === 0 && (
            <Text size="xs" c="dimmed" fs="italic" py="xs">
              {t("ui.custom-skill-group-no-custom")}
            </Text>
          )}
          {flatGroups.map((group) =>
            editingId === group.id ? (
              <EditForm
                key={group.id}
                name={editName}
                skillIds={editSkills}
                allSkills={allSkills}
                occupiedSkillIds={occupiedSkillIds}
                onNameChange={handleNameChange}
                onSkillsChange={handleSkillsChange}
                onClose={() => {
                  commitEdit();
                  setEditingId(null);
                }}
              />
            ) : (
              <GroupRow
                key={group.id}
                name={group.name}
                skillLabels={group.skillIds.map((id) => getSkillLabel(id))}
                onEdit={() => startEdit(group)}
                onDelete={() => handleDelete(group.id, group.isPreset, group.presetKey)}
              />
            )
          )}
        </Stack>
      </Stack>
    </Modal>
  );
};
