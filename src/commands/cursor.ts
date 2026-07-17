import { encode } from "@toon-format/toon";
import {
  buildCursorSnapshot,
  readCursorActivity,
  type CursorSnapshot,
} from "../cursor.js";
import { cursorPlain } from "../views.js";
import { renderHelp, renderOutput } from "../toon.js";
import type { SpendContext } from "../context.js";

export const CURSOR_HELP = `usage: spend-axi cursor [flags]
Cursor on-demand daily spend posture. The captain (2026-07-17) mandates keeping
cursor spend under ~USD 50 per weekday with a claude-subscription fallback when
the cap is hit. Cursor DOLLAR spend is not yet readable via any API/CLI, so the
section surfaces today's request ACTIVITY from the local usage log and flags
dollar spend as "not wired" — ready the moment a usage-$ source is wired.

flags[2]:
  --cursor-cap <usd> (default 50), --json, --help
examples:
  spend-axi cursor
  spend-axi cursor --cursor-cap 60 --json
`;

/** Gather the cursor snapshot (never throws). */
export function gatherCursor(
  ctx: SpendContext,
  today?: string,
): CursorSnapshot {
  const activity = readCursorActivity({ today });
  return buildCursorSnapshot(ctx.cursorCapUsd, activity);
}

/** Render the cursor snapshot as a TOON string. */
export function renderCursor(snapshot: CursorSnapshot): string {
  return encode({ cursor: cursorPlain(snapshot) });
}

export async function cursorCommand(
  args: string[],
  ctx: SpendContext,
): Promise<string> {
  if (args[0] === "--help") return CURSOR_HELP;
  const snapshot = gatherCursor(ctx);
  if (ctx.json) {
    return JSON.stringify(snapshot, null, 2);
  }
  return renderOutput([renderCursor(snapshot), renderHelp(cursorHints(snapshot))]);
}

function cursorHints(snapshot: CursorSnapshot): string[] {
  const hints: string[] = [];
  if (!snapshot.activity.dbPresent) {
    hints.push("No local cursor usage DB found at ~/.cursor/ai-tracking — run cursor-agent once to seed it");
  } else if (snapshot.activity.error) {
    hints.push("Cursor usage DB present but unreadable: " + snapshot.activity.error);
  }
  hints.push("Wire a Cursor usage-$ source in src/cursor.ts to activate the $" + snapshot.dailyCapUsd + " daily-cap headroom math");
  hints.push("Run `spend-axi` for the full snapshot (subscriptions + gateway + cursor)");
  return hints;
}
