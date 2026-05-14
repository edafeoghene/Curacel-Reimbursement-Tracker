import { describe, expect, it } from "vitest";
import {
  MalformedEmployeeError,
  lookupEmployeeBySlackId,
  parseEmployeeRow,
} from "../../src/sheets/employees.js";

describe("parseEmployeeRow", () => {
  it("parses a fully-populated row", () => {
    const e = parseEmployeeRow([
      "Edafeoghene Egona",
      "Henry Mascot",
      "AI Ops",
      "U0B0N34QZV1",
      "U02LVHPC8AD",
      "C08UMFHEAGP",
    ]);
    expect(e).toEqual({
      employee_name: "Edafeoghene Egona",
      team_lead_name: "Henry Mascot",
      team: "AI Ops",
      employee_slack_id: "U0B0N34QZV1",
      team_lead_slack_id: "U02LVHPC8AD",
      team_channel_id: "C08UMFHEAGP",
    });
  });

  it("trims trailing whitespace and stray newlines", () => {
    const e = parseEmployeeRow([
      "Oluwadurotimi Olorode\n",
      "Jake Obodomechine ",
      " Engineering",
      "U094TGRM6LW",
      "U01P79C0M32",
      "",
    ]);
    expect(e.employee_name).toBe("Oluwadurotimi Olorode");
    expect(e.team_lead_name).toBe("Jake Obodomechine");
    expect(e.team).toBe("Engineering");
  });

  it("tolerates missing team_lead_slack_id / team_channel_id (validated downstream)", () => {
    const e = parseEmployeeRow([
      "David Bassey",
      "",
      "",
      "U096XUZ8BGQ",
      "",
      "",
    ]);
    expect(e.team_lead_slack_id).toBe("");
    expect(e.team_channel_id).toBe("");
  });

  it("throws when employee_slack_id is missing", () => {
    expect(() =>
      parseEmployeeRow(["Someone", "Lead", "Team", "", "ULEAD", "CCHAN"]),
    ).toThrow(MalformedEmployeeError);
  });

  it("throws when employee_slack_id is not a U-prefixed Slack user ID", () => {
    // D-prefixed (DM channel ID) — the original Employee data tab had a few
    // of these from a copy-paste mistake; loader rejects them.
    expect(() =>
      parseEmployeeRow([
        "Oluwadara Kairos",
        "Abdul-Jabbar Momoh",
        "Commercial",
        "D0AAG4VACBT",
        "D0AAG4VACBT",
        "",
      ]),
    ).toThrow(MalformedEmployeeError);
  });
});

describe("lookupEmployeeBySlackId", () => {
  const A = {
    employee_name: "Alice",
    team_lead_name: "Carol",
    team: "X",
    employee_slack_id: "U_ALICE",
    team_lead_slack_id: "U_CAROL",
    team_channel_id: "C_X",
  };
  const B = {
    employee_name: "Bob",
    team_lead_name: "Carol",
    team: "X",
    employee_slack_id: "U_BOB",
    team_lead_slack_id: "U_CAROL",
    team_channel_id: "C_X",
  };

  it("returns null when the slack id is not in the list", () => {
    expect(lookupEmployeeBySlackId([A, B], "U_NOBODY")).toBeNull();
  });

  it("returns the matching row", () => {
    expect(lookupEmployeeBySlackId([A, B], "U_BOB")).toBe(B);
  });

  it("returns the LAST match when duplicates exist", () => {
    const olderA = { ...A, team_lead_name: "OldLead" };
    const newerA = { ...A, team_lead_name: "NewLead" };
    expect(lookupEmployeeBySlackId([olderA, B, newerA], "U_ALICE")).toBe(newerA);
  });
});
