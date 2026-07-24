export function splitModelKey(modelKey: string): { workflow: string; model: string } {
  const [workflow, ...rest] = modelKey.split("/");
  return { workflow: workflow ?? modelKey, model: rest.join("/") };
}

export function trimModelComponent(model: string, maxLength = 28): string {
  if (!model) return "";
  const parts = model.split("@");
  const [primary, secondary] = parts;
  // The language component distinguishes otherwise identical variants
  // (large-v3@silero_vad_v6 vs ...@lang-en), so it always survives trimming.
  const language = parts.slice(2).find((part) => part.startsWith("lang-"));
  let label = primary;
  if (secondary) {
    label = `${primary}@${secondary}`;
  }
  const suffix = language ? `@${language}` : "";
  const budget = maxLength - suffix.length;
  if (label.length > budget) {
    label = `${label.slice(0, Math.max(0, budget - 3))}...`;
  }
  return `${label}${suffix}`;
}

export function formatModelLabel(modelKey: string, maxLength = 28): string {
  const { workflow, model } = splitModelKey(modelKey);
  if (!model) return workflow;
  const trimmed = trimModelComponent(model, maxLength);
  return `${workflow} / ${trimmed}`;
}
