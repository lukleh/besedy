"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";

export type TextSize = "default" | "large" | "xlarge";

const TEXT_SIZE_STORAGE_KEY = "besedy-text-size";
const TEXT_SIZE_VALUES: Record<TextSize, string> = {
  default: "100%",
  large: "112%",
  xlarge: "125%",
};

interface TextSizeContextValue {
  textSize: TextSize;
  setTextSize: (size: TextSize) => void;
}

const TextSizeContext = createContext<TextSizeContextValue | undefined>(
  undefined
);

export function TextSizeProvider({ children }: { children: ReactNode }) {
  const [textSize, setTextSizeState] = useState<TextSize>("default");
  const [mounted, setMounted] = useState(false);

  // Load from localStorage on mount - standard SSR hydration pattern
  useEffect(() => {
    const stored = localStorage.getItem(TEXT_SIZE_STORAGE_KEY) as TextSize | null;
    if (stored && TEXT_SIZE_VALUES[stored]) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTextSizeState(stored);
    }
    setMounted(true);
  }, []);

  // Apply the font-size to html element
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.style.fontSize = TEXT_SIZE_VALUES[textSize];
  }, [textSize, mounted]);

  const setTextSize = useCallback((size: TextSize) => {
    setTextSizeState(size);
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, size);
  }, []);

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
