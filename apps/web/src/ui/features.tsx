/**
 * Feature registry: the single list the app shell is built from.
 *
 * To add a feature: write its view component, then add one entry below.
 * The top tabs, bottom tabs, remembered-tab check and the view switch all
 * come from this list, so nothing else in the shell needs to change.
 * To turn a feature off, set `enabled: false` (or remove its entry).
 */
import type { JSX } from "react";
import { CalendarIcon, ListIcon, StackIcon, TimerIcon } from "./icons.tsx";
import { LogView } from "./LogView.tsx";
import { PriorityView } from "./PriorityView.tsx";
import { TasksView } from "./TasksView.tsx";
import { TimerView } from "./TimerView.tsx";

/** What the shell hands every feature view. */
export interface FeatureViewProps {
  /** Switch to another feature by id (unknown or disabled ids are ignored). */
  navigate: (id: string) => void;
}

export interface Feature {
  /** Stable id: stored on the device as the remembered tab, so don't rename it. */
  id: string;
  label: string;
  Icon: () => JSX.Element;
  View: (props: FeatureViewProps) => JSX.Element;
  /** Defaults to true. */
  enabled?: boolean;
}

export const FEATURES: readonly Feature[] = [
  { id: "tasks", label: "Tasks", Icon: ListIcon, View: () => <TasksView /> },
  {
    id: "priority",
    label: "Priority",
    Icon: StackIcon,
    View: ({ navigate }) => <PriorityView onGoToTasks={() => navigate("tasks")} />,
  },
  { id: "log", label: "Log", Icon: CalendarIcon, View: () => <LogView /> },
  { id: "timer", label: "Timer", Icon: TimerIcon, View: () => <TimerView /> },
];

/** Opened on first launch, or when the remembered feature no longer exists. */
export const DEFAULT_FEATURE_ID = "priority";

/** Enabled features, with duplicate ids rejected so a bad entry fails loudly. */
export function activeFeatures(list: readonly Feature[] = FEATURES): Feature[] {
  const active = list.filter((f) => f.enabled !== false);
  const seen = new Set<string>();
  for (const f of active) {
    if (seen.has(f.id)) throw new Error(`Duplicate feature id: ${f.id}`);
    seen.add(f.id);
  }
  if (active.length === 0) throw new Error("No features enabled");
  return active;
}

/** Picks a valid feature id: the wanted one, else the default, else the first enabled. */
export function resolveFeatureId(wanted: string | null, list: readonly Feature[]): string {
  if (wanted && list.some((f) => f.id === wanted)) return wanted;
  if (list.some((f) => f.id === DEFAULT_FEATURE_ID)) return DEFAULT_FEATURE_ID;
  return list[0]!.id;
}
