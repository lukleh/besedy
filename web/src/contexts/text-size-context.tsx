"use client";

import {
  createContext,
  useContext,
  useEffect,
  type ReactNode,
} from "react";
import { useHydratedState } from "@/hooks/use-hydrated-state";

export type TextSize = "default" | "large" | "xlarge";

const TEXT_SIZE_STORAGE_KEY = "besedy-text-size";
const TEXT_SIZE_VALUES: Record<TextSize, string> = {
  default: "100%",
  large: "112%",
  xlarge: "125%",
};
const textSizeCodec = {
  serialize: (value: TextSize) => value,
  deserialize: (stored: string): TextSize =>
    Object.hasOwn(TEXT_SIZE_VALUES, stored) ? stored as TextSize : "default",
};

interface TextSizeContextValue {
  textSize: TextSize;
  setTextSize: (size: TextSize) => void;
}

const TextSizeContext = createContext<TextSizeContextValue | undefined>(
  undefined
);

export function TextSizeProvider({ children }: { children: ReactNode }) {
  const [textSize, setTextSize, mounted] = useHydratedState(
    TEXT_SIZE_STORAGE_KEY, "default" as TextSize, textSizeCodec,
  );

  // Apply the font-size to html element
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.style.fontSize = TEXT_SIZE_VALUES[textSize];
  }, [textSize, mounted]);

  return (
    <TextSizeContext.Provider value={{ textSize, setTextSize }}>
      {children}
    </TextSizeContext.Provider>
  );
}

export function useTextSize() {
  const context = useContext(TextSizeContext);
  if (!context) {
    throw new Error("useTextSize must be used within a TextSizeProvider");
  }
  return context;
}
