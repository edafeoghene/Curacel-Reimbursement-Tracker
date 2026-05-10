"use client";

import * as Popover from "@radix-ui/react-popover";
import { format, parseISO } from "date-fns";
import { useState } from "react";
import { DayPicker } from "react-day-picker";

import "react-day-picker/dist/style.css";

interface Props {
  /**
   * Form field name. Submitted as a YYYY-MM-DD string in the form's GET
   * payload so the server can parse it directly into a date-range filter.
   */
  name: string;
  /** YYYY-MM-DD or empty string. */
  defaultValue?: string;
  /** Placeholder shown when no date is selected. */
  placeholder?: string;
  /** aria-label for the trigger button (read by screen readers). */
  ariaLabel: string;
}

/**
 * Calendar-themed date input. Replaces the bare <input type="date">
 * whose UI varies wildly by browser. Submits as a hidden YYYY-MM-DD
 * field so the server form handler doesn't need to know whether the
 * frontend is using native or custom picker.
 */
export function DatePicker({ name, defaultValue, placeholder = "Pick a date", ariaLabel }: Props) {
  const initialDate = defaultValue ? safeParseIso(defaultValue) : undefined;
  const [date, setDate] = useState<Date | undefined>(initialDate);
  const [open, setOpen] = useState(false);

  const isoValue = date ? format(date, "yyyy-MM-dd") : "";
  const displayValue = date ? format(date, "MMM d, yyyy") : placeholder;

  return (
    <>
      {/* Hidden field is what actually submits with the form. The visible
          trigger button is decorative — clicking it opens the popover. */}
      <input type="hidden" name={name} value={isoValue} />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-2 text-left text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <span className={date ? "text-zinc-900 dark:text-zinc-50" : "text-zinc-500"}>
              {displayValue}
            </span>
            <CalendarIcon />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className="z-50 rounded-md border border-zinc-200 bg-white p-2 shadow-md dark:border-zinc-800 dark:bg-zinc-950"
          >
            <DayPicker
              mode="single"
              selected={date}
              onSelect={(d) => {
                setDate(d);
                setOpen(false);
              }}
              showOutsideDays
              fixedWeeks
              classNames={DAY_PICKER_CLASSNAMES}
            />
            {date ? (
              <button
                type="button"
                onClick={() => {
                  setDate(undefined);
                  setOpen(false);
                }}
                className="mt-1 w-full rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
              >
                Clear date
              </button>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

function safeParseIso(s: string): Date | undefined {
  try {
    const d = parseISO(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
  } catch {
    return undefined;
  }
}

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="11" height="10" rx="1.5" stroke="currentColor" />
      <path d="M1.5 5.5h11M4.5 1v2.5M9.5 1v2.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/**
 * react-day-picker v9 classNames API. We override its default styles so
 * the calendar matches our Tailwind theme. Keys here are from
 * react-day-picker's DefaultClassNames; missing keys fall back to library
 * defaults (loaded via the imported CSS).
 */
const DAY_PICKER_CLASSNAMES = {
  root: "text-sm",
  month_caption: "flex items-center justify-center py-1 font-medium",
  caption_label: "text-sm",
  nav: "flex items-center gap-1",
  weekdays: "text-xs uppercase tracking-wide text-zinc-500",
  day_button:
    "h-8 w-8 rounded-md text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50",
  selected: "[&_button]:bg-zinc-900 [&_button]:text-white dark:[&_button]:bg-zinc-50 dark:[&_button]:text-zinc-900",
  today: "[&_button]:font-semibold [&_button]:text-zinc-900 dark:[&_button]:text-zinc-50",
  outside: "[&_button]:text-zinc-400 dark:[&_button]:text-zinc-600",
} as const;
