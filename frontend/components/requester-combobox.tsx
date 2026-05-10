"use client";

import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { useState } from "react";

export interface RequesterOption {
  userId: string;
  name: string;
}

interface Props {
  /** Form field name. Submitted as user_id (or empty string for "all"). */
  name: string;
  options: RequesterOption[];
  /** user_id of the initially-selected requester, or "" for none. */
  defaultValue?: string;
  /** Visible label when no requester is selected. */
  placeholder?: string;
}

/**
 * Type-to-filter requester picker. Replaces a plain <select> that
 * doesn't scale past ~20 names. Submits as a hidden user_id (the
 * unique key) so existing bookmarks with ?requester=U0xxx keep working
 * and filter logic in applyTicketFilters() is unchanged.
 *
 * Built on cmdk (headless command primitive — case-insensitive
 * fuzzy-match filter is built in) wrapped in Radix Popover for
 * focus-management and click-outside behaviour. cmdk's `value` prop on
 * each item is what gets fuzzy-matched; we set it to "name userId" so
 * the user can search by either label.
 */
export function RequesterCombobox({
  name,
  options,
  defaultValue = "",
  placeholder = "All requesters",
}: Props) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);

  const selected = options.find((o) => o.userId === value);
  const displayLabel = selected ? selected.name : placeholder;
  const isPlaceholder = !selected;

  return (
    <>
      {/* Hidden field is what submits with the form. */}
      <input type="hidden" name={name} value={value} />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-2 text-left text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <span
              className={
                isPlaceholder
                  ? "truncate text-zinc-500"
                  : "truncate text-zinc-900 dark:text-zinc-50"
              }
            >
              {displayLabel}
            </span>
            <ChevronIcon />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            // Match the trigger's width so the popover doesn't overflow
            // the form column awkwardly.
            style={{ width: "var(--radix-popover-trigger-width)" }}
            className="z-50 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-md dark:border-zinc-800 dark:bg-zinc-950"
          >
            <Command className="w-full">
              <div className="border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
                <Command.Input
                  placeholder="Search by name or ID…"
                  className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-zinc-500"
                />
              </div>
              <Command.List className="max-h-64 overflow-y-auto py-1">
                <Command.Empty className="px-2 py-3 text-center text-xs text-zinc-500">
                  No requesters match.
                </Command.Empty>
                <Command.Item
                  value="all requesters none"
                  onSelect={() => {
                    setValue("");
                    setOpen(false);
                  }}
                  className="cursor-pointer rounded-sm px-2 py-1.5 text-sm text-zinc-700 aria-selected:bg-zinc-100 aria-selected:text-zinc-900 dark:text-zinc-300 dark:aria-selected:bg-zinc-900 dark:aria-selected:text-zinc-50"
                >
                  All requesters
                </Command.Item>
                {options.map((o) => (
                  <Command.Item
                    key={o.userId}
                    value={`${o.name} ${o.userId}`}
                    onSelect={() => {
                      setValue(o.userId);
                      setOpen(false);
                    }}
                    className="cursor-pointer rounded-sm px-2 py-1.5 text-sm text-zinc-900 aria-selected:bg-zinc-100 dark:text-zinc-50 dark:aria-selected:bg-zinc-900"
                  >
                    <div className="truncate">{o.name}</div>
                    <div className="truncate font-mono text-xs text-zinc-500">{o.userId}</div>
                  </Command.Item>
                ))}
              </Command.List>
            </Command>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
