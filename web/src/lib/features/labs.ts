export interface LabsPreference {
  enabled: boolean;
  updatedAt: string | null;
}

const DEFAULT_LABS_PREFERENCE: LabsPreference = {
  enabled: false,
  updatedAt: null,
};

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function readLabsPreferenceFromSettings(settings: unknown): LabsPreference {
  const settingsRecord = toRecord(settings);
  const labsRecord = toRecord(settingsRecord.labs);

  return {
    enabled: labsRecord.enabled === true,
    updatedAt: typeof labsRecord.updatedAt === "string" ? labsRecord.updatedAt : null,
  };
}

export function mergeLabsIntoSettings(
  currentSettings: unknown,
  enabled: boolean,
  updatedAt: string
): Record<string, unknown> {
  const settingsRecord = toRecord(currentSettings);

  return {
    ...settingsRecord,
    labs: {
      enabled,
      updatedAt,
    },
  };
}

export function defaultLabsPreference(): LabsPreference {
  return DEFAULT_LABS_PREFERENCE;
}
