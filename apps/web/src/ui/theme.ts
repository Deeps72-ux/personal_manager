/**
 * Light / dark appearance, chosen PER DEVICE (not synced).
 *
 * "system" follows the device setting (no attribute on <html>);
 * "light" / "dark" force it via <html data-theme="...">, which the CSS
 * tokens in styles.css respond to.
 */
import { useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "pm.theme";

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage blocked (private mode): follow the device
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // not remembered, but still applied for this session
  }
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const set = (c: ThemeChoice) => {
    saveTheme(c);
    applyTheme(c);
    setChoice(c);
  };
  return [choice, set];
}
