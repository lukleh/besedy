interface NamedOption {
  id: number;
  name: string;
}

interface CountedNamedOption extends NamedOption {
  count: number;
}

export function normalizeEnumFilter(value: string | null): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "empty") return "empty";

  return /^\d+$/.test(trimmed) ? trimmed : null;
}

export function includeSelectedNamedOption<T extends NamedOption>(
  baseOptions: Array<T & CountedNamedOption>,
  allOptions: T[],
  selectedFilter: string
): Array<T & CountedNamedOption> {
  if (selectedFilter === "all" || selectedFilter === "empty") {
    return baseOptions;
  }

  const hasSelected = baseOptions.some(
    (option) => option.id.toString() === selectedFilter
  );
  if (hasSelected) {
    return baseOptions;
  }

  const selectedOption = allOptions.find(
    (option) => option.id.toString() === selectedFilter
  );
  if (!selectedOption) {
    return baseOptions;
  }

  return [...baseOptions, { ...selectedOption, count: 0 }].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}
